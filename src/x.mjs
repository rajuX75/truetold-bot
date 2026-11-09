import { TwitterApi } from 'twitter-api-v2';

const CREDS_KEYS = ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET'];
const hasCreds = () => !CREDS_KEYS.some((k) => !process.env[k]);

/** Build the tweet text: hook + "Continue Reading" CTA + hashtags.
 *  The blog URL is a bare link so X cards expand it.
 *
 * @param {object} opts
 * @param {string} opts.hook       - Factual one-liner teaser (≤180 chars from LLM)
 * @param {string} opts.url        - Published Blogger post URL
 * @param {string[]} opts.hashtags - Config hashtags array
 * @returns {string} Full tweet text ≤280 Twitter-counted chars
 */
export function buildTweet({ hook, url, hashtags = [] }) {
  const tags = hashtags.join(' ');
  const CTA = '→ Continue Reading';
  // X counts every URL as 23 chars regardless of actual length
  const URL_LEN = 23;
  const ctaLine = `\n${CTA}\n`;
  const tagsLine = tags ? `\n${tags}` : '';
  const reserved = ctaLine.length + URL_LEN + tagsLine.length;
  const room = 280 - reserved;
  let text = hook.trim();
  if (text.length > room) text = text.slice(0, room - 1).trimEnd() + '…';
  return `${text}${ctaLine}${url}${tagsLine}`;
}

/** Post to X (Twitter) with an optional OG image attached as media.
 *
 * @param {string} text          - Tweet text from buildTweet()
 * @param {object} [opts]
 * @param {Buffer} [opts.imageBuffer] - JPEG buffer of the OG image (1200×630)
 * @returns {{ id: string } | { skipped: true, reason: string }}
 */
export async function postToX(text, { imageBuffer } = {}) {
  if (!hasCreds()) {
    return { skipped: true, reason: 'X credentials not configured (X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_SECRET missing from secrets)' };
  }

  const client = new TwitterApi({
    appKey: process.env.X_API_KEY,
    appSecret: process.env.X_API_SECRET,
    accessToken: process.env.X_ACCESS_TOKEN,
    accessSecret: process.env.X_ACCESS_SECRET,
  });

  let mediaId;
  if (imageBuffer) {
    try {
      mediaId = await client.v2.uploadMedia(imageBuffer, {
        media_type: 'image/jpeg',
        media_category: 'tweet_image',
      });
    } catch (e) {
      // Surface 401 clearly so it's obvious the creds are wrong, not the code
      if (e.code === 401 || (e.message && e.message.includes('401'))) {
        throw new Error(
          'X API 401 Unauthorized — your X credentials in GitHub Secrets are invalid or expired.\n' +
          'Fix: go to GitHub → Settings → Secrets → update X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET.\n' +
          'Make sure your X app has "Read and Write" permissions and the tokens were regenerated AFTER changing permissions.'
        );
      }
      // Any other error: fall back to text-only tweet
      console.warn('X media upload failed (non-fatal, posting text-only):', e.message);
    }
  }

  const payload = mediaId ? { media: { media_ids: [mediaId] } } : {};
  const r = await client.v2.tweet(text, payload);
  return { id: r.data.id, withImage: !!mediaId };
}
