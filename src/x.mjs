// X (Twitter) API v2 client — dependency-free, OAuth 1.0a user context.
//
//  * Media: v2 chunked upload (initialize → append → finalize → status), then falls back to the
//    v2 one-shot endpoint, then the legacy v1.1 endpoint. If every path fails the post goes out
//    text-only (the blog link card still shows the image).
//  * Posting: POST /2/tweets with retries for 5xx / network / 429 (honours x-rate-limit-reset).
//    Retrying a post is safe: X rejects identical text as "duplicate", which we treat as success.
//  * Errors are classified (auth / credits / enrollment / permissions / duplicate / rate / ...) so the
//    pipeline can queue the tweet for a later run and print an actionable fix instead of failing.
//
// Pricing note (2026): X has no free tier any more. Pay-per-use: ~$0.015 per post, ~$0.20 if the post
// contains a link. Set X_LINK_MODE=none to post without the link.

import crypto from 'node:crypto';
import { sleep, log } from './util.mjs';

const E = () => process.env;
const num = (k, d) => (E()[k] !== undefined && E()[k] !== '' && !Number.isNaN(Number(E()[k])) ? Number(E()[k]) : d);
const apiBase = () => (E().X_API_BASE || 'https://api.x.com').replace(/\/$/, '');
const legacyUploadUrl = () => E().X_UPLOAD_V1_URL || 'https://upload.twitter.com/1.1/media/upload.json';

const CRED_KEYS = ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET'];
export const xConfigured = () => CRED_KEYS.every((k) => (E()[k] || '').trim());
export const missingXCreds = () => CRED_KEYS.filter((k) => !(E()[k] || '').trim());
const loadCreds = () => ({ appKey: E().X_API_KEY.trim(), appSecret: E().X_API_SECRET.trim(), accessToken: E().X_ACCESS_TOKEN.trim(), accessSecret: E().X_ACCESS_SECRET.trim() });

// ── Errors ──────────────────────────────────────────────────────────────────
export class XError extends Error {
  constructor(kind, message, { status, retryAfterMs } = {}) {
    super(message);
    this.name = 'XError'; this.kind = kind; this.status = status; this.retryAfterMs = retryAfterMs;
  }
  /** worth retrying right now */
  get retryable() { return ['rate', 'server', 'network'].includes(this.kind); }
  /** account-level problem: every later call will fail the same way until the user fixes it */
  get blocking() { return ['auth', 'credits', 'enrollment', 'permissions'].includes(this.kind); }
}

const HINTS = {
  auth: 'X rejected the credentials (401). Regenerate X_API_KEY / X_API_SECRET and X_ACCESS_TOKEN / X_ACCESS_SECRET in console.x.com. Create the access token AFTER setting the app to "Read and write".',
  credits: 'Your X API credits are used up (402). X ended its free tier in Feb 2026 — add credits in console.x.com → Billing. Queued posts are sent automatically on the next run after you top up.',
  enrollment: 'The X app is not enrolled in a pay-per-use package / Production environment (403 client-not-enrolled). In console.x.com move the app to the Pay-per-use package.',
  permissions: 'The X app is read-only. Set User authentication settings to "Read and write", then REGENERATE the access token + secret.',
  forbidden: 'X refused the request (403). Check app permissions and that the account is not restricted.',
  rate: 'X rate limit hit; the tweet will be retried on the next run.',
  server: 'X had a server-side problem; the tweet will be retried on the next run.',
  network: 'Could not reach X; the tweet will be retried on the next run.',
};
export const explainXError = (e) => (e instanceof XError ? HINTS[e.kind] || '' : '');

function classifyX(status, text, headers) {
  let j; try { j = JSON.parse(text); } catch { /* not JSON */ }
  const detail = String(j?.detail || (j?.errors || []).map((x) => x.message).join('; ') || j?.title || text || '').replace(/\s+/g, ' ').slice(0, 240);
  const blob = `${text} ${detail}`.toLowerCase();
  const mk = (kind, extra) => new XError(kind, `X ${status}: ${detail || kind}`, { status, ...extra });

  if (status === 401) return mk('auth');
  if (status === 402 || /credit/.test(blob)) return mk('credits');
  if (status === 403) {
    if (/duplicate/.test(blob)) return mk('duplicate');
    if (/client-not-enrolled|not enrolled|pay-per-use|client-forbidden|package/.test(blob)) return mk('enrollment');
    if (/oauth1 app permissions|read.?only|not permitted|permissions/.test(blob)) return mk('permissions');
    return mk('forbidden');
  }
  if (status === 429) {
    const reset = Number(headers.get('x-rate-limit-reset'));
    const ra = Number(headers.get('retry-after'));
    const ms = ra > 0 ? ra * 1000 : reset > 0 ? Math.max(1000, reset * 1000 - Date.now()) : 60000;
    return mk('rate', { retryAfterMs: ms });
  }
  if (status >= 500) return mk('server');
  if (/media/.test(blob)) return mk('media');
  return mk('invalid');
}

