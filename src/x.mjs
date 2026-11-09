import { TwitterApi } from 'twitter-api-v2';

export function buildTweet({ hook, url, hashtags = [] }) {
  const tags = hashtags.join(' ');
  const URL_LEN = 23; // X counts every link as 23 chars
  const reserved = URL_LEN + 2 + (tags ? tags.length + 1 : 0);
  let text = hook.trim();
  const room = 280 - reserved;
  if (text.length > room) text = text.slice(0, room - 1).trimEnd() + '…';
  return `${text}\n${url}${tags ? `\n${tags}` : ''}`;
}

export async function postToX(text) {
  const need = ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET'];
  if (need.some((k) => !process.env[k])) return { skipped: true };
  const client = new TwitterApi({
    appKey: process.env.X_API_KEY,
    appSecret: process.env.X_API_SECRET,
    accessToken: process.env.X_ACCESS_TOKEN,
    accessSecret: process.env.X_ACCESS_SECRET,
  });
  const r = await client.v2.tweet(text);
  return { id: r.data.id };
}
