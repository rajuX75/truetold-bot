// Offline tests of the X client: OAuth signing vector, tweet sizing, media fallbacks, retries, error kinds.
import http from 'node:http';
import assert from 'node:assert/strict';

process.env.X_RETRY_BASE_MS = '1';
process.env.X_MAX_WAIT_MS = '3000';
delete process.env.X_LINK_MODE;
delete process.env.X_ATTACH_IMAGE;
Object.assign(process.env, { X_API_KEY: 'ck', X_API_SECRET: 'cs', X_ACCESS_TOKEN: 'at', X_ACCESS_SECRET: 'as' });

let behavior = () => ({});
let calls = [];
const server = http.createServer((req, res) => {
  const chunks = []; req.on('data', (d) => chunks.push(d));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const call = { method: req.method, url: req.url, auth: req.headers.authorization, ctype: req.headers['content-type'] || '', raw };
    if (call.ctype.includes('json')) call.json = JSON.parse(raw.toString() || '{}');
    calls.push(call);
    const r = behavior(call, calls.length) || {};
    res.writeHead(r.status || 200, { 'content-type': 'application/json', ...(r.headers || {}) });
    res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {}));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.X_API_BASE = `http://127.0.0.1:${server.address().port}`;
process.env.X_UPLOAD_V1_URL = `http://127.0.0.1:${server.address().port}/1.1/media/upload.json`;

const { oauth1Header, buildTweet, weightedLength, postToX, uploadImage, XError, xConfigured } = await import('../src/x.mjs');
const img = Buffer.from('fake-jpeg-bytes');
const paths = () => calls.map((c) => `${c.method} ${c.url.split('?')[0]}`);
const reset = () => { calls = []; behavior = () => ({}); };
const tweetOk = (id = '111') => ({ status: 201, body: { data: { id, text: 'x' } } });