// ── OAuth 1.0a (HMAC-SHA1) ──────────────────────────────────────────────────
const pct = (s) => encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** `params` = extra form-urlencoded body params that belong in the signature (none for JSON/multipart). */
export function oauth1Header({ method, url, creds, params = {}, nonce = crypto.randomBytes(16).toString('hex'), timestamp = String(Math.floor(Date.now() / 1000)) }) {
  const u = new URL(url);
  const oauth = {
    oauth_consumer_key: creds.appKey, oauth_nonce: nonce, oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp, oauth_token: creds.accessToken, oauth_version: '1.0',
  };
  const all = [...u.searchParams.entries(), ...Object.entries(params), ...Object.entries(oauth)]
    .map(([k, v]) => [pct(k), pct(v)])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  const base = `${method.toUpperCase()}&${pct(u.origin + u.pathname)}&${pct(all.map(([k, v]) => `${k}=${v}`).join('&'))}`;
  const signature = crypto.createHmac('sha1', `${pct(creds.appSecret)}&${pct(creds.accessSecret)}`).update(base).digest('base64');
  const h = { ...oauth, oauth_signature: signature };
  return `OAuth ${Object.keys(h).sort().map((k) => `${pct(k)}="${pct(h[k])}"`).join(', ')}`;
}

async function xFetch(method, urlOrPath, { json, form, creds, timeoutMs = num('X_TIMEOUT_MS', 30000) }) {
  const url = urlOrPath.startsWith('http') ? urlOrPath : `${apiBase()}${urlOrPath}`;
  const headers = { Authorization: oauth1Header({ method, url, creds }), 'User-Agent': 'TrueToldBot/2.0' };
  let body;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  else if (form) body = form;
  let res;
  try { res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) }); }
  catch (e) { throw new XError('network', `network error: ${e.message}`); }
  const text = await res.text().catch(() => '');
  if (!res.ok) throw classifyX(res.status, text, res.headers);
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { /* leave null */ }
  return { status: res.status, data };
}

// ── Retry helper ────────────────────────────────────────────────────────────
const RETRY_BASE = () => num('X_RETRY_BASE_MS', 2000);
async function withRetry(fn, { tries = 3, label = 'X request' } = {}) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      if (!(e instanceof XError) || !e.retryable || i >= tries) throw e;
      const maxWait = num('X_MAX_WAIT_MS', 90000);
      let wait = e.kind === 'rate' ? e.retryAfterMs ?? 60000 : RETRY_BASE() * 3 ** (i - 1) * (0.8 + Math.random() * 0.4);
      if (wait > maxWait) throw e; // too long to sit in a CI job → caller queues it for the next run
      log(`${label}: ${e.kind} (${e.status ?? 'n/a'}) — retry ${i}/${tries - 1} in ${Math.ceil(wait / 1000)}s`);
      await sleep(wait + (e.kind === 'rate' ? 500 : 0));
    }
  }
}

// ── Media upload ────────────────────────────────────────────────────────────
const blobOf = (buf, type = 'application/octet-stream') => new Blob([buf], { type });

async function waitProcessing(id, info, creds) {
  for (let i = 0; info && ['pending', 'in_progress'].includes(info.state) && i < 15; i++) {
    await sleep(Math.max(1, info.check_after_secs ?? 1) * (RETRY_BASE() > 100 ? 1000 : 1));
    const r = await xFetch('GET', `/2/media/upload?command=STATUS&media_id=${encodeURIComponent(id)}`, { creds });
    info = r.data?.data?.processing_info;
  }
  if (info?.state === 'failed') throw new XError('media', `media processing failed: ${info.error?.message || 'unknown'}`);
}

async function uploadChunkedV2(buf, creds) {
  const init = await xFetch('POST', '/2/media/upload/initialize', { creds, json: { media_type: 'image/jpeg', total_bytes: buf.length, media_category: 'tweet_image' } });
  const id = init.data?.data?.id;
  if (!id) throw new XError('media', 'initialize returned no media id');
  const CH = 4 * 1024 * 1024;
  for (let off = 0, seg = 0; off < buf.length; off += CH, seg++) {
    const fd = new FormData();
    fd.append('segment_index', String(seg));
    fd.append('media', blobOf(buf.subarray(off, off + CH)), 'chunk');
    await xFetch('POST', `/2/media/upload/${id}/append`, { creds, form: fd });
  }
  const fin = await xFetch('POST', `/2/media/upload/${id}/finalize`, { creds });
  await waitProcessing(id, fin.data?.data?.processing_info, creds);
  return String(id);
}

async function uploadSimpleV2(buf, creds) {
  const fd = new FormData();
  fd.append('media', blobOf(buf, 'image/jpeg'), 'card.jpg');
  fd.append('media_category', 'tweet_image');
  fd.append('media_type', 'image/jpeg');
  const r = await xFetch('POST', '/2/media/upload', { creds, form: fd });
  const id = r.data?.data?.id || r.data?.media_id_string;
  if (!id) throw new XError('media', 'one-shot upload returned no media id');
  return String(id);
}

