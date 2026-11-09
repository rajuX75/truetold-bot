// One-time helper: run locally to obtain BLOGGER_REFRESH_TOKEN.
//   BLOGGER_CLIENT_ID=... BLOGGER_CLIENT_SECRET=... node scripts/get-blogger-token.mjs
import http from 'node:http';
const id = process.env.BLOGGER_CLIENT_ID, secret = process.env.BLOGGER_CLIENT_SECRET;
if (!id || !secret) { console.error('Set BLOGGER_CLIENT_ID and BLOGGER_CLIENT_SECRET first.'); process.exit(1); }
const PORT = 53682, redirect = `http://127.0.0.1:${PORT}`;
const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: id, redirect_uri: redirect, response_type: 'code',
  scope: 'https://www.googleapis.com/auth/blogger', access_type: 'offline', prompt: 'consent',
});
console.log('\nOpen this URL in your browser and approve access:\n\n' + authUrl + '\n');
http.createServer(async (req, res) => {
  const code = new URL(req.url, redirect).searchParams.get('code');
  if (!code) { res.end('Waiting…'); return; }
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: id, client_secret: secret, redirect_uri: redirect, grant_type: 'authorization_code' }),
  });
  const j = await r.json();
  res.end(j.refresh_token ? 'Done. Return to the terminal.' : 'No refresh token returned. See terminal.');
  console.log(j.refresh_token ? `\nBLOGGER_REFRESH_TOKEN=${j.refresh_token}\n` : j);
  process.exit(0);
}).listen(PORT, '127.0.0.1');
