export const CONTACT = process.env.CONTACT_EMAIL || 'contact@example.com';
export const UA = `TrueToldBot/1.0 (+https://github.com/${process.env.GITHUB_REPOSITORY || 'owner/repo'}; ${CONTACT})`;

export const log = (...a) => console.log(new Date().toISOString(), ...a);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function getJson(url, { retries = 3 } = {}) {
  let last;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (e) {
      last = e;
      await sleep(1500 * (i + 1));
    }
  }
  throw last;
}

export async function getBuffer(url, { retries = 3 } = {}) {
  let last;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      last = e;
      await sleep(2000 * (i + 1));
    }
  }
  throw last;
}

export function slugify(s) {
  return String(s)
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 70).replace(/-+$/g, '');
}

/**
 * Extract and parse a JSON object from LLM output.
 *
 * LLMs commonly produce JSON with:
 *   1. Markdown fences  ```json ... ```
 *   2. Unescaped newlines / tabs inside string values
 *   3. Stray control characters
 *   4. Literal unescaped double-quotes inside string values
 *
 * We try three progressive repair passes before giving up.
 */
export function extractJson(text) {
  // Strip markdown code fences
  let t = String(text).replace(/^```(?:json)?\s*/gm, '').replace(/^```\s*$/gm, '');

  // Locate the outermost { ... }
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b < 0) throw new Error('No JSON braces found in model output');
  const raw = t.slice(a, b + 1);

  // Pass 1: direct parse
  try { return JSON.parse(raw); } catch (e1) {
    // Pass 2: replace literal (unescaped) control chars inside the text
    try {
      const pass2 = raw
        .replace(/\r\n/g, '\\n')   // Windows newlines
        .replace(/\n/g, '\\n')     // Unix newlines
        .replace(/\r/g, '\\n')     // CR
        .replace(/\t/g, '\\t');    // tabs
      return JSON.parse(pass2);
    } catch (e2) {
      // Pass 3: strip ALL bare control characters (< 0x20 except already-escaped)
      try {
        // Only strip control chars that aren't part of a \n \t \r escape sequence
        const pass3 = raw.replace(/(?<!\\)[\x00-\x1F\x7F]/g, ' ');
        return JSON.parse(pass3);
      } catch (e3) {
        // Surface the real parse error so logs show exactly what went wrong
        throw new Error(`JSON parse failed [${e3.message}] — raw starts: ${raw.slice(0, 120)}`);
      }
    }
  }
}

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
