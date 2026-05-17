# Environment Variables Audit

**Date:** 2026-05-17
**Branch:** `audit/env-vars`
**Scope:** Every `process.env.X` (TS/JS) and `os.environ` / `os.getenv` (Python) reference in the codebase, plus every variable declared in `.env*`, deploy configs, and documentation.

---

## 1. Executive summary

- **~80 distinct environment variables** referenced across 4 services (Next.js main app, `cua-service`, `scraper`, Python `ml-service`).
- **No centralised validation library** in use anywhere on the JS/TS side (no Zod, envalid, envsafe, or `@t3-oss/env-nextjs`). The Python `ml-service` is the only service with proper schema-based env validation (Pydantic `BaseSettings`).
- **Three independent throw-on-import patterns** in the JS/TS side, each with bespoke logic and error copy: `src/lib/supabase-admin.ts`, `cua-service/src/supabase.ts`, `cua-service/src/anthropic-client.ts`. Everything else either lazy-throws on first call (Twilio SMS), gracefully disables (Stripe, Sentry), or reads `process.env.X` blindly with no validation at all (ElevenLabs, Resend, GitHub, Vercel, Fly, Picovoice).
- **21+ vars referenced in code but not declared in `.env.local.example`** — most are scraper/CUA tuning knobs or optional integrations (ElevenLabs, Resend, Picovoice) that should at minimum appear in the example with a comment, or be wrapped in a schema that documents them.
- **3 vars in the example with no readers in code** (`STAXIS_DEFAULT_PROPERTY_ID` is the cleanest case — referenced only in `seed-supabase.js` as a print statement, never actually read).
- **5 cases of the same logical config split across multiple variable names** (origin URL trio, Twilio sender, ops alert phone, Supabase URL alias, DB connection alias). Each has different fallback orders in different files.
- **First-call 500 risk** for Twilio SMS, ElevenLabs, Resend, Picovoice, GitHub/Vercel/Fly admin routes — all currently fail at the first request that needs them, not at boot.

**Recommendation:** consolidate every JS/TS env access into a single `src/lib/env.ts` (and a peer `cua-service/src/env.ts`, `scraper/env.js`) built on Zod. Parse `process.env` once at module-load time, throw an aggregated error listing every missing/invalid var, and export a typed object. All scattered `process.env.X` reads switch to `import { env } from '@/lib/env'`. Inconsistent variable names are reconciled inside the schema (one canonical exported field; legacy names accepted as fallbacks in the transform).

---

## 2. Methodology

Scanned:
- `src/` (Next.js app — routes, lib, components, hooks)
- `cua-service/src/` (Fly.io CUA worker)
- `scraper/` (Railway Choice Advantage scraper)
- `ml-service/src/` (Python ML service)
- `scripts/` (one-off node scripts)
- `next.config.ts`, `vercel.json`, all `Dockerfile`s, `cua-service/fly.toml`, `scraper/railway.toml`
- `.env.local.example`, `scraper/.env.example`
- `.github/workflows/*.yml`
- All `README.md` and `docs/*.md`

Excluded: `node_modules/`, `.next/`, `dist/`, `build/`, `.git/`, `coverage/`.

Tools: `grep -rn process.env.X --include=*.ts ...`, manual `Read` of `.env.local.example` and validation modules.

A real `.env.local` exists at the parent project root (`/Users/reeyen/Desktop/hotelops-ai/.env.local`, 15 var lines); values are redacted here.

---

## 3. Full variable inventory

Conventions in the table:
- **Validated on startup?** — *crash on import*: throws at module load if missing; *crash on first call*: throws inside a request handler if missing (likely 500); *graceful disable*: returns a `{ disabled: true }` flag or no-ops; *none*: read with no check, can yield `undefined`.
- **In example?** — `Y` = declared in `.env.local.example` or `scraper/.env.example`; `N` = not declared; `(docs)` = only in a `README.md` or `docs/` file.
- File:line citations are to the worktree root.

### 3.1 Supabase

