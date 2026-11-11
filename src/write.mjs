// Grounded writing + independent fact-check + image vetting with any OpenAI-compatible model.
// Every call goes through chatJson(): schema validation is part of the request, so malformed or
// truncated output fails over to another model automatically (see llm.mjs).
import { log } from './util.mjs';
import { chatJson, hasRole } from './llm.mjs';

const WRITER_SYSTEM = `You are a master narrative journalist who writes short, gripping, TRUE stories for a popular history blog. You have the pacing of a thriller writer and the discipline of a fact-checker.

HARD RULES — NEVER break these:
- Use ONLY facts explicitly stated in the SOURCE TEXT. Zero invented dates, numbers, names, places, causes, quotes, dialogue, internal thoughts, or feelings.
- No invented scenes. Rich narrative pacing is encouraged; invention is forbidden. If the source is vague, stay vague or omit it.
- Preserve every hedge the source uses ("reportedly", "alleged", "according to witnesses").
- Write entirely in your own words. Never copy source sentences.
- No clickbait, no "you won't believe", no filler superlatives.

STYLE GUIDE:
- Open STRONG: hook the reader in the very first sentence with the most dramatic true fact of the story.
- Use short sentences at high-tension moments. Vary rhythm. Aim for a human, present-tense sense of urgency.
- Each section should end with a sentence that makes the reader want to continue.
- Prefer concrete nouns and active verbs over abstractions.
- The tweetHook must be your most punchy one-liner from the story — a single arresting fact or irony.

JSON OUTPUT RULES (critical — a JSON parse error wastes an entire API call):
- Return ONLY the raw JSON object. No markdown fences, no text before or after, no comments.
- All string values must use properly escaped JSON. If a paragraph contains a double-quote character, escape it as \\".
- Do NOT include literal newline characters inside string values — write everything on one line per string.
- Do NOT add trailing commas after the last item in an array or object.

Schema (return exactly this shape):
{
  "title": "<= 60 chars, compelling but honest, includes primary keyword",
  "description": "140-155 char meta description — factual and enticing, ends with a reason to click",
  "slug": "3-7 lowercase words joined by hyphens",
  "category": "ONE of the allowed categories",
  "tags": ["up to 3 short topic tags"],
  "takeaways": ["3 punchy factual bullet points readers will remember"],
  "sections": [{"heading": "vivid H2 heading (not generic)", "paragraphs": ["paragraph text here"]}],
  "tweetHook": "<= 180 chars, one arresting factual statement or irony, no hashtags, no links, no emojis"
}
Length: 600-850 words across 3-4 sections. Each section must have at least 2 paragraphs.`;

const wordCount = (j) => j.sections.flatMap((s) => s.paragraphs).join(' ').split(/\s+/).filter(Boolean).length;

/** Throws if the story is unusable (→ llm.mjs tries another model); normalises optional fields. */
export function validateStory(j, categories) {
  if (!j || typeof j !== 'object') throw new Error('not an object');
  if (typeof j.title !== 'string' || !j.title.trim()) throw new Error('missing title');
  if (!Array.isArray(j.sections) || j.sections.length < 2) throw new Error('needs at least 2 sections');
  for (const s of j.sections) {
    if (!s || typeof s.heading !== 'string' || !s.heading.trim()) throw new Error('section without heading');
    if (!Array.isArray(s.paragraphs) || !s.paragraphs.length || s.paragraphs.some((p) => typeof p !== 'string' || !p.trim())) throw new Error('section without paragraphs');
  }
  if (!Array.isArray(j.takeaways) || !j.takeaways.length || j.takeaways.some((t) => typeof t !== 'string')) throw new Error('missing takeaways');
  const words = wordCount(j);
  if (words < 350) throw new Error(`story too short (${words} words) — likely truncated`);

  j.title = j.title.trim();
  j.tags = Array.isArray(j.tags) ? j.tags.filter((t) => typeof t === 'string' && t.trim()).slice(0, 3) : [];
  if (!categories.includes(j.category)) j.category = categories[0];
  j.description = String(j.description || j.takeaways[0]).trim().slice(0, 160);
  j.tweetHook = String(j.tweetHook || j.takeaways[0]).trim().slice(0, 180);
  if (typeof j.slug !== 'string' || !j.slug.trim()) j.slug = '';
  return j;
}

