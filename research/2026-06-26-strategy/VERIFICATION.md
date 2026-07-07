# Verification — strategy-brief claims vs. actual code

_Read-only check by 11 agents against the live codebase. Verdicts: ✅ confirmed, ⚠️ partial (true but with a correction), ❌ refuted, ❔ unverifiable from code alone._

| Claim | Verdict | Confidence | Needs live/DB check |
|---|---|---|---|
| ml-staffing-broken | ⚠️ PARTIAL | high | yes |
| no-pms-writeback | ✅ CONFIRMED | high | no |
| feed-page | ⚠️ PARTIAL | high | no |
| dashboard-demo-charts | ✅ CONFIRMED | high | yes |
| agent-hardcoded-zeros | ❌ REFUTED | high | no |
| roomnum-dropped | ❌ REFUTED | high | no |
| invite-email-off | ✅ CONFIRMED | high | yes |
| signup-session-60min | ❌ REFUTED | high | yes |
| moat-reservoir-fields | ⚠️ PARTIAL | high | yes |
| two-ai-brains | ✅ CONFIRMED | high | no |
| cost-cap-failopen | ✅ CONFIRMED | high | no |

---

## ml-staffing-broken — ⚠️ PARTIAL (high confidence)

**Claim:** The ML labor/headcount staffing optimizer reads a database table that was deleted during the PMS rebuild and therefore returns zeros, and its automatic scheduled run (cron) is disabled — i.e. the "how many housekeepers tomorrow" feature is broken in the live code.

**Verified truth:** The "how many housekeepers tomorrow" feature is effectively non-functional in the current code for both reasons stated — but with one correction to the mechanism. The chain depends on the legacy plan_snapshots table, which the PMS rebuild dropped (migration 0204) then recreated as a permanently EMPTY stub (migration 0205) that nothing writes to. With plan_snapshots empty: (1) demand inference returns "No plan snapshot for prediction date" and writes no demand_predictions row (inference/demand.py:141-146); (2) the optimizer then finds no demand row and returns "No demand prediction available" and writes no recommendation (optimizer/monte_carlo.py:197-208). So the optimizer does NOT return zeros — it returns an explicit error and produces no headcount at all; the net effect (no recommendation) is the same. The cron half is fully correct: every ML cron schedule is disabled. The in-optimizer comment (monte_carlo.py:499) calling the cron "paused 2026-05-13" is stale — the route code was un-paused, but the GitHub Actions workflow that triggers it is now hard-disabled. The rebuild added bridge functions (today_room_work_v1 / today_property_counts_v1, migration 0224) to replace plan_snapshots, but they were wired only into the web app, NOT the ML service — the ML code still queries the raw empty stub.

**What to do before the hotel:** Don't promise a working "how many housekeepers tomorrow" number for the first hotel — it currently produces nothing. Two fixes are needed together: (1) point the ML service at a real data source — rewrite demand.py/supply.py/inventory_rate.py to call the new bridge functions today_property_counts_v1/today_room_work_v1 (migration 0224) instead of the empty plan_snapshots stub, OR have the CUA pipeline populate plan_snapshots; and (2) re-enable the inference schedule (uncomment the daily 05:30 CT cron in .github/workflows/ml-cron.yml, plus weekly training crons). Re-enabling the cron alone just fails against empty data, so the data wiring must come first. For day-one launch, hide or label the headcount panel as 'warming up' until both ship.