| Variable | Read in | Fallback / default | Startup validation | In example? | Issues |
|---|---|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | [src/lib/supabase-admin.ts:18](src/lib/supabase-admin.ts:18), [cua-service/src/supabase.ts:12](cua-service/src/supabase.ts:12), 17 other refs, [next.config.ts](next.config.ts) (CSP header) | none in main app; `?? SUPABASE_URL` in cua-service | **crash on import** (`supabase-admin.ts:24–28`) | Y | Same logical config as `SUPABASE_URL` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | [src/lib/supabase-browser.ts](src/lib/supabase-browser.ts), 3 other refs | none | none in browser client | Y | Browser-exposed (correctly `NEXT_PUBLIC_*`) |
| `SUPABASE_URL` | [cua-service/src/supabase.ts:12](cua-service/src/supabase.ts:12) (fallback), [scraper/supabase-helpers.js](scraper/supabase-helpers.js), [ml-service/src/config.py](ml-service/src/config.py) | accepts either prefix | crash on import (cua-service, ml-service) | Y | Same logical config as `NEXT_PUBLIC_SUPABASE_URL` |
| `SUPABASE_SERVICE_ROLE_KEY` | [src/lib/supabase-admin.ts:19](src/lib/supabase-admin.ts:19), [cua-service/src/supabase.ts:13](cua-service/src/supabase.ts:13), [scraper/supabase-helpers.js](scraper/supabase-helpers.js), [ml-service/src/config.py](ml-service/src/config.py) | none | **crash on import** in all three services | Y | OK |
| `DATABASE_URL` | [ml-service/src/config.py:86](ml-service/src/config.py:86), [ml-service/src/training/demand.py:82](ml-service/src/training/demand.py:82), [ml-service/src/training/supply.py:71](ml-service/src/training/supply.py:71), [ml-service/src/training/inventory_rate.py:107](ml-service/src/training/inventory_rate.py:107) | `?? SUPABASE_DB_URL` | Pydantic optional | N (docs in `ml-service/README.md`) | Same logical config as `SUPABASE_DB_URL` |
| `SUPABASE_DB_URL` | same 4 ml-service files | `?? DATABASE_URL` | Pydantic optional | N | Same logical config as `DATABASE_URL` |
| `SUPABASE_DB_HOST` | a couple of admin scripts | none | none | N | Undocumented; could be derived from `SUPABASE_URL` |
| `SUPABASE_DB_PASSWORD` | admin scripts only | none | none | N | Undocumented secret |

### 3.2 Anthropic / LLM

| Variable | Read in | Fallback / default | Startup validation | In example? | Issues |
|---|---|---|---|---|---|
| `ANTHROPIC_API_KEY` | [cua-service/src/anthropic-client.ts:20](cua-service/src/anthropic-client.ts:20), [src/lib/anthropic*.ts](src/lib/), agent extraction routes | none | **crash on import** (cua-service); none in main app | Y | OK — required for CUA worker |
| `MODEL_OVERRIDE` | one main-app route (LLM model selection) | uses default if unset | none | N | Undocumented escape hatch |

### 3.3 Stripe

| Variable | Read in | Fallback / default | Startup validation | In example? | Issues |
|---|---|---|---|---|---|
| `STRIPE_SECRET_KEY` | [src/lib/stripe.ts:23](src/lib/stripe.ts:23), 2 other refs | none | **graceful disable** — `stripeIsConfigured` flag (`stripe.ts`) | Y | OK |
| `STRIPE_WEBHOOK_SECRET` | [src/lib/stripe.ts:24](src/lib/stripe.ts:24), webhook route | none | graceful disable (treats secret-without-webhook as unconfigured) | Y | OK |
| `STRIPE_PRICE_ID` | [src/lib/stripe.ts:25](src/lib/stripe.ts:25), checkout route | none | none — would yield `undefined` price | Y | Missing-but-stripe-on would 500 on checkout |

### 3.4 Twilio

| Variable | Read in | Fallback / default | Startup validation | In example? | Issues |
|---|---|---|---|---|---|
| `TWILIO_ACCOUNT_SID` | [src/lib/sms.ts:28](src/lib/sms.ts:28), 9 other refs | none | **crash on first call** (`sms.ts:32–34`) | Y | OK |
| `TWILIO_AUTH_TOKEN` | [src/lib/sms.ts:29](src/lib/sms.ts:29), 9 other refs | none | crash on first call | Y | OK |
| `TWILIO_FROM_NUMBER` | [src/lib/sms.ts:30](src/lib/sms.ts:30), 4 other refs | `|| TWILIO_PHONE_NUMBER` | crash on first call | Y | Same logical config as `TWILIO_PHONE_NUMBER` |
| `TWILIO_PHONE_NUMBER` (legacy) | same 5 places | accepted as fallback | n/a | Y | Legacy migration incomplete; doctor route knows both names ([src/app/api/admin/doctor/route.ts:274](src/app/api/admin/doctor/route.ts:274)) |
| `TWILIO_BALANCE_WARN_USD` | 1 ref (Twilio balance check route) | default `'10'` | none | N | Undocumented |
| `TWILIO_BALANCE_FAIL_USD` | 1 ref | default `'5'` | none | N | Undocumented |

### 3.5 ElevenLabs

| Variable | Read in | Fallback / default | Startup validation | In example? | Issues |
|---|---|---|---|---|---|
| `ELEVENLABS_API_KEY` | 2 refs in voice routes | none | none | N | Undocumented, would 500 silently |
| `ELEVENLABS_AGENT_ID` | 1 ref | none | none | N | Undocumented |
| `ELEVENLABS_VOICE_ID` | 1 ref | none | none | N | Undocumented |
| `ELEVENLABS_WEBHOOK_SECRET` | 1 ref (webhook signature verify) | none | none | N | **Undocumented webhook secret** — security-relevant |

