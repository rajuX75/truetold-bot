// Grounded writing + independent fact-check + image vetting with Claude.
import Anthropic from '@anthropic-ai/sdk';
import { extractJson } from './util.mjs';

const client = new Anthropic(); // reads ANTHROPIC_API_KEY
const MODEL = () => process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';

async function ask({ system, content, max = 4000, temperature = 0.4 }) {
  const r = await client.messages.create({
    model: MODEL(),
    max_tokens: max,
    temperature,
    system,
    messages: [{ role: 'user', content }],
  });
  return r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

const WRITER_SYSTEM = `You write short, gripping, TRUE stories for a blog. You are a careful journalist, not a novelist.
HARD RULES
- Use ONLY facts stated in the SOURCE TEXT. Never add dates, numbers, names, places, causes, quotes, dialogue, thoughts, or feelings that the source does not state.
- No invented scenes. Narrative pacing is fine; invention is not. If the source is thin on something, leave it out.
- Where the source hedges ("reportedly", "according to"), keep the hedge.
- Write in your own words. Do not copy sentences from the source.
- Plain, vivid, human tone. No clickbait claims, no "you won't believe".
Return ONLY a JSON object:
{
 "title": "<= 60 chars, natural primary keyword, honest",
 "description": "140-155 char meta description",
 "slug": "3-7 lowercase words joined by hyphens",
 "category": "ONE of the allowed categories",
 "tags": ["up to 3 short topic tags"],
 "takeaways": ["3 short factual takeaways"],
 "sections": [{"heading": "H2 heading", "paragraphs": ["..."]}],
 "tweetHook": "<= 180 chars, factual teaser, no hashtags, no links"
}
Length: 650-900 words across 3-5 sections.`;

export async function writeStory({ article, candidate, categories, today, feedback }) {
  const prompt =
    `Allowed categories: ${categories.join(', ')}\nToday: ${today}\n` +
    `Event year (per feed): ${candidate.year}\nFeed blurb: ${candidate.blurb}\n\n` +
    `SOURCE TEXT (the only permitted source of facts):\n"""\n${article.text}\n"""` +
    (feedback ? `\n\nA fact-checker rejected the previous draft for these unsupported claims. Fix them by removing or correcting:\n${feedback}` : '');
  const out = await ask({ system: WRITER_SYSTEM, content: prompt, max: 4500 });
  const j = extractJson(out);
  if (!j.title || !Array.isArray(j.sections) || j.sections.length < 2) throw new Error('Malformed story JSON');
  if (!categories.includes(j.category)) j.category = categories[0];
  return j;
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
    max: 1500,
    temperature: 0,
  });
  const j = extractJson(out);
  return { pass: j.pass === true, issues: j.issues || [] };
}

// Vision check: does the picture plausibly relate to the story? Also writes accessible alt text + caption.
export async function vetImage({ title, summary, fileTitle, fileDescription, jpegBuffer }) {
  const out = await ask({
    system:
      'You review a candidate hero image for a factual article. Describe ONLY what is visibly in the image; never assert identities, places or dates that you cannot see unless the provided file description states them. Return ONLY JSON: {"ok": boolean, "alt": "concise descriptive alt text, 80-125 chars, no \\"image of\\"", "caption": "one factual sentence <= 140 chars based on the file description", "reason": "short"}. ok=false if the image is a logo, map, text-heavy graphic, unrelated, low quality, or graphic gore.',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpegBuffer.toString('base64') } },
      { type: 'text', text: `Article title: ${title}\nArticle summary: ${summary}\nFile name: ${fileTitle}\nFile description (from Wikimedia Commons): ${fileDescription || 'n/a'}` },
    ],
    max: 600,
    temperature: 0,
  });
  return extractJson(out);
}