**Evidence:**
- supabase/migrations/0204_drop_legacy_pms_tables.sql:53 — 'drop table if exists public.plan_snapshots cascade;' (Plan v4 cutover dropped the scraper's plan table)
- supabase/migrations/0205_post_cutover_patches.sql:93 — 'create table if not exists public.plan_snapshots (' recreated EMPTY; header lines 13-23 say SELECTs return [], inserts disappear, and 'The CUA worker writes to the NEW pms_* schema; it never touches these stubs.'
- ml-service/src/inference/demand.py:132 'from plan_snapshots' and 141-146 — empty => returns {'error':'No plan snapshot for prediction date'}, writes no demand_predictions row
- ml-service/src/optimizer/monte_carlo.py:197-208 — fetches demand_predictions; if empty returns {'error':'No demand prediction available'} (an error, not zeros) and writes no recommended_headcount
- ml-service/src/inference/supply.py:355 'from plan_snapshots' — supply inference also reads the empty stub (room_state_lookup ends up empty)
- supabase/migrations/0224_today_room_work_bridge.sql:167,180 — bridge functions created to 'replace plan_snapshots', but grep finds no reference to them under ml-service/src; ML still hits the raw stub
- .github/workflows/ml-cron.yml:24-38 — 'Scheduled run(s) DISABLED 2026-05-30 — the ML service has no incoming data since the scraper was removed...'; entire schedule: block (incl. '30 10 * * * Daily 05:30 CDT run inference') commented out, only workflow_dispatch remains
- vercel.json — 0 occurrences of 'ml-' among 29 cron entries; /api/cron/ml-run-inference is not scheduled there
- .github/workflows/ml-shadow-evaluate-cron.yml:15-25 and ml-retention-purge.yml:17-28 — same 2026-05-30 DISABLED block; all ML schedules off
- ml-service/src/optimizer/monte_carlo.py:499-501 — stale comment 'optimizer cron is paused as of 2026-05-13'; route src/app/api/cron/ml-run-inference/route.ts:192-199 actually calls the optimizer ('optimizer un-paused' M3.1), so the real off-switch is the disabled GitHub Actions schedule

> Still needs a live database or external check to be 100% sure.

---

## no-pms-writeback — ✅ CONFIRMED (high confidence)

**Claim:** Staxis cannot write back to the PMS — it is read-only. No write recipe exists (the brief referenced a missing seed-write-recipe.ts), so marking a room clean in Staxis does NOT update Choice Advantage.

**Verified truth:** Confirmed for what ships today. Staxis only READS from the PMS. The CUA worker stays logged into Choice Advantage and polls the feeds every ~30s, writing the captured data into Staxis's own database (the pms_* tables) — it never pushes anything back into the PMS. There is no write recipe of any kind: a search for seed-write-recipe / write recipe across the whole repo returns zero files, and the one example of a write-back action (mark_room_clean) appears ONLY as a documentation comment, never as real code. The generic "operator workflow" engine that COULD one day drive PMS writes is built but inert: at startup the only handler registered is the read-only PMS-learning/mapping job, so any write-back job would just sit in the queue with no handler. When a housekeeper marks a room clean in Staxis, it updates Staxis's own rooms/cleaning_events tables; the room only turns 'clean' in Choice Advantage if the housekeeper also marks it there — the route header states the PMS reflects "the housekeeper's action in PMS, not via our app at all." Note: "PMS write" as used in the cua-service code means writing PMS-derived data INTO Staxis's database, not writing back to the PMS — easy to misread.

**What to do before the hotel:** Set the founder's expectation plainly: Staxis is a one-way mirror of Choice Advantage today. Housekeepers (or staff) must still mark rooms clean / update statuses inside Choice Advantage itself — Staxis will see that change within ~30 seconds on its next read. Marking a room clean inside the Staxis app records it in Staxis's own logs/performance data but does NOT change anything in the PMS. If the hotel expects to run entirely out of the Staxis app and have it update Choice Advantage, that write-back capability does not exist yet and would need to be built (the engine is in place, but no write handlers are wired up).

**Evidence:**
- cua-service/src/index.ts:106 — the ONLY registered handler is read-only mapping: runtime.registerHandler('mapper.learn_pms_family', ...)
- cua-service/src/index.ts:20-21 — 'dispatches to registered handlers — none registered in this rebuild; Reeyen adds them separately'
- cua-service/src/workflow-runtime.ts:6-8 — 'no specific workflows are defined in this rebuild. Reeyen wires up specific workflows ... in a separate effort'
- cua-service/src/workflow-runtime.ts:25 — 'mark_room_clean' appears only inside a doc-comment example of registerHandler, not as real code
- cua-service/src/workflow-runtime.ts:33-34 — 'Until that happens, the runtime sits idle (queued jobs accumulate with status=queued)'
- Repo-wide grep for seed-write-recipe / writeRecipe / seedWriteRecipe returned ZERO files (confirms the missing seed-write-recipe.ts)
- cua-service/src/session-driver.ts:5-7 — 'stays logged into one hotel's PMS 24/7, polls the active feeds every ~30 sec, and writes the results into the new 15-table schema' (writes to Staxis DB, not PMS)
- cua-service/src/persistence/generic-table-writer.ts:34,320,337 — the 'PMS write' path is supabase.from(tableName).insert/upsert into pms_* tables, i.e. into Staxis's own DB
- src/app/api/housekeeper/room-action/route.ts:14-18 — 'The PMS sync ... was the only thing actually moving status to clean — by way of CA reflecting the housekeeper's action in PMS, not via our app at all'
- cua-service/src/recipe-runner.ts:121-125 — REQUIRED_ACTIONS are all reads (getRoomLayout/getRoomStatus/getHistoricalOccupancy); click/fill/type_text steps exist only as navigation to reach read feeds

---

## feed-page — ⚠️ PARTIAL (high confidence)

**Claim:** The "/feed" decision-inbox home page shows sample/demo data and may not even exist as a real page.

**Verified truth:** There is no "/feed" page in the app. The directory src/app/feed does not exist, no route group contains it, and nothing in the codebase links to or navigates to "/feed" — there is also no "decision inbox" concept anywhere. So the second half of the claim ("may not even exist") is correct, but the first half ("shows sample/demo data") cannot be true because the surface simply isn't there. The real entry points are src/app/page.tsx (a static marketing landing page at "/") and src/app/dashboard/page.tsx (the operational home for signed-in users). Note: the dashboard IS known to show synthetic/demo KPIs for test properties — but that is a different page, not "/feed".

**What to do before the hotel:** Do not rely on a "/feed" decision-inbox page — it does not exist. If a decision inbox was promised in the launch brief, treat it as unbuilt scope. The actual signed-in home is /dashboard (src/app/dashboard/page.tsx); "/" is a static marketing landing page. If the brief's "feed shows demo data" concern was really about the dashboard, verify the dashboard's test-property KPI behavior separately — that is the page that gates synthetic data on properties.is_test.

**Evidence:**
- shell: `ls src/app/feed` → "No such file or directory"; `find src/app -iname *feed*` returns only src/app/api/feedback
- shell: grep for '/feed' route refs (href/router.push) across src returns zero matches (excluding feedback)
- shell: grep -ni 'decision.inbox' across src returns zero matches — the 'decision inbox' concept does not exist
- src/app/page.tsx:3 — `export default function LandingPage()` renders a static marketing page (force-static), not a decision inbox
- src/app: top-level route dirs are admin, dashboard, housekeeping, financials, etc. — no 'feed' dir
- All remaining 'feed' hits are unrelated: PMS 'repair feed' (OnboardingTab.tsx:451), admin 'activity feed' (mapper/[jobId]/page.tsx:409), housekeeping feed (dashboard/page.tsx:333)

---

## dashboard-demo-charts — ✅ CONFIRMED (high confidence)

**Claim:** The dashboard's money/KPI charts are demo-only — synthetic data shown for test properties, gated by properties.is_test / Property.isTest.

**Verified truth:** On the LIVE codebase (origin/main), the dashboard's revenue / ADR / RevPAR / profit figures — the KPI strip, the metric chart series, and the month-to-date footer — are entirely synthetic (generated by a deterministic formula, not real PMS revenue). They are shown ONLY on a property explicitly flagged as a demo/test hotel. The gate is: showFinancials = isDemo = !!activeProperty?.isTest, where isTest is mapped from the database column properties.is_test. Every real hotel (even one already reporting live occupancy) gets an honest "trends appear as history builds" state with the money KPIs and MTD footer hidden. Note: real occupancy is NOT synthetic — the occupancy ring is driven by live PMS counts; only the dollar/KPI showcase is demo-gated. IMPORTANT CAVEAT: the local Desktop checkout is 298 commits behind origin/main and its on-disk page.tsx predates this gating (it renders the synthetic KPIs unconditionally and even imports a today-series.ts file that is missing from the working tree). The claim is true of what is actually deployed, but NOT of the stale local files on disk.

**What to do before the hotel:** No code action needed — the live site already does this correctly. Before onboarding the first real hotel (Comfort Suites Beaumont), just confirm that property's properties.is_test = false in Supabase so the founder/owner does NOT see fabricated revenue/ADR/profit numbers; with is_test=false the KPI strip, money chart, and month-to-date footer are hidden and only real occupancy shows. Do NOT trust the local Desktop checkout when reasoning about this — it is 298 commits stale and shows the old always-on synthetic behavior; always verify against origin/main.

**Evidence:**
- origin/main:src/app/dashboard/page.tsx:492 — `const isDemo = !!activeProperty?.isTest;`
- origin/main:src/app/dashboard/page.tsx:495 — `const showFinancials = isDemo;`
- origin/main:src/app/dashboard/page.tsx:784 — KPI strip wrapped in `{showFinancials && (` with comment 'synthetic financials; shown on a demo property only, never fabricated for a real hotel'
- origin/main:src/app/dashboard/page.tsx:873 — MTD footer wrapped in `{showFinancials && mtd && (` comment 'synthetic totals; demo property only'
- origin/main:src/app/dashboard/page.tsx:480-485 — comment: 'revenue / ADR / RevPAR / profit have NO real source for ANY hotel yet, and the multi-month history is fabricated... So we show them ONLY on an explicit demo property.'
- origin/main:src/lib/db-mappers.ts:236 — `isTest: Boolean(r.is_test),` maps the DB column to Property.isTest
- origin/main:supabase/migrations/0068_properties_is_test.sql:17 — `add column if not exists is_test boolean not null default false;`
- origin/main:src/lib/dashboard/today-series.ts:10-14 — 'revenue / ADR / RevPAR / profit are estimated until pms_revenue_daily carries real daily history'
- Local stale state: `git rev-list --count HEAD..origin/main` = 298; on-disk src/app/dashboard/page.tsx (HEAD 754351e) has NO isTest gate and imports a missing src/lib/dashboard/today-series.ts

> Still needs a live database or external check to be 100% sure.

---

## agent-hardcoded-zeros — ❌ REFUTED (high confidence)

**Claim:** The AI agent ("Ask Staxis") returns hardcoded zeros for live housekeeping state — counts like in-progress / DND / issues / help-requested are stubbed at 0 rather than read from live data.

**Verified truth:** The agent's housekeeping/occupancy counts are NOT hardcoded. Every relevant agent tool reads live rows from the `rooms` table via the service-role client and computes the counts (dirty / in-progress / clean / DND / issues / help-requested) by iterating those real rows and incrementing counters. The `0` values that appear in the code are accumulator initializers that get incremented from live database rows immediately afterward — not stubbed return values. This is true across all three places these numbers are produced: get_hotel_state (via buildHotelSnapshot in context.ts), get_today_summary (queries.ts), and get_occupancy (reports.ts).

**What to do before the hotel:** No action needed for this concern — the agent reads live housekeeping/occupancy state correctly. The only caveat unrelated to the claim: these numbers reflect whatever is in the `rooms` table for the active date, so the upstream seed/CUA feed must actually be populating `rooms` for the day. If a hotel sees the agent report all-zeros at launch, that would be an empty/un-seeded `rooms` table for today, not a hardcoded stub in the agent. Verify the first hotel has same-day room rows seeded before relying on agent occupancy answers.

**Evidence:**
- src/lib/agent/context.ts:149-156 — the `0`s are an initializer object: `const rooms = { total: 0, dirty: 0, in_progress: 0, clean: 0, dnd: 0, issuesFlagged: 0, helpRequested: 0, seedingGap: 0 }`
- src/lib/agent/context.ts:160-176 — counts are filled from live DB rows: queries `supabaseAdmin.from('rooms').select('status, is_dnd, issue_note, help_requested')` then `for (const r of data) { if (r.is_dnd) rooms.dnd++; ... if (r.issue_note) rooms.issuesFlagged++; if (r.help_requested) rooms.helpRequested++; }`
- src/lib/agent/tools/queries.ts:254-262 — get_today_summary: `let dirty = 0, inProgress = 0, ... helpRequests = 0;` then `for (const r of rooms ?? []) { if (r.is_dnd) dnd++; ... if (r.help_requested) helpRequests++; }` over rows fetched from `rooms`
- src/lib/agent/tools/queries.ts:28-44 — get_hotel_state tool delegates to `buildHotelSnapshot(ctx.propertyId, ctx.user.role, ctx.staffId)` (the live reader above)
- src/lib/agent/tools/queries.ts:68-86 — list_my_rooms selects `is_dnd, issue_note, help_requested` from `rooms` and maps real per-room flags
- src/lib/agent/tools/reports.ts:48-65 — get_occupancy fetches `rooms` for the active date and passes real rows to computeOccupancySummary (denominator from properties.room_inventory/total_rooms to avoid under-reporting, not zeros)

---

## roomnum-dropped — ❌ REFUTED (high confidence)

**Claim:** Room numbers that are not 3-4 digits (e.g. a letter-prefixed suite like "A12") are silently dropped by validation.

**Verified truth:** There is no "3-4 digit" rule, and nothing is silently dropped. A letter-prefixed room like "A12" is fully accepted. parseRoomList accepts any single token matching [A-Za-z0-9_-]+ (so "A12" passes and is kept), and validateRoomNumbers accepts any non-empty, whitespace-free, unique string up to ROOM_NUMBER_MAX chars — no digit-count restriction at all. The only place numeric-only is enforced is inside a RANGE token like "101-103"; an alphanumeric range (e.g. "A1-A9") is REJECTED WITH AN ERROR (not dropped), and the docs explicitly tell operators to list alphanumeric rooms individually. Any genuinely invalid entry returns an error that the caller surfaces (the create-hotel modal shows it inline; the API returns {ok:false, reason}). So the failure mode is "loud rejection," the opposite of "silent drop."

**What to do before the hotel:** No action needed to support letter-prefixed rooms like "A12" — list them individually (comma/newline/space separated) and they save fine. The one constraint to brief the operator on: ranges (e.g. "101-110") must be numeric only; you cannot write "A1-A9" as a range — list those suites one by one. There is also a hard rule that the room-number count must equal totalRooms, or the create is rejected with a clear message.

**Evidence:**
- src/lib/api-validate.ts:286-289 — `if (!/^[A-Za-z0-9_-]+$/.test(tok)) { return { error: ... } } out.push(tok);` — a single token like "A12" passes the regex and is pushed (kept), not dropped
- src/lib/api-validate.ts:270-287 — range form `/^(\d+)-(\d+)$/` is numeric-only; a non-numeric range token returns `{ error: ... }` rather than being silently skipped
- src/lib/api-validate.ts:252-255 — doc: "Range form is numeric only — alphanumeric room numbers (\"L1-201\") must be listed individually." Individually-listed alphanumerics are valid
- src/lib/api-validate.ts:300-323 — validateRoomNumbers checks non-empty, length<=ROOM_NUMBER_MAX, no whitespace, uniqueness; NO digit-count/format rule; invalid entries return `{ error }`
- src/app/api/admin/properties/create/route.ts:201-203 — `const r = validateRoomNumbers(...); if (r.error) return { ok: false, reason: r.error };` — errors are surfaced, not swallowed
- src/app/admin/_components/CreateHotelModal.tsx:109-114 — parse errors render as `{ kind: 'error', message }` to the operator before submit

---

## invite-email-off — ✅ CONFIRMED (high confidence)

**Claim:** Invite / onboarding email is OFF in production (Resend disabled), so the staff/owner join link must be copy-pasted manually.

**Verified truth:** Correct. Production email runs through Resend, gated on RESEND_API_KEY. When the key is unset the code soft-fails (ok:false, non-fatal) and no email is sent; production intentionally has RESEND_API_KEY unset per the 2026-06-26 audit. The owner onboarding link and staff join link are returned in the API response for the admin to copy-paste. Owner-invite email is also opt-in (sendEmail defaults false). The newer onboarding wizard and staff-link minter send no email by design.

**What to do before the hotel:** Copy-paste join links manually for the first hotel: take signupUrl/joinCode from the admin create result, and mint each staff URL via the schedule tab Copy button and send via SMS/chat. No email will arrive unless RESEND_API_KEY is set in Vercel.

**Evidence:**
- src/lib/email/resend.ts: if (!apiKey) returns ok:false 'RESEND_API_KEY not configured' — send gated on env var
- src/lib/env.ts:158 RESEND_API_KEY optional; :346 isEmailConfigured = !!env.RESEND_API_KEY
- src/app/api/admin/properties/create/route.ts:191 sendEmail default false; :422 send is non-fatal, URL still copyable
- src/app/api/staff-link/route.ts:107 returns ok({url}) only — no send
- src/app/api/auth/invites/route.ts:106-122 uses Supabase generateLink not Resend, non-fatal, returns inviteLink
- memory project_preonboarding_audit_20260626.md: 'RESEND_API_KEY UNSET -> outbound email OFF', 'intentionally kept OFF for now'

> Still needs a live database or external check to be 100% sure.

---

## signup-session-60min — ❌ REFUTED (high confidence)

**Claim:** The owner's signup/onboarding session expires after roughly 60 minutes, so onboarding must be done in one sitting.

**Verified truth:** There is no 60-minute onboarding session limit. The owner logs in with a normal Supabase auth session whose token auto-refreshes (middleware refreshes at the edge), so it does not silently die mid-onboarding. Onboarding progress is also saved on the server step-by-step (keyed to the hotel join code), so the owner can close the tab and come back. The only real deadline is the join code itself, which is valid for 7 days. A separate short email verification code (the 6-digit OTP) does expire after about an hour per Supabase's default, but it only gates the 'verify your email' step and can be re-sent — it does not end the session or wipe progress.

**What to do before the hotel:** Reassure the founder: onboarding does NOT have to be done in one sitting. He can sign up, walk away, and resume — progress is saved and the login stays alive. The only clock that matters is the 7-day validity of the hotel's onboarding code, which is plenty. If he ever sees a 'code expired' message on the email-verify step, he just clicks resend to get a fresh 6-digit code; it does not lose his progress. No code change needed.

**Evidence:**
- src/lib/join-codes.ts:66 — export const OWNER_CODE_TTL_HOURS = 24 * 7; (owner code valid 7 days, not 60 min)
- src/app/api/admin/properties/create/route.ts:357 — new Date(Date.now() + OWNER_CODE_TTL_HOURS * 60 * 60 * 1000) (owner onboarding code expiry)
- src/app/onboard/page.tsx:315-322 — PATCH /api/onboard/wizard persists partialState (accountCreatedAt) server-side; progress is durable, not session-bound
- src/app/api/onboard/wizard/route.ts:92 — if (new Date(codeRow.expires_at).getTime() <= Date.now()) return null; (only time check is the code's expiry, not a 60-min session)
- src/lib/supabase.ts:6-25 — cookie storage + middleware 'refreshes tokens at the edge so a server-rendered navigation always sees an up-to-date session' (auto-refresh, no hard 60-min cap)
- src/app/onboard/page.tsx:313,374 — session established via supabase.auth.signInWithOtp / verifyOtp (standard Supabase Auth session)
- Codebase-wide grep for 60min/3600/'one sitting'/'session expir' found only unrelated matches (housekeeping over_60min flags, ML 36*3600 freshness, doctor supabase_jwt_expiry which checks the API KEY expiry, not user sessions)

> Still needs a live database or external check to be 100% sure.

---

## moat-reservoir-fields — ⚠️ PARTIAL (high confidence)

**Claim:** The data moat is latent: cleaning_events and model_runs are empty, and cohort keys (brand / region / size_tier) on the property are blank — but those columns DO exist and can be seeded.

**Verified truth:** The schema half of the claim is fully CONFIRMED: both the cleaning_events table and the model_runs table exist, and the properties table has brand, region, and size_tier columns (plus climate_zone) — all nullable and settable. cleaning_events is populated by live housekeeping activity (each "Done" tap writes a row via /api/housekeeper/complete-clean), and model_runs is written by the ML service on each training run. So they will be empty for a brand-new hotel until housekeepers start cleaning / a model trains, and they CAN be backfilled (migration 0012 already backfills cleaning_events from 365 days of rooms history). The cohort columns are NOT necessarily blank, though: the onboarding wizard explicitly sets brand/region/size_tier when the founder fills in hotel details (size_tier is auto-derived from room count), and migration 0062 backfilled the existing Comfort Suites property to brand='Comfort Suites', region='South', size_tier by room count. Whether they are actually blank right now is a live-data question. The claim's framing that they exist and can be seeded is correct; the assertion that all three are currently empty/blank cannot be confirmed from code alone and is partly contradicted by the auto-set/backfill paths.

**What to do before the hotel:** Before the first hotel goes live, verify in the database (or via /admin/ml-health, which selects brand, region, size_tier) that the target property actually has brand/region/size_tier filled — these are set by the onboarding wizard and auto-derived for size, but a property created via the admin create route only gets brand (region/size_tier left null there), so a manually-created hotel may need region/size_tier backfilled. Expect cleaning_events and model_runs to be empty until housekeepers start cleaning and a training run fires; the system is designed for this (cohort priors in demand_priors/supply_priors provide Day-1 cold-start predictions). No schema work is needed — only confirm/seed the cohort values for this specific property.

**Evidence:**
- supabase/migrations/0012_cleaning_events.sql:53 — 'create table if not exists cleaning_events (' — table exists; lines 118-148 backfill it from rooms history (seedable)
- src/app/api/housekeeper/complete-clean/route.ts:266,339 — '.from('cleaning_events')' insert — cleaning_events is populated by live housekeeper 'Done' taps, not at hotel creation
- supabase/migrations/0021_ml_infrastructure.sql:129 — 'create table if not exists model_runs (' — table exists
- ml-service/src/training/demand.py:463 & supply.py:439 — client.insert('model_runs', shadow_row) — model_runs is written by ML training runs
- supabase/migrations/0062_inventory_ml_foundation.sql:73-76 — 'alter table properties add column if not exists brand text; ... region text; ... size_tier text;' — cohort columns exist on properties, nullable
- supabase/migrations/0062_inventory_ml_foundation.sql:80-87 — comments: brand 'NULL until set during onboarding', size_tier 'Computed from total_rooms' — confirms can-be-blank AND can-be-seeded
- supabase/migrations/0062_inventory_ml_foundation.sql:89-97 — backfills existing Comfort Suites property to brand='Comfort Suites', region='South', size_tier by room count — already seeded for the first hotel
- src/app/onboard/page.tsx:443-447 — propertyUpdates sets brand, region, size_tier: deriveSizeTier(totalRooms) — onboarding wizard populates cohort keys, so a fully-onboarded hotel is NOT blank
- supabase/migrations/0122_demand_supply_priors.sql:32-90 — demand_priors/supply_priors keyed by cohort_key with industry-benchmark seeds — the cohort priors that consume these keys exist and ship seeded for cold-start

> Still needs a live database or external check to be 100% sure.

---

## two-ai-brains — ✅ CONFIRMED (high confidence)

**Claim:** There are two divergent AI agent implementations — a team-chat agent with only ~3 tools and a main agent with ~36 tools — and model routing is off (paying Sonnet rates for everything instead of routing cheap calls to cheaper models).

**Verified truth:** Both halves of the claim are true in the code. (1) There are two separate agent implementations. The MAIN agent (src/app/api/agent/command/route.ts, powering the /chat page, the floating chat button, and voice) draws from a shared tool registry that self-registers 49 tools across 12 modules; after the chat-surface filter (only the 2 voice-issue tools are voice-only) and per-role gating, a manager/owner sees on the order of high-30s to mid-40s tools — the "~36" figure is approximately right for a manager role. The SEPARATE team-chat agent (runStaxisAssistant in src/lib/comms/assistant.ts, invoked by the @Staxis mention inside the staff Communications/messaging feature via src/app/api/comms/assistant/route.ts) is a completely independent implementation with its own hardcoded list of exactly 3 tools: get_room_status, create_work_order, create_complaint. It does NOT use the main registry, so it can never reach inventory, financials, reports, knowledge, compliance, lost-and-found, memory, etc. (2) Model routing is effectively off on the main agent: pickModel() in src/lib/agent/llm.ts is hardcoded to `return 'sonnet'` — every interactive chat/voice turn pays Sonnet rates ($3/$15 per million in/out), with a comment explicitly stating Haiku routing for simple commands is backlog. The override path exists (an opts.model param, used only by an offline summarizer cron passing 'haiku', plus a MODEL_OVERRIDE env var) but nothing routes live user turns to a cheaper tier. The team-chat agent is partly smarter about cost — its background helpers (detectAction, summarizeUnread, polishAnnouncement) use Haiku, but the interactive @Staxis assistant itself is also pinned to Sonnet. Nuance: the claim's "paying Sonnet for everything" is true for all interactive turns; it is not literally everything, since some background/utility calls already use Haiku.

**What to do before the hotel:** No launch blocker, but two cheap wins worth knowing before onboarding: (1) Be aware the staff-chat @Staxis assistant is a deliberately limited 3-tool helper (room status, work order, complaint) — it cannot answer inventory/financials/reports questions; that's the full main agent at /chat or the floating button. Don't promise the in-chat @Staxis can do everything the main assistant does. (2) Every interactive AI turn currently runs on Sonnet; there is no live cheap-model routing. This won't break anything, but it sets your per-turn AI cost at Sonnet rates. If AI spend matters at launch, the MODEL_OVERRIDE env var lets you flip tiers without a redeploy, and turning on Haiku routing for simple commands is a known backlog item that needs eval coverage first.

**Evidence:**
- src/lib/comms/assistant.ts:152-188 — ASSISTANT_TOOLS is a hardcoded array of exactly three Anthropic.Tool entries: get_room_status, create_work_order, create_complaint
- src/lib/comms/assistant.ts:218-221 — runStaxisAssistant calls c.messages.create({ model: SONNET, ... tools: ASSISTANT_TOOLS }) where `const SONNET = 'claude-sonnet-4-6'` (line 26)
- src/app/api/comms/assistant/route.ts:17,45 — the @Staxis in-chat assistant route imports and calls runStaxisAssistant, a separate code path from /api/agent/command
- src/lib/agent/tools/index.ts — imports 12 tool modules (room-actions, queries, management, reports, walkthrough, voice-issue, complaints, compliance, lost-found, financials, knowledge, memory) that self-register; counted 49 total registerTool() calls (queries 7, management 7, room-actions 6, reports 6, compliance 6, financials 4, memory 3, complaints/walkthrough/voice-issue/knowledge/lost-found 2 each)
- src/app/api/agent/command/route.ts:228 — main agent builds its catalog via getToolsForRole(userCtx.role, 'chat'); /chat page (src/app/chat/page.tsx:23,55) uses useAgentChat -> this route
- src/lib/agent/llm.ts:263-270 — comment 'Pinned to Sonnet 4.6 ... Smart routing (Haiku for confirmed-simple commands -> ~10x cost win) is backlog' followed by `function pickModel(): ModelTier { return 'sonnet'; }`
- src/lib/agent/llm.ts:521-522 — `const model = opts.model ?? pickModel();` so a live turn always resolves to Sonnet unless a caller explicitly overrides (only the summarizer cron passes 'haiku')
- src/lib/agent/llm.ts:83-85 — PRICING shows sonnet input $3 / output $15 vs haiku input $1 / output $5, confirming the ~3-5x cost gap not being captured
- src/lib/comms/assistant.ts:25,67,107,123 — comms background helpers detectAction/summarizeUnread/polishAnnouncement DO use `const HAIKU = 'claude-haiku-4-5'`, so cost-tiering is partially applied there but not for interactive turns

---

## cost-cap-failopen — ✅ CONFIRMED (high confidence)

**Claim:** The CUA per-feed cost cap can fail-open (allow continued spend) if the database read it depends on errors out.

**Verified truth:** Confirmed and intentional. The cost-cap check is designed to fail OPEN, not fail safe. In cua-service/src/cost-cap.ts, when the database read that the cap depends on errors out, the code explicitly returns ok=true (Claude spending allowed) rather than blocking. This happens in three distinct places: (1) checkBudget — when the read of property_sessions fails, it logs a warning and returns ok=true with spentMicros=0 (a comment literally says "Fail open on read errors"); (2) recordSpend — when the atomic increment RPC fails it falls back to a read-modify-write, and if THAT read also returns a low value the cap won't trip; (3) checkDailyMappingSpend — when the org-wide mapping spend query fails it returns over=false ("assuming under cap"). So a sustained Supabase outage during a runaway Claude-vision repair loop would let spend continue past the cap. The designers made this a conscious tradeoff: they'd rather keep all hotels running during a flaky-database moment than freeze every hotel, and they rely on the daily mapping cap and Claude token-usage tracking as backstops. Note: the per-hotel daily cap is $5/day; mapping has a separate org-wide cap (default $100/day). The exposure window is bounded by how long the DB stays unreadable, but during that window there is no hard ceiling enforced.

**What to do before the hotel:** Know before launch that the $5/hotel/day Claude spend cap is NOT a hard ceiling: if the Supabase database is unreachable while a Claude-vision loop is running, spending continues uncapped until the DB recovers. This is a deliberate design choice (fail-open to avoid freezing all hotels during a database blip), but for the first paying hotel it means the only real backstop during a DB outage is Claude token-usage tracking, which is reactive not preventive. Before onboarding, decide whether this risk is acceptable. If you want a true safety net, ask for a hard fail-closed fallback (e.g., an in-memory per-process spend counter on the Fly worker that blocks spend when the DB has been unreadable for more than a few minutes), and/or a billing alert on the Anthropic API key as an out-of-band tripwire. No code change is required to launch, but this should be a conscious accept-the-risk decision, not a surprise.

**Evidence:**
- cua-service/src/cost-cap.ts:88-103 — checkBudget: `if (error) { log.warn('cost-cap: failed to read property_sessions, defaulting to ok=true', ...); ... return { ok: true, spentMicros: 0, ... }; }`
- cua-service/src/cost-cap.ts:93-96 — comment: `// Fail open on read errors — if Supabase is flaky we'd rather keep // serving than freeze every hotel.`
- cua-service/src/cost-cap.ts:328-335 — checkDailyMappingSpend: `if (error) { // Don't fail-closed... log.warn('...daily mapping spend query failed — assuming under cap'...); return { over: false, spentMicros: 0, capMicros }; }`
- cua-service/src/cost-cap.ts:222-244 — recordSpend RPC-failure fallback: on `error || !data` it does a read-modify-write off checkBudget (which itself can fail open), tripping the cap only if `newTotal >= DAILY_CAP_MICROS`
- cua-service/src/cost-cap.ts:35-36 — `const DAILY_CAP_MICROS = env.CUA_JOB_COST_CAP_MICROS;` ($5/day per hotel is the cap being bypassed)

---