### 3.6 Email (Resend)

| Variable | Read in | Fallback / default | Startup validation | In example? | Issues |
|---|---|---|---|---|---|
| `RESEND_API_KEY` | 4 refs across email-sending paths | none | none | N | Undocumented; any email send 500s silently if unset |

### 3.7 Sentry

| Variable | Read in | Fallback / default | Startup validation | In example? | Issues |
|---|---|---|---|---|---|
| `SENTRY_DSN` | [sentry.server.config.ts](sentry.server.config.ts), [cua-service/src/](cua-service/src/) | none | graceful (SDK init is a no-op if missing) | Y | OK |
| `NEXT_PUBLIC_SENTRY_DSN` | [sentry.client.config.ts](sentry.client.config.ts) | none | graceful | Y | OK |
| `SENTRY_AUTH_TOKEN` | next.config.ts (sourcemap upload), CI only | none | graceful | Y | Documented in [docs/sentry-sourcemaps-activation.md](docs/sentry-sourcemaps-activation.md) |
| `SENTRY_WEBHOOK_SECRET` | 2 refs (Sentry → app webhook) | none | none | N | **Undocumented webhook secret** |

### 3.8 Origin URLs (FLAGGED — same logical config split 3 ways)

| Variable | Read in | Fallback / default | Issues |
|---|---|---|---|
| `NEXT_PUBLIC_APP_URL` | [src/app/api/sms-reply/route.ts:167](src/app/api/sms-reply/route.ts:167) (1st), [src/app/api/stripe/create-checkout/route.ts:97](src/app/api/stripe/create-checkout/route.ts:97) (only) | falls back to `'https://getstaxis.com'` in stripe route | **Inconsistent precedence across files** |
| `NEXT_PUBLIC_SITE_URL` | [src/app/api/sms-reply/route.ts:168](src/app/api/sms-reply/route.ts:168) (2nd), [src/app/api/admin/properties/create/route.ts:416](src/app/api/admin/properties/create/route.ts:416) (only) | falls back to `'https://getstaxis.com'` in properties route | |
| `NEXT_PUBLIC_BASE_URL` | [src/app/api/sms-reply/route.ts:169](src/app/api/sms-reply/route.ts:169) (3rd only) | none | **Set in example but never read except as 3rd-tier fallback in one route** |

All three live in `.env.local.example`. Three different files, three different precedence orders. Pick one. (The schema-based recommendation collapses them into `env.APP_URL`.)

### 3.9 Cron / internal secrets

| Variable | Read in | Fallback / default | Startup validation | In example? | Issues |
|---|---|---|---|---|---|
| `CRON_SECRET` | 17 refs (every cron route header check) | none | crash on first call (each cron route checks at top) | Y | OK |
| `LOCAL_SYNC_SECRET` | 1 ref (internal sync route) | none | crash on first call | N | Undocumented |
| `GITHUB_WEBHOOK_SECRET` | 1 ref (GitHub webhook handler) | none | crash on first call | Y | OK |

### 3.10 Voice / wake word

| Variable | Read in | Fallback / default | Startup validation | In example? | Issues |
|---|---|---|---|---|---|
| `PICOVOICE_ACCESS_KEY` | 3 refs (wake-word client) | none | none | N (docs in [docs/wake-word-setup.md](docs/wake-word-setup.md)) | Documented in docs but not in example |

### 3.11 reCAPTCHA

| Variable | Read in | Fallback / default | Startup validation | In example? | Issues |
|---|---|---|---|---|---|
| `NEXT_PUBLIC_RECAPTCHA_SITE_KEY` | client signup form | none | none | Y | OK (optional) |

### 3.12 PMS scraper (Choice Advantage)