export async function writeStory({ article, candidate, categories, today, feedback }) {
  const prompt =
    `Allowed categories: ${categories.join(', ')}\nToday: ${today}\n` +
    `Event year (per feed): ${candidate.year}\nFeed blurb: ${candidate.blurb}\n\n` +
    `SOURCE TEXT (the only permitted source of facts):\n"""\n${article.text}\n"""` +
    (feedback ? `\n\nA fact-checker rejected the previous draft for these unsupported claims. Fix them by removing or correcting:\n${feedback}` : '');

  return chatJson({
    role: 'text', system: WRITER_SYSTEM, user: prompt,
    max: 6000, temperature: feedback ? 0.2 : 0.4,
    validate: (j) => validateStory(j, categories),
  });
}

const STRICT = () => String(process.env.FACTCHECK_STRICT || '').toLowerCase() === 'true';

const CHECK_SYSTEM = `You are a strict fact-checker. Compare the ARTICLE with the SOURCE TEXT.
List every factual claim in the article that is NOT directly supported by the source text or that contradicts it.
Classify each issue:
- "major": a date, number, name, place, quote, outcome, sequence of events or causal claim that is absent from the source or contradicts it.
- "minor": wording, emphasis or reasonable paraphrase that adds no new verifiable fact. Pure style and connective prose are NOT issues.
Return ONLY JSON: {"pass": boolean, "issues": [{"claim": "short quote or description", "severity": "major" | "minor", "why": "short reason"}]}
pass=true only if there are zero major issues.`;

export async function factCheck({ article, story }) {
  const body = story.sections.map((s) => `## ${s.heading}\n${s.paragraphs.join('\n')}`).join('\n\n');
  const j = await chatJson({
    role: 'check', system: CHECK_SYSTEM, max: 3000, temperature: 0,
    user: `SOURCE TEXT:\n"""\n${article.text}\n"""\n\nARTICLE:\n"""\n${story.title}\n${story.takeaways.join('\n')}\n${body}\n"""`,
    validate: (r) => {
      if (!r || typeof r !== 'object') throw new Error('not an object');
      if (typeof r.pass !== 'boolean' && !Array.isArray(r.issues)) throw new Error('missing pass/issues');
    },
  });
  const issues = (Array.isArray(j.issues) ? j.issues : []).map((i) =>
    typeof i === 'string' ? { claim: i, severity: 'major', why: '' } : { claim: String(i?.claim || ''), severity: i?.severity === 'minor' ? 'minor' : 'major', why: String(i?.why || '') });
  const blocking = STRICT() ? issues : issues.filter((i) => i.severity === 'major');
  const unspecified = j.pass === false && issues.length === 0; // model said "fail" but gave nothing actionable
  const fmt = (i) => (i.why ? `${i.claim} — ${i.why}` : i.claim);
  if (issues.length && !blocking.length) log(`Fact-check: ${issues.length} minor wording note(s) ignored`);
  return {
    pass: blocking.length === 0 && !unspecified,
    issues: unspecified ? ['Checker flagged the article without naming a claim'] : blocking.map(fmt),
  };
}

// Vision check: does the picture plausibly relate to the story? Also writes accessible alt text + caption.
// If no vision-capable model is available, it falls back to evaluating the file metadata only.
export async function vetImage({ title, summary, fileTitle, fileDescription, jpegBuffer }) {
  const systemPrompt =
    'You review a candidate hero image for a factual article. Describe ONLY what is visibly in the image; never assert identities, places or dates that you cannot see unless the provided file description states them. Return ONLY JSON: {"ok": boolean, "alt": "concise descriptive alt text, 80-125 chars, no \\"image of\\"", "caption": "one factual sentence <= 140 chars based on the file description", "reason": "short"}. ok=false if the image is a logo, map, text-heavy graphic, unrelated, low quality, or graphic gore.';
  const textPrompt = `Article title: ${title}\nArticle summary: ${summary}\nFile name: ${fileTitle}\nFile description (from Wikimedia Commons): ${fileDescription || 'n/a'}`;
  const validate = (j) => {
    if (!j || typeof j.ok !== 'boolean') throw new Error('missing ok');
    if (j.ok && (typeof j.alt !== 'string' || typeof j.caption !== 'string' || !j.alt.trim())) throw new Error('missing alt/caption');
  };

  if (await hasRole('vision')) {
    try {
      return await chatJson({
        role: 'vision', system: systemPrompt, max: 1500, temperature: 0, validate,
        user: [
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpegBuffer.toString('base64')}` } },
          { type: 'text', text: textPrompt },
        ],
      });
    } catch (err) {
      log(`Vision check unavailable (${String(err.message).slice(0, 100)}), falling back to metadata vetting`);
    }
  }
  return chatJson({
    role: 'text', system: systemPrompt, max: 1500, temperature: 0, validate,
    user: `${textPrompt}\n(Note: the image itself is not viewable. Judge from the file name and description whether it is a relevant photographic or historical hero image.)`,
  });
}
