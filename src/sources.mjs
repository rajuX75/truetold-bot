// Verifiable real-world sources: Wikipedia "On this day" + article text + Commons-licensed images.
import { getJson, shuffle } from './util.mjs';

const enc = encodeURIComponent;

export async function getCandidates(date, alreadyPublished) {
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const data = await getJson(`https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/events/${mm}/${dd}`);
  const seen = new Set(alreadyPublished);
  const out = [];
  for (const ev of data.events || []) {
    const page = (ev.pages || []).find((p) => p.type === 'standard' && p.titles?.canonical);
    if (!page) continue;
    const title = page.titles.canonical;
    if (seen.has(title)) continue;
    seen.add(title);
    out.push({ title, display: page.titles.normalized, year: ev.year, blurb: ev.text, hasThumb: !!page.thumbnail });
  }
  return [...shuffle(out.filter((o) => o.hasThumb)), ...shuffle(out.filter((o) => !o.hasThumb))];
}

export async function getArticle(title) {
  const url =
    'https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&redirects=1' +
    '&prop=extracts|revisions|info&explaintext=1&exsectionformat=plain&rvprop=ids&inprop=url' +
    `&titles=${enc(title)}`;
  const j = await getJson(url);
  const p = j.query?.pages?.[0];
  if (!p || p.missing) throw new Error(`Article missing: ${title}`);
  const revid = p.revisions?.[0]?.revid;
  return {
    title: p.title,
    text: (p.extract || '').slice(0, 12000),
    revid,
    url: p.fullurl,
    permalink: revid ? `https://en.wikipedia.org/w/index.php?title=${enc(p.title.replaceAll(' ', '_'))}&oldid=${revid}` : p.fullurl,
  };
}

const OK_LICENSE = /^(cc0|public domain|pd[\s-]|cc[\s-]by|attribution)/i;
const BAD_LICENSE = /(-nc|-nd|non-?commercial|no derivatives|fair use|non-free|copyrighted)/i;
const BAD_TITLE = /(flag|icon|logo|symbol|map|seal|coat of arms|signature|commons-|wiki|edit-|question|diagram|chart|stamp|banner|ambox|portal|crystal)/i;
const strip = (h = '') => String(h).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

export async function getImageCandidates(title, minWidth) {
  const url =
    'https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&generator=images&gimlimit=50' +
    `&titles=${enc(title)}&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiurlwidth=1920` +
    '&iiextmetadatafilter=LicenseShortName|LicenseUrl|Artist|Credit|ImageDescription|Restrictions|ObjectName';
  const j = await getJson(url);
  let lead = '';
  try {
    const s = await getJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${enc(title)}`);
    lead = decodeURIComponent(s.originalimage?.source || '').toLowerCase();
  } catch { /* optional */ }

  const out = [];
  for (const p of j.query?.pages || []) {
    const ii = p.imageinfo?.[0];
    if (!ii || p.imagerepository !== 'shared') continue; // Commons-hosted only (no local fair-use files)
    if (!['image/jpeg', 'image/png'].includes(ii.mime)) continue;
    if (ii.width < minWidth || BAD_TITLE.test(p.title)) continue;
    const m = ii.extmetadata || {};
    const license = strip(m.LicenseShortName?.value);
    if (!license || !OK_LICENSE.test(license) || BAD_LICENSE.test(license)) continue;
    if (strip(m.Restrictions?.value)) continue;
    const ratio = ii.width / ii.height;
    let score = Math.min(ii.width, 3000) / 3000;
    if (ratio >= 1.2 && ratio <= 2.1) score += 1;
    if (lead && lead.includes(p.title.replace(/^File:/, '').replaceAll(' ', '_').toLowerCase())) score += 1.5;
    out.push({
      fileTitle: p.title,
      url: ii.thumburl || ii.url,
      width: ii.width,
      height: ii.height,
      pageUrl: ii.descriptionurl,
      license,
      licenseUrl: strip(m.LicenseUrl?.value) || '',
      author: strip(m.Artist?.value) || strip(m.Credit?.value) || 'Unknown author',
      description: strip(m.ImageDescription?.value).slice(0, 400),
      score,
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 4);
}