| Variable | Read in | Fallback / default | Startup validation | In example? | Issues |
|---|---|---|---|---|---|
| `CA_USERNAME` | [scraper/scraper.js](scraper/scraper.js) (`CONFIG`), `properties-loader.js` | DB fallback via properties loader | none in scraper.js | Y (scraper/.env.example) | OK |
| `CA_PASSWORD` | same | DB fallback | none | Y | OK |
| `HOTELOPS_PROPERTY_ID` | scraper, properties-loader | DB fallback | none | Y | OK |
| `HOTELOPS_USER_ID` | declared in scraper/.env.example; **NOT actually read in scraper code** (only referenced as a print statement in [scripts/seed-supabase.js:444](scripts/seed-supabase.js:444)) | n/a | n/a | Y (orphan) | **Declared but never read** |
| `TIMEZONE` | scraper [scraper.js:90 area](scraper/scraper.js) + main app | default `'America/Chicago'` | none | Y | OK |
| `TICK_MINUTES` | [scraper/scraper.js:90](scraper/scraper.js:90) | default `5` | none | N | Undocumented tuning knob |
| `SCRAPE_INTERVAL_MINUTES` | declared in `scraper/.env.example`; not in `process.env.SCRAPE_INTERVAL_MINUTES` greps | n/a | n/a | Y (orphan) | **Declared but never read** — duplicates `TICK_MINUTES` |
| `OPERATIONAL_HOURS_START` / `_END` | declared in `scraper/.env.example`; not read | n/a | n/a | Y (orphan) | **Declared but never read** |
| `CSV_TEST_ON_STARTUP` | 1 ref in scraper | default `false`-ish | none | N | Undocumented |
| `HEADED` | 1 ref (Playwright headed mode) | default headless | none | N | Undocumented |
| `PORT` | scraper | default in code | none | N | Auto-injected by Railway |
| `SCRAPER_INSTANCE_ID` | 1 ref (instance tagging) | default `hostname` | none | N | Undocumented |
| `MIN_EXPECTED_ROOMS` | [scraper/csv-scraper.js:929](scraper/csv-scraper.js:929) | default `60` | none | N | Undocumented sanity check |

### 3.13 CUA worker (Fly.io)

| Variable | Read in | Fallback / default | Startup validation | In example? | Issues |
|---|---|---|---|---|---|
| `JOB_TIMEOUT_MS` | cua-service worker | default `900000` (15 min) | none (parseInt with default) | N (set in [cua-service/fly.toml](cua-service/fly.toml)) | OK |
| `POLL_INTERVAL_MS` | cua-service worker | default `5000` | none | N (in fly.toml) | OK |
| `PULL_TIMEOUT_MS` | cua-service worker | default | none | N | Undocumented |
| `WORKER_ID_PREFIX` | cua-service worker | default `'fly-cua'` | none | N (in fly.toml) | OK |
| `CUA_JOB_COST_CAP_MICROS` | cua-service | default `5_000_000` ($5) | none | N | **Cost ceiling — should be documented** (Codex audit pass-6 P1) |
| `FLY_APP_NAME` | cua-service + admin/codex route | default `'staxis-cua'` | none | Y | OK (auto-injected on Fly) |
| `FLY_MACHINE_ID` | cua-service | none | none | N | Auto-injected by Fly |
| `FLY_REGION` | cua-service | none | none | N | Auto-injected by Fly |
| `HOSTNAME` | cua-service | default `'local'` | none | N | Auto-injected by Fly |

### 3.14 ML routing (web app → Python service)

| Variable | Read in | Fallback / default | Startup validation | In example? | Issues |
|---|---|---|---|---|---|
| `ML_SERVICE_URL` | 20 refs (single-shard inference) | falls back to `ML_SERVICE_URLS` | none | Y | Same logical config as plural form |
| `ML_SERVICE_URLS` | 16 refs (multi-shard, deterministic FNV-1a routing) | takes precedence over singular | none | Y | Same logical config as singular form |
| `ML_SERVICE_SECRET` | 18 refs (bearer auth) | none | Pydantic on Python side (min 8 chars); none on TS side | Y | OK |

### 3.15 Admin / DevOps tokens

| Variable | Read in | Fallback / default | Startup validation | In example? | Issues |
|---|---|---|---|---|---|
| `GITHUB_TOKEN` | 10 refs (PR/issue routes, doctor) | none | none — first call 500s | Y | OK |
| `VERCEL_API_TOKEN` | 1 ref (doctor) | none | none | Y | OK |
| `VERCEL_PROJECT_ID` | 1 ref (doctor) | none | none | Y | OK |
| `VERCEL_TEAM_ID` | 2 refs (doctor) | none | none | Y | OK |
| `VERCEL_DOCTOR_URL` | [scraper/vercel-watchdog.js:86](scraper/vercel-watchdog.js:86) | none | none | Y | OK (not orphan as it first appeared — read by scraper watchdog) |
| `FLY_API_TOKEN` | 1 ref (admin/codex trigger) | none | none | Y | OK |
| `RAILWAY_SCRAPER_URL` | 1 ref (scraper-health cron) | none | none | Y | OK |

### 3.16 Platform auto-injected (best-effort metadata)

