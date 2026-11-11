# TrueTold Autopublisher

Every day, GitHub Actions publishes **4 true stories** to your Blogger blog and shares each link on X.

```
Wikipedia "On this day" ─► article text ─► the LLM writes (facts only from source)
        ─► the LLM fact-checks against source ─► licensed Commons image ─► vision check
        ─► AVIF/WebP/JPEG + OG card ─► commit to GitHub Pages ─► wait until live
        ─► Blogger API post ─► X post
```

## Why stories are trustworthy
- Facts come only from a fetched, cited source (Wikipedia revision permalink). No invented scenes, quotes or numbers.
- A second LLM call checks every claim against the source. Two failures = story skipped.
- Each post ends with a Sources block and an honest AI-assistance disclosure.

## Image system
- Only Wikimedia Commons images with CC0 / public domain / CC BY / CC BY-SA licences (NC/ND/fair-use rejected).
- A vision-capable model confirms the picture fits the story and writes alt text and caption.
- Output: smart 16:9 crop, AVIF + WebP + JPEG at 480/800/1200/1600 px, `<picture>` + `srcset`/`sizes`, width/height (no layout shift), `fetchpriority=high`, blur-up placeholder, 1200x630 social card, stripped EXIF, keyword file names.
- Visible credit line, plus `Article` and `ImageObject` JSON-LD with licence and credit text.

## Setup (about 20 minutes)
1. **Create a GitHub repo**, push this folder, then *Settings → Pages → Deploy from branch → `main` / `/docs`*.
2. **Blogger API**: Google Cloud Console → new project → enable *Blogger API v3* → *OAuth consent screen* (External) → **Publish app to "In production"** (in Testing mode refresh tokens expire after 7 days) → *Credentials → OAuth client ID → Desktop app*.
3. Get the refresh token locally:
   `BLOGGER_CLIENT_ID=... BLOGGER_CLIENT_SECRET=... npm run blogger-token`
4. **Blog ID**: Blogger dashboard URL contains `blogID=NUMBER`.
5. **X**: console.x.com → create a Project + App → *User authentication settings: Read and write* → generate API key/secret and access token/secret (**generate the access token AFTER setting Read and write**). Since Feb 2026 X has **no free tier**: put the app on the *Pay-per-use* package and buy credits. A post costs about **$0.015**, but a post that contains a **link costs about $0.20** (4 posts/day ≈ $24/month). To post without the link set the variable `X_LINK_MODE=none`. If X fails, the blog post still publishes, and the tweet is **queued and retried on later runs** for up to 72 hours (so topping up credits later sends the missed tweets).
6. **Repo → Settings → Secrets and variables → Actions**
   - Secrets: `LLM_API_KEY`, `BLOGGER_BLOG_ID`, `BLOGGER_CLIENT_ID`, `BLOGGER_CLIENT_SECRET`, `BLOGGER_REFRESH_TOKEN`, `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET`
   - Variables: `CONTACT_EMAIL` (sent in the User-Agent to Wikimedia, required by their policy); optional `IMAGE_BASE_URL` (custom domain), `LLM_BASE_URL`, `LLM_MODEL`, `LLM_VISION_MODEL`, `LLM_CHECK_MODEL`.
7. **First runs**: *Actions → Publish true stories → Run workflow* with **dry_run** (writes `out/*.html`), then with **draft** (Blogger draft, no X). Review, then let the schedule run.

## Tuning
- `config.json`: stories per day, categories, hashtags, image widths.
- Schedule: `.github/workflows/publish.yml` (UTC). One story per run keeps runs short and spaces posts out.
- Blogger: Settings → Posts → set "Show Search Description" to Yes so the meta description is used.

