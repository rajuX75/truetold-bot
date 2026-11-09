// Offline test of the LLM client against a fake OpenAI-compatible server.
import http from 'node:http';
import assert from 'node:assert/strict';

process.env.LLM_MIN_INTERVAL_MS = '0';
process.env.LLM_API_KEY = 'test-key';
const calls = [];
const server = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => (b += d));
  req.on('end', () => {
    const body = JSON.parse(b); calls.push({ url: req.url, auth: req.headers.authorization, body });
    const n = calls.length;
    if (n === 1) { res.writeHead(429, { 'retry-after': '0' }); return res.end('slow down'); }
    if (n === 2 && body.response_format) { res.writeHead(400); return res.end('response_format unsupported'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '```json\n{"ok":true,"alt":"a photo"}\n```' } }] }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.LLM_BASE_URL = `http://127.0.0.1:${server.address().port}/v1beta/openai/`;
const { chat } = await import('../src/llm.mjs');
const { vetImage } = await import('../src/write.mjs');

const out = await chat({ model: 'm', system: 's', user: 'u' });
assert.match(out, /"ok":true/);
assert.equal(calls[0].url, '/v1beta/openai/chat/completions');
assert.equal(calls[0].auth, 'Bearer test-key');
assert.ok(calls[0].body.response_format, 'first try uses JSON mode');
assert.equal(calls.at(-1).body.response_format, undefined, 'falls back without JSON mode');

calls.length = 10; // vision request shape
const v = await vetImage({ title: 't', summary: 's', fileTitle: 'File:X.jpg', fileDescription: 'd', jpegBuffer: Buffer.from('abc') });
assert.equal(v.ok, true);
const last = calls.at(-1).body.messages[1].content;
assert.equal(last[0].type, 'image_url');
assert.match(last[0].image_url.url, /^data:image\/jpeg;base64,/);
server.close();
console.log('llm client tests passed');
