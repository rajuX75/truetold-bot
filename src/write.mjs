// Grounded writing + independent fact-check + image vetting with any OpenAI-compatible model.
import { extractJson, log } from './util.mjs';
import { chat, MODELS } from './llm.mjs';

async function ask({ system, content, max = 4000, temperature = 0.4, model = MODELS.text() }) {
  return chat({ model, system, user: content, max, temperature });
}

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
Length: 700-950 words across 3-5 sections. Each section must have at least 2 paragraphs.`;

export async function writeStory({ article, candidate, categories, today, feedback }) {
  const prompt =
    `Allowed categories: ${categories.join(', ')}\nToday: ${today}\n` +
    `Event year (per feed): ${candidate.year}\nFeed blurb: ${candidate.blurb}\n\n` +
    `SOURCE TEXT (the only permitted source of facts):\n"""\n${article.text}\n"""` +
    (feedback ? `\n\nA fact-checker rejected the previous draft for these unsupported claims. Fix them by removing or correcting:\n${feedback}` : '');

  // Try up to 2 times; some models occasionally return prose instead of JSON,
  // or produce JSON with syntax errors. Second attempt uses lower temperature.
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await ask({ system: WRITER_SYSTEM, content: prompt, max: 9000, temperature: attempt === 0 ? 0.4 : 0.15 });
    let j;
    try {
      j = extractJson(out);
    } catch (e) {
      log(`Writer JSON error (attempt ${attempt + 1}): ${e.message}`);
      if (attempt === 0) continue;
      throw new Error(`Writer returned invalid JSON after 2 attempts: ${e.message}`);
    }
    if (!j.title || !Array.isArray(j.sections) || j.sections.length < 2) {
      log(`Writer malformed JSON (attempt ${attempt + 1}): title="${j.title}", sections=${j.sections?.length}`);
      if (attempt === 0) continue;
      throw new Error('Malformed story JSON after 2 attempts');
    }
    if (!categories.includes(j.category)) j.category = categories[0];
    return j;
  }
}

const CHECK_SYSTEM = `You are a strict fact-checker. Compare the ARTICLE with the SOURCE TEXT.
List every factual claim in the article (dates, numbers, names, places, causes, quotes, sequence of events) that is NOT directly supported by the source text or that contradicts it. Ignore style and pure connective prose.
Return ONLY JSON: {"pass": boolean, "issues": ["short description of each unsupported claim"]}
pass=true only if there are zero unsupported or contradicted claims.`;

export async function factCheck({ article, story }) {
  const body = story.sections.map((s) => `## ${s.heading}\n${s.paragraphs.join('\n')}`).join('\n\n');
  const out = await ask({
    system: CHECK_SYSTEM,
    content: `SOURCE TEXT:\n"""\n${article.text}\n"""\n\nARTICLE:\n"""\n${story.title}\n${story.takeaways.join('\n')}\n${body}\n"""`,
    max: 6000,
    temperature: 0,
    model: MODELS.check(),
  });
  const j = extractJson(out);
  return { pass: j.pass === true, issues: j.issues || [] };
}

// Vision check: does the picture plausibly relate to the story? Also writes accessible alt text + caption.
// If the provider doesn't support image inputs (e.g. text-only models), it gracefully falls back to metadata evaluation.
export async function vetImage({ title, summary, fileTitle, fileDescription, jpegBuffer }) {
  const systemPrompt =
    'You review a candidate hero image for a factual article. Describe ONLY what is visibly in the image; never assert identities, places or dates that you cannot see unless the provided file description states them. Return ONLY JSON: {"ok": boolean, "alt": "concise descriptive alt text, 80-125 chars, no \\"image of\\"", "caption": "one factual sentence <= 140 chars based on the file description", "reason": "short"}. ok=false if the image is a logo, map, text-heavy graphic, unrelated, low quality, or graphic gore.';
  const textPrompt = `Article title: ${title}\nArticle summary: ${summary}\nFile name: ${fileTitle}\nFile description (from Wikimedia Commons): ${fileDescription || 'n/a'}`;

  try {
    const out = await ask({
      system: systemPrompt,
      model: MODELS.vision(),
      content: [
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpegBuffer.toString('base64')}` } },
        { type: 'text', text: textPrompt },
      ],
      max: 3000,
      temperature: 0,
    });
    return extractJson(out);
  } catch (err) {
    log(`Vision API unavailable or failed (${err.message.slice(0, 100)}), falling back to metadata vetting`);
    const out = await ask({
      system: systemPrompt,
      model: MODELS.text(),
      content: `${textPrompt}\n(Note: Image preview is not viewable by your endpoint. Review the file name and description to determine if it is a relevant photographic or historical hero image).`,
      max: 3000,
      temperature: 0,
    });
    return extractJson(out);
  }
}