// 1) OAuth 1.0a signature matches the reference example from the official docs
const h = oauth1Header({
  method: 'POST', url: 'https://api.twitter.com/1.1/statuses/update.json?include_entities=true',
  params: { status: 'Hello Ladies + Gentlemen, a signed OAuth request!' },
  creds: { appKey: 'xvz1evFS4wEEPTGEFPHBog', appSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw', accessToken: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb', accessSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE' },
  nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg', timestamp: '1318622958',
});
assert.equal(decodeURIComponent(h.match(/oauth_signature="([^"]+)"/)[1]), 'hCtSmYh+iHYCEqBWrE7C7hYmtUk=');

// 2) tweet sizing the way X counts
assert.equal(weightedLength('https://example.com/some/very/long/path/that/is/not/23/chars'), 23);
assert.equal(weightedLength('→'), 2);
for (const hook of ['x'.repeat(400), 'é'.repeat(400), '日本語'.repeat(120), '🔥'.repeat(150)]) {
  const t = buildTweet({ hook, url: 'https://example.blogspot.com/2026/11/a.html', hashtags: ['#TrueStory', '#History'], linkMode: 'inline' });
  assert.ok(weightedLength(t) <= 280, `too long: ${weightedLength(t)}`);
  assert.match(t, /→ Continue Reading\nhttps:\/\/example\.blogspot\.com\/2026\/11\/a\.html\n#TrueStory #History$/);
}
const none = buildTweet({ hook: 'Short hook', url: 'https://e.com/a', hashtags: ['#A'], linkMode: 'none' });
assert.equal(none, 'Short hook\n#A', 'X_LINK_MODE=none posts without the (expensive) link');

// 3) happy path: v2 chunked upload (initialize → append → finalize) then post with media
reset();
behavior = (c) => (c.url.endsWith('/initialize') ? { body: { data: { id: '999' } } } : c.url.endsWith('/finalize') ? { body: { data: { id: '999' } } } : c.url.endsWith('/append') ? { status: 200, body: {} } : tweetOk());
let r = await postToX('hello');
assert.deepEqual(paths(), ['POST /2/tweets'], 'no image → only the tweet');
reset();
behavior = (c) => (c.url.endsWith('/initialize') ? { body: { data: { id: '999' } } } : c.url.endsWith('/finalize') ? { body: { data: { id: '999' } } } : c.url.endsWith('/append') ? { body: {} } : tweetOk('222'));
r = await postToX('hello', { imageBuffer: img });
assert.deepEqual(paths(), ['POST /2/media/upload/initialize', 'POST /2/media/upload/999/append', 'POST /2/media/upload/999/finalize', 'POST /2/tweets']);
assert.equal(r.id, '222'); assert.equal(r.withImage, true); assert.equal(r.mediaVia, 'v2-chunked');
assert.deepEqual(calls[0].json, { media_type: 'image/jpeg', total_bytes: img.length, media_category: 'tweet_image' });
assert.deepEqual(calls.at(-1).json, { text: 'hello', media: { media_ids: ['999'] } });
assert.match(calls[1].ctype, /multipart\/form-data/);
assert.ok(calls.every((c) => /^OAuth /.test(c.auth)), 'every call is OAuth1-signed');

// 4) chunked path forbidden → falls back to the one-shot v2 endpoint
reset();
behavior = (c) => (c.url.endsWith('/initialize') ? { status: 403, body: { title: 'Forbidden', detail: 'OAuth1 not allowed for this endpoint' } } : c.url === '/2/media/upload' ? { body: { data: { id: '555' } } } : tweetOk());
r = await postToX('hello', { imageBuffer: img });
assert.equal(r.mediaVia, 'v2-simple'); assert.deepEqual(calls.at(-1).json.media, { media_ids: ['555'] });

// 5) every media path broken → still posts (text-only)
reset();
behavior = (c) => (c.url.includes('/media') || c.url.includes('/1.1/') ? { status: 500, body: 'down' } : tweetOk());
r = await postToX('hello', { imageBuffer: img });
assert.equal(r.withImage, false); assert.equal(calls.at(-1).json.media, undefined);

// 6) post retried on 5xx; then on 429 (x-rate-limit-reset); then success
reset();
behavior = (c, n) => (n === 1 ? { status: 503, body: 'busy' } : n === 2 ? { status: 429, headers: { 'x-rate-limit-reset': String(Math.ceil(Date.now() / 1000) + 1) }, body: { title: 'Too Many Requests' } } : tweetOk('333'));
r = await postToX('hello');
assert.equal(r.id, '333'); assert.equal(calls.length, 3);

// 7) account-level errors are classified, not retried, and carry a fix
const kinds = [
  [401, { title: 'Unauthorized' }, 'auth'],
  [402, { title: 'CreditsDepleted', detail: 'Your enrolled account does not have any credits', type: 'https://api.twitter.com/2/problems/credits' }, 'credits'],
  [403, { title: 'Forbidden', detail: 'client-not-enrolled: app must be in a pay-per-use package' }, 'enrollment'],
  [403, { title: 'Forbidden', detail: 'Your client app is not configured with the appropriate oauth1 app permissions for this endpoint' }, 'permissions'],
  [403, { title: 'Forbidden', detail: 'You are not allowed to create a Post with duplicate content.' }, 'duplicate'],
];
for (const [status, body, kind] of kinds) {
  reset(); behavior = () => ({ status, body });
  await assert.rejects(() => postToX('hello'), (e) => e instanceof XError && e.kind === kind && calls.length === 1, `${status} → ${kind}`);
}
reset(); behavior = () => ({ status: 402, body: { title: 'CreditsDepleted' } });
await assert.rejects(() => uploadImage(img), (e) => e.kind === 'credits' && e.blocking && calls.length === 1, 'credits error stops media fallbacks immediately');

// 8) media id rejected at post time → retried text-only (post must not be lost)
reset();
let first = true;
behavior = (c) => (c.url.endsWith('/initialize') ? { body: { data: { id: '7' } } } : c.url.endsWith('/finalize') ? { body: { data: { id: '7' } } } : c.url.endsWith('/append') ? { body: {} } : c.url === '/2/tweets' && first ? ((first = false), { status: 400, body: { detail: 'Invalid media id' } }) : tweetOk('444'));
r = await postToX('hello', { imageBuffer: img });
assert.equal(r.id, '444'); assert.equal(r.withImage, false);

// 9) credentials missing → skipped, not an error
for (const k of ['X_API_KEY']) delete process.env[k];
assert.equal(xConfigured(), false);
assert.equal((await postToX('hello')).skipped, true);

server.close();
console.log('x client tests passed');