| Variable | Read in | Source | Issues |
|---|---|---|---|
| `NODE_ENV` | 6 refs (dev/prod branching) | set by Next/Vercel | OK |
| `CI` | next.config.ts (Sentry suppression) | GitHub Actions, Vercel | OK |
| `NEXT_RUNTIME` | 2 refs (edge vs node disambiguation) | Next | OK |
| `VERCEL_ENV` | 13 refs | Vercel | OK |
| `VERCEL_GIT_COMMIT_SHA` | 2 refs (release tagging) | Vercel | OK |
| `VERCEL_REGION` | 1 ref | Vercel | OK |
| `VERCEL_DEPLOYMENT_CREATED_AT` | 1 ref | Vercel | OK |
| `VERCEL` | 1 ref | Vercel | OK |

### 3.17 ML service (Python — Pydantic-validated)

Defined in [ml-service/src/config.py](ml-service/src/config.py). All validated by Pydantic `BaseSettings` at process start.

| Variable | Default | Notes |
|---|---|---|
| `SUPABASE_URL` | required | |
| `SUPABASE_SERVICE_ROLE_KEY` | required | |
| `ML_SERVICE_SECRET` | required, min 8 chars | |
| `LOG_LEVEL` | `'INFO'` | |
| `DATABASE_URL` / `SUPABASE_DB_URL` | optional (one or the other) | |
| `TRAINING_ROW_COUNT_MIN` | 200 | |
| `TRAINING_ROW_COUNT_ACTIVATION` | 500 | |
| `VALIDATION_MAE_RATIO_THRESHOLD` | 0.10 | |
| `VALIDATION_MAE_FLOOR` | 1.0 | |
| `BASELINE_BEAT_PCT_THRESHOLD` | 0.20 | |
| `CONSECUTIVE_PASSING_RUNS_REQUIRED` | 2 | |
| `MIN_HOURS_BETWEEN_PASSING_RUNS` | 24 | |
| `SHIFT_CAP_MINUTES` | 420 | |
| `TARGET_COMPLETION_PROBABILITY` | 0.95 | |
| `MONTE_CARLO_DRAWS` | 1000 | |
| `AUTO_ROLLBACK_WINDOW_DAYS` | 14 | |
| `AUTO_ROLLBACK_PVALUE_THRESHOLD` | 0.05 | |
| `DISAGREEMENT_THRESHOLD_FALLBACK` | 0.30 | |
| `DISAGREEMENT_ZSCORE_THRESHOLD` | 2.0 | |
| `INVENTORY_MIN_EVENTS_PER_ITEM` | 3 | |
| `INVENTORY_XGBOOST_ACTIVATION_EVENTS` | 100 | |
| `INVENTORY_GRADUATION_MIN_EVENTS` | 30 | |
| `INVENTORY_GRADUATION_MAE_RATIO` | 0.10 | |
| `INVENTORY_GRADUATION_CONSECUTIVE_PASSES` | 5 | |

This is the only service in the repo doing things properly. It's the model the JS/TS side should mirror.

### 3.18 Misc / test-only

| Variable | Read in | Issues |
|---|---|---|
| `SMOKE_PROPERTY_ID` | smoke-test route | Undocumented |
| `STAXIS_DEFAULT_PROPERTY_ID` | declared in `.env.local.example`; **no `process.env.STAXIS_DEFAULT_PROPERTY_ID` reader found** in `src/`, `scripts/`, or `scraper/` | **Declared but never read** |

### 3.19 Ops alert phone (FLAGGED — same logical config split 2 ways)

| Variable | Read in | Issues |
|---|---|---|
| `MANAGER_PHONE` | 8 refs (cron routes, scraper) | Legacy name, still preferred in most reads |
| `OPS_ALERT_PHONE` | 8 refs (cron routes, scraper) | Modern name; doctor route ([src/app/api/admin/doctor/route.ts:276](src/app/api/admin/doctor/route.ts:276)) knows both |

Always read as `MANAGER_PHONE || OPS_ALERT_PHONE`. Pick one canonical name.

---

## 4. Findings

### 4a. Referenced in code but NOT in any `.env.example` (orphan code-side)

These vars are read by the running app but a developer cloning the repo gets zero documentation of their existence:

- `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_WEBHOOK_SECRET` — entire voice/agent integration undocumented
- `RESEND_API_KEY` — all email sending silently broken if missing
- `MODEL_OVERRIDE` — LLM escape hatch
- `LOCAL_SYNC_SECRET` — internal sync route auth
- `SMOKE_PROPERTY_ID` — smoke tests
- `SENTRY_WEBHOOK_SECRET` — Sentry → app webhook (security-relevant)
- `TWILIO_BALANCE_WARN_USD`, `TWILIO_BALANCE_FAIL_USD` — alert thresholds
- `CUA_JOB_COST_CAP_MICROS` — cost ceiling (Codex audit pass-6 P1 safety net)
- `JOB_TIMEOUT_MS`, `POLL_INTERVAL_MS`, `PULL_TIMEOUT_MS`, `WORKER_ID_PREFIX` — set in `cua-service/fly.toml`, never surfaced in any example
- `CSV_TEST_ON_STARTUP`, `TICK_MINUTES`, `SCRAPER_INSTANCE_ID`, `HEADED`, `MIN_EXPECTED_ROOMS` — scraper tuning
- `LOG_LEVEL`, `DATABASE_URL`, `SUPABASE_DB_URL`, `SUPABASE_DB_HOST`, `SUPABASE_DB_PASSWORD` — only mentioned in `ml-service/README.md`, not in the main example
- `PICOVOICE_ACCESS_KEY` — only in `docs/wake-word-setup.md`, not in example
- `NEXT_RUNTIME`, `VERCEL`, `VERCEL_REGION`, `VERCEL_DEPLOYMENT_CREATED_AT` — platform-injected, fine

