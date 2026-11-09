// Multi-provider LLM client with automatic failover.
// Chains up to 3 OpenAI-compatible providers. When one hits rate limits (429)
// or server errors (5xx), the next provider is tried before giving up.
//
// Provider 1 (primary):  LLM_BASE_URL   + LLM_API_KEY   + LLM_MODEL
// Provider 2 (fallback): LLM_BASE_URL_2 + LLM_API_KEY_2 + LLM_MODEL_2
// Provider 3 (fallback): LLM_BASE_URL_3 + LLM_API_KEY_3 + LLM_MODEL_3
//
// All providers use the OpenAI /chat/completions format (Gemini, Groq, Cerebras,
// OpenRouter, GitHub Models, Mistral, NVIDIA NIM, etc.).

import { sleep, log } from './util.mjs';

function cleanBase(url, fallback) {
  const u = (url && String(url).trim()) ? String(url).trim() : fallback;
  return u.replace(/\/$/, '');
}

export function loadProviders() {
  const providers = [];

  // Provider 1 (primary, usually Gemini)
  if (process.env.LLM_API_KEY && process.env.LLM_API_KEY.trim()) {
    providers.push({
      name: process.env.LLM_PROVIDER_NAME || 'primary',
      base: cleanBase(process.env.LLM_BASE_URL, 'https://generativelanguage.googleapis.com/v1beta/openai'),
      key: process.env.LLM_API_KEY.trim(),
      model: process.env.LLM_MODEL || 'gemini-2.5-flash',
      visionModel: process.env.LLM_VISION_MODEL || process.env.LLM_MODEL || 'gemini-2.5-flash',
      checkModel: process.env.LLM_CHECK_MODEL || process.env.LLM_MODEL || 'gemini-2.5-flash',
    });
  }

  // Provider 2 (fallback 1, e.g. Groq)
  if (process.env.LLM_API_KEY_2 && process.env.LLM_API_KEY_2.trim()) {
    providers.push({
      name: process.env.LLM_PROVIDER_NAME_2 || 'groq',
      base: cleanBase(process.env.LLM_BASE_URL_2, 'https://api.groq.com/openai/v1'),
      key: process.env.LLM_API_KEY_2.trim(),
      model: process.env.LLM_MODEL_2 || 'llama-3.3-70b-versatile',
      visionModel: process.env.LLM_VISION_MODEL_2 || 'llama-3.2-11b-vision-preview',
      checkModel: process.env.LLM_CHECK_MODEL_2 || process.env.LLM_MODEL_2 || 'llama-3.3-70b-versatile',
    });
  }

  // Provider 3 (fallback 2, e.g. Cerebras)
  if (process.env.LLM_API_KEY_3 && process.env.LLM_API_KEY_3.trim()) {
    providers.push({
      name: process.env.LLM_PROVIDER_NAME_3 || 'cerebras',
      base: cleanBase(process.env.LLM_BASE_URL_3, 'https://api.cerebras.ai/v1'),
      key: process.env.LLM_API_KEY_3.trim(),
      model: process.env.LLM_MODEL_3 || 'llama-3.3-70b',
      visionModel: process.env.LLM_VISION_MODEL_3 || process.env.LLM_MODEL_3 || 'llama-3.3-70b',
      checkModel: process.env.LLM_CHECK_MODEL_3 || process.env.LLM_MODEL_3 || 'llama-3.3-70b',
    });
  }

  return providers;
}

export function getProviders() {
  return loadProviders();
}

// ── Model resolution ────────────────────────────────────────────────────────

export const MODELS = {
  text:   () => getProviders()[0]?.model       || 'gemini-2.5-flash',
  vision: () => getProviders()[0]?.visionModel || 'gemini-2.5-flash',
  check:  () => getProviders()[0]?.checkModel  || 'gemini-2.5-flash',
};

// ── Throttle (shared across all providers) ──────────────────────────────────

let lastCall = 0;
async function throttle() {
  const gap = Number(process.env.LLM_MIN_INTERVAL_MS ?? 4500);
  const wait = lastCall + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
}

// ── Resolve the correct model for a provider ────────────────────────────────

function resolveModel(requestedModel, provider, providers) {
  const primary = providers[0];
  if (!primary) return requestedModel;

  if (requestedModel === primary.model)       return provider.model;
  if (requestedModel === primary.visionModel) return provider.visionModel;
  if (requestedModel === primary.checkModel)  return provider.checkModel;
  return provider.model || requestedModel;
}

// ── Core chat function with multi-provider failover ─────────────────────────

export async function chat({ model, system, user, max = 4000, temperature = 0.4, json = true }) {
  const providers = getProviders();
  if (!providers.length) throw new Error('No LLM providers configured — set LLM_API_KEY');

  let lastErr;

  for (let pi = 0; pi < providers.length; pi++) {
    const provider = providers[pi];
    const providerModel = resolveModel(model, provider, providers);
    let useJsonMode = json;
    let providerFailed = false;

    for (let attempt = 0; attempt < 3; attempt++) {
      await throttle();

      const messages = [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ];

      const body = { model: providerModel, messages, temperature, max_tokens: max };
      if (useJsonMode) body.response_format = { type: 'json_object' };

      let res;
      try {
        res = await fetch(`${provider.base}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${provider.key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (e) {
        lastErr = e;
        log(`[${provider.name}] Network error: ${e.message}`);
        await sleep(3000 * (attempt + 1));
        continue;
      }

      if (res.ok) {
        const j = await res.json();
        const text = j.choices?.[0]?.message?.content;
        if (!text) { lastErr = new Error('Empty model response'); continue; }
        if (pi > 0) log(`[${provider.name}] Responded successfully (fallback from previous provider)`);
        return text;
      }

      const detail = (await res.text()).slice(0, 300);
      lastErr = new Error(`[${provider.name}] HTTP ${res.status}: ${detail}`);

      // JSON mode not supported by this provider — retry without it (same provider)
      if (res.status === 400 && useJsonMode) {
        useJsonMode = false;
        log(`[${provider.name}] Rejected JSON mode, retrying without it`);
        continue;
      }

      // Rate limited (429) or server error (5xx) — fail over to next provider immediately if available
      if (res.status === 429 || res.status >= 500) {
        if (pi < providers.length - 1) {
          log(`[${provider.name}] HTTP ${res.status} (rate limited / server busy) -> failing over to ${providers[pi + 1].name}`);
          providerFailed = true;
          break; // break retry loop, move to next provider
        }
        // Last provider: wait and retry
        const ra = Number(res.headers.get('retry-after'));
        const wait = ra > 0 ? ra * 1000 : 15000 * (attempt + 1);
        log(`[${provider.name}] HTTP ${res.status} (last provider); waiting ${Math.round(wait / 1000)}s before retry ${attempt + 1}/3`);
        await sleep(wait);
        continue;
      }

      // 401/403/404 — auth or configuration error on this provider, fail over to next provider
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        log(`[${provider.name}] Auth/config error (${res.status}), failing over to next provider`);
        providerFailed = true;
        break;
      }

      throw lastErr;
    }

    if (!providerFailed) break;
  }

  throw lastErr;
}
