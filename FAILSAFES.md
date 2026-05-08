# FAILSAFES.md

The guardrails that catch silent failures. Each exists because of a specific past incident; weakening any of them costs Twilio credits or missed shift confirmations.

**Do not delete, weaken, or "simplify" any of these without understanding what they protect against.** `CLAUDE.md` lists the names as a deterrent; this file has the why and the editing rules.

---

## 1. `/api/admin/doctor` (`src/app/api/admin/doctor/route.ts`)

Single URL that tests every critical dependency — env vars, Supabase Admin auth, Postgres reads, Twilio credentials, CRON_SECRET shape. Returns structured JSON with per-check status. Called by:

- Post-deploy smoke test (every push to main)
- Daily drift check (once per day, 8am Central)
- Railway-hosted Vercel watchdog (every 5 min)
- Reeyen, manually, whenever anything smells off

### Rules for editing

- New required env var anywhere in the app → **add it to `REQUIRED_ENV_VARS`** in the doctor route.
- New external dependency (new API, new platform) → **add a check function** for it.
- Every check must return a `fix` string with an exact, actionable remediation — no "check the logs" vagueness.
- Don't remove checks. If a check is consistently green and you think it's redundant, leave it — the cost is microseconds, the deterrent is permanent.

---

## 2. `supabase-admin.ts` fails loudly (`src/lib/supabase-admin.ts`)

Throws at module load if `NEXT_PUBLIC_SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` are missing. `verifySupabaseAdmin()` does a preflight read against `scraper_status` with an exact error message pointing to the key rotation playbook in `RUNBOOKS.md`.

### Rules for editing

- **Do not replace the throw with `console.warn`** — silent warn is what caused the Apr 20/21 incident (silent prod failure for hours because the missing env var didn't crash the build).
- The error message is intentionally specific (mentions which env var, which platform to check). Don't dilute it.
- If you need a no-throw variant for some specific case (e.g., a build-time tool), create a separate helper — don't soften the main one.

---

## 3. Scraper fails loudly (`scraper/scraper.js`)

Does a preflight Postgres read at startup against `scraper_status`. `process.exit(1)` if it fails. Railway crash-loops visibly — scraper-health cron catches it within 15 min.

### Rules for editing

- **Don't catch the preflight error and continue.** The whole point is a visible crash-loop on Railway, not a silently broken scraper.
- If you need to add new startup checks, add them alongside (not replace).

---

## 4. GitHub Actions workflows (`.github/workflows/`)

| Workflow | Cadence | What it catches |
|---|---|---|
| `tests.yml` | Every push and PR | Broken tests |
| `post-deploy-smoke-test.yml` | Every push to main | Broken deploy, missing/stale env vars |
| `daily-drift-check.yml` | 8am Central daily | Credential drift between Vercel, Railway, Fly |
| `scraper-health-cron.yml` | Every 15 min | Scraper process dead, CA errors, stale data |
| `scraper-weekly-digest-cron.yml` | Saturdays 8am Central | Weekly scraper performance summary |
| `sms-jobs-cron.yml`, `ml-cron.yml` | Per-feature | Background job processors |

Each workflow uses `CRON_SECRET` from GitHub repo secrets, prints the full response body, uses `--retry 2` for transient blips, and fails loudly so GitHub emails Reeyen.

### Rules for editing

- Don't disable any of these "temporarily" — the daily drift check has caught real cross-platform credential drift more than once.
- New cron endpoint? Add a workflow for it. Mirror the pattern in `scraper-health-cron.yml`.
- Don't switch off `--retry 2`. Transient 502s shouldn't page Reeyen.

---

## 5. Railway-hosted Vercel watchdog (`scraper/vercel-watchdog.js`)

The Railway scraper pings `/api/admin/doctor` every 5 min — **cross-platform failsafe**, completely independent of GitHub Actions. Catches Vercel outages and CRON_SECRET drift even if GitHub itself is down.

- 3-failure threshold (15 min) before SMS alerts, to absorb transient 502s.
- `auth_mismatch` (HTTP 401) short-circuits the threshold — alerts on first occurrence (auth drift is never transient).
- Alerts only during business hours (6am–10pm Central) to avoid 3am SMS noise.
- 6h re-alert interval to avoid SMS spam during ongoing outages.
- State persisted in Postgres `scraper_status` table (key=`vercelWatchdog`).
- Wrapped in its own try/catch inside `scraper.js` so it can **never crash the main scraper loop** — if watchdog code has a bug, scraper keeps running and logs `[watchdog] crashed (non-fatal)`.
- Gracefully **no-ops if `CRON_SECRET` is missing** on Railway (no crash) — defensive default so missing env var doesn't break the scraper.

### Rules for editing

- **Don't remove the try/catch wrapper around `runVercelWatchdog()` in `scraper.js tick()`.** The isolation is the whole point. A bug in watchdog code must never bring down the main scraper.
- To temporarily disable the watchdog: unset `CRON_SECRET` on Railway → watchdog no-ops automatically. Don't comment out the call.
- Don't tighten the threshold below 3 — transient 502s during Vercel deploys are normal.
- Don't expand alert hours. 3am SMS makes Reeyen distrust the system.

---

## 6. `RUNBOOKS.md`

Symptom → diagnosis → fix → verify → prevention, per failure type. When a new class of bug bites, add a section so we don't re-diagnose from scratch.

### Rules for editing

- Match the existing five-section format.
- "Fix" steps must be exact and copy-pasteable. No "check the logs" hand-waving.
- "Prevention" must point at the specific failsafe (or workflow, or check) that catches this next time. If there isn't one, add one and link it.

---

## How to verify all failsafes still work

Run after any significant infra change:

```bash
# 1. Doctor — all checks green
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://hotelops-ai.vercel.app/api/admin/doctor | python3 -m json.tool

# 2. Scraper-health — condition:ok
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://hotelops-ai.vercel.app/api/cron/scraper-health

# 3. Manually trigger from GitHub Actions UI:
#    - Post-deploy smoke test → Run workflow → should pass in 2-3 min
#    - Daily drift check → Run workflow → should pass in <1 min
```

If any fail unexpectedly, **stop and investigate** before making more changes. The failsafes are catching real drift.
