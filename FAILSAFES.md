# FAILSAFES.md

The guardrails that catch silent failures. Each exists because of a specific past incident; weakening any of them costs real money or a broken customer-facing feature. (2026-07-17: all Twilio texting was retired on the owner's order, so SMS-related failsafes below are historical.)

**Do not delete, weaken, or "simplify" any of these without understanding what they protect against.** `CLAUDE.md` lists the names as a deterrent; this file has the why and the editing rules.

---

## 1. `/api/admin/doctor` (`src/app/api/admin/doctor/route.ts`)

Single URL that tests the critical dependencies. Returns structured JSON with per-check status. Called by the every-5-min vercel-watchdog cron and by Reeyen manually.

**2026-07-17 — owner-ordered slim-down.** Reeyen explicitly ordered the check battery cut from ~45 checks to the three signals he actually acts on, after weeks of alert noise from checks watching retired systems (Twilio texting, dead ML schedulers). The battery is now exactly:

1. **Site works** — `env_vars`, `supabase_admin_auth`, `supabase_migrations_applied` (the manual-migration net).
2. **Robot OK** — `cua_sessions_alive`, `cua_cost_cap_paused`, `cua_mfa_pending`.

Deleted checks (2FA/RLS/storage/Sentry/Stripe/ML/HSTS/cron-heartbeats/etc.) are in git history at commit `8b18232d^..` if a signal ever earns its place back. The underlying protections (RLS itself, 2FA enforcement, cost caps) are all still active — only their *monitoring* was removed.

### Rules for editing

- New required env var anywhere in the app → **add it to `REQUIRED_ENV_VARS`** in the doctor route.
- Every check must return a `fix` string with an exact, actionable remediation — no "check the logs" vagueness.
- Adding a check now requires it to map to one of the owner's three signals (site up / robot OK / AI spend runaway) — anything else is the noise he ordered removed.

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

**The tables below are a summary, not the source of truth.** `vercel.json` and
`.github/workflows/*` are the runtime triggers, and
`src/lib/automation/job-catalog.ts` is the one inventory that parity tests hold
them to. This section drifted badly once (it listed four Vercel crons when
there were nineteen, and named three workflows that had been deleted months
earlier, including one it told you never to disable), so check the catalog
before trusting a row here.

As of 2026-08-07 there are **19 Vercel cron entries**. The five-minute tier is
the operational one:

| Path | Cadence | What it does |
|---|---|---|
| `/api/cron/process-agent-schedules` | every 5 min | Delivers agent reminders + materializes recurring to-dos |
| `/api/cron/agent-sweep-reservations` | every 5 min | Releases stale AI cost reservations |
| `/api/cron/sweep-account-lifecycle` | every 5 min | Finishes interrupted account disable/reactivate operations from their durable intent |
| `/api/cron/vercel-watchdog` | every 5 min | Checks the production app/doctor and fails visibly on red |
| `/api/cron/companion-event-wake` | every 10 min | One deterministic look at each hotel's `activity_log`; a model call only where something landed |

The other fourteen are daily/weekly housekeeping, the AI findings layer's four,
and the retention jobs. `docs/cron-triggers.md` has the full table with
purposes.

Vercel Pro guarantees per-minute precision. Operational sub-30-minute jobs stay here because GitHub Actions has previously delayed tight schedules by 7–17×. The Twilio-backed `process-sms-jobs` worker was retired on 2026-07-17; reminders and recurring in-app tasks must remain independent of any SMS transport.

### GitHub Actions workflows (`.github/workflows/`)
**Use for:** daily/weekly cadences where hour-scale precision is fine.

Every workflow with a LIVE `schedule:` block, as of 2026-08-07:

| Workflow | Cadence | What it catches |
|---|---|---|
| `tests.yml` | Every push and PR | Broken tests |
| `post-deploy-smoke-test.yml` | Every push to main | Broken deploy, missing/stale env vars |
| `ml-cron.yml` | Sun 07:30 + Sun 09:00 + daily 11:00 UTC | Inventory priors, weekly retrain, daily prediction |
| `purge-old-error-logs-cron.yml` | Daily 09:30 UTC | error_logs retention sweep + api_limits cleanup |
| `robot-walk.yml` | Daily 10:00 UTC | A real browser signs into the live site and uses it |
| `dependency-audit.yml` | Mon 09:17 UTC | High/critical dependency advisories |

Manual-only (no live `schedule:`), and kept that way deliberately:
`memory-consolidate-cron.yml`, `ml-retention-purge.yml`, `ml-smoke-nightly.yml`,
`sentry-test.yml`, `check-migrations-applied.yml` (event-driven), and
`ml-shadow-evaluate-cron.yml` (its route is gone; the job is guarded off rather
than deleted).

`daily-drift-check.yml`, `scraper-weekly-digest-cron.yml` and
`pull-jobs-cron.yml` were listed here for months after they stopped existing.
They went with the Railway scraper in the Plan v4 cutover. **The drift check
they described has no replacement**, so nothing compares credentials across
platforms today; treat that as an open gap, not as covered.

Each workflow uses `CRON_SECRET` from GitHub repo secrets, prints the full response body, uses `--retry 1` (was 2 before pass-6) for transient blips, and fails loudly so GitHub emails Reeyen.

**A job nothing can start must not curl a route that exists only in its
comment.** `ml-cron.yml`'s `auto-rollback` job and the whole of
`ml-shadow-evaluate-cron.yml` both call routes that were deleted, and both
accepted `workflow_dispatch`, so every manual run of the ML workflow ended red
on a 404. `cron-coverage.test.ts` now refuses that: any job a trigger can reach
must target a route that is on disk.

### Rules for editing

- **Don't put a new sub-30-min cron on GitHub Actions.** GH publicly documents that tight cron schedules are best-effort; we've measured 7-17× delays. Use Vercel native instead.
- **Don't disable any workflow "temporarily"** — the daily drift check has caught real cross-platform credential drift more than once.
- **New cron endpoint?**
  - Decide tier (Vercel vs GH). Sub-30-min → Vercel; daily/weekly → GH.
  - Add the route's heartbeat to `EXPECTED_CRONS` in `src/app/api/admin/doctor/route.ts`.
  - Add the schedule to `SCHEDULE_REGISTRY` in `src/lib/__tests__/cron-cadences.test.ts` — the test enforces alignment.
- **Don't switch off `--retry 1` on workflow curls.** Transient 502s shouldn't fail the workflow.

---

## 5. Vercel watchdog cron (`src/app/api/cron/vercel-watchdog/route.ts`)

**RETIRED & REPLACED.** The original Railway-hosted `scraper/vercel-watchdog.js` (with SMS alerts, business-hours gating, and `scraper_status` state) was deleted with the Railway scraper during the Plan v4 cutover. The SMS/Twilio transport it alerted through was retired entirely on 2026-07-17. The current watchdog is a Vercel cron that runs every 5 min and pings `/api/admin/doctor`.

How a red watchdog now reaches a human (no SMS):

- **Sentry** — the route calls `captureMessage(title, extras, 'error')`, raising an ERROR-level Sentry event, de-duped by fingerprint. A Sentry issue-alert rule (email/push on error) must be configured for this to actually notify.
- **Vercel** — the route returns **HTTP 503 on red**, so Vercel logs the cron invocation as FAILED even if Sentry is unconfigured or down. This is the backstop channel and must not be softened to a 200.

### Known gap (do not pretend it's covered)

This cron runs ON Vercel, so a Vercel control-plane outage silences it. There is **no external monitor** yet. The real 2am alarm is a third-party monitor (Uptime Robot / Better Stack / Cronitor) pinging `/api/admin/doctor` from outside Vercel → SMS/push. **This is the single highest-leverage ops fix and is still open.**

### Rules for editing

- **Don't change the red-path return from 503 to 200.** The non-2xx is what makes a red watchdog visible in Vercel's cron history when Sentry is down. It's the last backstop.
- Keep the Sentry event at `'error'` level (not the default `'info'`) so an alert rule can fire on it.
- When you add an external monitor, update the "Known gap" above and the doctor's alert story so the docs stay true.

---

## 6. `RUNBOOKS.md`

Symptom → diagnosis → fix → verify → prevention, per failure type. When a new class of bug bites, add a section so we don't re-diagnose from scratch.

### Rules for editing

- Match the existing five-section format.
- "Fix" steps must be exact and copy-pasteable. No "check the logs" hand-waving.
- "Prevention" must point at the specific failsafe (or workflow, or check) that catches this next time. If there isn't one, add one and link it.

---

## 7. Cron heartbeats (`src/lib/cron-heartbeat.ts` + migration 0074)

**What it does:** Every cron route's LAST step is a write to `cron_heartbeats` with its name + timestamp. (2026-07-17: the doctor's `cron_heartbeats_fresh` check was deleted in the owner-ordered slim-down — heartbeats are still WRITTEN and queryable, and the `EXPECTED_CRONS` list is still cross-checked against the schedule registry by the `cron-cadences` test at build time; nothing alerts on stale heartbeats at runtime anymore.)