async function uploadLegacyV1(buf, creds) {
  const fd = new FormData();
  fd.append('media', blobOf(buf, 'image/jpeg'), 'card.jpg');
  fd.append('media_category', 'tweet_image');
  const r = await xFetch('POST', legacyUploadUrl(), { creds, form: fd });
  const id = r.data?.media_id_string || r.data?.data?.id;
  if (!id) throw new XError('media', 'legacy upload returned no media id');
  return String(id);
}

export async function uploadImage(buf, creds = loadCreds()) {
  const strategies = [['v2-chunked', uploadChunkedV2], ['v2-simple', uploadSimpleV2], ['v1-legacy', uploadLegacyV1]];
  const errs = [];
  for (const [name, fn] of strategies) {
    try { return { id: await withRetry(() => fn(buf, creds), { tries: 2, label: `X media (${name})` }), via: name }; }
    catch (e) {
      errs.push(`${name}: ${e.message}`);
      if (e instanceof XError && (e.blocking && e.kind !== 'permissions')) throw e; // creds/credits problem → no point trying other paths
    }
  }
  throw new XError('media', `all media upload paths failed — ${errs.join(' | ')}`);
}

// ── Tweet text ──────────────────────────────────────────────────────────────
/** Length the way X counts it: URLs = 23, most CJK/emoji/symbols = 2, everything else = 1. */
export function weightedLength(text) {
  let n = 0;
  for (const ch of String(text).replace(/https?:\/\/\S+/g, 'x'.repeat(23))) {
    const cp = ch.codePointAt(0);
    n += cp <= 4351 || (cp >= 8192 && cp <= 8205) || (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247) ? 1 : 2;
  }
  return n;
}

/** hook + "Continue Reading" CTA + bare link (X expands it to a card) + hashtags, always ≤ 280. */
export function buildTweet({ hook, url, hashtags = [], linkMode = E().X_LINK_MODE || 'inline', max = 280 }) {
  const tags = hashtags.join(' ');
  const tail = linkMode === 'none' ? (tags ? `\n${tags}` : '') : `\n→ Continue Reading\n${url}${tags ? `\n${tags}` : ''}`;
  const room = max - weightedLength(tail);
  let text = String(hook).trim().replace(/\s+/g, ' ');
  if (weightedLength(text) > room) {
    const chars = Array.from(text);
    while (chars.length && weightedLength(`${chars.join('')}…`) > room) chars.pop();
    text = `${chars.join('').trimEnd()}…`;
  }
  return `${text}${tail}`;
}

// ── Post ────────────────────────────────────────────────────────────────────
/**
 * @returns {{id:string, withImage:boolean, mediaVia?:string}|{skipped:true, reason:string}}
 * @throws {XError} with .kind / .retryable / .blocking
 */
export async function postToX(text, { imageBuffer, creds } = {}) {
  if (!creds && !xConfigured()) return { skipped: true, reason: `X credentials not configured (missing: ${missingXCreds().join(', ')})` };
  creds ||= loadCreds();

  let mediaId; let via;
  if (imageBuffer && E().X_ATTACH_IMAGE !== 'false') {
    try { ({ id: mediaId, via } = await uploadImage(imageBuffer, creds)); }
    catch (e) {
      if (e instanceof XError && e.blocking && e.kind !== 'permissions') throw e;
      log(`X media upload failed (non-fatal, posting text-only): ${e.message}`);
    }
  }

  let useMedia = !!mediaId;
  const MAX = 4;
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await xFetch('POST', '/2/tweets', { creds, json: { text, ...(useMedia ? { media: { media_ids: [mediaId] } } : {}) } });
      const id = r.data?.data?.id;
      if (!id) throw new XError('server', 'X accepted the request but returned no post id');
      return { id, withImage: useMedia, mediaVia: via };
    } catch (e) {
      if (!(e instanceof XError)) throw e;
      if (useMedia && (e.kind === 'media' || e.kind === 'invalid')) { log('X: media was rejected at post time, retrying text-only'); useMedia = false; continue; }
      if (!e.retryable || attempt >= MAX) throw e;
      const maxWait = num('X_MAX_WAIT_MS', 90000);
      const wait = e.kind === 'rate' ? e.retryAfterMs ?? 60000 : RETRY_BASE() * 3 ** (attempt - 1) * (0.8 + Math.random() * 0.4);
      if (wait > maxWait) throw e;
      log(`X post: ${e.kind} (${e.status ?? 'n/a'}) — retry ${attempt}/${MAX - 1} in ${Math.ceil(wait / 1000)}s`);
      await sleep(wait + (e.kind === 'rate' ? 500 : 0));
    }
  }
}

/** Credential check used by `npm run x-check` (one cheap authenticated read). */
export async function xWhoAmI(creds = loadCreds()) {
  const r = await xFetch('GET', '/2/users/me', { creds });
  return r.data?.data;
}