### 4b. Declared in example/config but NOT read by code (orphan declaration-side)

- `STAXIS_DEFAULT_PROPERTY_ID` — listed in `.env.local.example`, only referenced as a `console.log` string in [scripts/seed-supabase.js:444](scripts/seed-supabase.js:444). Never actually used to gate behaviour.
- `SCRAPE_INTERVAL_MINUTES`, `OPERATIONAL_HOURS_START`, `OPERATIONAL_HOURS_END` — declared in `scraper/.env.example`, no `process.env.SCRAPE_INTERVAL_MINUTES` etc. readers in scraper code (the live tuning knob is `TICK_MINUTES`).
- `HOTELOPS_USER_ID` — declared in `scraper/.env.example`, only referenced in `scripts/seed-supabase.js:444` as a print statement. Scraper credentials are loaded from DB now (`properties-loader.js`), not env.
- `NEXT_PUBLIC_BASE_URL` — declared in example, only read as the *third* fallback in one route ([src/app/api/sms-reply/route.ts:169](src/app/api/sms-reply/route.ts:169)). Effectively dead.

### 4c. Same logical config, multiple variable names (inconsistencies)

| Logical config | Variables (precedence varies) | Where they diverge |
|---|---|---|
| App origin URL | `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_BASE_URL` | [src/app/api/sms-reply/route.ts:167–169](src/app/api/sms-reply/route.ts:167) reads all three (APP > SITE > BASE); [src/app/api/stripe/create-checkout/route.ts:97](src/app/api/stripe/create-checkout/route.ts:97) reads only `APP_URL`; [src/app/api/admin/properties/create/route.ts:416](src/app/api/admin/properties/create/route.ts:416) reads only `SITE_URL`. |
| Twilio sender | `TWILIO_FROM_NUMBER`, `TWILIO_PHONE_NUMBER` | [src/lib/sms.ts:30](src/lib/sms.ts:30) reads `FROM_NUMBER \|\| PHONE_NUMBER`. Doctor knows both ([doctor/route.ts:274](src/app/api/admin/doctor/route.ts:274)). Legacy migration incomplete. |
| Ops alert phone | `MANAGER_PHONE`, `OPS_ALERT_PHONE` | All cron routes read `MANAGER_PHONE \|\| OPS_ALERT_PHONE`. Doctor knows both ([doctor/route.ts:276](src/app/api/admin/doctor/route.ts:276)). |
| Supabase project URL | `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_URL` | [cua-service/src/supabase.ts:12](cua-service/src/supabase.ts:12) reads `NEXT_PUBLIC_SUPABASE_URL ?? SUPABASE_URL`; main app reads only the prefixed form; scraper reads `SUPABASE_URL`. Tests workflow inlines both. |
| Postgres DSN | `DATABASE_URL`, `SUPABASE_DB_URL` | ML service ([config.py:86](ml-service/src/config.py:86) and 3 training scripts) accepts either with different precedence per file (`DATABASE_URL or SUPABASE_DB_URL` in config; reverse in training scripts). |
| ML service URL(s) | `ML_SERVICE_URL`, `ML_SERVICE_URLS` | Singular = legacy single shard, plural = multi-shard. Plural takes precedence everywhere. Documented but the singular field should eventually be removed. |

### 4d. Validation timing — where things break