**Why it exists:** The May 2026 audit found that the previous health signal — "GitHub Actions workflow returned 200" — could be green while the route silently aggregated 100% per-item errors. A heartbeat written AFTER all the real work means "the route actually finished, not just returned." Pairs with the tightened jq checks in `ml-cron.yml`.

**Don't:**
- Move the `writeCronHeartbeat()` call earlier in the route. It must come AFTER every write that matters; otherwise a silent partial-failure still writes the heartbeat.
- Remove a workflow from the `EXPECTED_CRONS` list in `doctor/route.ts` without also removing the cron itself. Otherwise the doctor reports "missing heartbeat" forever.
- Bump the cadence multiplier from 2× to 3× or higher. 2× catches one missed tick; higher hides drift.

**Touch points:** every file under `src/app/api/cron/`, plus the doctor route's `EXPECTED_CRONS` list. When you add a new cron, update both.

`run-management-patterns` is the background owner for management-company findings: it runs the live legacy portfolio checks and the shadow-only v2 evaluator through their existing claims/leases, and it writes no heartbeat when any organization is incomplete or unavailable, so production cannot advertise a successful fleet pass from partial coverage.

**Scheduled since 2026-08-06 at `0 8 * * *`,** when the founder flipped the AI master switch. (This paragraph said "It is unscheduled, and its heartbeat is deliberately NOT in `EXPECTED_CRONS`" for a day after that stopped being true. It is in `vercel.json`, and `EXPECTED_CRONS` is a derived projection of the job catalog, so it is there too.) The half of the ruling that still stands is the one that always will: it moves TOGETHER with `run-findings`, `findings-sweep` and `findings-janitor`, in either direction, in one commit. It was briefly scheduled daily on 2026-07-29 ON ITS OWN, on a fleet whose only management company was the seeded demo one, and parked again the same day. Parking one of the four now has the mirror-image failure: a heartbeat the doctor expects forever and a stage of the pipeline nothing runs. The single checklist is `docs/cron-triggers.md`, "The AI master switch".

