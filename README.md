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
5. **X**: developer.x.com → create app with *Read and write* permission → generate API key/secret and access token/secret for your account. X changes plans and limits often; check your current allowance before relying on 4 posts/day. If X fails, the post still publishes and the run continues.
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

## Free / alternative AI providers
Any OpenAI-compatible chat endpoint works. Defaults are Google Gemini's free tier (key from aistudio.google.com/apikey, no card needed): base URL `https://generativelanguage.googleapis.com/v1beta/openai/`, model `gemini-2.5-flash`.

| Provider | `LLM_BASE_URL` | Notes |
|---|---|---|
| Google Gemini (default) | `https://generativelanguage.googleapis.com/v1beta/openai/` | Text + vision on one model |
| Groq | `https://api.groq.com/openai/v1` | Fast; set `LLM_VISION_MODEL` to a Groq vision model |
| OpenRouter | `https://openrouter.ai/api/v1` | Use model ids ending in `:free` |
| Mistral | `https://api.mistral.ai/v1` | Set a vision-capable `LLM_VISION_MODEL` |

Model names and free limits change; confirm them in the provider's dashboard. Calls are spaced by `LLM_MIN_INTERVAL_MS` (default 4500 ms) and 429 errors are retried automatically. Use `LLM_CHECK_MODEL` to fact-check with a different model than the writer. Free-tier prompts may be used by the provider to improve its products; the pipeline only sends public Wikipedia text and public images.