| Tier | Vars | Failure mode |
|---|---|---|
| Crash on import (desired for required prod secrets) | `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (both services), `ANTHROPIC_API_KEY` (cua-service), all 5 required ml-service vars | Boot fails immediately with actionable message |
| Crash on first call | `TWILIO_*` (via [sms.ts:32–34](src/lib/sms.ts:32)), `CRON_SECRET` (every cron route), `LOCAL_SYNC_SECRET`, `GITHUB_WEBHOOK_SECRET` | First request 500s — bad UX, only surfaces in prod when the cron fires |
| Graceful disable (intentional) | `STRIPE_*` (returns `{ disabled: true }`), `SENTRY_*` (SDK no-ops) | OK |
| **No validation at all** | `ELEVENLABS_*`, `RESEND_API_KEY`, `MODEL_OVERRIDE`, `PICOVOICE_ACCESS_KEY`, `GITHUB_TOKEN`, `VERCEL_*` tokens, `FLY_*` tokens, `RAILWAY_SCRAPER_URL`, `STRIPE_PRICE_ID` if Stripe is on, `TWILIO_BALANCE_*`, scraper tuning vars | Silent `undefined` → unpredictable downstream (string concat `"undefined"` in URLs, JSON serialisation as `null`, etc.). Hardest tier to debug. |

---

## 5. Recommendation: canonical config module

### What

A single source of truth per service, built on **Zod**:

- `src/lib/env.ts` — main Next.js app (server + client schemas)
- `cua-service/src/env.ts` — Fly worker
- `scraper/env.js` — Railway scraper (plain JS, Zod via CommonJS)
- `ml-service/src/config.py` — **already exists, no change needed**

Each TS module exposes:

```ts
// shape (illustrative; not to be implemented in this PR)
import { z } from 'zod';

const serverSchema = z.object({
  // Required — boot fails if missing
  SUPABASE_URL: z.string().url(),                  // accepts NEXT_PUBLIC_SUPABASE_URL as fallback in transform
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  ANTHROPIC_API_KEY: z.string().startsWith('sk-ant-'),
  CRON_SECRET: z.string().min(16),

  // Optional with sane defaults
  TWILIO_FROM_NUMBER: z.string().regex(/^\+\d{10,}$/).optional(),  // accepts TWILIO_PHONE_NUMBER as legacy fallback
  OPS_ALERT_PHONE:    z.string().regex(/^\+\d{10,}$/).optional(),  // accepts MANAGER_PHONE as legacy fallback
  APP_URL:            z.string().url().default('https://getstaxis.com'),
                       // built from NEXT_PUBLIC_APP_URL ?? NEXT_PUBLIC_SITE_URL ?? NEXT_PUBLIC_BASE_URL
  STRIPE_SECRET_KEY:  z.string().optional(),  // graceful disable retained
  // ...
});

const clientSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string(),
  NEXT_PUBLIC_APP_URL: z.string().url().optional(),
  // ...
});