**A heartbeat proves a route finished. It does not prove the route had anything to read.** That gap is invisible from every screen, and it was open in production for weeks: `plan_snapshots` held zero rows and `daily_logs` had not gained one since 2026-07-18, because their only writer (`/api/cron/seal-daily`) is on no schedule, while `ml-predict-inventory` and `ml-train-inventory` read "On time" in Mission Control every day. Producer/consumer links are declared as `fedBy` in `src/lib/automation/job-catalog.ts` and guarded by `src/lib/__tests__/job-feeds.test.ts`. **Do not add a scheduled job that reads a table without declaring who writes it.**

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

## 9. The AI books have ONE owner, and are never pruned unverified

**What it does:** `agent_costs` is the financial record (INV-43 — "agent_costs is the BOOKS"; every spend figure the founder sees is summed from it). Two guards protect it:

1. **Single owner.** `/api/cron/agent-costs-rollup` is the only job allowed to delete from it. `agent_costs` is on `EXEMPT_FROM_PURGE` in `ml-retention-purge`, which used to delete from it too on a 5-year window.
2. **Verify, then prune.** A month's raw rows may only be deleted after `staxis_rollup_agent_costs_month` (migration 0375) has folded that month into `agent_costs_monthly` AND confirmed the fold reproduces the raw sum and row count *exactly* — decimal equality, no tolerance. Success stamps `verified_at`. No stamp, no delete.

