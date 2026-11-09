// Offline smoke test: image pipeline, HTML/JSON-LD, tweet length, helpers. No network, no API keys.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { processImage } from '../src/images.mjs';
import { renderPost } from '../src/render.mjs';
import { buildTweet } from '../src/x.mjs';
import { slugify, extractJson } from '../src/util.mjs';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tt-'));
const noise = Buffer.alloc(2400 * 1500 * 3);
for (let i = 0; i < noise.length; i++) noise[i] = (i * 7 + ((i / 3000) | 0) * 13) % 256;
const buffer = await sharp(noise, { raw: { width: 2400, height: 1500, channels: 3 } }).jpeg().toBuffer();

const img = await processImage({
  buffer, slug: 'test-story', date: new Date('2026-11-09T00:00:00Z'),
  widths: [480, 800, 1200, 1600], outRoot: path.join(tmp, 'img'), baseUrl: 'https://u.github.io/r/img',
});
assert.equal(img.files.length, 4 * 3 + 1, 'avif+webp+jpg x4 widths + og');
assert.match(img.srcset.avif, /480w.*1600w/);
assert.ok(img.lqip.startsWith('data:image/webp;base64,'));
const og = await sharp(path.join(tmp, 'img/2026/11/test-story-og-1200x630.jpg')).metadata();
assert.deepEqual([og.width, og.height], [1200, 630]);
assert.equal(og.exif, undefined, 'metadata stripped');

const html = renderPost({
  story: { title: 'T', description: 'D', category: 'History', tags: ['a'], takeaways: ['x', 'y', 'z'], sections: [{ heading: 'H', paragraphs: ['p1 <b>'] }, { heading: 'H2', paragraphs: ['p2'] }] },
  img, imageMeta: { author: 'A', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0', pageUrl: 'https://commons.wikimedia.org/wiki/File:X.jpg', fileTitle: 'File:X.jpg' },
  alt: 'alt text', caption: 'cap', article: { title: 'Art', permalink: 'https://en.wikipedia.org/w/index.php?title=Art&oldid=1', revid: 1 },
  siteName: 'TrueTold', sizes: '100vw', datePublished: '2026-11-09T00:00:00Z',
});
assert.match(html, /<picture>[\s\S]*image\/avif[\s\S]*image\/webp[\s\S]*<img /);
assert.match(html, /fetchpriority="high"/);
assert.ok(!html.includes('p1 <b>'), 'HTML escaped');
for (const m of html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)) JSON.parse(m[1]);

const t = buildTweet({ hook: 'x'.repeat(400), url: 'https://example.blogspot.com/2026/11/a.html', hashtags: ['#TrueStory', '#History'] });
// Count tweet length the way X does: every URL = 23 chars
const counted = t.replace(/https?:\/\/\S+/g, 'x'.repeat(23)).length;
assert.ok(counted <= 280, `tweet too long: ${counted}`);
assert.match(t, /→ Continue Reading/, 'tweet must include CTA');

assert.equal(slugify('The Fall of Rome!'), 'the-fall-of-rome');
assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
console.log('offline tests passed');