## Limits to know
- GitHub may delay scheduled runs by minutes, and pauses schedules in repos with 60 days of no activity (the bot's own commits count as activity).
- "On this day" gives history-weighted stories. Add other verifiable sources in `src/sources.mjs`.
- CC BY-SA images and Wikipedia-derived text require attribution, which the template includes.

## AI providers and models (self-healing)
Any OpenAI-compatible endpoint works. The client is built around **model chains**: each provider has an ordered list of models per job (write / fact-check / vision). On any problem it moves to the next model, then the next provider.

- **Live model discovery**: at the start of every run it asks each provider which models exist (`GET /models`) and skips names that were retired. Stale model names in your settings can no longer break a run.
- **Health memory**: dead models, exhausted daily quotas and rate limits are remembered for the run, so nothing keeps hitting a model that cannot answer.
- **Output validation**: invalid / truncated JSON is treated as a failure of *that model* and the next model is tried, instead of repeating the same one.
- **Auto-adapt**: if a model rejects `response_format` or `reasoning_effort` it is retried without it.
- If every model is unavailable, the run stops early instead of burning quota on other stories (`MAX_CANDIDATES`, default 4, also caps this).

Defaults (checked Nov 2026; free tiers change, so run **Diagnose** below):

| Slot | Provider | Default chain | Notes |
|---|---|---|---|
| 1 | Google Gemini | `gemini-3.8-flash` → `3.6-flash` → `3.5-flash-lite` → `3.1-flash-lite` → `2.5-flash-lite` | Quota is per model (3.8-flash ≈ 20 req/day free, 3.5-flash-lite ≈ 500/day). Only provider with vision by default. `gemini-2.5-flash` is restricted to existing users and retires 2026-12-01. |
| 2 | Groq (`LLM_*_2`) | `openai/gpt-oss-120b` → `qwen/qwen3.6-27b` → `openai/gpt-oss-20b` | `llama-3.3-70b-versatile`, `llama-3.1-8b-instant` were retired 2026-08-16. |
| 3 | Cerebras (`LLM_*_3`) | `gpt-oss-120b` → `qwen-3-235b-a22b-instruct-2507` → `zai-glm-4.7` → `llama3.1-8b` | `llama-3.3-70b` was removed. Free context is 8K, so output is capped. |
| 4 | OpenRouter (`LLM_*_4`) | none; set `LLM_MODEL_4` to a model id ending in `:free` | optional |

**Recommended: leave `LLM_MODEL*` variables empty** and delete old ones such as `LLM_MODEL=gemini-2.5-flash` or `LLM_MODEL_2=llama-3.3-70b-versatile` (they are skipped automatically now, but they are clutter). To force a model, set `LLM_MODEL="model-a,model-b"` (comma list = your own chain; the defaults still follow as fallback).

Free-tier prompts may be used by the provider to improve its products; the pipeline only sends public Wikipedia text and public images.

## Diagnose / troubleshoot
**Actions → Publish true stories → Run workflow → tick `diagnose`.** It pings every model in every job and checks your X credentials without publishing anything. The same checks run locally with `npm run llm-check` and `npm run x-check` (set the same environment variables).

| Symptom in the log | Meaning | Fix |
|---|---|---|
| `"…" is not offered by this provider — skipping` | A configured model was retired | Nothing (auto-skipped). Remove the stale variable. |
| `daily quota exhausted → cooling …` | Free quota of that model is used | Nothing; it fails over. Add another provider key for more headroom. |
| `All text models failed` / `All AI models unavailable` | Every provider is down or out of quota | Run **diagnose**; add a second provider key. |
| `X BLOCKED … credits` (402) | X has no credits | Add credits in console.x.com. Queued tweets go out automatically. |
| `X BLOCKED … client-not-enrolled` (403) | App is not on the pay-per-use package | Move the app to Pay-per-use in console.x.com. |
| `X BLOCKED … 401` | Wrong/old X keys | Regenerate keys + tokens (tokens after setting Read and write). |

## Other settings (repository *Variables*)
`FACTCHECK_STRICT=true` fails a story on any fact-check note (default: only on **major** unsupported facts: dates, numbers, names, places, quotes, causes). `X_LINK_MODE=none` posts without the link. `X_ATTACH_IMAGE=false` skips the image upload. `MAX_CANDIDATES` limits how many stories are attempted per run.
