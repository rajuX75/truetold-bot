// Offline tests of the LLM client against a fake OpenAI-compatible server.
import http from 'node:http';
import assert from 'node:assert/strict';

process.env.LLM_MIN_INTERVAL_MS = '0';
process.env.LLM_MAX_WAIT_MS = '50';
process.env.LLM_MAX_WAIT_TOTAL_MS = '100';
process.env.LLM_BACKOFF_BASE_MS = '5';
process.env.LLM_MIN_COOLDOWN_MS = '1';

let behavior = () => ({});          // (req, body) => { status, body, headers }
let calls = [];                      // chat calls only
const OFFERED = ['m-b', 'm-c', 'p2-a', 'gemini-3.9-flash'];

const server = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => (b += d));
  req.on('end', () => {
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: OFFERED.map((id) => ({ id: `models/${id}` })) }));
    }
    const body = JSON.parse(b);
    const call = { url: req.url, auth: req.headers.authorization, body };
    calls.push(call);
    const r = behavior(call, calls.length) || {};
    res.writeHead(r.status || 200, { 'content-type': 'application/json', ...(r.headers || {}) });
    if (r.raw !== undefined) return res.end(r.raw);
    res.end(JSON.stringify({ choices: [{ message: { content: r.content ?? '{"ok":true}' }, finish_reason: r.finish || 'stop' }] }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const llm = await import('../src/llm.mjs');
async function fresh(extra = {}) {
  llm.resetLLM(); calls = []; behavior = () => ({});
  for (const k of Object.keys(process.env)) if (/^LLM_(API_KEY|BASE_URL|MODEL|VISION_MODEL|CHECK_MODEL|PROVIDER_NAME)/.test(k)) delete process.env[k];
  delete process.env.FACTCHECK_STRICT;
  delete process.env.MAX_CANDIDATES;
  Object.assign(process.env, {
    LLM_API_KEY: 'k1', LLM_BASE_URL: `http://127.0.0.1:${port}/v1`, LLM_MODEL: 'm-a,m-b,m-c',
    LLM_API_KEY_2: 'k2', LLM_BASE_URL_2: `http://127.0.0.1:${port}/p2`, LLM_MODEL_2: 'p2-a',
    ...extra,
  });
}
const models = () => calls.map((c) => c.body.model);
const sys = { system: 's', user: 'u' };

// 1) discovery skips models the provider does not offer (m-a is retired) — and uses the right URL/auth
await fresh();
let out = await llm.chat({ ...sys });
assert.match(out, /"ok":true/);
assert.equal(calls[0].url, '/v1/chat/completions');
assert.equal(calls[0].auth, 'Bearer k1');
assert.equal(calls[0].body.model, 'm-b', 'retired/unknown m-a must be skipped via /models discovery');
assert.ok(calls[0].body.response_format, 'JSON mode is requested first');

// 2) JSON mode rejected → remembered and retried on the SAME model without it
await fresh();
behavior = (c) => (c.body.response_format ? { status: 400, raw: 'response_format json_object unsupported' } : {});
await llm.chat({ ...sys });
assert.deepEqual(models(), ['m-b', 'm-b']);
assert.equal(calls[1].body.response_format, undefined);
await llm.chat({ ...sys });
assert.equal(calls[2].body.response_format, undefined, 'rejection is remembered for later calls');

// 3) daily quota on m-b → immediate failover to m-c, and m-b is NOT retried by later calls
await fresh();
behavior = (c) => (c.body.model === 'm-b' ? { status: 429, raw: '{"error":{"message":"Quota exceeded: GenerateRequestsPerDayPerProjectPerModel-FreeTier"}}' } : {});
await llm.chat({ ...sys });
assert.deepEqual(models(), ['m-b', 'm-c']);
await llm.chat({ ...sys });
assert.deepEqual(models().slice(2), ['m-c'], 'model with exhausted daily quota is skipped');

// 4) invalid JSON from every Google-side model → fails over across models AND to provider 2
await fresh();
behavior = (c) => (c.body.model === 'p2-a' ? { content: '```json\n{"title":"fine"}\n```' } : { content: 'Sure! Here is a story…' });
const j = await llm.chatJson({ ...sys, validate: (v) => { if (!v.title) throw new Error('no title'); } });
assert.equal(j.title, 'fine');
assert.deepEqual(models(), ['m-b', 'm-c', 'p2-a'], 'bad output is never retried on the same model first');

// 5) truncated output (finish_reason=length) → retried with a larger max_tokens
await fresh();
behavior = (c, n) => (n === 1 ? { finish: 'length', content: '{"a":' } : {});
await llm.chatJson({ ...sys, max: 1000 });
assert.ok(calls[1].body.max_tokens > calls[0].body.max_tokens, `max_tokens must grow (${calls[0].body.max_tokens} → ${calls[1].body.max_tokens})`);

// 6) model_not_found / decommissioned → model permanently disabled for the run
await fresh();
behavior = (c) => (c.body.model === 'm-b' ? { status: 404, raw: '{"error":{"code":"model_not_found","message":"The model m-b does not exist"}}' } : {});
await llm.chat({ ...sys });
await llm.chat({ ...sys });
assert.deepEqual(models(), ['m-b', 'm-c', 'm-c']);

// 7) rejected key on provider 1 → provider disabled, provider 2 answers
await fresh();
behavior = (c) => (c.auth === 'Bearer k1' ? { status: 401, raw: 'invalid key' } : {});
await llm.chat({ ...sys });
assert.equal(calls.at(-1).body.model, 'p2-a');
await llm.chat({ ...sys });
assert.equal(calls.filter((c) => c.auth === 'Bearer k1').length, 1, 'dead provider is not contacted again');

// 8) short rate limit on the only model → client waits for the cooldown instead of failing
await fresh({ LLM_MODEL: 'm-b', LLM_API_KEY_2: '' });
behavior = (c, n) => (n === 1 ? { status: 429, raw: 'slow down', headers: { 'retry-after': '0.01' } } : {});
await llm.chat({ ...sys });
assert.equal(calls.length, 2);

// 9) everything down → LLMExhaustedError (run.mjs uses it to stop burning quota)
await fresh();
behavior = () => ({ status: 500, raw: 'boom' });
await assert.rejects(() => llm.chat({ ...sys, maxAttempts: 6 }), (e) => e instanceof llm.LLMExhaustedError);

// 10) Gemini 3 models: temperature omitted, reasoning_effort sent; dropped automatically if rejected
await fresh({ LLM_BASE_URL: `http://127.0.0.1:${port}/generativelanguage.googleapis.com/v1beta/openai`, LLM_MODEL: 'gemini-3.9-flash', LLM_API_KEY_2: '' });
behavior = (c) => (c.body.reasoning_effort ? { status: 400, raw: 'Unknown field reasoning_effort' } : {});
await llm.chat({ ...sys, temperature: 0 });
assert.equal(calls[0].body.temperature, undefined, 'Gemini 3 keeps its default temperature');
assert.equal(calls[0].body.reasoning_effort, 'low');
assert.equal(calls[1].body.reasoning_effort, undefined, 'reasoning_effort dropped after rejection');

// 11) writer / fact-check / vision through the public API
await fresh({ LLM_VISION_MODEL: 'm-b' });
const { validateStory, factCheck, vetImage } = await import('../src/write.mjs');
const para = 'word '.repeat(60).trim();
const story = { title: 'T', category: 'Nope', takeaways: ['a'], sections: [{ heading: 'H', paragraphs: [para, para, para] }, { heading: 'H2', paragraphs: [para, para, para, para] }] };
const v = validateStory(structuredClone(story), ['History', 'Survival']);
assert.equal(v.category, 'History'); assert.ok(v.tweetHook && v.description && Array.isArray(v.tags));
assert.throws(() => validateStory({ ...story, sections: [story.sections[0]] }, ['History']), /2 sections/);
assert.throws(() => validateStory({ ...story, sections: story.sections.map((s) => ({ ...s, paragraphs: ['short'] })) }, ['History']), /too short/);

delete process.env.FACTCHECK_STRICT;
const article = { text: 'source' };
behavior = () => ({ content: JSON.stringify({ pass: false, issues: [{ claim: 'tone', severity: 'minor', why: 'paraphrase' }] }) });
assert.equal((await factCheck({ article, story: v })).pass, true, 'minor-only findings do not fail the story');
behavior = () => ({ content: JSON.stringify({ pass: false, issues: [{ claim: 'killed 500', severity: 'major', why: 'not in source' }] }) });
const bad = await factCheck({ article, story: v });
assert.equal(bad.pass, false); assert.match(bad.issues[0], /killed 500/);
process.env.FACTCHECK_STRICT = 'true';
behavior = () => ({ content: JSON.stringify({ pass: true, issues: [{ claim: 'x', severity: 'minor' }] }) });
assert.equal((await factCheck({ article, story: v })).pass, false, 'FACTCHECK_STRICT=true fails on any issue');
delete process.env.FACTCHECK_STRICT;

behavior = () => ({ content: '{"ok":true,"alt":"a photo","caption":"c","reason":"r"}' });
const vi = await vetImage({ title: 't', summary: 's', fileTitle: 'File:X.jpg', fileDescription: 'd', jpegBuffer: Buffer.from('abc') });
assert.equal(vi.ok, true);
const content = calls.at(-1).body.messages[1].content;
assert.equal(content[0].type, 'image_url');
assert.match(content[0].image_url.url, /^data:image\/jpeg;base64,/);

// vision unavailable → metadata-only fallback instead of failing the story
await fresh({ LLM_VISION_MODEL: '' });
behavior = () => ({ content: '{"ok":true,"alt":"a photo","caption":"c","reason":"r"}' });
const vm = await vetImage({ title: 't', summary: 's', fileTitle: 'File:X.jpg', fileDescription: 'd', jpegBuffer: Buffer.from('abc') });
assert.equal(vm.ok, true);
assert.equal(typeof calls.at(-1).body.messages[1].content, 'string', 'no image sent when no vision model exists');

server.close();
console.log('llm client tests passed');
