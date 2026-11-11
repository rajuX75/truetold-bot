// Resilient LLM client for OpenAI-compatible endpoints.
//
//  * Model CHAINS, not single models: every provider has an ordered list of models per role
//    (text / check / vision). A failure moves to the next model, then the next provider.
//  * LIVE DISCOVERY: GET {base}/models is called once per provider. Configured/default models the
//    provider no longer offers are skipped, so retired model names can never break a run again.
//  * HEALTH MEMORY: a model that is dead (404/decommissioned/zero quota), out of daily quota or
//    rate-limited is not hit again until its cooldown ends.
//  * OUTPUT VALIDATION: a `validate` callback (e.g. JSON parse + schema) is part of the call.
//    Invalid / truncated output fails over to a different model instead of repeating the same one.
//  * AUTO-ADAPT: rejects of response_format / reasoning_effort are remembered and dropped.
//
// Providers (all optional except the first):  LLM_API_KEY[_2.._6], LLM_BASE_URL[_n],
// LLM_MODEL[_n] (comma list allowed), LLM_VISION_MODEL[_n], LLM_CHECK_MODEL[_n], LLM_PROVIDER_NAME[_n]

import { sleep, log, extractJson } from './util.mjs';

export class LLMExhaustedError extends Error {
  constructor(message, causes = []) { super(message); this.name = 'LLMExhaustedError'; this.causes = causes; }
}

// ── Known providers and their CURRENT model preferences (checked Nov 2026; discovery trims stale ones)
const KINDS = {
  gemini: {
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    match: /generativelanguage\.googleapis\.com/,
    // Free tier is per-model: 3.8-flash ≈ 20 req/day, 3.5-flash-lite ≈ 500 req/day.
    // gemini-2.5-* is restricted to existing users and retires 2026-12-01 → last resort only.
    text:   ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite', 'gemini-2.5-flash'],
    check:  ['gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-3.1-flash-lite', 'gemini-3.8-flash', 'gemini-2.5-flash-lite'],
    vision: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-2.5-flash-lite'],
  },
  groq: {
    base: 'https://api.groq.com/openai/v1',
    match: /groq\.com/,
    // llama-3.3-70b-versatile + llama-3.1-8b-instant were retired 2026-08-16; llama-4-scout 2026-07-17.
    text:   ['openai/gpt-oss-120b', 'qwen/qwen3.6-27b', 'openai/gpt-oss-20b'],
    check:  ['openai/gpt-oss-120b', 'qwen/qwen3.6-27b', 'openai/gpt-oss-20b'],
    vision: [], // no known-good Groq vision model right now; set LLM_VISION_MODEL_2 to use one
  },
  cerebras: {
    base: 'https://api.cerebras.ai/v1',
    match: /cerebras\.ai/,
    maxOut: 3500, // free tier context window is 8K tokens
    text:   ['gpt-oss-120b', 'qwen-3-235b-a22b-instruct-2507', 'zai-glm-4.7', 'llama3.1-8b'],
    check:  ['gpt-oss-120b', 'qwen-3-235b-a22b-instruct-2507', 'zai-glm-4.7'],
    vision: [],
  },
  openrouter: {
    base: 'https://openrouter.ai/api/v1',
    match: /openrouter\.ai/,
    text: [], check: [], vision: [], // set LLM_MODEL_n (ids ending in :free)
  },
};
const SLOT_DEFAULT_KIND = { 1: 'gemini', 2: 'groq', 3: 'cerebras', 4: 'openrouter' };
const ROLES = ['text', 'check', 'vision'];
const EFFORT = { text: 'low', check: 'medium', vision: 'low' };

