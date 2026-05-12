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

## 4. Scheduler tiers — when to use what

We deliberately split crons across two schedulers because they have different reliability profiles. Pick the right tier for the cadence.

### Vercel native crons (`vercel.json`)
**Use for:** cadence under 30 minutes, OR any cron where reliable timing matters operationally.

| Path | Cadence | What it does |
|---|---|---|
| `/api/cron/process-sms-jobs` | every 5 min | Drains SMS jobs queue → Twilio |
| `/api/cron/scraper-health` | every 15 min | Alerting watchdog for dead scrapers |
| `/api/cron/expire-trials` | daily 09:00 UTC | Flips expired trial accounts |

Vercel Pro guarantees per-minute precision. We moved `process-sms-jobs` and `scraper-health` here in May 2026 audit pass-6 after observing GitHub Actions throttle them by 7-17×.

### GitHub Actions workflows (`.github/workflows/`)
**Use for:** daily/weekly cadences where hour-scale precision is fine.

| Workflow | Cadence | What it catches |
|---|---|---|
| `tests.yml` | Every push and PR | Broken tests |
| `post-deploy-smoke-test.yml` | Every push to main | Broken deploy, missing/stale env vars |
| `daily-drift-check.yml` | 8am Central daily | Credential drift between Vercel, Railway, Fly |
| `seal-daily-cron.yml` | Hourly | Per-property attendance marks + daily_logs |
| `ml-cron.yml` | Multiple daily + weekly | ML training, inference, prior aggregation |
| `ml-shadow-evaluate-cron.yml` | Daily 11:30 UTC | Shadow-model promotion/rejection pass |
| `purge-old-error-logs-cron.yml` | Daily 09:30 UTC | error_logs retention sweep + api_limits cleanup |
| `scraper-weekly-digest-cron.yml` | Sat 14:00 UTC | Weekly scraper performance summary |
| `pull-jobs-cron.yml` | Disabled (workflow_dispatch only) | Future: drain Railway pull-jobs queue |

Each workflow uses `CRON_SECRET` from GitHub repo secrets, prints the full response body, uses `--retry 1` (was 2 before pass-6) for transient blips, and fails loudly so GitHub emails Reeyen.

### Rules for editing

- **Don't put a new sub-30-min cron on GitHub Actions.** GH publicly documents that tight cron schedules are best-effort; we've measured 7-17× delays. Use Vercel native instead.
- **Don't disable any workflow "temporarily"** — the daily drift check has caught real cross-platform credential drift more than once.
- **New cron endpoint?**
  - Decide tier (Vercel vs GH). Sub-30-min → Vercel; daily/weekly → GH.
  - Add the route's heartbeat to `EXPECTED_CRONS` in `src/app/api/admin/doctor/route.ts`.
  - Add the schedule to `SCHEDULE_REGISTRY` in `src/lib/__tests__/cron-cadences.test.ts` — the test enforces alignment.
- **Don't switch off `--retry 1` on workflow curls.** Transient 502s shouldn't fail the workflow.

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

## 7. Cron heartbeats (`src/lib/cron-heartbeat.ts` + migration 0074)

**What it does:** Every cron route's LAST step is a write to `cron_heartbeats` with its name + timestamp. The doctor's `cron_heartbeats_fresh` check reads back and fails if any expected cron is older than 2× its cadence. Independent of GitHub Actions' "workflow succeeded" signal (which silent-passed for weeks while inner ML calls all failed).

**Why it exists:** The May 2026 audit found that the previous health signal — "GitHub Actions workflow returned 200" — could be green while the route silently aggregated 100% per-item errors. A heartbeat written AFTER all the real work means "the route actually finished, not just returned." Pairs with the tightened jq checks in `ml-cron.yml` and `seal-daily-cron.yml`.

**Don't:**
- Move the `writeCronHeartbeat()` call earlier in the route. It must come AFTER every write that matters; otherwise a silent partial-failure still writes the heartbeat.
- Remove a workflow from the `EXPECTED_CRONS` list in `doctor/route.ts` without also removing the cron itself. Otherwise the doctor reports "missing heartbeat" forever.
- Bump the cadence multiplier from 2× to 3× or higher. 2× catches one missed tick; higher hides drift.

**Touch points:** every file under `src/app/api/cron/`, plus the doctor route's `EXPECTED_CRONS` list. When you add a new cron, update both.

---

## 8. Tier 3 fleet-ops invariants

These are guards added in the May 2026 multi-tenant scaling work. Don't weaken them in a refactor.

**`requireAdminOrCron` (`src/lib/admin-auth.ts`)** — fleet endpoints (`/api/admin/scraper-instances`, `/api/admin/scraper-assign`) require admin role OR `CRON_SECRET`. The earlier draft used `requireSessionOrCron` which accepted ANY signed-in user; that let non-admin staff reassign hotels between scrapers. Don't loosen.

**`cleanTagValue` (`src/lib/sentry.ts`, `cua-service/src/sentry.ts`)** — clamps Sentry tag values to 200 codepoints with whitespace collapse + ellipsis. Uses `Array.from` so surrogate pairs (emoji in hotel names) survive truncation intact. Don't replace with `.slice()` — silently produces invalid UTF-16 on emoji.

**`resolveMlShardUrl` / FNV-1a hash (`src/lib/ml-routing.ts`)** — the partition function that maps property UUIDs to ML shard URLs. FNV-1a hashes the FULL string, not just the first 8 hex chars; this is what makes the partition stable across UUID v4 / v7 / non-UUID inputs. Don't switch back to a prefix slice — UUID v7 would catastrophically collapse all same-second properties onto one shard.

**`scraper_credentials.scraper_instance` CHECK constraint (migration 0073)** — enforces `^[A-Za-z0-9._-]{1,64}$` at the DB layer regardless of write path. The TS validator does the same on the admin reassign endpoint, but a direct service-role INSERT or a future API that forgets to validate would bypass it. Don't drop the constraint.

**`promote_shadow_model_run` (migration 0072)** — atomic ONE-statement swap that deactivates the prior active model AND activates the shadow in the same transaction. The pre-audit version did two separate UPDATEs; a mid-promotion failure could leave an item with NO active model (predictions stop until next retrain). Don't refactor to two calls "for clarity."

**Tier 3 fleet ownership recheck (`scraper/scraper.js` tick prologue)** — every tick re-reads `scraper_credentials.scraper_instance` for the active property. If it no longer matches our `SCRAPER_INSTANCE_ID` env, the tick is skipped. Closes the 60-second reassignment overlap window from the properties-loader cache. Don't remove — without it, two Railway instances will briefly both write data for a reassigned hotel.

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
