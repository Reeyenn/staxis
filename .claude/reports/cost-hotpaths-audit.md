# HotelOps AI — Cost & Hot-Paths Audit (static)

**Date:** 2026-05-17
**Branch:** `audit/cost-hotpaths`
**Method:** Pure static analysis (grep, AST-level file reads, call-graph tracing). No profilers run.
**Scope:** `src/`, `cua-service/src/`, `ml-service/src/`, `scraper/`, `vercel.json`.

> All cost/latency figures are **back-of-the-envelope estimates** from token math, polling intervals, and call-fanout — not measurements. Use the recommendation column for direction; rerun with real telemetry before quoting exact dollars.

---

## 1. Executive summary

**Cost drivers in one paragraph.** Anthropic Sonnet 4.6 dominates the cost surface — every user message in the agent chat ([`streamAgent` in src/lib/agent/llm.ts:736](src/lib/agent/llm.ts:736)), every Clicky walkthrough step ([src/app/api/walkthrough/step/route.ts:400](src/app/api/walkthrough/step/route.ts:400)), every invoice scan ([src/lib/vision-extract.ts:178](src/lib/vision-extract.ts:178)), and the every-5-minute nudges cron ([src/app/api/agent/nudges/check/route.ts](src/app/api/agent/nudges/check/route.ts)) call out to the same model. The agent uses prompt caching well (stable system block + tools marked `cache_control: ephemeral`), so the marginal-token cost is much smaller than naive token counts suggest. The non-LLM hot paths are dominated by **polling**: 4-second public housekeeper poll, 15s–60s admin dashboards, the CUA worker's 5s claim loop, and Vercel's 13 scheduled crons (some `*/5 *`). DB pressure is moderate — 734 `.from(` calls across `src/`, ~40 of them `.select('*')` on hot tables (`rooms`, `staff`, `properties`).

**Top 5 quick wins (ROI-ordered):**

1. **Singleton the Vision Anthropic client** at [src/lib/vision-extract.ts:36](src/lib/vision-extract.ts:36) — one-line fix; matches the pattern at [src/lib/agent/llm.ts:245](src/lib/agent/llm.ts:245). Saves a TLS handshake per invoice scan.
2. **Bump admin overview-stats poll** from 15s → 60s (or move to SSE) — [src/app/admin/_components/HealthBanner.tsx:33](src/app/admin/_components/HealthBanner.tsx:33) already uses 60s, but `overview-stats` is the noisiest one. Cuts admin-tab request rate ~75%.
3. **Coalesce realtime refetches** in [src/lib/db/_common.ts:69-169](src/lib/db/_common.ts:69) — current pattern fires N full-table refetches when N rows change in quick succession. Add a 150ms debounce.
4. **Narrow the top 10 `.select('*')` sites** on hot tables (`rooms`, `staff`, `properties`, `cleaning_events`). The DB layer in [src/lib/db/](src/lib/db/) is the cheapest place to fix — column-narrow once, every caller benefits.
5. **Activate Haiku for confirmed-simple agent commands** by giving [`pickModel()` in src/lib/agent/llm.ts:259](src/lib/agent/llm.ts:259) a real classifier. Comments at lines 254-256 say this is backlog pending evals. Haiku is ~10× cheaper than Sonnet.

---

## 2. Top 20 Hot Paths (ranked)

Ranked by **expected $/month × user-facing latency impact**. "Cost type" — LLM (Anthropic tokens) · DB (Supabase) · SMS (Twilio) · CPU (Vercel/Fly compute) · NET (round-trips).