const E = () => process.env;
const num = (k, d) => (E()[k] !== undefined && E()[k] !== '' && !Number.isNaN(Number(E()[k])) ? Number(E()[k]) : d);
const list = (v) => String(v ?? '').split(',').map((s) => s.trim().replace(/^["']|["']$/g, '').trim()).filter(Boolean);
const uniq = (a) => [...new Set(a)];
const cleanBase = (u, fb) => String((u && String(u).trim()) || fb || '').replace(/\/+$/, '');
const kindOf = (base) => Object.entries(KINDS).find(([, v]) => v.match.test(base))?.[0] || 'generic';

// ── State (module-level; reset in tests) ────────────────────────────────────
let providers = null;
let initPromise = null;
const health = new Map();
const lastCallAt = new Map();
const stats = new Map();

export function resetLLM() { providers = null; initPromise = null; health.clear(); lastCallAt.clear(); stats.clear(); }

export function loadProviders() {
  const out = [];
  for (let n = 1; n <= 6; n++) {
    const s = n === 1 ? '' : `_${n}`;
    const key = (E()[`LLM_API_KEY${s}`] || '').trim();
    if (!key) continue;
    const base = cleanBase(E()[`LLM_BASE_URL${s}`], KINDS[SLOT_DEFAULT_KIND[n]]?.base);
    if (!base) { log(`LLM slot ${n}: LLM_BASE_URL${s} is required for this provider; skipping`); continue; }
    const kind = kindOf(base);
    const d = KINDS[kind] || { text: [], check: [], vision: [] };
    const main = list(E()[`LLM_MODEL${s}`]);
    const chk = list(E()[`LLM_CHECK_MODEL${s}`]);
    const vis = list(E()[`LLM_VISION_MODEL${s}`]);
    const models = {
      text: uniq([...main, ...d.text]),
      check: uniq([...chk, ...d.check, ...main]),
      vision: uniq([...vis, ...d.vision]),
    };
    if (!models.text.length) { log(`LLM slot ${n} (${kind}): no models known — set LLM_MODEL${s}; skipping`); continue; }
    out.push({
      id: `p${n}`, slot: n, kind, base, key, models, maxOut: d.maxOut || 0,
      name: E()[`LLM_PROVIDER_NAME${s}`] || (out.some((p) => p.kind === kind) ? `${kind}-${n}` : kind),
      available: null, dead: null, warned: new Set(), roleModels: null,
    });
  }
  return out;
}
export const getProviders = () => providers || loadProviders();

// ── Discovery ───────────────────────────────────────────────────────────────
async function discover(p) {
  try {
    const res = await fetch(`${p.base}/models`, { headers: { Authorization: `Bearer ${p.key}` }, signal: AbortSignal.timeout(15000) });
    if (res.status === 401) { p.dead = 'invalid API key (401)'; log(`[${p.name}] ${p.dead} — provider disabled for this run`); return; }
    if (!res.ok) return;
    const j = await res.json();
    const ids = (j.data || j.models || []).map((m) => String(m.id || m.name || '').replace(/^models\//, '')).filter(Boolean);
    if (ids.length) p.available = new Set(ids);
  } catch (e) { log(`[${p.name}] model discovery skipped: ${e.message}`); }
}

function heuristic(p) {
  const bad = /(embed|whisper|tts|orpheus|image|imagen|veo|lyria|live|audio|guard|moderation|rerank|compound|robotics|computer-use|aqa|transcribe)/i;
  let c = [...p.available].filter((i) => !bad.test(i));
  if (p.kind === 'gemini') c = c.filter((i) => /^gemini-\d/.test(i) && /flash/.test(i) && !/-\d{2}-\d{2,4}$/.test(i));
  if (p.kind === 'groq') c = c.filter((i) => /gpt-oss|qwen|llama/.test(i));
  const ver = (s) => Number((s.match(/(\d+(?:\.\d+)?)/) || [0, 0])[1]);
  return c.sort((a, b) => ver(b) - ver(a) || a.localeCompare(b)).slice(0, 4);
}

function resolveModels(p, role) {
  let l = p.models[role] || [];
  if (p.available) {
    const missing = l.filter((m) => !p.available.has(m));
    for (const m of missing) if (!p.warned.has(m)) { p.warned.add(m); log(`[${p.name}] "${m}" is not offered by this provider — skipping`); }
    l = l.filter((m) => p.available.has(m));
    if (!l.length && role !== 'vision') {
      l = heuristic(p);
      if (l.length) log(`[${p.name}] none of the configured ${role} models exist; auto-selected: ${l.join(', ')}`);
    }
  }
  return l;
}

async function init() {
  if (!initPromise) {
    initPromise = (async () => {
      providers = loadProviders();
      await Promise.all(providers.map(discover));
      for (const p of providers) p.roleModels = Object.fromEntries(ROLES.map((r) => [r, resolveModels(p, r)]));
      const fmt = (r) => providers.filter((p) => !p.dead).flatMap((p) => p.roleModels[r].map((m) => `${p.name}:${m}`)).join(' → ') || '(none)';
      log(`LLM chain  text: ${fmt('text')}`);
      log(`LLM chain  check: ${fmt('check')}`);
      log(`LLM chain  vision: ${fmt('vision')}`);
    })();
  }
  await initPromise;
}

// ── Health ──────────────────────────────────────────────────────────────────
function H(p, m) {
  const k = `${p.id}|${m}`;
  let h = health.get(k);
  if (!h) { h = { until: 0, dead: null, fails: 0, noJson: false, drop: new Set(), noVision: false }; health.set(k, h); }
  return h;
}
function stat(p, m) {
  const k = `${p.name}:${m}`;
  let s = stats.get(k);
  if (!s) { s = { calls: 0, ok: 0, bad: 0 }; stats.set(k, s); }
  return s;
}
export function llmStats() {
  const now = Date.now();
  return [...stats.entries()].map(([model, s]) => ({ model, ...s })).concat(
    [...health.entries()].filter(([, h]) => h.dead || h.until > now).map(([k, h]) => ({ model: k.replace(/^p\d+\|/, ''), note: h.dead ? `dead: ${h.dead}` : `cooling ${Math.ceil((h.until - now) / 1000)}s` })),
  );
}
const backoff = (h) => Math.min(num('LLM_BACKOFF_BASE_MS', 15000) * 2 ** Math.min(h.fails, 4), 120000) * (0.8 + Math.random() * 0.4);

function candidates(role) {
  const now = Date.now();
  const out = [];
  let soonest = Infinity; let alive = false;
  for (const p of providers) {
    if (p.dead) continue;
    for (const m of p.roleModels?.[role] || []) {
      const h = H(p, m);
      if (h.dead || (role === 'vision' && h.noVision)) continue;
      alive = true;
      if (h.until > now) { soonest = Math.min(soonest, h.until); continue; }
      out.push({ p, m, h, key: `${p.id}|${m}` });
    }
  }
  return { out, soonest, alive };
}

export async function hasRole(role) { await init(); return candidates(role).alive; }

async function gate(key) {
  const gap = num('LLM_MIN_INTERVAL_MS', 1500);
  const wait = (lastCallAt.get(key) || 0) + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt.set(key, Date.now());
}

// ── Error classification ────────────────────────────────────────────────────
function parseRetryMs(detail, headers) {
  const ra = Number(headers.get('retry-after'));
  if (ra > 0) return ra * 1000;
  let m = detail.match(/retrydelay"?\s*[:=]\s*"?([\d.]+)s/i) || detail.match(/retry in ([\d.]+)\s*s/i);
  if (m) return Number(m[1]) * 1000;
  m = detail.match(/try again in (?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i);
  if (m && (m[1] || m[2] || m[3])) return (Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) * 1000;
  return 0;
}

function classify(status, detail, headers, c, role) {
  const d = detail.toLowerCase();
  const short = detail.replace(/\s+/g, ' ').slice(0, 160);
  const err = (action, msg, extra = {}) => Object.assign(new Error(`[${c.p.name}/${c.m}] HTTP ${status}: ${msg}`), { action, status, ...extra });

  if (status === 400 || status === 422) {
    if (/response_format|json_object|json mode|json_schema/.test(d) && !c.h.noJson) { c.h.noJson = true; return err('adapt', 'JSON mode rejected → retrying without it'); }
    if (/reasoning|effort/.test(d) && !c.h.drop.has('reasoning_effort')) { c.h.drop.add('reasoning_effort'); return err('adapt', 'reasoning_effort rejected → dropping it'); }
    if (role === 'vision' && /image|vision|multimodal|modalit|content type/.test(d)) { c.h.noVision = true; return err('skip', 'no image input support'); }
    if (/decommission|no longer supported|does not exist|not found|deprecated/.test(d)) return err('dead', short);
    return err('cooldown', short, { ms: 5 * 60000 });
  }
  if (status === 401) return err('provider_dead', 'API key rejected');
  if (status === 403) {
    if (/api.?key|disabled|suspend|billing|credential|not been used|has not been enabled/.test(d)) return err('provider_dead', short);
    return err('dead', short);
  }
  if (status === 404 || status === 410) return err('dead', short);
  if (status === 429 || status === 413) {
    if (/limit:\s*0\b/.test(d)) return err('dead', 'no quota for this model on this tier');
    if (/per ?day|daily|\brpd\b|\btpd\b|requests per day|tokens per day/.test(d)) return err('cooldown', 'daily quota exhausted', { ms: 6 * 3600 * 1000 });
    const ms = parseRetryMs(detail, headers);
    return err('cooldown', 'rate limited', { ms: Math.min(Math.max(ms || backoff(c.h), num('LLM_MIN_COOLDOWN_MS', 2000)), 6 * 3600 * 1000) });
  }
  if (status === 408 || status >= 500) return err('cooldown', `server error ${short}`, { ms: backoff(c.h) });
  return err('cooldown', short, { ms: 2 * 60000 });
}

// ── One HTTP call ───────────────────────────────────────────────────────────
async function callOnce(c, { messages, max, temperature, json, role }) {
  const { p, m, h } = c;
  const body = { model: m, messages, max_tokens: p.maxOut ? Math.min(max, p.maxOut) : max };
  if (!(p.kind === 'gemini' && /^gemini-3/.test(m))) body.temperature = temperature; // Google: keep Gemini 3 at default temperature
  if (json && !h.noJson) body.response_format = { type: 'json_object' };
  if (!h.drop.has('reasoning_effort') && (p.kind === 'gemini' || (/gpt-oss/.test(m) && (p.kind === 'groq' || p.kind === 'cerebras')))) body.reasoning_effort = EFFORT[role] || 'low';

  let res;
  try {
    res = await fetch(`${p.base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${p.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(num('LLM_TIMEOUT_MS', 120000)),
    });
  } catch (e) {
    throw Object.assign(new Error(`[${p.name}/${m}] network: ${e.message}`), { action: 'cooldown', ms: backoff(h) });
  }
  if (!res.ok) throw classify(res.status, (await res.text().catch(() => '')).slice(0, 600), res.headers, c, role);

  const j = await res.json().catch(() => null);
  const ch = j?.choices?.[0];
  let text = ch?.message?.content;
  if (Array.isArray(text)) text = text.map((x) => x?.text || '').join('');
  text = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  return { text, finish: ch?.finish_reason };
}

// ── Public API ──────────────────────────────────────────────────────────────
/**
 * @param {object} o
 * @param {'text'|'check'|'vision'} [o.role]
 * @param {string} o.system
 * @param {string|Array} o.user
 * @param {(text:string)=>any} [o.validate] throw to reject the output (→ next model); return value is exposed as `.value`
 */
export async function chatDetailed({ role = 'text', system, user, max = 4096, temperature = 0.4, json = true, validate, maxAttempts }) {
  await init();
  if (!providers.length) throw new LLMExhaustedError('No LLM providers configured — set the LLM_API_KEY secret');
  const attemptsCap = maxAttempts || num('LLM_MAX_ATTEMPTS', 14);
  const maxWait = num('LLM_MAX_WAIT_MS', 90000);
  const maxWaitTotal = num('LLM_MAX_WAIT_TOTAL_MS', 240000);
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  const tried = new Set();
  const errors = [];
  let curMax = max; let curTemp = temperature; let waited = 0;

  for (let attempt = 1; attempt <= attemptsCap; attempt++) {
    const { out, soonest, alive } = candidates(role);
    if (!out.length) {
      if (!alive) break;
      const wait = soonest - Date.now();
      if (wait <= maxWait && waited + wait <= maxWaitTotal) {
        log(`All ${role} models are cooling down; waiting ${Math.ceil(wait / 1000)}s`);
        await sleep(wait + 250); waited += wait; attempt--; continue;
      }
      break;
    }
    const pick = out.find((x) => !tried.has(x.key)) || out[0];
    await gate(pick.key);
    const s = stat(pick.p, pick.m);
    s.calls++;
    try {
      const r = await callOnce(pick, { messages, max: curMax, temperature: curTemp, json, role });
      if (!r.text) {
        if (r.finish === 'length') curMax = Math.min(Math.ceil(curMax * 1.6), 16000);
        throw Object.assign(new Error(`[${pick.p.name}/${pick.m}] empty response (finish=${r.finish})`), { action: 'bad' });
      }
      if (r.finish === 'length') {
        curMax = Math.min(Math.ceil(curMax * 1.6), 16000);
        throw Object.assign(new Error(`[${pick.p.name}/${pick.m}] output truncated at max_tokens (next try allows ${curMax})`), { action: 'bad' });
      }
      let value;
      if (validate) {
        try { value = validate(r.text); } catch (e) { throw Object.assign(new Error(`[${pick.p.name}/${pick.m}] invalid output: ${String(e.message).slice(0, 140)}`), { action: 'bad' }); }
      }
      s.ok++; pick.h.fails = 0;
      if (errors.length) log(`[${pick.p.name}] ${pick.m} succeeded after ${errors.length} failed attempt(s)`);
      return { text: r.text, value, model: pick.m, provider: pick.p.name };
    } catch (e) {
      errors.push(e.message);
      switch (e.action) {
        case 'adapt': log(e.message); attempt--; break;
        case 'skip': log(e.message); break;
        case 'dead': pick.h.dead = e.message; log(`${e.message} → model disabled for this run`); break;
        case 'provider_dead': pick.p.dead = e.message; log(`${e.message} → provider disabled for this run`); break;
        case 'cooldown': {
          pick.h.fails++; pick.h.until = Date.now() + (e.ms || backoff(pick.h));
          log(`${e.message} → cooling ${pick.m} for ${Math.round((e.ms || 0) / 1000)}s, failing over`);
          break;
        }
        default: { // bad output
          s.bad++; tried.add(pick.key); curTemp = Math.max(0, curTemp * 0.6);
          log(`${e.message} → trying another model`);
        }
      }
    }
  }
  throw new LLMExhaustedError(`All ${role} models failed. ${errors.slice(-4).join(' | ')}`, errors);
}

/** Back-compat: returns the raw text. */
export async function chat(opts) { return (await chatDetailed(opts)).text; }

/** Returns parsed + validated JSON; invalid JSON fails over to another model. */
export async function chatJson({ validate, ...o }) {
  const r = await chatDetailed({
    ...o, json: true,
    validate: (t) => { const j = extractJson(t); const v = validate ? validate(j) : undefined; return v === undefined ? j : v; },
  });
  return r.value;
}

// ── Diagnostics (npm run llm-check) ─────────────────────────────────────────
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
export async function probeAll() {
  await init();
  const rows = [];
  for (const p of providers) {
    if (p.dead) { rows.push({ provider: p.name, model: '*', role: '*', ok: false, note: p.dead }); continue; }
    for (const role of ROLES) {
      for (const m of p.roleModels[role]) {
        const c = { p, m, h: H(p, m), key: `${p.id}|${m}` };
        const user = role === 'vision' ? [{ type: 'image_url', image_url: { url: PIXEL } }, { type: 'text', text: 'Reply with {"ok":true}' }] : 'Reply with {"ok":true}';
        try {
          const r = await callOnce(c, { messages: [{ role: 'system', content: 'Return only JSON.' }, { role: 'user', content: user }], max: 600, temperature: 0, json: true, role });
          rows.push({ provider: p.name, model: m, role, ok: !!r.text, note: r.text ? r.text.slice(0, 40) : `empty (finish=${r.finish})` });
        } catch (e) { rows.push({ provider: p.name, model: m, role, ok: false, note: e.message.replace(/^\[[^\]]+\] /, '').slice(0, 140) }); }
        await sleep(num('LLM_MIN_INTERVAL_MS', 1500));
      }
    }
  }
  return rows;
}
