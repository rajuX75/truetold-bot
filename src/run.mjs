import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { log, getBuffer, slugify, sleep } from './util.mjs';
import { getCandidates, getArticle, getImageCandidates } from './sources.mjs';
import { writeStory, factCheck, vetImage } from './write.mjs';
import { processImage, previewJpeg } from './images.mjs';
import { renderPost } from './render.mjs';
import { insertPost } from './blogger.mjs';
import { buildTweet, postToX, xConfigured, explainXError, XError } from './x.mjs';
import { LLMExhaustedError, llmStats } from './llm.mjs';

const cfg = JSON.parse(await fs.readFile('config.json', 'utf8'));
const DRY = process.env.DRY_RUN === 'true';
const DRAFT = process.env.PUBLISH_AS_DRAFT === 'true';
const STATE_FILE = 'state/published.json';

const [owner, repo] = (process.env.GITHUB_REPOSITORY || 'owner/repo').split('/');
const IMAGE_BASE =
  (process.env.IMAGE_BASE_URL || `https://${owner}.github.io${repo.toLowerCase() === `${owner.toLowerCase()}.github.io` ? '' : `/${repo}`}`).replace(/\/$/, '') + '/img';

const state = JSON.parse(await fs.readFile(STATE_FILE, 'utf8').catch(() => '{"stories":[],"days":{}}'));
state.xQueue ||= []; // tweets that could not be sent yet (no credits, rate limit, outage) — retried every run
const MAX_CANDIDATES = Number(process.env.MAX_CANDIDATES || 4);
const X_QUEUE_MAX_AGE_MS = 72 * 3600 * 1000;
const now = new Date();
const today = now.toISOString().slice(0, 10);
const doneToday = state.days[today] || 0;

const capReached = !process.env.FORCE && doneToday >= cfg.storiesPerDay;

function git(...a) { return execFileSync('git', a, { stdio: 'inherit' }); }
function commitPush(message) {
  if (DRY || !process.env.GITHUB_ACTIONS) return;
  git('config', 'user.name', 'truetold-bot');
  git('config', 'user.email', 'truetold-bot@users.noreply.github.com');
  git('add', 'docs/img', 'state');
  try { execFileSync('git', ['diff', '--cached', '--quiet']); return; } catch { /* has changes */ }
  git('commit', '-m', message);
  for (let i = 0; i < 3; i++) {
    try { git('push'); return; } catch { git('pull', '--rebase'); }
  }
  throw new Error('git push failed');
}

async function waitForUrl(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url, { method: 'HEAD' }); if (r.ok) return true; } catch { /* retry */ }
    await sleep(10000);
  }
  return false;
}


const gh = (level, title, msg) => console.log(`::${level} title=${title}::${String(msg).replace(/\r?\n/g, ' ')}`);
let xBlocked = null; // set when X rejects us for an account-level reason; stops hammering the API this run

/** Try to tweet one item. Returns 'sent' | 'drop' | 'queue'. Never throws. */
async function tweetItem(item) {
  if (!xConfigured()) { log('X: skipped - credentials not configured'); return 'drop'; }
  if (xBlocked) return 'queue';
  try {
    const tweet = buildTweet({ hook: item.hook, url: item.url, hashtags: cfg.xHashtags });
    const imageBuffer = item.ogFile ? await fs.readFile(item.ogFile).catch(() => undefined) : undefined;
    const r = await postToX(tweet, { imageBuffer });
    if (r.skipped) { log('X: skipped -', r.reason); return 'drop'; }
    log(`X: posted ${r.id}${r.withImage ? ` (with image via ${r.mediaVia})` : ' (text-only)'}`);
    item.xId = r.id;
    return 'sent';
  } catch (e) {
    item.attempts = (item.attempts || 0) + 1;
    item.lastError = String(e.message).slice(0, 200);
    if (e instanceof XError) {
      if (e.kind === 'duplicate') { log('X: already posted (duplicate rejected by X) - marking done'); return 'sent'; }
      if (e.kind === 'invalid') { log(`X: post rejected permanently (${e.message}) - dropping`); return 'drop'; }
      if (e.blocking) { xBlocked = e; gh('warning', 'X posting blocked', `${e.message} :: ${explainXError(e)}`); log('X BLOCKED:', e.message, '\n   ->', explainXError(e)); }
      else log(`X: ${e.kind} - will retry next run (${e.message})`);
    } else log(`X: unexpected error - will retry next run (${e.message})`);
    return 'queue';
  }
}

async function flushXQueue() {
  if (DRY || DRAFT || !state.xQueue.length) return;
  log(`X queue: ${state.xQueue.length} pending tweet(s)`);
  const keep = [];
  for (const item of state.xQueue) {
    if (Date.now() - Date.parse(item.queuedAt) > X_QUEUE_MAX_AGE_MS || (item.attempts || 0) >= 8) { log('X queue: dropping stale item', item.url); continue; }
    const r = await tweetItem(item);
    if (r === 'queue') keep.push(item);
  }
  state.xQueue = keep;
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
  commitPush('state: x queue');
}

