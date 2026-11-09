// Builds the Blogger post HTML: <picture> (AVIF/WebP/JPEG), caption with licence credit,
// takeaways, sources, disclosure, and Article + ImageObject JSON-LD.
import { esc } from './util.mjs';

export function renderPost({ story, img, imageMeta, alt, caption, article, siteName, sizes, datePublished }) {
  const credit =
    `Image: ${esc(imageMeta.author)} / ` +
    (imageMeta.licenseUrl
      ? `<a href="${esc(imageMeta.licenseUrl)}" rel="license noopener" target="_blank">${esc(imageMeta.license)}</a>`
      : esc(imageMeta.license)) +
    ` via <a href="${esc(imageMeta.pageUrl)}" rel="noopener" target="_blank">Wikimedia Commons</a>`;

  const picture = `
<figure class="tt-hero" style="margin:0 0 1.5em">
  <picture>
    <source type="image/avif" srcset="${esc(img.srcset.avif)}" sizes="${esc(sizes)}">
    <source type="image/webp" srcset="${esc(img.srcset.webp)}" sizes="${esc(sizes)}">
    <img src="${esc(img.src)}" srcset="${esc(img.srcset.jpeg)}" sizes="${esc(sizes)}"
         width="${img.width}" height="${img.height}" alt="${esc(alt)}"
         fetchpriority="high" decoding="async"
         style="width:100%;height:auto;aspect-ratio:16/9;object-fit:cover;background:center/cover url(${img.lqip});border-radius:8px">
  </picture>
  <figcaption style="font-size:.85em;opacity:.8;margin-top:.5em">${esc(caption)}<br><small>${credit}</small></figcaption>
</figure>`;

  const takeaways = `<h2>Key facts</h2>\n<ul>\n${story.takeaways.map((t) => `  <li>${esc(t)}</li>`).join('\n')}\n</ul>`;
  const body = story.sections
    .map((s) => `<h2>${esc(s.heading)}</h2>\n${s.paragraphs.map((p) => `<p>${esc(p)}</p>`).join('\n')}`)
    .join('\n');

  const sources = `<h2>Sources</h2>
<ul>
  <li><a href="${esc(article.permalink)}" rel="noopener" target="_blank">${esc(article.title)} — Wikipedia (revision ${esc(article.revid)})</a>, text under <a href="https://creativecommons.org/licenses/by-sa/4.0/" rel="license noopener" target="_blank">CC BY-SA 4.0</a></li>
  <li><a href="${esc(imageMeta.pageUrl)}" rel="noopener" target="_blank">${esc(imageMeta.fileTitle)} — Wikimedia Commons</a></li>
</ul>
<p><small>${esc(siteName)} stories are researched from the public sources above, written with AI assistance, and automatically checked against those sources before publishing. Found a mistake? Tell us and we will correct it.</small></p>`;

  const jsonld = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: story.title,
    description: story.description,
    datePublished,
    dateModified: datePublished,
    image: [img.ogUrl, img.src],
    author: { '@type': 'Organization', name: siteName },
    publisher: { '@type': 'Organization', name: siteName },
    isBasedOn: article.permalink,
    citation: [article.permalink],
    articleSection: story.category,
    keywords: [story.category, ...story.tags].join(', '),
  };
  const imageObject = {
    '@context': 'https://schema.org',
    '@type': 'ImageObject',
    contentUrl: img.src,
    url: img.ogUrl,
    width: img.width,
    height: img.height,
    caption,
    creditText: `${imageMeta.author} / ${imageMeta.license} via Wikimedia Commons`,
    creator: { '@type': 'Person', name: imageMeta.author },
    license: imageMeta.licenseUrl || undefined,
    acquireLicensePage: imageMeta.pageUrl,
  };
  const ld = [jsonld, imageObject].map((o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`).join('\n');

  return `${picture}\n${takeaways}\n${body}\n${sources}\n${ld}`;
}
