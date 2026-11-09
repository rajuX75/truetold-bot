import { getJson, UA } from './util.mjs';

async function accessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.BLOGGER_CLIENT_ID,
      client_secret: process.env.BLOGGER_CLIENT_SECRET,
      refresh_token: process.env.BLOGGER_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const j = await res.json();
  if (!res.ok || !j.access_token) throw new Error(`Blogger OAuth failed: ${JSON.stringify(j)}`);
  return j.access_token;
}

export async function insertPost({ title, html, labels, description, draft, published }) {
  const token = await accessToken();
  const blogId = process.env.BLOGGER_BLOG_ID;
  const url = `https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts?isDraft=${draft ? 'true' : 'false'}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({
      kind: 'blogger#post',
      title,
      content: html,
      labels,
      customMetaData: description, // Blogger "search description"
      ...(published ? { published } : {}),
    }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`Blogger insert failed (${res.status}): ${JSON.stringify(j)}`);
  return { id: j.id, url: j.url, status: j.status };
}