async function buildOne(candidate) {
  const article = await getArticle(candidate.title);
  if (article.text.length < 1500) throw new Error('Source article too short to be reliable');

  // 1) Write + independent fact-check (one corrective retry, otherwise skip the story)
  let story = await writeStory({ article, candidate, categories: cfg.categories, today });
  let check = await factCheck({ article, story });
  if (!check.pass) {
    log('Fact-check issues:', check.issues);
    story = await writeStory({ article, candidate, categories: cfg.categories, today, feedback: check.issues.join('\n') });
    check = await factCheck({ article, story });
    if (!check.pass) throw new Error('Failed fact-check twice: ' + check.issues.join(' | '));
  }

  // 2) Pick a licensed image that a vision check agrees with
  const summary = story.takeaways.join(' ');
  const imgs = await getImageCandidates(candidate.title, cfg.image.minSourceWidth);
  let chosen = null;
  for (const c of imgs) {
    try {
      const buf = await getBuffer(c.url);
      const v = await vetImage({ title: story.title, summary, fileTitle: c.fileTitle, fileDescription: c.description, jpegBuffer: await previewJpeg(buf) });
      if (v.ok) { chosen = { c, buf, alt: v.alt, caption: v.caption }; break; }
      log(`Image rejected (${c.fileTitle}): ${v.reason}`);
    } catch (e) { log('Image candidate failed:', e.message); }
  }
  if (!chosen) throw new Error('No suitable licensed image');

  // 3) Process image, render HTML
  const slug = slugify(story.slug || story.title);
  const img = await processImage({ buffer: chosen.buf, slug, date: now, widths: cfg.image.widths, baseUrl: IMAGE_BASE });
  const html = renderPost({
    story, img, imageMeta: chosen.c, alt: chosen.alt, caption: chosen.caption,
    article, siteName: cfg.siteName, sizes: cfg.image.sizes, datePublished: now.toISOString(),
  });
  return { story, img, html, article, slug };
}

let made = 0;
let tried = 0;
await flushXQueue();
if (capReached) {
  log(`Daily cap reached (${doneToday}/${cfg.storiesPerDay}). Nothing more to publish.`);
  process.exit(0);
}
const candidates = await getCandidates(now, state.stories.map((s) => s.page));
log(`${candidates.length} candidate stories for today`);

for (const cand of candidates) {
  if (made >= cfg.storiesPerRun) break;
  if (tried >= MAX_CANDIDATES) { log(`Reached MAX_CANDIDATES (${MAX_CANDIDATES}) - stopping to protect API quota.`); break; }
  tried++;
  try {
    log('Building:', cand.title);
    const { story, img, html, article } = await buildOne(cand);

    if (DRY) {
      await fs.mkdir('out', { recursive: true });
      await fs.writeFile(`out/${img.probeUrl.split('/').pop().replace('.jpg', '')}.html`, html);
      log('DRY RUN: wrote preview to out/, skipping commit/publish/tweet. Title:', story.title);
      made++; continue;
    }

    // Images must be live on GitHub Pages BEFORE the post references them.
    commitPush(`images: ${story.title}`);
    if (process.env.GITHUB_ACTIONS && !(await waitForUrl(img.probeUrl))) throw new Error('Images did not go live on Pages in time');

    const post = await insertPost({
      title: story.title, html, labels: [story.category, ...story.tags].slice(0, 5),
      description: story.description, draft: DRAFT,
    });
    log('Blogger:', post.status, post.url);

    state.stories.push({ page: cand.title, title: story.title, url: post.url, date: today });
    state.days[today] = (state.days[today] || 0) + 1;
    made++;

    if (!DRAFT) {
      const ogFile = img.files.find((f) => f.includes('-og-'));
      const item = { title: story.title, url: post.url, hook: story.tweetHook, ogFile, queuedAt: new Date().toISOString(), attempts: 0 };
      const r = await tweetItem(item);
      const rec = state.stories[state.stories.length - 1];
      if (r === 'sent') rec.xId = item.xId;
      else if (r === 'queue') { state.xQueue.push(item); log('X: tweet queued for the next run'); }
    }
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
    commitPush(`state: ${today} ${state.days[today]}/${cfg.storiesPerDay}`);
  } catch (e) {
    log(`Skipped "${cand.title}":`, e.message);
    if (e instanceof LLMExhaustedError) {
      gh('error', 'All AI models unavailable', e.message);
      log('All LLM models are exhausted/cooling down - other candidates would fail the same way, stopping this run.');
      break;
    }
  }
}
for (const s of llmStats()) log('LLM', s.model, s.note || `calls=${s.calls} ok=${s.ok} badOutput=${s.bad}`);
if (!made) { log('No story could be published this run.'); process.exitCode = 1; }
