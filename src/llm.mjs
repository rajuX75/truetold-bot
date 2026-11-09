// Provider-agnostic chat client for any OpenAI-compatible endpoint
// (Gemini, Groq, OpenRouter, GitHub Models, Mistral, ...). Plain fetch, no SDK.
import { sleep, log } from './util.mjs';

const BASE = () => (process.env.LLM_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/$/, '');
const KEY = () => process.env.LLM_API_KEY;
export const MODELS = {
  text: () => process.env.LLM_MODEL || 'gemini-2.5-flash',
  vision: () => process.env.LLM_VISION_MODEL || process.env.LLM_MODEL || 'gemini-2.5-flash',
  check: () => process.env.LLM_CHECK_MODEL || process.env.LLM_MODEL || 'gemini-2.5-flash',
};

// Free tiers are rate-limited: keep calls spaced (default ~13 requests/minute max).
let lastCall = 0;
async function throttle() {
  const gap = Number(process.env.LLM_MIN_INTERVAL_MS ?? 4500);
  const wait = lastCall + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
}

export async function chat({ model, system, user, max = 4000, temperature = 0.4, json = true }) {
  if (!KEY()) throw new Error('LLM_API_KEY is not set');
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user }, // string, or array of {type:'text'|'image_url'}
  ];
  let useJsonMode = json;
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    await throttle();
    const body = { model, messages, temperature, max_tokens: max };
    if (useJsonMode) body.response_format = { type: 'json_object' };
    let res;
    try {
      res = await fetch(`${BASE()}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) { lastErr = e; await sleep(3000 * (attempt + 1)); continue; }

    if (res.ok) {
      const j = await res.json();
      const text = j.choices?.[0]?.message?.content;
      if (!text) { lastErr = new Error('Empty model response'); continue; }
      return text;
    }
    const detail = (await res.text()).slice(0, 300);
    lastErr = new Error(`LLM HTTP ${res.status}: ${detail}`);
    if (res.status === 400 && useJsonMode) { useJsonMode = false; log('Provider rejected JSON mode, retrying without it'); continue; }
    if (res.status === 429 || res.status >= 500) {
      const ra = Number(res.headers.get('retry-after'));
      const wait = ra > 0 ? ra * 1000 : 15000 * (attempt + 1);
      log(`LLM busy/rate-limited (${res.status}); waiting ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      continue;
    }
    throw lastErr; // 401/403/404: configuration problem, do not retry
  }
  throw lastErr;
}
