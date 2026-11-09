import { TwitterApi } from 'twitter-api-v2';

const CREDS_KEYS = ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET'];
const hasCreds = () => !CREDS_KEYS.some((k) => !process.env[k]);

/** Build the tweet text: hook + "Continue Reading" CTA + hashtags.
 *  The blog URL is included as a bare link on its own line so X cards
 *  expand it. A "→ Continue Reading" label sits right before the link.
 *
 * @param {object} opts
 * @param {string} opts.hook    - Factual one-liner teaser (≤180 chars from LLM)
 * @param {string} opts.url     - Published Blogger post URL
 * @param {string[]} opts.hashtags - Config hashtags array
 * @returns {string} Full tweet text ≤280 Twitter-counted chars
 */
export function buildTweet({ hook, url, hashtags = [] }) {
  const tags = hashtags.join(' ');
  const CTA = '→ Continue Reading';
  // X counts every URL as 23 chars regardless of actual length
  const URL_LEN = 23;
  // Reserve space for: "\n{CTA}\n{url}" + optional "\n{tags}"
  const ctaLine = `\n${CTA}\n`;
  const tagsLine = tags ? `\n${tags}` : '';
  const reserved = ctaLine.length + URL_LEN + tagsLine.length;
  const room = 280 - reserved;
  let text = hook.trim();
  if (text.length > room) text = text.slice(0, room - 1).trimEnd() + '…';
  return `${text}${ctaLine}${url}${tagsLine}`;
}

/** Post to X with an optional OG image attached as media.
 *
 * @param {string} text          - Tweet text from buildTweet()
 * @param {object} [opts]
 * @param {Buffer} [opts.imageBuffer] - JPEG buffer of the OG image (1200×630)
 * @returns {{ id: string } | { skipped: true }}
 */
export async function postToX(text, { imageBuffer } = {}) {
  if (!hasCreds()) return { skipped: true };

  const client = new TwitterApi({
    appKey: process.env.X_API_KEY,
    appSecret: process.env.X_API_SECRET,
    accessToken: process.env.X_ACCESS_TOKEN,
    accessSecret: process.env.X_ACCESS_SECRET,
  });

  let mediaId;
  if (imageBuffer) {
    try {
      // twitter-api-v2 v2.uploadMedia accepts a Buffer + media_type
      mediaId = await client.v2.uploadMedia(imageBuffer, {
        media_type: 'image/jpeg',
        media_category: 'tweet_image',
      });
    } catch (e) {
      // Non-fatal: fall back to text-only tweet if media upload fails
      console.error('X media upload failed (non-fatal), posting text-only:', e.message);
    }
  }

  const payload = mediaId ? { media: { media_ids: [mediaId] } } : {};
  const r = await client.v2.tweet(text, payload);
  return { id: r.data.id };
}