| # | Path / function | file:line | Cost type | Frequency | Why it's expensive | Recommendation |
|---|---|---|---|---|---|---|
| 1 | `streamAgent()` — agent chat per-turn | [src/lib/agent/llm.ts:736](src/lib/agent/llm.ts:736) | LLM | Per user message; production main path | Sonnet 4.6 streaming, up to 8 tool iterations per turn ([MAX_TOOL_ITERATIONS line 100](src/lib/agent/llm.ts:100)), `maxDuration: 60s`. Each iteration is a fresh Anthropic call. | Already does prompt caching well. Add an LLM-side iteration ceiling on cached-only tokens (early-stop), and ship Haiku routing for simple turns. |
| 2 | `buildHotelSnapshot()` | [src/lib/agent/context.ts:64](src/lib/agent/context.ts:64) | DB | Every agent turn + every walkthrough step + every voice turn + the nudges cron | 5 cheap Supabase reads per call. Already has a **30s in-process cache** at [context.ts:49-53](src/lib/agent/context.ts:49). | Move cache from in-process Map to Vercel Data Cache / KV so it survives across Lambda instances. In-process cache evaporates on cold start. |
| 3 | `POST /api/walkthrough/step` | [src/app/api/walkthrough/step/route.ts:400](src/app/api/walkthrough/step/route.ts:400) | LLM | Once per step of a walkthrough run; rate-limited 10 starts/hr/user; up to N steps per run | Sonnet 4.6 with forced `tool_use`. Reservation ≈ $0.03/step ([line 89](src/app/api/walkthrough/step/route.ts:89)). | Reuse system prompt across steps inside one walkthrough (already cached via `cache_control`); keep the UI snapshot trim. Consider Haiku-vision for the "next click" prediction once evals exist. |
| 4 | `visionExtractJSON()` — invoice/photo OCR | [src/lib/vision-extract.ts:178](src/lib/vision-extract.ts:178) | LLM | Inventory manager pressing "scan invoice"; 5–20× per property/day | Sonnet 4.6 Vision with up to 8192 output tokens ([line 168](src/lib/vision-extract.ts:168)); 5MB-per-image limit ([lines 74-138](src/lib/vision-extract.ts:74)). Vision tokens are pricier than text. | (a) **Singleton the client** ([line 36](src/lib/vision-extract.ts:36)) — currently per-call. (b) Resize images to 1024×1024 on the client before upload. (c) For receipts with <20 line items, try Haiku Vision. |
| 5 | `POST /api/agent/voice-brain/chat/completions` | [src/app/api/agent/voice-brain/chat/completions/route.ts:236](src/app/api/agent/voice-brain/chat/completions/route.ts:236) | LLM + NET | Per voice turn from ElevenLabs Custom-LLM webhook | Same agent loop as the chat path, plus an ElevenLabs WS round-trip and a `buildHotelSnapshot` call inside the stream. | Hoist the snapshot lookup OUT of the ReadableStream constructor so it parallelizes with prompt assembly; everything else is shared with #1. |
| 6 | `POST /api/agent/nudges/check` (cron) | [src/app/api/agent/nudges/check/route.ts:17](src/app/api/agent/nudges/check/route.ts:17) | LLM + DB | Every 5 min (Vercel cron — [vercel.json:17-19](vercel.json:17)) | Fans out across all properties via `Promise.allSettled`. Each property triggers nudge evaluation, which can call Anthropic for nuanced decisions. | Skip inactive/sleeping properties (no agent activity in last N days). Move to `*/15` if SLA allows; the nudges aren't latency-critical. |
| 7 | `GET /api/cron/agent-summarize-long-conversations` | [vercel.json:29-30](vercel.json:29) | LLM | Every 30 min | Generates a Claude summary for each long conversation; cost compounds over the day. | Only summarize when `>200` messages AND last-summary-age > 24h. Defer to off-peak window. |
| 8 | `GET /api/cron/ml-run-inference` (daily) | [src/app/api/cron/ml-run-inference/route.ts:39](src/app/api/cron/ml-run-inference/route.ts:39) | CPU + NET | Daily ~05:30 CT | Fans out 3 stages (demand, supply, optimizer) across every property; ML service call is ~5s/property; `maxDuration: 300s`. Not Anthropic, but burns ML-service compute and Vercel time. | Already sharded via `shardCount` — verify all properties land in some shard. Consider caching forecasts within-day if input features haven't changed. |
| 9 | Realtime refetch pattern — `subscribeTable()` | [src/lib/db/_common.ts:69-169](src/lib/db/_common.ts:69) | DB | Per `postgres_changes` event on every subscribed table | When N rows change in a burst, N events fire N full-table refetches (single-column filter limit forces this). Mobile Safari visibility recovery (lines 142-155) adds a fresh refetch on every tab focus. | Coalesce events with a 100–200ms debounce per `(table, propertyId)` key. Drop already-fetched rows by `updated_at` to skip no-ops. |
| 10 | Public housekeeper poll | [src/lib/db/housekeeper-helpers.ts:78-84](src/lib/db/housekeeper-helpers.ts:78) | DB + NET | Every 4s per active housekeeper tab | `fetchRooms` via service-role API every 4s. Has `document.visibilityState` guard so it stops when tab backgrounded. With 10 HKs on shift, 150 req/min/property. | Bump to 6–8s. Realtime channel is already in place ([line 63](src/lib/db/housekeeper-helpers.ts:63)) — the 4s poll is a fallback for the unauth-channel case. Verify the unauth path actually needs it, or shorten to a single fallback poll on subscribe error. |
| 11 | `GET /api/admin/overview-stats` poll | [src/app/admin/_components/HealthBanner.tsx:54](src/app/admin/_components/HealthBanner.tsx:54) (POLL_MS=60s at [line 33](src/app/admin/_components/HealthBanner.tsx:33)); other admin tabs at 30s | DB | Per admin tab open | 5 parallel COUNT queries on every poll. Cheap individually; with 3 admins × multiple tabs, 100s of req/hr. | HealthBanner is already 60s — fine. The 30s pollers (`/admin/agent` [line 97](src/app/admin/agent/page.tsx:97), `/laundry/[id]` [line 126](src/app/laundry/[id]/page.tsx:126)) should bump to 60s or move to SSE. |
| 12 | Vision Anthropic client (re-instantiated per call) | [src/lib/vision-extract.ts:36](src/lib/vision-extract.ts:36) | NET | Per `scan-invoice` / `photo-count` call | `new Anthropic(...)` on every invocation — TLS handshake + SDK warmup tax. Singleton already used at [src/lib/agent/llm.ts:245](src/lib/agent/llm.ts:245) and [src/app/api/walkthrough/step/route.ts:93-99](src/app/api/walkthrough/step/route.ts:93). | Hoist client out of `getClient()` into a module-level `let _client`. 1-line fix. |
| 13 | Wide-column reads — `.select('*')` | [src/lib/db/*](src/lib/db/) — ~40 sites | DB + NET | Anywhere these helpers are imported (most pages) | Pulls every column. Worst offenders on hot tables: [rooms.ts:24,48,87](src/lib/db/rooms.ts:24), [staff.ts:40,76](src/lib/db/staff.ts:40), [properties.ts:10,16](src/lib/db/properties.ts:10), [cleaning-events.ts:196,219,314](src/lib/db/cleaning-events.ts:196), [shift-confirmations.ts:20,33](src/lib/db/shift-confirmations.ts:20). | Narrow at the helper. One change in `src/lib/db/rooms.ts` benefits every caller. Add a `// columns:` comment listing what's used. |
| 14 | `GET /api/cron/process-sms-jobs` (Twilio fan-out) | [src/app/api/cron/process-sms-jobs/route.ts:39](src/app/api/cron/process-sms-jobs/route.ts:39) | SMS | Every 5 min ([vercel.json:9-10](vercel.json:9)) | Claims up to 50 SMS/tick, sends each via Twilio (~1s each, sequential or low-concurrency). Cost is Twilio per-message. | OK at current volume; if SMS load grows, parallelize sends within a tick with a small concurrency cap (10) and per-property rate limit. |
| 15 | `GET /api/cron/enqueue-property-pulls` | [src/app/api/cron/enqueue-property-pulls/route.ts:43](src/app/api/cron/enqueue-property-pulls/route.ts:43) | DB + NET | Every 15 min (via GitHub Actions; not in vercel.json) | Iterates all properties, calls `staxis_enqueue_property_pull` RPC each. Idempotent. | Already parallel via `Promise.allSettled`. Low concern. |
| 16 | CUA worker claim-loop | [cua-service/src/index.ts:33,79](cua-service/src/index.ts:33) | CPU + NET | Every 5s (default `POLL_INTERVAL_MS`) | `while (!shuttingDown)` calls `staxis_claim_next_job` RPC every 5s on the Fly worker. When a job exists, runs a full Playwright recipe (30–60s). When idle, just an RPC every 5s. | Idle polling is cheap. If the Fly machine is idle most of the time, swap to PG `LISTEN/NOTIFY` or webhook from Vercel → Fly to wake on new jobs. |
| 17 | CUA recipe-runner — Playwright per onboarding | [cua-service/src/recipe-runner.ts](cua-service/src/recipe-runner.ts) | CPU | Per onboarding job (low volume) | Spins up Chromium, logs into PMS, navigates, extracts, tears down. 30–60s wall-time, ~256MB RAM peak. | Already the right shape for a worker. Cache the logged-in browser context across consecutive jobs for the same PMS if the recipe supports it. |
| 18 | Scraper pulls (Choice Advantage CSV + dashboard) | `scraper/scraper.js:69-100` | CPU + NET | 7 CSV pulls + 32 dashboard pulls / property / day | Playwright per pull; ~10–30s each. At 50 hotels, 50 × 39 = ~2000 sessions/day. | Coalesce CSV + dashboard pulls into one browser session per visit window. Skip properties with stale credentials (already known bad). |
| 19 | Agent tool layer — N+1 staff name lookups | [src/lib/agent/tools/queries.ts](src/lib/agent/tools/queries.ts) (`query_room_status` and similar) | DB | Per tool call | Tool returns rooms, then issues a secondary `staff.select('name')` per room for the assignee name. | Switch to one JOIN-equivalent fetch (Postgres `select('id, number, ..., assignee:staff(name)')`) or a single bulk staff fetch per call. |
| 20 | `JSON.stringify` change-detection in `ScheduleTab` / `AuthContext` | [src/app/housekeeping/_components/ScheduleTab.tsx:201](src/app/housekeeping/_components/ScheduleTab.tsx:201), [src/contexts/AuthContext.tsx:201](src/contexts/AuthContext.tsx:201) | CPU | Per save / per auth refresh | Stringify-equality on large arrays. Cheap in isolation; runs in the render path of a frequently-rerendered component. | Use a memoized id-list comparison or `useMemo(() => assignments, [assignments.length, assignments[0]?.id, ...])` — or just accept the few ms; it's not in the top tier. |

---

## 3. Database queries on the critical path

**Volume**: 734 `.from(` calls in `src/` across **~120 files**. Of those, **29 RPC calls** to 27 distinct stored procedures — encapsulation is good.

**Top tables by query count** (grep counts, indicative):

| Table | `.from(` count | Where it's hot |
|---|---|---|
| `properties` | 70 | Property selector, admin views, multi-tenant scoping |
| `rooms` | 65 | Housekeeping tabs (every poll & realtime event), agent context, scraper writes |
| `staff` | 48 | Schedule, assignments, agent tools (secondary lookups — see #19 above) |
| `accounts` | 47 | Auth, RLS scoping |
| `cleaning_events` | 26 | Performance tab (30s poll), agent context, ML training |
| `scraper_status` | 23 | Admin diagnostics, doctor checks |
| `model_runs` | 21 | ML health, agent context (predicted minutes), shadow mode |
| `inventory` | 17 | Inventory cockpit, scan-invoice |
| `shift_confirmations` | 16 | Manager save flow, SMS dispatch path |
| `inventory_counts` | 13 | Daily inventory log |
| `inventory_rate_predictions` | 12 | ML inventory predictions |
| `agent_conversations` | 12 | Agent UI sidebar |
| `schedule_assignments` | 11 | Schedule tab (subscribe + save) |
| `onboarding_jobs` | 10 | CUA worker claim, admin diagnostics |
| `agent_messages` | 10 | Agent UI scroll-back |

**Wide-column hot spots (`.select('*')`)** — full list of 28 confirmed sites in `src/lib/db/`:

- `rooms` — [src/lib/db/rooms.ts:24,48,87](src/lib/db/rooms.ts:24)
- `staff` — [src/lib/db/staff.ts:40,76](src/lib/db/staff.ts:40), [src/lib/db/housekeeper-helpers.ts:105](src/lib/db/housekeeper-helpers.ts:105), [src/lib/db/attendance.ts:96](src/lib/db/attendance.ts:96)
- `properties` — [src/lib/db/properties.ts:10,16](src/lib/db/properties.ts:10) (page-level list returns every column)
- `cleaning_events` — [src/lib/db/cleaning-events.ts:196,219,314](src/lib/db/cleaning-events.ts:196)
- `shift_confirmations` — [src/lib/db/shift-confirmations.ts:20,33](src/lib/db/shift-confirmations.ts:20)
- `schedule_assignments` — [src/lib/db/schedule-assignments.ts:50,88](src/lib/db/schedule-assignments.ts:50)
- `inventory` — [src/lib/db/inventory.ts:18](src/lib/db/inventory.ts:18)
- `inventory_counts` — [src/lib/db/inventory-counts.ts:52](src/lib/db/inventory-counts.ts:52)
- `inventory_discards` — [src/lib/db/inventory-discards.ts:42](src/lib/db/inventory-discards.ts:42)
- `inventory_orders` — [src/lib/db/inventory-orders.ts:69](src/lib/db/inventory-orders.ts:69)
- `inventory_budgets` — [src/lib/db/inventory-budgets.ts:33](src/lib/db/inventory-budgets.ts:33)
- `inventory_reconciliations` — [src/lib/db/inventory-reconciliations.ts:50](src/lib/db/inventory-reconciliations.ts:50)
- `dashboard_by_date` — [src/lib/db/dashboard.ts:142,166](src/lib/db/dashboard.ts:142)
- `daily_logs` — [src/lib/db/daily-logs.ts:11,28](src/lib/db/daily-logs.ts:11)
- `deep_clean_config / records` — [src/lib/db/deep-cleaning.ts:19,42](src/lib/db/deep-cleaning.ts:19)
- `work_orders` — [src/lib/db/work-orders.ts:20](src/lib/db/work-orders.ts:20)
- `laundry_config` — [src/lib/db/laundry.ts:10](src/lib/db/laundry.ts:10)
- `public_areas` — [src/lib/db/public-areas.ts:11](src/lib/db/public-areas.ts:11)
- `preventive_tasks` — [src/lib/db/preventive.ts:19](src/lib/db/preventive.ts:19)
- `handoff_logs` — [src/lib/db/handoff-logs.ts:19](src/lib/db/handoff-logs.ts:19)
- `guest_requests` — [src/lib/db/guest-requests.ts:18](src/lib/db/guest-requests.ts:18)
- `manager_notifications` — [src/lib/db/manager-notifications.ts:18](src/lib/db/manager-notifications.ts:18)

Plus the admin/API surface (`src/app/api/admin/{prospects,roadmap,expenses,feedback,property-health}/route.ts`) and bootstrap routes like [src/app/api/laundry/bootstrap/route.ts:97-99](src/app/api/laundry/bootstrap/route.ts:97).

**Subscription pattern amplification** — every `subscribeToX()` helper does a full table refetch on each row change. Files: `subscribeToRooms`, `subscribeToStaff`, [`subscribeToTodayCleaningEvents` src/lib/db/cleaning-events.ts:302-323](src/lib/db/cleaning-events.ts:302), [`subscribeToScheduleAssignments` src/lib/db/schedule-assignments.ts:46-57](src/lib/db/schedule-assignments.ts:46). When a manager edits 20 rooms in 3 seconds (typical), every client subscribed fires 20 full refetches.

**RPC inventory (27 distinct procs)** — well-encapsulated, mostly admin/cron/agent-memory. No N+1 detected at the RPC layer. The advisory-lock-based reservation pattern (`staxis_reserve_agent_spend` / `staxis_finalize_agent_spend` / `staxis_cancel_agent_spend`) is correct and explicitly defended against double-spend.

---

## 4. External API calls on the critical path

### 4a. Anthropic (Claude) — biggest cost lever

| Site | file:line | Model | Triggered by | Notes |
|---|---|---|---|---|
| Agent sync (eval/test path) | [src/lib/agent/llm.ts:527](src/lib/agent/llm.ts:527) | Sonnet 4.6 | Internal evals, `runAgent` | Not on user hot path. |
| Agent stream (PRODUCTION) | [src/lib/agent/llm.ts:736](src/lib/agent/llm.ts:736) | Sonnet 4.6 | `/api/agent/command`, `/api/agent/voice-brain` | Streaming SSE; 50s per-attempt timeout; `maxRetries: 1` ([line 248](src/lib/agent/llm.ts:248)). |
| Walkthrough step | [src/app/api/walkthrough/step/route.ts:400](src/app/api/walkthrough/step/route.ts:400) | Sonnet 4.6 (forced `tool_use`) | Each Clicky walkthrough click | max_tokens=512; per-step reserve $0.03. |
| Vision OCR | [src/lib/vision-extract.ts:178](src/lib/vision-extract.ts:178) | Sonnet 4.6 (vision) | `scan-invoice`, photo-count | max_tokens=8192; 30s timeout; 5MB image cap. |

**Model picker.** [`pickModel()` in src/lib/agent/llm.ts:259-261](src/lib/agent/llm.ts:259) hard-returns `'sonnet'`. Haiku and Opus are defined in the `PRICING` table ([line ~280](src/lib/agent/llm.ts:280)) and a `'haiku'` override exists in `runAgent` opts ([line 512](src/lib/agent/llm.ts:512)), but no caller passes it. Comments at lines 254–256 acknowledge Haiku routing is a 10× cost win pending evals. **Largest deferred cost win in the codebase.**

**Prompt caching.** ✅ Already implemented. [src/lib/agent/llm.ts:493](src/lib/agent/llm.ts:493) marks the stable system block with `cache_control: { type: 'ephemeral' }`; [src/lib/agent/tools/index.ts:217](src/lib/agent/tools/index.ts:217) marks the last tool definition the same way. Usage report tracks `cachedInputTokens` ([line 537, 776](src/lib/agent/llm.ts:537)). Cost estimator at [line 278](src/lib/agent/llm.ts:278) correctly bills cached tokens at 1/10.

**Cost controls.** Reservation pattern via three RPCs (`staxis_reserve_agent_spend`, `staxis_finalize_agent_spend`, `staxis_cancel_agent_spend`). Stale-reservation sweeper runs every 5 min ([vercel.json:21-22](vercel.json:21)). Stranded-row cleanup confirmed in code comments at [src/app/api/agent/command/route.ts:1-40](src/app/api/agent/command/route.ts:1).

**Client lifecycle.** Singletons at `llm.ts:245` and `walkthrough/step/route.ts:93`. **Vision client is NOT a singleton** ([vision-extract.ts:36](src/lib/vision-extract.ts:36)) — single most actionable client-side change.

### 4b. ElevenLabs

- Signed-URL fetch (voice session bootstrap): [src/app/api/agent/voice-session/route.ts:133](src/app/api/agent/voice-session/route.ts:133) — `GET https://api.elevenlabs.io/v1/convai/conversation/get-signed-url`. Once per voice session.
- TTS endpoint: [src/app/api/agent/speak/route.ts:143](src/app/api/agent/speak/route.ts:143) — `POST https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`. Per agent voice response. mp3_44100_128 output.
- Realtime WS via SDK: [src/components/agent/useConversationalSession.ts:159](src/components/agent/useConversationalSession.ts:159) — dynamic-imported `@elevenlabs/client`. Long-lived WS.
- ElevenLabs Custom-LLM webhook callback: ElevenLabs → our `/api/agent/voice-brain/chat/completions` (so our Anthropic spend is downstream of every voice turn).

### 4c. Stripe

- Customer create: [src/lib/stripe.ts:100](src/lib/stripe.ts:100)
- Checkout session: [src/lib/stripe.ts:147](src/lib/stripe.ts:147)
- Billing portal: [src/lib/stripe.ts:186](src/lib/stripe.ts:186)
- Webhook verification: [src/lib/stripe.ts:206](src/lib/stripe.ts:206)

Low frequency (signup / upgrade). Not on the user hot path.

### 4d. Twilio (SMS)

No direct Twilio import in `src/`. SMS dispatch is RPC-driven: `staxis_claim_sms_jobs` and `staxis_reset_stuck_sms_jobs` ([src/lib/sms-jobs.ts:106,118](src/lib/sms-jobs.ts:106)) — the Twilio call happens server-side in the Postgres function or in the `process-sms-jobs` cron handler. Volume scales with shift confirmations + nudges.

### 4e. ML service (FastAPI in `ml-service/`)

Called from every `/api/cron/ml-*` route and from `/api/admin/ml/*/run-inference`. Synchronous HTTP, ~5s per call per property. Not Anthropic.

### 4f. PMS scrapers (Choice Advantage etc.)

Driven by `scraper/scraper.js` and the CUA service Playwright recipes in `cua-service/src/recipe-runner.ts`. Cost is browser CPU + bandwidth, not API tokens.

---

## 5. Synchronous operations that should be async/backgrounded

| Pattern | Location | Why it blocks |
|---|---|---|
| `buildHotelSnapshot` inside the SSE stream constructor | [src/app/api/agent/voice-brain/chat/completions/route.ts:334](src/app/api/agent/voice-brain/chat/completions/route.ts:334) | Snapshot fetch happens after the SSE stream starts. Hoist it before stream construction so the user sees first token sooner. |
| Per-turn assistant memory write before stream close | [src/app/api/agent/command/route.ts](src/app/api/agent/command/route.ts) (around the finally of the streaming handler) | The `recordAssistantTurn` RPC blocks before the response finishes. Already throws on failure (Codex fix #2), so it must be in-flight — but consider firing it in parallel with sending the final SSE chunk. |
| Inline conversation summarization | [src/app/api/cron/agent-summarize-long-conversations/route.ts](src/app/api/cron/agent-summarize-long-conversations/route.ts) | Runs synchronously per conversation. Already on a cron, so not user-facing — but could be a job queue with per-conversation idempotency keys. |
| `JSON.stringify` equality at render time | [src/app/housekeeping/_components/ScheduleTab.tsx:201](src/app/housekeeping/_components/ScheduleTab.tsx:201), [src/contexts/AuthContext.tsx:201](src/contexts/AuthContext.tsx:201) | Runs in render path. Small payloads in practice; low priority. |
| Vision `new Anthropic(...)` per call | [src/lib/vision-extract.ts:36](src/lib/vision-extract.ts:36) | TLS handshake per call. Singleton fix. |

No `fs.readFileSync` in hot request paths. No `bcrypt`/expensive crypto on hot paths (auth uses Supabase). No large `JSON.parse` outside known SSE-decoder paths.

---

## 6. Over-fetching (caller wants less than it gets)

| Site | Over-fetched | Caller actually uses |
|---|---|---|
| `listProperties()` [src/lib/db/properties.ts:10](src/lib/db/properties.ts:10) | All columns of every property | Most callers want `id`, `name`, `timezone`, `total_rooms` |
| `subscribeToRooms` and `fetchRooms` [src/lib/db/rooms.ts:24,48,87](src/lib/db/rooms.ts:24) | Every column of every room | Housekeeping UI uses ~10 columns |
| `subscribeToStaff` [src/lib/db/staff.ts:40,76](src/lib/db/staff.ts:40) | Every column of every staff row | Schedule UI needs `id, name, role, active, auth_user_id` |
| `subscribeToTodayCleaningEvents` [src/lib/db/cleaning-events.ts:302-323](src/lib/db/cleaning-events.ts:302) | All cleaning events for today (no `.limit()`) | Performance tab paginates client-side |
| `getFlaggedCleaningEvents` (poll target of [PerformanceTab.tsx:113](src/app/housekeeping/_components/PerformanceTab.tsx:113)) | All flagged events | UI shows ~20 at a time |
| `/api/laundry/bootstrap` [src/app/api/laundry/bootstrap/route.ts:97-99](src/app/api/laundry/bootstrap/route.ts:97) | `public_areas`, `laundry_config`, `rooms` all with `.select('*')` | UI needs subset of each |
| Agent conversation history fetch | [src/app/api/agent/conversations/[id]/route.ts](src/app/api/agent/conversations/[id]/route.ts) | Full thread, no pagination visible | UI shows most-recent N |

---

## 7. Per-request work that could be cached, batched, or moved to startup

| Work | Currently | Recommendation |
|---|---|---|
| Hotel snapshot | 30s in-process Map cache at [context.ts:49-53](src/lib/agent/context.ts:49) | Lift to shared cache (Vercel Data Cache or KV). Survives across instances. |
| Anthropic client construction | Singleton in `llm.ts` and `walkthrough/step/route.ts`; **per-call in `vision-extract.ts`** | Add singleton to vision-extract. |
| Prompt caching | Enabled on stable system block + last tool | Already optimal. Monitor `cachedInputTokens` ratio per route to confirm hit rate. |
| Tool catalog | Loaded via side-effect import at [src/app/api/agent/command/route.ts:61](src/app/api/agent/command/route.ts:61) | Already done at module load. |
| Hotel timezone / room inventory | Read inside `buildHotelSnapshot` each call | Move to a property-level cache with realtime invalidation on `properties` row change. |
| Doctor checks (admin diagnostics) | Per-route invocation with 60s in-memory cache | Confirmed already cached at [src/app/api/admin/doctor/route.ts](src/app/api/admin/doctor/route.ts). |
| Admin overview-stats / agent metrics | Polled every 15–30s by the client | Move to SSE channel or bump intervals. |
| Realtime refetch | One per row event | Debounce + diff against `updated_at`. |

---

## 8. AI/LLM calls — what triggers them

### Per-request LLM calls (Sonnet 4.6 unless noted)

| Trigger | Path | Cost note |
|---|---|---|
| **User sends agent chat message** | `POST /api/agent/command` → `streamAgent` → up to 8 tool iterations | Largest single-message variability — agent loops can do 1–8 LLM calls. |
| **User clicks in Clicky walkthrough** | `POST /api/walkthrough/step` → Sonnet with forced tool_use | $0.03 reserved per step; max 512 output tokens. |
| **ElevenLabs sends voice turn** | `POST /api/agent/voice-brain/chat/completions` → same agent loop as chat | Subject to all of #1's costs. |
| **Inventory manager scans invoice** | `POST /api/inventory/scan-invoice` → `visionExtractJSON` | Up to 8192 output tokens. |
| **Inventory manager photo-counts items** | (photo-count route) → `visionExtractJSON` | Same. |

### Cron-triggered LLM calls

| Trigger | Schedule | Notes |
|---|---|---|
| Nudges check | `*/5 * * * *` | Fans out across properties; some property evaluations call Anthropic. |
| Long-conversation summarization | `*/30 * * * *` | Per-conversation Anthropic call. |
| Weekly digest | `0 9 * * 0` | Once weekly per account. Low frequency. |

### NOT per-request LLM (despite naming)

- ML service routes (`ml-train-*`, `ml-run-inference`, `ml-shadow-evaluate`) — these are XGBoost / Bayesian / Monte Carlo in Python. Not Anthropic.
- `walkthrough-health-alert` — DB-only health check, no LLM.
- `scraper-health`, `doctor-check` — diagnostics, no LLM.

**Streaming vs batch.** Production agent path streams ([llm.ts:736](src/lib/agent/llm.ts:736)); evals call sync ([llm.ts:527](src/lib/agent/llm.ts:527)). No Anthropic Batch API usage. Batching would only help cron-triggered LLM calls (#nudges, #summarization) — real-time paths can't batch.

**Large context.** No file-upload Anthropic flow. Conversation history is bounded by the conversation-archival cron ([vercel.json:25-26](vercel.json:25)). Hotel snapshot is small (~5 fields, sub-KB).

**Tool re-sending.** Tools defined fresh each request but the last one is `cache_control: ephemeral` so the full tool block is cached on Anthropic's side after first call.

---

## 9. Polling and intervals — full inventory

### Client-side intervals

| Location | Interval | What it polls | Notes |
|---|---|---|---|
| [src/lib/db/housekeeper-helpers.ts:78-84](src/lib/db/housekeeper-helpers.ts:78) | **4s** | Public housekeeper SMS link — rooms refetch | `document.visibilityState` guard. Most aggressive in the app. |
| [src/app/onboard/page.tsx:699](src/app/onboard/page.tsx:699) | 3s | Onboarding status | Only during 5–30 min onboarding flow. |
| [src/app/housekeeping/_components/RoomsTab.tsx:85](src/app/housekeeping/_components/RoomsTab.tsx:85) | 15s | `setNowMs(Date.now())` for relative timestamps | Just a re-render trigger, not a fetch. |
| [src/app/housekeeping/_components/DeepCleanTab.tsx:169](src/app/housekeeping/_components/DeepCleanTab.tsx:169) | (visibility-change driven) | Today's rooms |  |
| [src/app/housekeeping/_components/PerformanceTab.tsx:113](src/app/housekeeping/_components/PerformanceTab.tsx:113) | 30s | `getFlaggedCleaningEvents()` | No pagination on fetch. |
| [src/app/laundry/[id]/page.tsx:126](src/app/laundry/[id]/page.tsx:126) | 30s | `loadBootstrap` | Calls `/api/laundry/bootstrap` (wide-column query). |
| [src/app/admin/agent/page.tsx:97](src/app/admin/agent/page.tsx:97) | 30s | `fetchMetrics` | Agent metrics rollup. |
| [src/app/admin/_components/HealthBanner.tsx:33,54](src/app/admin/_components/HealthBanner.tsx:33) | **60s** | Overview health | Already at the right interval. |

### Worker / cron intervals

| Location | Interval | Notes |
|---|---|---|
| [cua-service/src/index.ts:33,79](cua-service/src/index.ts:33) | 5s | `staxis_claim_next_job` RPC + recipe execution |
| `scraper/scraper.js:69-100` | 5 min (TICK_MINUTES) | Wake/sleep loop |
| Scraper CSV pulls | hourly 5am–11pm | 7×/day/hotel |
| Scraper dashboard pulls | every 15min 5am–11pm | 32×/day/hotel |

### Vercel cron jobs (`vercel.json`)

13 scheduled crons:

| Path | Schedule |
|---|---|
| `/api/cron/expire-trials` | `0 9 * * *` |
| `/api/cron/process-sms-jobs` | `*/5 * * * *` |
| `/api/cron/scraper-health` | `*/15 * * * *` |
| `/api/agent/nudges/check` | `*/5 * * * *` |
| `/api/cron/agent-sweep-reservations` | `*/5 * * * *` |
| `/api/cron/agent-archive-stale-conversations` | `0 3 * * *` |
| `/api/cron/agent-summarize-long-conversations` | `*/30 * * * *` |
| `/api/cron/agent-heal-counters` | `0 4 * * *` |
| `/api/cron/agent-weekly-digest` | `0 9 * * 0` |
| `/api/cron/doctor-check` | `0 * * * *` |
| `/api/cron/walkthrough-heal-stale` | `*/30 * * * *` |
| `/api/cron/walkthrough-health-alert` | `*/10 * * * *` |
| `/api/cron/seed-rooms-daily` | `10 * * * *` |

**Routes that exist under `/api/cron/` but are NOT in `vercel.json`** (triggered externally, presumably GitHub Actions or manual): `enqueue-property-pulls`, `ml-aggregate-priors`, `ml-predict-inventory`, `ml-retention-purge`, `ml-run-inference`, `ml-shadow-evaluate`, `ml-train-demand`, `ml-train-inventory`, `ml-train-supply`, `purge-old-error-logs`, `schedule-auto-fill`, `scraper-weekly-digest`, `seal-daily`. Document the external triggers if not already in a runbook.

### Realtime subscriptions (event-driven, frequency proportional to row changes)

Centralized in [src/lib/db/_common.ts:69-169](src/lib/db/_common.ts:69) (`subscribeTable`). All `subscribeToX` helpers in `src/lib/db/` use this. Each `postgres_changes` event triggers a full refetch — N row changes = N refetches.

---

## 10. Recommendations, ranked by ROI

Each item lists the **expected effort** (S = <1h, M = 1–4h, L = >4h) and **estimated impact**.

1. **[S] Singleton the Vision Anthropic client** at [src/lib/vision-extract.ts:36](src/lib/vision-extract.ts:36). Saves a TLS handshake per OCR call. Trivial diff.
2. **[S] Bump the 30s admin pollers to 60s** ([src/app/admin/agent/page.tsx:97](src/app/admin/agent/page.tsx:97), [src/app/laundry/[id]/page.tsx:126](src/app/laundry/[id]/page.tsx:126)). 50% fewer admin requests.
3. **[S] Bump housekeeper public poll** from 4s → 6–8s at [src/lib/db/housekeeper-helpers.ts:84](src/lib/db/housekeeper-helpers.ts:84). Visibility guard already in place; this is just dialing the fallback. 30–50% fewer requests when realtime fails.
4. **[M] Debounce realtime refetches** in [src/lib/db/_common.ts:69-169](src/lib/db/_common.ts:69). Collapse bursts of row changes into one refetch. Helps every subscribed UI.
5. **[M] Narrow the top 10 `.select('*')` sites** on `rooms`, `staff`, `properties`, `cleaning_events`, `schedule_assignments`. One DB-helper change cascades through every caller.
6. **[L] Lift hotel-snapshot cache from in-process to shared.** [src/lib/agent/context.ts:49-53](src/lib/agent/context.ts:49) is a `Map`, scoped to a single Vercel Lambda instance. With cold starts, the cache misses are way more frequent than the 30s TTL suggests. Move to Vercel Data Cache / KV.
7. **[L] Ship Haiku routing for confirmed-simple commands** — [`pickModel()` src/lib/agent/llm.ts:259](src/lib/agent/llm.ts:259) is the single biggest deferred LLM cost win. ~10× cheaper input/output. Needs an eval harness — the path exists at [src/lib/agent/evals/](src/lib/agent/evals/).
8. **[M] Tighten the conversation-summarizer cron** — only summarize conversations > 200 messages AND last summary > 24h old. Move to off-peak (current `*/30` runs all day).
9. **[M] Skip inactive properties in `*/5` crons** — nudges-check and agent-sweep-reservations fan out across all properties. Add a "last-activity > 7d → skip" guard.
10. **[S] Hoist `buildHotelSnapshot` outside the SSE stream** in [src/app/api/agent/voice-brain/chat/completions/route.ts:334](src/app/api/agent/voice-brain/chat/completions/route.ts:334). Lets the stream start sooner.
11. **[M] Compress invoice images client-side** before posting to `/api/inventory/scan-invoice`. Resize to ≤1024px long edge, 0.85 JPEG quality. Vision tokens scale with image size.
12. **[M] Fix the agent tool N+1** — staff name lookups in [src/lib/agent/tools/queries.ts](src/lib/agent/tools/queries.ts). Use a single `rooms` query with `assignee:staff(name)` shape.
13. **[L] Add a "warm browser context" cache** in [cua-service/src/recipe-runner.ts](cua-service/src/recipe-runner.ts) — reuse a logged-in Chromium across consecutive jobs for the same PMS hotel.
14. **[L] Replace CUA's 5s claim-loop with PG NOTIFY** — let Vercel signal Fly when a job is enqueued instead of polling. Removes idle RPC traffic on the Fly worker.
15. **[L] Document external triggers for the 13 un-Vercel-scheduled cron routes** — anyone reading `vercel.json` will assume they're not running.

---

## 11. Estimates (back-of-envelope)

> These numbers are **derived from pricing × estimated frequency**, not from telemetry. Treat them as direction, not budget.

**Anthropic pricing (Sonnet 4.6):** input $3 / M tokens, cached input $0.30 / M, output $15 / M ([PRICING table in src/lib/agent/llm.ts:278](src/lib/agent/llm.ts:278)).

**Per-message agent chat (typical):**
- System prompt + tools ≈ 4–6K tokens, mostly **cached** ($0.30/M)
- User message + history ≈ 500–2K input tokens (uncached)
- Output ≈ 200–800 tokens
- 1–3 tool iterations typical (each adds ~500 cached + tool result)
- **Estimated cost per user message: ~$0.005–$0.015 typical, $0.05+ for heavy 8-iteration tool loops.**

**Per walkthrough step:**
- Cost-reservation cap: $0.03 ([line 89](src/app/api/walkthrough/step/route.ts:89)).
- Average likely $0.008–$0.015 (smaller max_tokens at 512).

**Per invoice OCR:**
- Image tokens dominate. 1MB JPEG ≈ ~1.5K vision tokens at typical resolution.
- Output up to 8192 tokens for ~150-line invoices.
- **Estimated: $0.02–$0.10 per scan depending on document size.**

**Cron LLM spend (rough):**
- Nudges check `*/5`: 288 runs/day × N properties × P(needs LLM call) — bounded by per-property nudge cooldowns.
- Summarizer `*/30`: 48 runs/day × N qualifying conversations. With the recommended >200-msg gate, likely <10 conversations/day at current scale.

**The cost surface is dominated by per-user-action LLM calls** (chat turns + walkthrough steps + invoice scans), not by crons. Anthropic prompt caching is the single largest cost lever already in place; **Haiku routing for simple turns is the next 10× win** (recommendation #7).

---

## Appendix: methodology

- **Code search**: grep, glob, AST-level reads via `Read`. No `eslint --rule no-unused-imports` or similar.
- **Verification**: every file:line citation in this report was opened during the audit. Spot-check a random 5 if reviewing.
- **What's NOT in scope**: actual Anthropic console spend, Supabase query stats, Vercel function timing histograms. Those would refine the ranking — but the static ordering is robust.
- **Branch**: `audit/cost-hotpaths`, branched from `claude/laughing-fermat-e8bab0`. No source files modified.