**Why it exists (2026-07-27 chore audit):** two crons could delete from one ledger, so neither window was the real policy and the surviving total was whichever ran last. Nothing was actually being lost only because `ml-retention-purge` has been unscheduled since 2026-05-30 — the danger was entirely in the re-enable moment.

### Rules for editing

- **Do not remove `agent_costs` from `EXEMPT_FROM_PURGE`.** Two owners of a ledger is the bug this closes.
- **Do not prune on the function's returned `verified` boolean.** It means "the sums match", which is true of an OPEN month too. Only the durable `verified_at` stamp authorises a delete, and the cron re-reads it from the table immediately before deleting.
- **Do not let a verified month be re-folded** (0375 Guard 1). Re-folding a month whose raw rows are already pruned finds zero rows, deletes the real summary, inserts nothing, and reports success because 0 = 0. The month's money would vanish with the function agreeing it was fine.
- **Do not stamp a month that is not over** (0375 Guard 2), or Guard 1 freezes it mid-month and every later row is summarised nowhere.
- **Keep retention longer than the longest window any screen reads.** `checkRetentionCoversReadWindows` in `src/lib/ai/cost-rollup.ts` throws if that stops being true. This is why no spend screen needed changing: readers look back 30 days, retention is 6 months, so nothing reads across the boundary.
- **Never compute the month bucket by casting a timestamptz to date.** That resolves in the session timezone and silently shifts the label to the previous month at any negative offset. Use a pure `date` (`v_month`).

**Tested by:** `agent-costs-rollup.test.ts` (the arithmetic, including "a spend total is identical before and after rollup + prune") and `agent-costs-rollup-sql.integration.test.ts` (the real function against Postgres, including both guards).

---

## 10. The admin account switcher's way back is bound to a session, not just a cookie

**What it does:** `POST /api/auth/admin-switch-return` mints a real platform-admin session. It sits outside `/api/admin/*` on purpose (by the time it is called the browser IS the demo person), so it carries its own gate. Two things authorize it and **neither alone is enough**:

1. the httpOnly, HMAC-signed `staxis_admin_return` cookie the switch set, and
2. a live session belonging to the demo person that same cookie names, resolved through `requireSession` — never from anything the caller can set.

**Why it exists (2026-08-07 security audit):** with only the cookie, the endpoint was a two-hour bearer credential for the platform-admin account that outlived the act it belonged to. An admin who switched into a demo person and then signed out, or handed the machine over, left a browser one unauthenticated POST away from a full admin session — no password, no second factor. Sign-out could not fix it either: `clearSignedOutBrowserState` removes the cosmetic hint cookie, but JavaScript cannot delete an httpOnly one.

### Rules for editing

- **Never let `performAdminReturn` run without a presenter.** `presenterAuthUserId` is required, and it must equal the `authUserId` of the account named by `targetAccountId`. An absent or empty presenter is a refusal, not a wildcard.
- **Keep the presenter check BEFORE the single-use claim.** Reversed, anyone holding the browser could burn the admin's `jti` without ever being allowed to redeem it, i.e. deny the return by touching it.
- **Keep the claim BEFORE the admin lookup.** Reversed, two racing redeems could both read "still an admin" and both be served.
- **Keep `DELETE` on that route, and keep sign-out calling it.** It is the difference between the credential being inert and being absent. Do not move that call into `clearSignedOutBrowserState`: that also runs on hydration paths where a momentary "no session yet" reading would throw away a valid return.
- **Do not write an `app_events` row for refusals that never got past the HMAC** (`no_return_token`, `token_malformed`, `token_bad_signature`). Anyone can produce those at will, and a row each is an unbounded audit-table write from an unauthenticated endpoint. Everything that DID verify is still recorded.
- **`properties.is_test` is the only thing standing between this feature and a real hotel.** A real property mistakenly flagged `is_test = true` makes its staff switchable, and the resulting session is indistinguishable from that person working. There is no second, independent check. Treat flipping that flag on a live hotel as a security event.

**Tested by:** `admin-account-switch.test.ts` (the policy, dependency-injected), `admin-switch-return-route.test.ts` (the route actually resolves and passes the caller), and `admin-account-switch.integration.test.ts` (the whole round trip against real migrations, including the cookie tried as a signed-out browser, as another real person, and as the admin).

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