export const env = serverSchema.parse({
  // explicit destructure so `next build` sees the env-var names
  SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL,
  TWILIO_FROM_NUMBER: process.env.TWILIO_FROM_NUMBER ?? process.env.TWILIO_PHONE_NUMBER,
  OPS_ALERT_PHONE: process.env.OPS_ALERT_PHONE ?? process.env.MANAGER_PHONE,
  APP_URL: process.env.NEXT_PUBLIC_APP_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? process.env.NEXT_PUBLIC_BASE_URL,
  // ...
});
```

Boot behaviour:
- `serverSchema.parse(...)` runs at module import. A single Zod error lists every missing/invalid var. Vercel build logs and Fly machine logs both surface it.
- Aggregated error beats the current pattern (`supabase-admin.ts` throws for Supabase, then `anthropic-client.ts` throws for Anthropic, then `sms.ts` throws on first SMS — three separate boot debug cycles).
- Client schema is parsed in a `'use client'` boundary file (`src/lib/env-client.ts`) so the bundler only ships the `NEXT_PUBLIC_*` subset to the browser.

### Files that switch to importing from `env`

**Main app (~150+ files based on `grep -rn process.env. src/`):**
- Validation modules consolidated into the new schema, manual throws deleted:
  - [src/lib/supabase-admin.ts:18–29](src/lib/supabase-admin.ts:18) — drop manual missing-vars throw, import `env`
  - [src/lib/sms.ts:28–34](src/lib/sms.ts:28) — drop manual throw, import `env`, schema already merged `FROM_NUMBER`/`PHONE_NUMBER`
  - [src/lib/stripe.ts:23–25](src/lib/stripe.ts:23) — import `env.STRIPE_*`, keep `stripeIsConfigured` flag computed from optional schema fields
- Every `src/app/api/**/*.ts` route reading `process.env.X` — mechanical replacement
- [src/lib/anthropic*.ts](src/lib/), [src/lib/elevenlabs*.ts](src/lib/), [src/lib/email/*.ts](src/lib/email/), `src/lib/twilio*.ts` — same
- [next.config.ts](next.config.ts) — only references `NEXT_PUBLIC_SUPABASE_URL` (CSP), `NODE_ENV`, `CI`; minimal change, use the client schema's parse result
- [sentry.server.config.ts](sentry.server.config.ts), [sentry.client.config.ts](sentry.client.config.ts), [sentry.edge.config.ts](sentry.edge.config.ts) — switch DSN reads

**cua-service (~30 files):**
- [cua-service/src/supabase.ts:12–26](cua-service/src/supabase.ts:12) — drop manual throw
- [cua-service/src/anthropic-client.ts:20–27](cua-service/src/anthropic-client.ts:20) — drop manual throw
- `cua-service/src/worker.ts`, `cua-service/src/jobs/*.ts` — switch all `process.env.X` reads

**scraper (~10 files):**
- [scraper/scraper.js:69–94](scraper/scraper.js:69) `CONFIG` object — replace with `scraper/env.js` Zod parse
- [scraper/csv-scraper.js:929](scraper/csv-scraper.js:929), [scraper/properties-loader.js](scraper/properties-loader.js), [scraper/supabase-helpers.js](scraper/supabase-helpers.js), [scraper/vercel-watchdog.js:86](scraper/vercel-watchdog.js:86) — switch reads

**Reconciled inconsistencies after migration:**
- `env.APP_URL` — single field, fallback chain `NEXT_PUBLIC_APP_URL ?? NEXT_PUBLIC_SITE_URL ?? NEXT_PUBLIC_BASE_URL ?? 'https://getstaxis.com'`. Delete `NEXT_PUBLIC_BASE_URL` from example after one release.
- `env.TWILIO_FROM_NUMBER` — accepts legacy `TWILIO_PHONE_NUMBER`. Delete legacy from example after one release.
- `env.OPS_ALERT_PHONE` — accepts legacy `MANAGER_PHONE`. Delete legacy from example after one release.
- `env.SUPABASE_URL` — single field, accepts either prefix. The CSP code in `next.config.ts` still reads `NEXT_PUBLIC_SUPABASE_URL` directly because it's evaluated before module-level code runs — keep that as a single-line exception.

### Why Zod (and not the alternatives)

- **Zod**: ~20kb, zero runtime deps, already familiar to the team's stack (heavily used in Next.js apps), TypeScript-first. Wins on familiarity + ecosystem.
- `@t3-oss/env-nextjs`: thin wrapper around Zod. Worth considering for the auto server/client split, but adds a dependency for ~50 lines of code we can write ourselves. Defer unless needed.
- `envalid`/`envsafe`: less mindshare, no TS edge.
- Plain `if (!process.env.X) throw`: what we have now, scattered. Doesn't aggregate errors, doesn't validate format (no regex on phone numbers, no `.url()` check), no autocomplete on `env.X`.

### Migration plan (specified, not executed in this PR)

1. **Land the module + parallel reads** (1 day): add `src/lib/env.ts` with the full schema. Don't yet replace `process.env.X` reads. Ship + verify the boot validation actually fires (set a bad value in a preview branch).
2. **Sweep main app** (1 day): mechanical replacement of `process.env.X` → `env.X` across `src/`. PR per logical area (Twilio, Stripe, Supabase, etc.) to keep diffs reviewable.
3. **Sweep cua-service** (½ day): copy schema, adapt to cua-service's narrower surface.
4. **Sweep scraper** (2 hours): replace `CONFIG` object.
5. **Update `.env.local.example`** with every var from the schema, grouped, commented. Delete the three orphans (`STAXIS_DEFAULT_PROPERTY_ID`, `SCRAPE_INTERVAL_MINUTES`/`OPERATIONAL_HOURS_*`, `NEXT_PUBLIC_BASE_URL`).
6. **Deprecate the inconsistent doubles** (one-line warning when the legacy form is used, deletion after one release).

Total: ~2.5 engineer-days. Zero behaviour change once complete.

---

## 6. Caveats

- **Edge runtime**: Next.js edge routes don't have full `process.env` — some vars only resolve at deploy time. The client schema covers `NEXT_PUBLIC_*`; for edge-specific reads, mark them optional in the schema or split a third `edgeSchema`.
- **Tests**: `.github/workflows/tests.yml` inlines placeholder values (`NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co`). The schema must tolerate these — use `.url()` for URL checks but accept any non-empty string for keys. CI runs would otherwise fail.
- **Platform-injected vars** (`VERCEL_*`, `FLY_*`, `HOSTNAME`, `PORT`) stay outside the required schema — declare as optional metadata so missing them in local dev doesn't crash anything.
- **Python**: don't unify cross-language. `ml-service/src/config.py` already does the right thing in Pydantic. Mirror the *pattern*, not the *module*.

---

## Appendix A: file:line index of every `process.env.X` read

Generated via:

```
grep -rnE "process\.env\.[A-Z_]+" src/ cua-service/src/ scraper/ scripts/ \
  --include='*.ts' --include='*.tsx' --include='*.js'
```

For the full enumerated list (333+ lines), see git history for this branch; the table in section 3 covers every distinct variable with at least one citation. To rebuild the dump locally:

```
grep -rnE "process\.env\.[A-Z_]+" src/ cua-service/src/ scraper/ \
  | sort > /tmp/env-refs.txt
```
