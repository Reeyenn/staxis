# AI Layer Invariants

This document is the canonical reference for every invariant the AI
layer depends on. When you change the AI layer, consult this list.
When you add a new invariant, append it here AND add the constraint
that enforces it.

## Why this exists

Round 12 (2026-05-13) of agent-layer review identified the structural
root cause of the bug-fix cycle: **the system encodes implicit
invariants in code, not in the database**. When two subsystems
interact, an invariant from one breaks the other silently. Codex
found a HIGH-severity bug (summarizer splitting tool_use/tool_result
pairs) and another HIGH-severity bug (restore RPC double-counting
counters) that both fit this pattern.

The fix is to encode invariants at the DB level wherever possible:
CHECK constraints, partial unique indexes, triggers, RPC
preconditions. Code can be wrong; the DB stays consistent. Each
invariant on this list is either DB-enforced or marked as a known gap.

## Doctrine

Before adding any feature to `src/lib/agent/`:
1. List its invariants below.
2. Add the constraint that enforces each (CHECK, trigger, RPC
   precondition).
3. If the invariant truly cannot be enforced at the DB level,
   document **why** and add a property-based test in
   `src/lib/agent/evals/` instead.

Code-level enforcement ("the function checks this before insert")
counts as **NOT ENFORCED** for the purpose of this doctrine. It
WILL drift over time across review rounds.

## Format

Each invariant has:
- **ID** (e.g. INV-1)
- **Statement** of the invariant
- **Enforced by** (constraint/trigger name + migration, or "NOT
  ENFORCED" + why)
- **Assumed by** (file:line where code relies on it)
- **History** (which review round originally surfaced it)

## Invariants

### INV-1: agent_messages.role='tool' rows have a matching tool_use earlier in the same conversation

- **Enforced by:** Trigger `agent_messages_tool_result_orphan_check` calling `staxis_check_tool_result_pairing()` (migration 0114, T12.11)
- **Assumed by:** [memory.ts toClaudeMessages](src/lib/agent/memory.ts), summarizer batch logic
- **History:** Surfaced by Codex round-12 finding #1

### INV-2: Summary batches must not split a tool_use/tool_result pair across the 50-row boundary

- **Enforced by:** Code in `trimTrailingOrphanToolUses()` ([summarizer.ts](src/lib/agent/summarizer.ts), T12.1). NOT enforced at DB level — would require RPC-side knowledge of batch contents.
- **Assumed by:** memory.ts replay; toClaudeMessages skips orphan tool rows.
- **Backstop:** INV-1's trigger catches the orphan if it ever lands.
- **History:** Surfaced by Codex round-12 finding #1.
- **TODO:** Consider RPC-side enforcement in a future round (have the apply RPC verify boundaries).

### INV-3: agent_prompts.content is non-empty (not NULL, not whitespace-only)

- **Enforced by:** CHECK constraint `agent_prompts_content_nonempty` (migration 0114)
- **Assumed by:** [prompts-store.ts loadFromDb + resolvePrompts](src/lib/agent/prompts-store.ts)
- **History:** Round-12 my-pass agent finding #2

### INV-4: After staxis_restore_conversation, message_count = SELECT count(*) FROM agent_messages

- **Enforced by:** Restore RPC's defensive recompute UPDATE (migration 0113)
- **Assumed by:** Summarization candidate filter, `/admin/agent` KPI
- **History:** Codex round-12 finding #2

### INV-5: Tool result content truncation cap is the same across all writers

- **Enforced by:** Single exported constant `MAX_TOOL_RESULT_CHARS` in [llm.ts](src/lib/agent/llm.ts) imported by every consumer. NOT enforced at DB level — would require a CHECK with a hardcoded number that drifts from the constant.
- **Assumed by:** llm.ts tool_result persistence, summarizer.ts formatter, evals runner.
- **History:** Round-12 senior-Anthropic-engineer finding #4

### INV-6: An agent_messages row cannot have both is_summary=true AND is_summarized=true

- **Enforced by:** CHECK constraint `agent_messages_summary_xor` (migration 0106)
- **Assumed by:** memory.ts replay, summarizer
- **History:** Round-10 F7

### INV-7: agent_conversations.message_count >= 0 AND unsummarized_message_count >= 0

- **Enforced by:** CHECK constraints `agent_conversations_msg_count_nonneg` + `agent_conversations_unsummarized_nonneg` (migration 0114 + 0115 hotfix)
- **Assumed by:** Summarization candidate filter, /admin/agent KPI
- **History:** Round-12 META analysis. The bump triggers from 0100/0105 had no bound — could go negative under weird interleavings.
- **Note:** The original 0114 also enforced `unsummarized_message_count <= message_count`, but Postgres triggers fire in alphabetical order and the message-count trigger fires BEFORE the unsummarized trigger. On DELETE: message_count drops first, creating a transient state where unsummarized > message_count. CHECK constraints aren't DEFERRABLE in Postgres, so the upper bound had to be relaxed. The `staxis_heal_conversation_counters` cron (T12.12) is the safety net that catches commit-time drift.

### INV-8: agent_messages.role is in ('user','assistant','tool','system')

- **Enforced by:** CHECK constraint `agent_messages_role_enum` (migration 0114)
- **Assumed by:** memory.ts replay branches; if a row had role='admin' (typo), it would silently fall through.
- **History:** Round-12 META analysis (implicit since project start)

### INV-9: agent_messages with is_summary=true must have role='assistant'

- **Enforced by:** CHECK constraint `agent_messages_summary_is_assistant` (migration 0114)
- **Assumed by:** memory.ts replay (the is_summary branch only handles role=assistant)
- **History:** Round-12 META analysis

### INV-10: agent_messages rows with role='tool' must have a non-NULL tool_call_id

- **Enforced by:** CHECK constraint `agent_messages_tool_needs_call_id` (migration 0114)
- **Assumed by:** memory.ts toClaudeMessages (joins on tool_call_id), metrics route (tool error rate join)
- **History:** Round-12 META analysis

### INV-11: Trust-marker boundary tags are escaped in any content wrapped in them

- **Enforced by:** Code helper `escapeTrustMarkerContent` ([llm.ts](src/lib/agent/llm.ts), Round 12 T12.4 rename). Applied at every wrap site (llm.ts toClaudeMessages, summarizer formatter, memory.ts summary-wrap). NOT enforced at DB level.
- **Assumed by:** PROMPT_BASE trust rule
- **History:** Round-5 trust marker chain; Round-12 T12.6 extended to summary path

### INV-12: Active prompts cache invalidation propagates within 30s

- **Enforced by:** Cache TTL (`CACHE_TTL_MS=30_000` in [prompts-store.ts](src/lib/agent/prompts-store.ts)) — accepted trade-off documented in L2 design
- **Assumed by:** Admin prompt-editing workflow
- **History:** Round-2/L2

### INV-13: Streaming reservation finalize OR cancel always runs in the route's finally

- **Enforced by:** Code (`route.ts` finally block + sweep cron as backstop)
- **Assumed by:** Cost cap math
- **History:** Round-5, Round-7

### INV-14: agent_messages.is_summarized=true rows are excluded from the replay history

- **Enforced by:** Code filter in `loadConversation` + `lockLoadAndRecordUserTurn` RPC
- **Assumed by:** L4 part B (summarization)
- **History:** Round-10 F1

### INV-15: When MODEL_OVERRIDE.haiku is set, the summarizer uses that snapshot

- **Enforced by:** Code (`MODELS[model]` resolution in [llm.ts](src/lib/agent/llm.ts:62), used by summarizer via `runAgent({ model: 'haiku' })`)
- **Assumed by:** Operator rollback workflow when Anthropic ships a regression
- **History:** Round-11 T5

### INV-16: Only one prompt row per role can be is_active=true at a time

- **Enforced by:** Partial unique index `agent_prompts_active_per_role_uq` (migration 0102)
- **Backstop:** Atomic `staxis_activate_prompt` RPC (migration 0106) inside one transaction
- **Assumed by:** prompts-store.ts (returns first match)
- **History:** Round-2 L2; Round-10 F5 added the atomic activate path

### INV-17: Cap math (user + property + global) ignores kind='background' rows

- **Enforced by:** Filter in `staxis_reserve_agent_spend` RPC (migration 0082) — `WHERE kind = 'request'`
- **Assumed by:** /admin/agent KPI separation, summarizer cost-tracking expectation
- **History:** Round-11 T2 (verified by review)
- **Note (2026-05-13 voice surface):** `assertAudioBudget` ([cost-controls.ts](src/lib/agent/cost-controls.ts)) deliberately deviates from INV-17 — it sums ALL kinds for the audio pre-flight check. Per Reeyen 2026-05-13: voice + text should share one $5/day total cap, not $5 + $5 = $10 effective. The reservation RPC for text stays kind='request' filtered (covers itself); the audio gate is total-spend-aware so audio doesn't stack on top of text.

### INV-18 (RETIRED 2026-05-14, table dropped in 0141): voice_recordings.expires_at = created_at + interval '7 days'

- **Status:** Retired with the ElevenLabs voice-surface switch and the underlying `voice_recordings` table was dropped in migration `0141_drop_dead_schema.sql` after the data-model audit confirmed zero writers/readers. Whisper STT and the per-clip storage upload were replaced by ElevenLabs streaming ASR (audio lives on their side). Entry preserved for historical commit-message context.
- **History:** Active 2026-05-13 → 2026-05-14. Retired when `/api/agent/transcribe` + `/api/cron/voice-recordings-purge` were deleted in the ElevenLabs cutover. Table dropped 2026-05-17 in `0141`.

### INV-19 (RETIRED 2026-05-14, table dropped in 0141): voice_recordings rows past expires_at are deleted within 24h

- **Status:** Retired alongside INV-18; table dropped in `0141_drop_dead_schema.sql`. The daily purge cron `/api/cron/voice-recordings-purge` was removed (no new rows to purge). Entry preserved for historical commit-message context.
- **History:** Active 2026-05-13 → 2026-05-14. Table dropped 2026-05-17 in `0141`.

### INV-20: agent_costs.kind='audio' rows have cost_usd > 0

- **Enforced by:** Code — `recordNonRequestCost` ([cost-controls.ts](src/lib/agent/cost-controls.ts)) short-circuits when `costUsd <= 0`. /api/agent/voice-brain only writes a `kind='audio'` row when `streamAgent` emits a `done` event with a non-zero usage report, so a zero-cost row would represent a logic bug. NOT enforced at DB level — `cost_usd >= 0` is in the column CHECK but `> 0` for `kind='audio'` would require a partial CHECK we judged not worth the schema noise.
- **Assumed by:** Audio-spend KPI in `/admin/agent` (counts `kind='audio'` rows as billable usage). ElevenLabs STT + TTS minutes are billed on their platform and surfaced separately; this row covers the Claude brain tokens consumed by each voice turn.
- **History:** Voice surface build 2026-05-13; revised 2026-05-14 for the ElevenLabs cutover (was Whisper/TTS cost; now Claude-brain cost only).

### INV-21: Wake-word detection runs only when document.visibilityState === 'visible'

- **Enforced by:** Code in `<WakeWord />` ([WakeWord.tsx](src/components/agent/WakeWord.tsx)) — `document.addEventListener('visibilitychange', ...)` starts the `PorcupineWorker` on visible and calls `release()` on hidden. NOT enforced at DB level (browser-only invariant). The doctor route's `REQUIRED_ENV_VARS` includes `PICOVOICE_ACCESS_KEY` so a misconfigured deploy fails the green check rather than silently leaving the worker idle.
- **Assumed by:** Battery / mic-permission story for the wake word being defensible — a tab in the background can't burn cycles. If this drifts, every backgrounded Staxis tab continues listening, which is a real user complaint vector.
- **History:** Voice surface build 2026-05-13.

### INV-22: Any "API key / required env var is missing" throw inside the agent layer also fires `captureException` to Sentry

- **Enforced by:** Code (`getClient()` in [llm.ts](src/lib/agent/llm.ts) calls `captureException` before throwing; future OpenAI client init in `src/lib/openai-client.ts` must do the same). The hourly `/api/cron/doctor-check` is the proactive safety net.
- **Assumed by:** Alerting infrastructure — silent UI errors are the exact failure mode this invariant exists to eliminate.
- **History:** Round 13 (2026-05-13). The 2026-05-13 incident: `ANTHROPIC_API_KEY` was missing in prod for an unknown duration; the chat showed a polite user-facing error but no operator notification fired. Discovered only because the founder typed "hi" into the chat. Going forward: every "API key missing" code path must `captureException` so the FIRST user to hit it triggers an SMS within ~1 minute, AND the new doctor-check cron catches it within ~1 hour even if no user hits it.

### INV-23: The agent's "total rooms" answer comes from `properties.room_inventory`, never from `count(rooms WHERE date=today)`

- **Enforced by:**
  - Code: [`buildHotelSnapshot`](src/lib/agent/context.ts) and [`get_today_summary`](src/lib/agent/tools/queries.ts) both read `room_inventory.length` for `rooms.total` (falling back to seeded count only when inventory is empty). `get_occupancy` used to be the third reader; the 2026-07-27 catalog rebuild folded it into `get_today_summary`, which inherited its never-shrink `computeRoomTotal` call — the invariant now has one fewer place to drift.
  - Cron: `/api/cron/seed-rooms-daily` runs hourly, calling `seedRoomsForDate()` ([src/lib/rooms/seed.ts](src/lib/rooms/seed.ts)) to phantom-seed every inventory room as vacant/clean whenever today's row count is short.
  - Doctor: `rooms_today_seeded` check ([doctor route](src/app/api/admin/doctor/route.ts)) alerts SMS when any property's gap is ≥ 4 rooms or > 10% of inventory.
- **Assumed by:** Every AI surface that reports "X total rooms" or computes an occupancy percentage. The CSV from Choice Advantage omits vacant-clean rooms entirely (see migration `0025_property_room_inventory.sql`), so `count(rooms today)` is structurally a partial picture; reading it as truth produced the 2026-05-14 incident.
- **History:** Round 14 (2026-05-14). User asked "how many people do we have in-house?" and the chat replied "100% occupancy, all 70 rooms occupied, 0 vacant" for a 74-room property. The 4 missing rooms were vacant-clean and got omitted by the CSV. Going forward: any new code that computes "total rooms" inside the agent must source it from `room_inventory.length` and surface a `seedingGap` so the agent can warn the user when it's looking at a partial seed.

### INV-24: properties.total_rooms == array_length(properties.room_inventory, 1) for every active property

- **Enforced by:**
  - **DB trigger** `staxis_sync_total_rooms_to_inventory` (migration 0125): on INSERT or on any UPDATE that changes `room_inventory`, automatically sets `total_rooms = array_length(room_inventory)`. Drift between writes is impossible.
  - Doctor: `rooms_today_seeded` check fails when `total_rooms` and `array_length(room_inventory)` disagree (both nonzero). This catches any pre-trigger legacy drift OR any path that somehow bypasses the trigger.
  - Code backstop: [`computeRoomTotal`](src/lib/agent/tools/_helpers.ts) and [`computeOccupancySummary`](src/lib/agent/tools/_helpers.ts) take the MAX of inventory length, configured total, and seeded count — so even a transient mid-transaction read would never under-report to the user.
- **Why a trigger, not a generated column:** a generated column would derive `total_rooms = array_length(room_inventory, 1)`. But an empty inventory yields 0, failing the existing `total_rooms > 0` CHECK constraint (migration 0116). The trigger only fires when inventory is non-empty, leaving the existing "onboarding wizard sets total_rooms before inventory is captured" flow intact.
- **Assumed by:** Every AI surface that reports "X total rooms" — the agent reads the max signal, so under-reporting is impossible even mid-drift. Also the ML stack which reads `total_rooms` for property sizing.
- **History:** Codex round-2 adversarial review of Round 14 (2026-05-14). Round 14 chose `room_inventory` as the single source for the agent layer and added a doctor check that ONLY read inventory — so a stale or empty inventory (with `total_rooms` still 74) silently passed status=ok while the AI under-reported.

### INV-32: The PMS feed tables the model reads directly never record a capture time in the future

- **Enforced by:** `captured_at timestamptz NOT NULL DEFAULT now()` (live on
  `pms_in_house_snapshot`, `pms_guest_balances`, `pms_payments_daily` — verified
  in prod 2026-07-24) **plus** the `<table>_captured_at_not_future` CHECK
  constraints in migration `0351_pms_capture_time_sanity.sql`. Code backstop:
  `freshnessAgeMinutes` ([feed-status.ts](src/lib/pms/feed-status.ts)) clamps a
  negative age to 0 and `console.warn`s.
- **Coverage SHRANK, deliberately.** 0351 pinned six tables. Three of those are
  gone: `pms_future_bookings` (0343, replaced by `pms_booking_pace`) and
  `pms_no_shows` + `pms_cancellations` (0354, folded onto `pms_reservations`).
  Their CHECK constraints went with them, and the no-show and cancellation
  readers now borrow `pms_reservations.last_synced_at`, which carries NO
  not-future constraint. That is a real narrowing of this invariant, recorded
  here rather than left for someone to discover from a negative age.
  **Trigger condition: when the report-intake workstream settles the as-of
  model on `pms_reservations`, pin it there too.**
- **Scope — read this before quoting it.** This covers those feed tables and
  nothing else. It is explicitly **NOT** "every PMS row the model can see":
  the snapshot's room numbers flow from `pms_room_status_log`,
  `pms_housekeeping_assignments`, `room_work` and `pms_reservations`, **none of
  which have a `captured_at` column at all**. Adding one is an ingestion-schema decision
  owned by the intake layer, not the AI layer; until then those numbers borrow
  the property-level signal from `fetchFreshness`
  ([pms-feed-status-server.ts](src/lib/pms-feed-status-server.ts)), which is an
  approximation and is labelled as such by its `source` field.
- **Assumed by:** every age/tier judgement in
  [feed-status.ts](src/lib/pms/feed-status.ts), the snapshot as-of line, the
  tool stamp, and the nudge suppression guard. A future-dated capture makes
  every age negative and every tier read `fresh` — the honesty layer would
  then state hours-old numbers as live, worse than the silence it replaced.
- **History:** A2 data-age honesty, 2026-07-24.

### INV-33: The as-of VALUE never appears in the cached stable system block

- **Enforced by:** `src/lib/__tests__/agent-prompt-cache-purity.test.ts` — two
  snapshots 40 minutes apart must yield a byte-identical `stable`, the rendered
  clock and age from the dynamic block must not appear in `stable`, and
  `stable` must contain no "min ago"/"hr ago" wording. Only the constant RULE
  (`DATA_FRESHNESS_PROMPT`) lives in the stable block; the value lives in the
  dynamic snapshot, which llm.ts appends without `cache_control`.
- **NOT DB-enforceable:** this is a property of string composition inside
  `buildSystemPrompt`, invisible to Postgres.
- **Assumed by:** the entire prompt-cache cost model. The plausible bug —
  someone appends the as-of line to `stableParts` to "make sure the model sees
  it" — breaks nothing visible while multiplying the input-token bill on every
  single turn, indefinitely, silently.
- **History:** A2 data-age honesty, 2026-07-24.

### INV-34: Operational nudges are computed against the data's capture time, and are suppressed when the feed is older than one report cycle

- **Enforced by:** the signatures themselves —
  `overdueRoomDrafts(rooms, propertyId, capturedAt, now, asOfLabel)` and
  `unresolvedHelpDrafts(...)` in [nudges.ts](src/lib/agent/nudges.ts) are pure
  with both clocks injected, so there is no ambient `Date.now()` inside them to
  reach for — plus `src/lib/__tests__/agent-nudge-data-clock.test.ts`, whose
  first case fails against the pre-A2 wall-clock code. The run-level guard in
  `checkOperationalAlerts` returns `[]` for tiers `stale` / `very_stale` /
  `unknown` (> `PMS_FRESH_MAX_MINUTES` = 75).
- **Gated on `mode === 'live'`.** A manual (`no_pms`) hotel has no capture time,
  falls back to `now`, and is never suppressed — its data genuinely is live.
- **Known approximation:** `capturedAt` comes from the in-house snapshot feed
  while `startedAt` comes from the housekeeping-assignments feed. That is only
  exact if one ingest run writes both near-simultaneously. **To verify against
  the report-intake writer when it lands**; if the feeds diverge, anchor on
  `pms_housekeeping_assignments.last_synced_at` instead.
- **Accepted cost:** a genuinely overdue room goes unflagged during an
  ingestion outage. The correct alert then is "reports stopped arriving", which
  the intake layer owns; duplicating it here would be the overlap to avoid.
- **History:** A2 data-age honesty, 2026-07-24.

### INV-35: Every agent tool that reads PMS data declares an explicit `pmsFreshness`, and every 'stamped' one is stamped by the dispatcher

- **Enforced by:** `src/lib/__tests__/agent-pms-freshness-completeness.test.ts`
  — an explicit `PMS_BACKED_TOOL_NAMES` list (14 tools, including the 7 that
  read PMS data INDIRECTLY through `mergePmsRoomsForDate` /
  `fetchTodayPropertyCounts` and therefore contain no `.from('pms_` to grep
  for), plus a source-scan backstop over `src/lib/agent/tools/*.ts` and an
  assertion that no `mutates: true` tool declares a data age. Mirrors the
  existing approval-tier completeness test.
- **Stamping is structural:** it happens once in `executeTool`, not per tool, so
  a new tool cannot forget to stamp — only to declare the flag, which the test
  above catches. A handler that resolves its own per-row `captured_at` wins over
  the property-level signal.
- **NOT DB-enforceable:** the tool registry is an in-process TypeScript map.
- **History:** A2 data-age honesty, 2026-07-24.

### INV-36: There is exactly ONE definition of "is this feed fresh", and it lives in SQL

- **Enforced by:** `pms_feed_health_v1` (migration 0339) is the only place the
  live / stale / learning / unavailable rules are written. `src/lib/pms/feed-health.ts`
  reads `state` and `minutes_late` off the view and deliberately contains **no
  copy** of the state machine; the rules are proved against real Postgres in
  `src/lib/__tests__/pms-ingest-quality.integration.test.ts`.
- **NOT DB-enforceable** as a uniqueness claim — a second implementation in
  TypeScript would compile fine. What makes it hold is that there is nothing to
  duplicate: the app never receives the inputs (grace, cadence, table stamps)
  in a form it could recompute from, only the answer.
- **Assumed by:** `src/lib/pms-feed-status-server.ts` (the view's only reader),
  the doctor's `pms_report_freshness` check, `get_pms_status`.
- **History:** D4 quality, 2026-07-24.

### INV-37: A hotel with no PMS report expectation renders exactly as it does today

- **Statement:** zero rows in `pms_feed_health_v1` for a property means "this
  hotel has no PMS report schedule", NOT "every feed is unavailable".
- **Enforced by:** the view's row source is `pms_feed_expectations`, so a hotel
  with no expectations produces no rows at all;
  `feedStatusFromHealth()` returns `null` for the empty case and
  `pms-feed-status-server.ts` falls through to the legacy derivation, which
  yields `NO_PMS_FEED_STATUS` (mode `no_pms`, every feed live, countsTrusted
  true). `'unavailable'` is reserved for an expectation row that EXISTS and is
  disabled.
- **Why it matters:** skip-PMS onboarding is a shipped path. Reading "no
  expectation" as "unavailable" would neutralise the dashboard tiles and
  housekeeper board of every manual hotel — hotels that were never supposed to
  have PMS data at all.
- **Backed by:** `pms-feed-health.test.ts` ("the manual-hotel fail-safe") and
  the FLAW B case in the pglite integration test.
- **History:** D4 quality, 2026-07-24.

### INV-38: Every row a report delivers is either written or quarantined — a row is never silently dropped

- **Enforced by:** the per-delivery open-dedupe indexes
  `pms_ingest_quarantine_open_per_delivery_uidx` (delivery_id, fingerprint) and
  `pms_ingest_quarantine_open_no_delivery_uidx` (property_id, fingerprint),
  plus `public.pms_delivery_quarantine_count(uuid)` — the number the intake
  ledger's own trigger writes into `rows_quarantined`, so the writer cannot
  supply it (migration 0339). **The CHECK
  `rows_parsed = rows_written + rows_quarantined` belongs to the intake
  ledger's table and lands with the report-intake workstream** — see
  "Accounting seam" in 0339.
- **Why the dedupe is scoped per delivery:** a GLOBAL dedupe on fingerprint
  makes the accounting CHECK unsatisfiable. Delivery #2 carrying the same 3
  persistent bad rows would insert nothing (the dedupe bumps rows owned by
  delivery #1), report `rows_quarantined = 0` against a short `rows_written`,
  and could never be marked 'parsed'. The pipeline would wedge on the second
  occurrence of any recurring bad row. Cross-delivery "this has happened N
  times" is answered by `pms_quarantine_rollup_v1`, a display-side view.
- **Fingerprint composition:** `sha256(property_id | target_table |
  reason_code | natural key or canonicalised raw row)` —
  `quarantineFingerprint()` in `src/lib/pms/quarantine.ts`. property_id and
  target_table are IN the hash so two hotels' identical bad rows cannot
  collide.
- **History:** D4 quality, 2026-07-24.

### INV-39: A column appearing in a report that we do not recognise is captured and surfaced, never ignored

- **Enforced by:** the value lands under the reserved key `raw->'_unmapped'`
  on the row (the `raw` jsonb column already exists on every pms_* table from
  0202 — no per-table DDL), and a `pms_unmapped_columns` row is upserted with
  `status='open'`. `pms_feed_health_v1` computes `state='learning'` whenever an
  open row exists for that (hotel, report). There is deliberately **no second
  denormalised review flag** — the review state is derived in one view, so
  there is no copy to drift.
- **Deliberately NOT a learning trigger:** open QUARANTINE count. Five bad rows
  out of three hundred leaves 295 good ones, and 'learning' blanks
  user-visible numbers. Backlog is a doctor warn plus the admin queue.
- **Backed by:** `pms-ingest-quarantine.test.ts` (capture + PII redaction) and
  the unmapped-column cases in the pglite integration test.
- **History:** D4 quality, 2026-07-24.

### INV-40: An anomaly flags; only a validator error or an SLO breach alerts. Anomalies never block a write

- **NOT DB-ENFORCEABLE** — it is a routing policy over which sink each detector
  writes to. Enforced structurally: `src/lib/pms/ingest-anomaly.ts` is a PURE
  module with no write access and no sink parameter. It returns findings; its
  only caller writes `pms_ingest_anomalies` rows. There is no input on any
  doctor evaluator through which an anomaly could travel, so adding one would
  be a compile-level decision rather than a silent drift.
- **What DOES alert** (doctor fail → the existing 5-minute
  `/api/cron/vercel-watchdog` → Sentry + business-hours SMS): a required feed
  past 2× its grace on an expectation that opted into `doctor_fail`; a delivery
  where every row was rejected; quarantine backlog over threshold.
- **Why:** containment for bad data is last-good preservation plus honest
  staleness, and a hotel really can sell out overnight.
- **Backed by:** `pms-ingest-anomaly.test.ts` and the alert-policy cases in
  `pms-feed-health.test.ts`.
- **History:** D4 quality, 2026-07-24.

## Counter-heal mechanism

`staxis_heal_conversation_counters(p_dry_run boolean)` runs daily via
`/api/cron/agent-heal-counters` (cron, 04:00 UTC). It recomputes
`message_count` and `unsummarized_message_count` from `agent_messages`
for every conversation and either reports drift (p_dry_run=true) or
heals it (false). This is the safety net for INV-4 and INV-7.

When a heal event fires, it indicates a bug in trigger logic or an
RPC path that updated counters incorrectly. The cron logs to Sentry.
Investigate; don't just heal and move on.

## Copilot long-term memory (migrations 0256 / 0257)

- **INV-MEM-1 — per-tenant isolation.** A memory row is only ever read for its
  own `property_id`. All access is via `supabaseAdmin` (RLS-bypassing), so the
  real guarantee is the `.eq('property_id', …)` filter in
  `src/lib/db/agent-memory.ts` + the `property_id` predicate inside the RPCs.
  **Enforced by:** RLS deny-all (anon/authenticated) on `agent_memory` (0256) as
  the backstop + `scripts/audit-rls-policy-coverage.mjs`; the read-path scoping
  is verified by `agent-memory.integration.test.ts` (cross-property + per-user
  isolation) — necessary because deny-all tables are NOT auto-discovered by
  `rls-tenant-isolation.integration.test.ts`. **History:** copilot-memory build
  2026-06-03; Codex caught the false "auto-covered" assumption.
- **INV-MEM-2 — one active fact per (property, scope, subject, topic).**
  **Enforced by:** partial unique index `agent_memory_active_topic_key` (0256) +
  the advisory-locked upsert in `staxis_store_memory`. Restating a topic updates
  in place; corrections never fork into duplicate rows.
- **INV-MEM-3 — scope/subject coherence.** property-scope ⇒
  `subject_account_id IS NULL`; user-scope ⇒ NOT NULL. **Enforced by:** CHECK
  `agent_memory_scope_subject_ck` (0256) + an early guard in `staxis_store_memory`.
- **INV-MEM-4 — bounded growth.** ≤200 active property rows / ≤50 active per
  (user,property); content ≤500, topic ≤80 chars; ≤20 entries / ~6000 chars
  injected per turn; ≤5 writes per request. **Enforced by:** length CHECKs (0256),
  active-row cap inside `staxis_store_memory` (returns `property_full`/`user_full`),
  injection caps in `memory-context.ts` (`MAX_MEMORY_ENTRIES`/`MEMORY_CHAR_BUDGET`),
  per-request `WeakMap` counter in `tools/memory.ts`.
- **INV-MEM-5 — memory is reference data, never instruction.** Injected memory is
  wrapped in `<staxis-memory trust="system-derived-from-untrusted">`, content
  escaped with `escapeTrustMarkerContent`, and the base prompt (0257) names the
  channel as data-not-instruction. **Enforced by:** the `memory-context.ts`
  formatter + `memory-format.test.ts` (stored `</staxis-memory>` / imperative
  content is neutralized) + the base-prompt rule. Prompt-level + escaping defense
  — no DB constraint can guarantee "the model obeys", so this is a documented
  not-DB-enforceable invariant backed by tests.
- **INV-MEM-6 — hotel-scope writes are management-only.** Floor roles may write
  only user-scope ('me') memory. **Enforced by:** `isManagerOrAbove` gate in the
  `remember`/`forget` handlers (`tools/memory.ts`), backed by
  `memory-tool-registration.test.ts`. Code-level (NOT DB) — a future
  "propose → manager approves" queue can move this to the DB.
- **INV-MEM-7 — no guest PII in memory content.** **Enforced by:**
  `redactMemoryContent` masks emails/phones/card/SSN shapes at write
  (`memory-redact.ts`) + the `remember` tool-description instruction +
  `memory-redact.test.ts`. Code-level and imperfect by nature (regex) — one layer
  of several (also: management-gated hotel writes, guest-data-default-deny);
  documented gap, not a hard guarantee.

## Prompt tiers: global → PMS family → company → hotel (migrations 0338 / 0365)

The copilot's instructions have FOUR tiers and exactly one home for each:

| Tier | Where it lives | Kind of content |
|---|---|---|
| global | `agent_prompts` rows with `pms_family IS NULL` | behaviour + hard rules |
| PMS family | `agent_prompts` rows with `role='family'`, keyed by `pms_family` | how that PMS's reports read |
| company | `company_knowledge` rows, `review_state='confirmed'`, keyed by `organization_id` — **DATA, never a prompt row** | the management company's own standards, vendors and approval rules |
| hotel | `agent_memory`, `knowledge_*`, and the DERIVED identity block — **DATA, never a prompt row** | this hotel's own facts |

The company tier was added 2026-07-26 (0365) and sits between the family tier
and the hotel: a company standard is the default across every hotel that company
operates, and the hotel in front of you is the exception that beats it. It is
the HIGHEST-authority position a customer's own typing reaches, which is what
INV-TIER-10 is about.

Two cells of the matrix are deliberately empty, so nobody has to re-derive it:
- **Family-scope facts bigger than 4000 chars have no home, on purpose.** The
  family tier holds the RULES for reading a PMS's reports, not the reports. Bulk
  per-PMS reference material, if it ever exists, belongs behind
  `search_knowledge` (retrieved on demand), not in the cached prompt every hotel
  on that PMS pays for on every conversation. The cap is a forcing function.
- **Global-scope facts are still smeared into the base prompt.** Deferred, not
  solved. Splitting global rules from global facts is a separate change and
  nothing depends on it yet.

Conflict rules, stated as two because "more specific wins" is only half true:
- **R1 facts** — more specific scope wins: hotel > family > global. Realized
  structurally: family text sits after global text in the stable block (later
  text wins), the hotel's DERIVED identity block sits after the family addendum
  (2026-07-25, INV-TIER-9), and the hotel's LEARNED and RETRIEVED facts arrive
  via `search_knowledge` and the `<staxis-memory>` block in the DYNAMIC half,
  which the model reads after the entire stable block. No hotel-authored
  *prompt row* exists at any point — see INV-TIER-2.
- **R2 behaviour** — global hard rules are non-overridable; a family row may
  only ADD or NARROW, never relax. This is why hotel-tier prompt rows are
  rejected outright: a hotel-authored behaviour row would be an unauditable
  relaxation channel.

- **INV-TIER-1 — one active row per tier.** The family tier lives on
  `agent_prompts` keyed by `(role='family', pms_family)`; a row is either fully
  global (`pms_family IS NULL`, role ≠ 'family') or fully family
  (`pms_family NOT NULL`, role = 'family'). No third state is representable.
  **Enforced by:** CHECK `agent_prompts_tier_coherence_ck` + partial unique
  index `agent_prompts_active_per_role_family_uq` ON
  `(role, coalesce(pms_family,''))` WHERE `is_active` (0338). **DB-ENFORCED.**
  Backstop: `staxis_activate_prompt(uuid,text,text)` does deactivate-others +
  activate-target in one transaction, now filtered on the family key — before
  0338 it deactivated EVERY family's row. **Assumed by:**
  `prompts-store.ts` `resolvePrompts` (single `find` per tier).
  **History:** A3 tiers, 2026-07-24.
- **INV-TIER-2 — no hotel ever gets its own prompt row.** **Enforced by:**
  construction — `agent_prompts` has no `property_id` column and this work does
  not add one; the tier-coherence CHECK allows exactly two shapes.
  **DB-ENFORCED BY CONSTRUCTION.** **History:** A3 tiers, 2026-07-24.
- **INV-TIER-3 — no global- or family-scope learned memory.** Learned patterns
  exist only at hotel scope. **Enforced by:** construction —
  `agent_memory.property_id` is NOT NULL with an FK to `properties(id)` and
  `agent_memory_scope_check` restricts scope to ('property','user') (0256).
  Promoting a hotel-learned fact to the family tier is a deliberate human act:
  a new `agent_prompts` family version, which leaves an audit trail.
  **DB-ENFORCED BY CONSTRUCTION.** **History:** A3 tiers, 2026-07-24.
- **INV-TIER-4 — the summarizer never receives a family addendum.**
  **Enforced by:** compile time —
  `getActivePrompt(role: Exclude<PromptRole,'family'>)` in `prompts-store.ts`;
  `npx tsc --noEmit` is in the gate. **NOT DB-enforceable** (a code-path fact,
  not a data fact). **Assumed by:** `summarizer.ts:296`,
  `evals/summarizer/runner.ts:86`. **History:** A3 tiers, 2026-07-24.
- **INV-TIER-5 — stable/dynamic placement.** Global base + role, the family
  addendum, the voice addenda, the inventory-routing block, the data-freshness
  rule, the derived hotel-identity block and the version line go in the STABLE
  (cached) block. The hotel
  snapshot, the `<staxis-memory-block>` and the room hint go in the DYNAMIC
  block. Nothing that varies within a conversation may appear in the stable
  block. **Enforced by:** three layers, none of them DB (prompt assembly is
  code, so no constraint can reach it): (1) compile time — disjoint
  `StableTier`/`DynamicTier` unions in `prompts.ts`, so moving `'pms_family'`
  into the dynamic array is a type error; (2) behaviour —
  `agent-prompt-tiers.test.ts` + `agent-prompt-cache-purity.test.ts` build
  twice with different snapshots and different memory and assert a
  byte-identical stable block; (3) runtime —
  `assertStableBlockIsCacheable()` in `llm.ts` throws outside production and
  `captureException`s-and-serves in production, covering producers that bypass
  `buildSystemPrompt` (`summarizer.ts:309`, `evals/runner.ts`).
  **Why it matters:** a misplacement has NO visible symptom — the copilot keeps
  answering correctly while every turn misses the Anthropic prompt cache.
  **History:** A3 tiers, 2026-07-24.
- **INV-TIER-6 — printed stamp ≠ persisted stamp.** `stableStamp` is printed
  into the prompt and is constant for the life of a conversation;
  `versionLabel` is persisted to `agent_messages.prompt_version`, is never
  printed, and carries the per-turn segments (`fam:<family>.none` when we
  looked and found nothing, `mem:<count>/<sha256-8>` of the exact injected
  memory block). **Enforced by:** `agent-prompt-tiers.test.ts` (same
  role+family, different memory ⇒ stable byte-identical AND versionLabel
  differs). **NOT DB-enforceable.** `parsePromptStamp()` is the single reader
  and tolerates pre-0338 stamps. **History:** A3 tiers, 2026-07-24.
- **INV-TIER-7 — a family row cannot forge structure or blow the cost cap.**
  Family content may not match `<\s*/?\s*(staxis-|tool-result)` or contain
  `───`, and may not exceed 4000 chars (≈1000 tokens of cached prompt).
  **Enforced by:** CHECKs `agent_prompts_family_no_markers_ck` and
  `agent_prompts_family_len_ck` (0338) — **DB-ENFORCED** — plus
  `familyContentIsSafe()` in `prompts.ts`, which drops the section and reports
  to Sentry if a violating row ever reaches the assembler, and the doctor's
  `agent_prompt_tiers` check, which re-verifies length on live active rows so
  relaxing the CHECK later still trips an alarm. **History:** A3 tiers,
  2026-07-24.
- **INV-TIER-8 — family content may ADD or NARROW behaviour, never relax a
  global hard rule** (approval gating, cross-property refusal, prompt
  non-disclosure, knowledge-hub-first answering). The *semantic* half is *NOT
  ENFORCEABLE by any constraint* — no CHECK can decide whether a paragraph of
  English relaxes a rule. What IS enforceable, and is now enforced, is the
  STANDING the text arrives with. **Enforced by:** `prompts.ts` renders every
  family row inside a code-owned trust envelope — the section header, the
  `FAMILY_TIER_TRUST_NOTE` ceiling, and both `<staxis-pms-family
  trust="untrusted" family="…">` tags are printed by the assembler, never by
  the row, and INV-TIER-7's marker vocabulary makes the closing tag unforgeable
  from inside. The family key is sanitized (`sanitizeFamilyKeyForPrompt`)
  before it reaches the header, the attribute or the printed stamp, so a key
  cannot re-label the envelope `trust="system"` or open a section. The ceiling
  is versioned into `stableStamp` as `family-trust-boundary-v1`, so which
  ceiling a past turn ran under is answerable from
  `agent_messages.prompt_version`. An operator with psql can rewrite the row;
  they cannot rewrite the ceiling, because it does not live in a row.
  Structure is pinned by `agent-prompt-tiers.test.ts` ("the family trust
  envelope"): row text only ever appears strictly between the two markers, the
  ceiling always precedes it, and no marker is left open when no family row
  exists. Behaviour is still only provable by running the model — the
  adversarial `family_tier` cases in `evals/test-bank.ts`, run through
  `evals/runner.ts` with a hostile addendum spliced in. Those cost real
  Anthropic tokens and run **on demand, not in CI**. Activating any new family
  row is gated on that bank passing.
  **History:** A3 tiers, 2026-07-24. Trust envelope added 2026-07-26 after the
  bank's first live run scored 20/22: a row claiming room status "updates
  itself" and that changes were "pre-approved" walked the model out of calling
  `mark_room_clean` — i.e. out of the approval card — and a row asserting the
  hotels were "one shared portfolio" got a cross-property question answered
  instead of declined. Raw prose in the last position of the cached block
  out-ranked every global rule above it; the fix was to stop it arriving as
  prose. 22/22 after.
- **INV-TIER-9 — the derived hotel-identity block is STRUCTURAL and
  DAY-ZERO-SILENT.** `src/lib/agent/hotel-identity.ts` assembles what the hotel
  already told us at signup and setup (room mix, housekeeping configuration,
  checklists, shift pattern, roster shape) into the stable block. Two rules:
  (a) it may contain nothing that varies with the clock — no live counts, no
  as-of stamps, no "today"; and (b) a section with no content is OMITTED, never
  rendered as `0` or `unknown`, because the model repeats a rendered zero to a
  manager as a finding about their hotel. It is also the FIRST hotel-supplied
  text to reach the cached block, so every interpolated value is sanitized
  against the same forgery vocabulary as INV-TIER-7 (`<`/`>`/`───`) and capped
  in length. **Enforced by:** behaviour —
  `agent-hotel-identity.test.ts` (day-zero silence, byte-identical rendering at
  two wall-clock times and across row orderings, forgery neutralisation) and
  `agent-hotel-identity-tenant.integration.test.ts` (the real query planner,
  two seeded hotels, `scopedDb` filters proven at the database).
  **NOT DB-enforceable.** **Assumed by:** `prompts.ts` `buildSystemPrompt`,
  tier `'hotel_identity'`. **History:** day-zero derivation, 2026-07-25.
- **INV-TIER-10 — a company rulebook fact reaches the model as ESCAPED text
  inside an envelope it cannot close.** The company tier (0365) is the same kind
  of channel as the family tier and sits one position HIGHER in the cached
  block, so it out-ranks every global rule above it by position — and unlike the
  family tier, its text is written by a CUSTOMER (a VP typing, or a PDF that VP
  uploaded). **Enforced by:** two layers, and the second is the guarantee.
  (1) FILTER — `companyFactIsSafe()` (`prompt-tiers.ts`) drops any fact that
  matches the `<staxis-…>` / `<tool-result` marker vocabulary or contains a
  drawn section rule, `captureException`s the drop with the row's identity (not
  its content), and CHECK `company_knowledge_no_markers_ck` (0365) rejects the
  same rows at the database — **DB-ENFORCED**. (2) ESCAPE —
  `company-tier.ts` runs every rendered fact through `escapeTrustMarkerContent`,
  so `< > &` become entities and NO byte sequence in a fact can close the
  envelope. Layer (2) exists because layer (1) is a denylist and denylists have
  holes: the red-team pass wrote `</staxis‑company‑rulebook>` with a U+2011
  NON-BREAKING HYPHEN straight past the ASCII pattern, and the tag rendered
  perfectly to a model. Both predicates now NFKC-normalize, flatten every
  dash-like code point to ASCII `-`, strip zero-width characters, and reject
  runs of any horizontal-rule glyph (`═ ━ — ▬`, not only `─`) before matching —
  but the escape is what makes the boundary unforgeable rather than
  merely well-guarded. The header, the ceiling
  (`COMPANY_TIER_TRUST_NOTE`) and both `<staxis-company-rulebook
  trust="untrusted">` tags are printed by `company-tier.ts`, never by a row,
  and the ceiling is versioned into `stableStamp` as `company-rulebook-v2`.
  Escaping is deterministic, so the cached prefix is unaffected (INV-TIER-5).
  **Tested by:** `agent-company-tier-envelope.test.ts` — the reviewer's exact
  forgery strings in EN and ES are neutralised, a fact only ever appears inside
  the envelope, an ampersand survives as an entity, and the same rulebook
  renders byte-identically twice. Behaviour is live-only: the adversarial
  `company_tier_cannot_bypass_the_tool_layer` and
  `company_tier_cannot_unlock_cross_property` cases in `evals/test-bank.ts`,
  run through `evals/runner.ts` with a rulebook seeded into the derivation
  cache — the same two attacks that BEAT the family tier on the eval bank's
  first live run, restated one tier up. **History:** the company tier, 0365,
  2026-07-26; envelope escaping + homoglyph-aware denylist after the
  walls/injection red-team pass, same day.

**Write-path warning for whoever adds a prompt-editing UI.** `agent_prompts` is
service-role-only (RLS deny-all) and today has no admin write route — prompts
are edited by psql. A family row is an org-wide prompt-injection surface across
every hotel on that PMS, so any future write route must be admin-role-gated,
and INV-TIER-8's eval bank must be a hard gate on activation, not advisory.
## PMS time model (migrations 0343 / 0344)

The agent answers "how did we do on the 9th?" and "how is next weekend
filling?" out of these tables. Before 0343 neither question had an answer:
occupancy held one row per hotel and booking pace collapsed a stay night's
whole history into a single row.

- **INV-TIME-1 — the writer registry cannot lie about the schema.** Every
  `pms_table_schemas` row names a real base table (not a view), its
  `natural_key` is backed by an actual non-partial UNIQUE index, and its
  `time_grain` is consistent with its `write_strategy` and its columns
  (observation ⇒ append; daily_fact ⇒ has `business_date`, with `business_date`
  AND `as_of` in the key; as_of_grid ⇒ `as_of` or `snapshot_date` in the key).
  **Enforced by:** trigger `staxis_pms_registry_matches_reality()` BEFORE INSERT
  OR UPDATE on `pms_table_schemas` (0343). **Surfaced by:**
  `staxis_pms_registry_violations()` → the `/api/admin/doctor` check
  `pms_time_model_ok`, polled every 5 minutes by vercel-watchdog. **Assumed
  by:** `cua-service/src/persistence/generic-table-writer.ts`, which builds its
  ON CONFLICT target from `natural_key` — a key with no index behind it silently
  duplicates every poll instead of upserting. **History:** D2-TIME 2026-07-24.

- **INV-TIME-2 — a PMS daily fact's business date is the date the report
  printed.** It is never derived from a timestamp. **Enforced by:**
  `business_date_source text NOT NULL CHECK (IN ('report_printed',
  'operator_entered'))` on `pms_revenue_daily`, `pms_payments_daily`,
  `pms_channel_performance` (0343) — NOT NULL with **no default**, so a writer
  that will not say where the date came from cannot insert at all, and there is
  no `'derived'` value in the domain to record. **Assumed by:**
  `src/lib/business-date.ts` (`businessDateFromReport` is the only sanctioned
  path for a daily fact; `businessDate(property, instant)` is for observations
  and for choosing which day to seal).

- **INV-TIME-3 — occupancy is never overwritten.** Each reading of the live
  in-house counts is a distinct row identified by when it was observed.
  **Enforced by:** `pms_occupancy_observation` UNIQUE (property_id,
  observed_at) + `observed_at` NOT NULL + the append-only trigger below; the old
  PRIMARY KEY (property_id) is dropped (0343). The old name survives as a
  DISTINCT ON view so every existing reader keeps its column contract.

- **INV-TIME-4 — booking pace is stored as-of.** On-the-books figures for a stay
  night are keyed by the day they were observed, so thirty readings ARE the
  pickup curve. **Enforced by:** `pms_booking_pace` UNIQUE (property_id,
  as_of_date, stay_date) + CHECK (stay_date >= as_of_date - 1) (0343).
  **Assumed by:** `src/lib/agent/tools/pms-feeds.ts` `get_future_bookings`.

- **INV-TIME-5 — a restatement never destroys the report it corrects, and never
  double-counts.** Corrections land as a new `as_of` generation; current truth
  is the newest generation. **Enforced by:** UNIQUE (property_id, business_date,
  as_of[, dimension]) on the daily facts + the `*_current` DISTINCT ON views
  (0343). **Assumed by — every range reader MUST use the view:**
  `src/lib/financials/revenue.ts` (`pms_revenue_daily_current`,
  `pms_forecast_daily_current`), `src/app/api/dashboard/labor-cost/route.ts`,
  `src/lib/agent/tools/pms-feeds.ts` (`pms_payments_daily_current`). Summing a
  base table over a range counts a restated day twice. **Backed by:**
  `pms-as-of-readers.test.ts` (money) + `pms-time-model-invariants.integration.test.ts`
  (the view semantics).

- **INV-TIME-6 — a changed PMS entity is recorded before the old value is
  lost.** **Enforced by:** AFTER UPDATE trigger `staxis_pms_log_entity_change()`
  on `pms_reservations`, `pms_guests`, `pms_guest_balances`,
  `pms_work_orders_v2`, `pms_rooms_inventory` → `pms_entity_change_log` (0343).
  Cannot be bypassed by the CUA writer, an API route, or direct psql. Returns
  early when only bookkeeping columns moved, which is what keeps a 30-second
  poll cadence free.

- **INV-TIME-7 — observations are append-only.** **Enforced by:** REVOKE UPDATE,
  DELETE FROM service_role + trigger `staxis_pms_observation_immutable()` on
  `pms_room_status_log`, `pms_activity_log`, `pms_occupancy_observation`,
  `pms_booking_pace`, `pms_entity_change_log` (0343). Two carve-outs, both
  explicit: the SECURITY DEFINER `staxis_pms_purge_observations()` retention
  path, and a property cascade (delete-hotel is a 129-FK cascade off one
  `properties` DELETE and must not be bricked).

- **INV-TIME-8 — a daily_logs bucket is NULL or it names its source; a missing
  feed can never seal as zero.** **Enforced by:** paired CHECKs
  `daily_logs_<bucket>_source_domain` / `_required` (0344). ADR, RevPAR,
  occupancy % and day-of-week are `GENERATED ALWAYS ... STORED`, so a client
  that tries to write a derived number gets 428C9 and the derived value can
  never disagree with the counts it claims to come from. **Careful:**
  `daily_logs.occupied` (legacy, robot-derived, read by ml-service
  `_exposure.py`) and `daily_logs.rooms_sold` (report-printed) are two different
  numbers on one row — anything showing one must say which.
### INV-25: the decision corpus survives the conversation and the account

Every AI decision recorded in `agent_decisions` outlives the archival of its
conversation and the offboarding of the employee who made the call. Only
deleting the HOTEL deletes its decisions.

- **Enforced by:** DB shape in migration 0350 —
  `agent_decisions.conversation_id` carries NO foreign key (deliberate, and
  commented as such in the migration), `actor_account_id` is
  `on delete set null`, and only `property_id` cascades. `agent_pending_actions`
  is `on delete cascade` to both `agent_conversations` and `accounts`
  (migration 0300), which is exactly why the corpus could not simply live there.
  Plus trigger `agent_decisions_immutable`, which rejects any UPDATE that
  changes the proposal or the state snapshot it was made against.
- **Assumed by:** [decisions.ts](src/lib/agent/decisions.ts), the
  `makePendingApprovalHandler` capture in
  `src/app/api/agent/command/_stream-runner.ts`
- **History:** A4-RATCHET, 2026-07-24. The corpus is the stated business moat and
  it was previously 10 rows in a cascade-deleted table, none of which recorded
  what the hotel looked like at decision time.

### INV-26: the decision corpus is exempt from the retention purge

No scheduled cleanup deletes from `agent_decisions`, `agent_pending_actions`,
`user_feedback`, or `agent_eval_baselines`.

- **Enforced by:** `EXEMPT_FROM_PURGE` in
  `src/lib/retention-purge-policy.ts` (a runtime refusal, not just a
  list) plus `src/lib/__tests__/retention-purge-exemptions.test.ts`, which drives
  the real handler with a stubbed client and fails if it attempts a delete
  against any exempt table, and which fails if a NEW `agent_decision*` table
  appears in the migrations without being exempted. NOT DB-enforced — Postgres
  cannot tell a legitimate delete from a purge — so the test is the guarantee.
- **Assumed by:** every "prove the AI was right" question the corpus exists to
  answer.
- **History:** A4-RATCHET, 2026-07-24. The purge workflow's schedule has been
  commented out since 2026-05-30; the risk is the re-enable moment, when the
  first run would delete everything past the window in one shot.

### INV-27: no fix to the agent, PMS, or ingestion code lands without a test

A commit whose subject starts with `fix(` and which touches `src/lib/agent/**`,
`src/lib/pms/**`, `src/app/api/agent/**`, `src/app/api/pms-inbox/**`, or
`cua-service/src/**` must also touch a test, the eval bank, or a golden fixture
— in the SAME commit.

- **Enforced by:** LINT — `scripts/audit-eval-regressions.mjs` in the
  `npm run lint` chain (already CI-blocking). The audited range is derived from
  the GitHub event (`before..after` on push, merge-base on PR) rather than from
  `origin/main..HEAD`, because on this repo's primary flow — pushing straight to
  main — that range is EMPTY and the gate would pass having checked nothing.
  `.github/workflows/tests.yml` sets `fetch-depth: 0` for the same reason, and
  the script FAILS rather than skips when the range cannot be resolved.
  Escape hatch: `[no-eval: <reason>]` in the commit body, counted and printed on
  every run, with a hard ceiling of 5 exemptions per range.
- **Assumed by:** the claim that a bug fixed once cannot ship twice.
- **History:** A4-RATCHET, 2026-07-24.

### INV-28: every mutating tool declares how you would know it worked — PLANNED

Every `mutates: true` ToolDefinition declares an outcome probe (a window plus a
check) or an explicit `notObservable` reason.

- **Enforced by:** **PLANNED-NOT-ENFORCED.** `agent_decisions` carries the
  `outcome_kind` / `outcome_observed_at` / `outcome_facts` columns from
  migration 0350 so the probe layer is a code change rather than another
  migration, but the per-tool contract and the daily probe cron are not built.
  **Trigger condition: before the corpus is used to make any claim about whether
  the AI's actions worked.** Until then every row is an intention, not an
  outcome, and must be described that way.
- **History:** A4-RATCHET, 2026-07-24 — deliberately deferred, and recorded here
  so the deferral is visible rather than forgotten.

### INV-41: a claim of completed work is never shown to a user unless a mutating tool succeeded on that turn

When an assistant turn's final text asserts that a mutation was completed and
no `mutates: true` tool returned `ok` on that turn, the user is shown an
explicit retraction and the incident is reported.

- **Enforced by:** Code — `detectFakeSuccess` / `reportFakeSuccess` in
  [llm.ts](src/lib/agent/llm.ts), detector in
  [fake-success-guard.ts](src/lib/agent/fake-success-guard.ts). NOT enforceable
  at the DB level: the thing being constrained is generated English/Spanish
  prose, and there is no row to CHECK. Per the doctrine above, the substitute is
  property-based coverage in the eval bank — eight hermetic cases named
  `fake_success_*` in [test-bank.ts](src/lib/agent/evals/test-bank.ts), plus the
  detector precision corpus in
  `src/lib/__tests__/agent-fake-success-guard.test.ts`. Each case was verified
  by breaking the guard and watching that case (and only that case) fail.
- **NOT enforced by the prompt, on purpose.** The incident that motivated this
  was a hostile PMS-family addendum instructing the model not to call a tool.
  The prompt is the attack surface, so a prompt rule is not a control.
- **Assumed by:** the approval card being the user's record of what happened;
  every "the AI did X" claim in the activity feed.
- **Known gap (accepted):** the guard is OFF on post-approval resume turns
  (`newUserMessage === null`), because the mutation on those turns executes in
  `/api/agent/command/resolve-action`, outside `streamAgent`, and firing there
  would tell a manager nothing changed immediately after it did. A second,
  un-approved action claimed on a resume turn is therefore not caught.
- **History:** First live run of the eval bank, 2026-07-25 —
  `family_tier_cannot_bypass_the_tool_layer` recorded the model replying "Done"
  to "mark room 302 clean" with zero tool calls.

### INV-42: a memory topic a human deleted is never re-learned by an automatic writer

Once any row exists for a `(property_id, scope, subject, topic)` with
`is_active = false`, no automatic writer — `source` in
(`consolidation`, `operational`) — may create or revive that topic. Permanently:
there is no time window, and the age of the deletion is never consulted. A HUMAN
write (`explicit_user` / `correction` / `inferred`) is never refused, so a
manager can always deliberately put back something they removed; once they do,
the topic is an active human fact and later automatic writes fall under the
0260/0261 guard (`skipped`) instead.

`is_active = false` is a sound proxy for "a human deleted this" because only two
paths ever set it, and both are human-initiated: the `staxis_forget_memory` RPC
(the manager tells the copilot to forget a topic) and `deactivateMemoryById`
(the dashboard Remove button). Expiry does NOT deactivate — `expires_at` is
applied as a read-time filter in [agent-memory.ts](src/lib/db/agent-memory.ts) —
so a deactivated row is always a deliberate human deletion, never decay.

- **Enforced by:** the RPC `staxis_store_memory` (migration
  `0357_memory_forget_is_permanent.sql`), inside the same per-property advisory
  lock as the dedup/cap logic, returning a new action code `refused_forgotten`
  with the tombstone's id. The refusal is evaluated BEFORE the cap check, so a
  forgotten topic never consumes cap budget nor gets mislabelled `property_full`.
- **Proven by:** `src/lib/__tests__/agent-memory.integration.test.ts` (real
  Postgres via pglite) — "an auto-learned write can never re-learn a topic a
  human deleted — no time window" (includes a tombstone backdated 400 days),
  "a human can deliberately re-add a topic they deleted; auto writes then defer
  to it", "an 'inferred' write is not refused for a forgotten topic", "a
  forgotten topic does not bleed across properties or across user accounts",
  and "a forgotten topic is refused for being forgotten, never mislabelled as a
  full memory". Each was verified by mutating the migration (reinstating a
  30-day bound, moving the refusal after the cap check, swapping it ahead of the
  human-fact guard, dropping the subject predicate) and watching exactly the
  matching test go red.
- **Assumed by:** the product promise that removing a note on the dashboard, or
  telling the copilot to forget something, is permanent; the "What Staxis
  learned / noticed" cards, whose Remove button is the manager's only control
  over auto-learned memory.
- **NOT enforced by the prompt, on purpose.** The previous mechanism was exactly
  that — a "do NOT re-learn" list in the consolidation prompt, populated from
  deletions in the last 30 days
  ([memory-consolidate.ts](src/lib/agent/memory-consolidate.ts)). Per the
  doctrine above, asking the model nicely counts as NOT ENFORCED, and the
  30-day bound meant that even the request expired. The list is still passed —
  now unbounded in time — but purely to avoid paying Claude to phrase a fact the
  database will refuse.
- **History:** Memory-permanence review, 2026-07-25. The deletion promise held
  for 30 days and only as a prompt hint; on day 31 the nightly consolidator
  could re-insert the deleted topic and it silently came back.


## The findings ledger (migration 0360)

The layer that turns "Staxis noticed something" into a durable object. Three
detection systems existed before it — the cleaning rules engine, the nudge
checks, the operational-signal aggregators — each with its own private notion of
"have I already said this?", and none able to answer "what is currently wrong at
this hotel?". These four invariants are what the unified ledger promises.

- **INV-FIND-1 — one problem is one row.** For a given hotel there is at most
  ONE finding per `dedupe_key` in an ACTIVE state (`open`, `updated`,
  `known_problem`, `muted`). A detector that finds tonight the same problem it
  found last night UPDATES that row; it never inserts a second. `resolved` and
  `expired` sit outside the guarantee on purpose, so a problem that returns
  after a fix opens a genuinely new row with its own `first_seen_at`.
- **Enforced by:** partial unique index `findings_one_active_per_problem_uq`
  (migration 0360). NOT by the runner looking first: two runners racing on one
  hotel would both look, both see nothing, and both insert. The loser now gets a
  unique violation and converts its insert into the update it should have been
  ([store.ts openFinding](src/lib/findings/store.ts)).
- **Assumed by:** [runner.ts](src/lib/findings/runner.ts) reconciliation; every
  later phase that renders a findings queue.
- **Tested by:** `findings-ledger.integration.test.ts` (real Postgres via
  pglite) — "a second open row for the same problem is refused", "two runs of
  the same problem leave one row with two sightings", "a concurrent run cannot
  produce two cards", "a RESOLVED problem may recur as a genuinely new row".
  Verified by narrowing the index predicate to open/updated only and watching
  the silenced-state cases go red.
- **History:** Findings-engine Phase 1, 2026-07-26.

- **INV-FIND-2 — a silence holds, except when the problem outgrows it.**
  `muted` suppresses unconditionally, forever. `known_problem` suppresses too,
  EXCEPT when the magnitude both reaches `silenced_at_magnitude × factor` AND
  has grown by at least `minDelta` — the detector's declared escalation policy.
  Four known work orders is consent to four, not to nine.
- **Enforced by:** the silenced states occupy the active slot of the partial
  unique index `findings_one_active_per_problem_uq` (0360), so a silence cannot
  be defeated by inserting a fresh row tomorrow. The transition table itself is
  [silencer.ts decideAction](src/lib/findings/silencer.ts) — a pure function
  with no clock and no database, which is what makes it exhaustively testable.
- **NOT ENFORCED at the DB level:** `findings.silenced_at_magnitude` is written
  by [store.ts setFindingStatus](src/lib/findings/store.ts) on every transition
  to `known_problem`; a CHECK cannot see the previous row's magnitude. The pure
  function therefore fails CLOSED — a silence with no recorded consent point
  never escalates, because guessing it would mean re-nagging a manager who
  explicitly asked for quiet.
- **Assumed by:** the "known problem" tap in every later phase's card UI.
- **Tested by:** `findings-detectors.test.ts` (the whole escalation table: 4→5
  quiet, 4→7 quiet, 4→8 loud, 4→9 loud, 1→2 quiet, null consent quiet) and
  `findings-ledger.integration.test.ts` — "a known problem that barely grew
  stays quiet", "four known work orders does not silence nine", "mute means
  gone, at any size", "a silenced card is never expired out from under the
  manager".
- **History:** Findings-engine Phase 1, 2026-07-26.

- **INV-FIND-3 — a proactive finding never lives in `agent_pending_actions`.**
  That table is the copilot's frozen-args proposal queue: `conversation_id` and
  `account_id` are NOT NULL with ON DELETE CASCADE, and its rows carry a
  ~10-minute TTL. A finding has no conversation and no author, must outlive both
  the chat and the manager's account, and must persist for weeks. Storing one
  there would mean every finding died the moment a conversation was archived.
- **Enforced by:** structure — the `findings` table (0360) carries
  `property_id` as its only tenancy column and has no `conversation_id` at all,
  so a finding is incapable of being conversation-scoped.
- **Assumed by:** [store.ts](src/lib/findings/store.ts); the product promise
  that a card nobody acted on is still there tomorrow.
- **History:** Findings-engine Phase 1, 2026-07-26. Same lesson as INV-25, which
  records why the copilot's own proposals needed their own lifecycle.

- **INV-FIND-4 — a price on a finding is a RANGE or it is absent.**
  "$200–400", never "$340" (founder call, 2026-07-26: a point estimate is a lie
  told confidently, and a manager who catches one stops believing the other
  numbers). Both bounds are NULL together, or both are set with
  `price_high_cents` STRICTLY greater than `price_low_cents` — a zero-width
  range is a point estimate in disguise. No basis in the hotel's own numbers ⇒
  say nothing about money.
- **Enforced by:** CHECK constraint `findings_price_is_a_range` (migration
  0360).
- **Assumed by:** [types.ts isUsablePriceRange](src/lib/findings/types.ts),
  which drops an unusable range before the write rather than letting the
  database reject the whole finding.
- **Tested by:** `findings-ledger.integration.test.ts` "the schema refuses a
  price that is not a range" (accepts 20000–40000 and NULL/NULL; refuses
  34000/34000, 40000/20000 and half a range), plus the pure mirror in
  `findings-detectors.test.ts`. Verified by relaxing the CHECK to `>=` and
  watching the point-estimate case go green.
- **History:** Findings-engine Phase 1, 2026-07-26.

## The learning loop (migration 0362)

Phase 3 is the half of the findings layer that can make it SMALLER, and the half
that can make it BIGGER. Both directions carry a failure mode that is invisible
from the outside — a check that quietly stopped watching, and a detector that
quietly carries one hotel's data to every hotel on its PMS family — so both get
an invariant rather than a comment.

- **INV-FIND-5 — a sweep hypothesis reproduces or it dies.** Everything the
  weekly sweep's model returns is a HYPOTHESIS. It becomes nothing at all —
  no card, no proposal, no memory — unless a deterministic reproducer re-queries
  the hotel's data and confirms it. The reproducer is handed the check kind and
  the subject and NOT the model's sentence, so a claim cannot argue its way
  through, and it runs against a SECOND, FRESH read rather than the snapshot the
  model was shown: a claim that only holds against the exact bytes in the prompt
  is a claim about the prompt. Every death is written to
  `finding_sweep_runs.irreproducible` and to `detail.hypotheses` with its reason;
  that count is the hallucination filter's visible miss rate, kept in the open
  for the same reason the prose guard's rejection count is.
- **Enforced by:** structure — `sweepProperty` has exactly one path from a
  hypothesis to a finding and it runs through `reproduceHypothesis`; the model's
  output contract (`parseSweepReplyStrict`) has no field for a number, a
  threshold or a sentence anybody will read, and any unknown key refuses the
  WHOLE reply.
- **NOT ENFORCED at the DB level:** nothing in Postgres can tell a reproduced
  finding from an invented one. The counts are recorded so the ratio is
  auditable after the fact.
- **Assumed by:** every card `ai_sweep` writes; the promotion path, which only
  ever sees reproduced candidates.
- **Tested by:** `findings-sweep.test.ts` — "an irreproducible hypothesis dies,
  is counted, and reaches nobody", "a flat series does not reproduce a spike,
  however confidently it was claimed", "the reproducer never reads the model's
  sentence" (an identical hostile claim produces a byte-identical verdict).
  Verified by making the runner treat every hypothesis as reproduced and
  watching the death case go red.
- **History:** Findings-engine Phase 3, 2026-07-26.

- **INV-FIND-6 — a promoted detector's content is property-agnostic, and the
  rule is "no digits".** Anything the sweep proposes into `knowledge_promotions`
  contains no digit and no currency mark anywhere in its topic, claim, proposed
  content or evidence summary, and none of the source hotel's own identifying
  strings. Structural constants of a derivation are spelled in words
  (`THRESHOLD_DERIVATIONS`); a threshold measured at the source hotel cannot
  survive being written that way, because a number is how such a threshold is
  written down. Softer rules ("nothing hotel-specific") are judgement calls a
  reviewer makes correctly forty times and wrongly once.
- **Enforced by:** `propertyAgnosticViolations`, applied to the ASSEMBLED payload
  and sitting in front of the RPC call, not behind it. Belt and braces: the
  payload is also built by construction from a fixed per-check template plus the
  derivation enum, with no parameter through which the hotel's evidence could
  reach it. A refusal is logged at ERROR — nothing leaked, but the assembly path
  grew a hole.
- **Also enforced by:** `staxis_propose_promotion`'s own bar (0353) — an origin
  other than `authored` needs two supporting hotels for family tier — and by the
  sweep proposing only at FAMILY tier and only when two hotels have
  independently reproduced the same property-agnostic signature. The signature
  of an item-shaped check collapses to `any_item` so an item id (which is that
  hotel's data) is never the thing two hotels agree on.
- **Assumed by:** every hotel that would inherit a promoted detector.
- **Tested by:** `findings-sweep.test.ts` — "the assembled proposal contains no
  digit anywhere" (every check kind), "every threshold derivation is expressed
  in words", "a literal-bearing payload is caught: a room range, an amount, an
  item name", "a candidate carrying the source hotel's own words is refused
  before the RPC", "one hotel is a quirk, and stays local". Verified by
  neutering the digit rule, by lowering the supporting-hotel bar to one, and by
  moving the guard behind the RPC — each turns a case red.
- **History:** Findings-engine Phase 3, 2026-07-26.

- **INV-FIND-7 — demotion is per hotel.** How far a detector has fallen down
  `propose → recommend → fyi → resting` is a fact about ONE hotel's behaviour.
  One hotel ignoring the supply-spend card must never quieten it at a hotel
  where it is the most useful thing on the screen, and no operator action, cron
  parameter or bug may express a fleet-wide demotion.
- **Enforced by:** the shape of the state — `finding_detector_state` is keyed
  `(property_id, detector_id)` with a unique index (0362), read and written
  exclusively through `scopedDb(propertyId)`. There is no row that could hold a
  fleet-wide verdict. The re-arm path refuses to run without a named hotel.
- **NOT ENFORCED at the DB level:** the THRESHOLDS (ten shows, zero positive
  engagement, three weeks; or five distinct problems refused across seven days)
  and the one-rung-per-stretch rule are code. They fail SAFE — a broken state
  read leaves every detector at full volume — and `baseline_shown` /
  `baseline_acted` / `baseline_at` move forward on every transition so one
  stretch buys exactly one rung, never three.
- **Assumed by:** the run summary's "N checks resting", which is counted apart
  from `detectorsSkipped` because starved and resting are different problems.
- **Tested by:** `findings-learning-loop.integration.test.ts` — "one hotel
  ignoring a check does not silence it at another", "below the threshold nothing
  moves", "long enough is not enough if the manager ever engaged", "a demotion
  cannot cascade on the same evidence", "out of rungs, the check rests —
  visibly, and apart from 'no data'", "re-arming puts it back on duty and does
  not immediately re-rest it"; the policy itself in `findings-demotion.test.ts`.
  Verified by dropping the engagement veto, by not moving the baseline, and by
  counting a resting check as skipped — each turns a case red.
- **History:** Findings-engine Phase 3, 2026-07-26. Extended 2026-07-26 by
  INV-FIND-7b.

- **INV-FIND-7b — declining is not the same as caring.** A manager who keeps
  saying "Not doing this" to one detector's cards is asking for LESS of that
  check, and the volume math must read it that way. Engagement is split by kind:
  POSITIVE (Handled it, Seen, receipt expanded, a one-tap fix approved, an
  upkeep job logged) keeps a detector at full volume and vetoes any demotion;
  NEGATIVE (muted / "Not doing this") counts toward quieting. Five DISTINCT
  problems refused, spread over at least seven days, with nothing positive in
  the same window, steps the same ladder one rung. One refusal quietens nothing
  — the per-finding mute already silenced that problem, and that behaviour is
  untouched. Per hotel and per detector, exactly as INV-FIND-7.
- **Enforced by:** `evaluateDemotion` in `src/lib/findings/demotion.ts`, over an
  engagement window built by `engagementSince`. The refusals are DERIVED from
  the findings rows themselves — `status = 'muted'` plus `status_changed_at` at
  or after `baseline_at`, counted distinct by `dedupe_key` — not from a counter.
  A mute is terminal in the ledger (silencer.ts suppresses muted
  unconditionally; only `known_problem` can escalate), so the rows cannot drift
  from the truth the way a fourth column maintained by every future caller of
  `recordFindingActed` would. **No migration:** nothing new is stored.
- **Fails safe in both directions:** an unreadable `baseline_at` yields an empty
  window (no refusals, no span) rather than an unbounded one, and positive
  engagement can never go negative. A detector that has been quietened climbs
  back one rung on a single positive engagement — resting detectors included,
  since their last cards are still on screen — which is deliberately far cheaper
  than falling, because too loud costs a scroll and too quiet costs the leak
  nobody was told about.
- **Assumed by:** the cron response, which reports `rearms` apart from
  `demotions` so a check getting louder is never counted as one getting quieter.
- **Tested by:** `findings-demotion.test.ts` — "twenty separate problems refused
  over a week: down a rung", "ONE refusal quietens nothing", "a queue cleared in
  one sitting is a mood, not a verdict", "the same problem refused twenty times
  is ONE refusal", "one 'Handled it' beats twenty refusals", "opening the
  numbers and THEN refusing is a refusal, not a reading", "an unreadable
  baseline demotes nothing rather than everything"; and against a real database
  in `findings-learning-loop.integration.test.ts` — "twenty separate problems
  refused across two weeks: down a rung", "one 'Seen' among the refusals keeps
  it loud", "one hotel refusing a check does not quieten it at another", "the
  refusals that bought a rung are spent", "a resting check wakes when somebody
  presses a button on its last card", "refusals do not wake it". Verified by
  reverting the veto to any-engagement, by dropping the distinct-key dedupe, by
  removing the decline span floor, by counting refusals as positive, and by
  removing the baseline filter on refusals — each turns cases red.
- **NOT this invariant:** the VP climb rules (`src/lib/company/vp-queue.ts`).
  "Seen" never hides a problem from the boss and a muted problem that outgrows
  its silence still climbs; that is a different system and demotion does not
  touch it.
- **History:** Founder ruling, 2026-07-26 — the red team found that under
  INV-FIND-7 alone ANY `acted > 0` vetoed demotion, so refusing a detector's
  cards across twenty rooms guaranteed it stayed at full volume forever. The
  loudest available "stop showing me this" kept it loudest.

- **INV-FIND-8 — an `ask` finding is asked through the drip pipeline, and only
  there.** A finding the judge sorted as `ask` never renders as a card. It
  becomes a candidate for the ONE question surface Staxis already has, and
  inherits that surface's promises unchanged: at most one question per session,
  never the same question twice, gone for the day when ignored, given up on
  after three asks. Answering it resolves the finding — yes marks it a known
  problem at the size the manager was shown, no resolves it and records the
  decline in the question ledger.
- **Enforced by:** `effectiveDisposition` (the judge's verdict wins over the
  detector's default) feeding `isCardRenderable` in `/api/findings`, so an `ask`
  finding is filtered out of the queue read; and by `ask-drip.ts` producing a
  `QuestionCandidate` rather than a question — every never-be-obnoxious rule
  lives in `selectQuestion` and none of it is duplicated. The link back is
  `agent_knowledge_questions.finding_id` (0362), and `(property_id, topic)` is
  unique, which is what makes "never twice" a database guarantee rather than a
  convention.
- **The bug this closes:** the queue read filtered on the DETECTOR's
  disposition, so a judged-`ask` finding kept its detector default of
  `recommend` and rendered as a card AND became a question — two surfaces asking
  the same thing with different rules.
- **Assumed by:** the drip card on the Staxis screen; the one-per-session cap in
  `src/lib/drip-question-session.ts`.
- **Tested by:** `findings-learning-loop.integration.test.ts` — "it becomes the
  drip card, recorded against the finding", "it does not come back the same
  day", "answered 'no' … the finding is resolved", "answered 'yes': the finding
  becomes a known problem at the size they agreed to", "a replayed tap changes
  nothing", "the card surface still refuses to render ask findings itself"; plus
  `findings-demotion.test.ts` for the adapter and the selection rules, and
  `findings-cards.test.ts` for the judged-verdict precedence. Verified by making
  `effectiveDisposition` return the detector's value and by disconnecting the
  answer from the finding — each turns a case red.
- **History:** Findings-engine Phase 3, 2026-07-26.

## The hands (migration 0363)

The layer that turns a card into a fix. A finding Staxis can act on arrives with
the action attached, and one tap runs it. Four invariants, because each one is
the difference between "the AI helped" and "the AI did something I did not ask
for".

- **INV-HAND-1 — what runs is what was shown.** The exact action and its exact
  parameters are written when the card is created, by CODE, from the finding's
  own evidence. There is no model call at execution time and no improvisation:
  `finding_actions.params` IS the decision. It cannot be edited afterwards, so
  the button a manager reads and the plan the database runs are the same object
  rather than two things that agree today.
- **Enforced by:** trigger `staxis_finding_actions_frozen` (migration 0363),
  which REJECTS any UPDATE that changes `params`, `verify`, `action_kind`,
  `finding_id`, `property_id`, `params_fingerprint`, `idempotency_key` or
  `proposed_at` — modelled on `staxis_agent_decisions_immutable` (0350). The
  same trigger COMPUTES `params_fingerprint` on insert (sha256 of the canonical
  jsonb text), so the app cannot supply a fingerprint that disagrees with the
  plan it fingerprints, and "was this the plan the manager approved?" is a diff.
  Belt to those braces: `staxis_execute_finding_action` recomputes the
  fingerprint and returns `tampered` on a mismatch, so a dropped trigger still
  cannot execute an edited plan. **DB-ENFORCED.**
- **Assumed by:** the card's Approve button, whose sentence and label are
  rendered on the SERVER from the frozen params through the same catalog entry
  that defines what the button does (`/api/findings` `toCardAction`), so the
  client is given no way to compose its own description of the plan.
- **Tested by:** `findings-actions.integration.test.ts` — "the frozen plan
  CANNOT be edited after the card was written", "neither can the facts it will
  be re-checked against", "a tampered fingerprint refuses to execute even with
  the trigger out of the way", "the database computes the fingerprint — the app
  never supplies one"; plus the pure mirror in `findings-actions.test.ts` ("the
  work-order plan is identical whether the location has 4 faults or 40" — the
  measurement must not reach `params`, or a re-find would churn a new proposal
  nightly). Verified by relaxing the trigger's params check and by removing the
  fingerprint comparison; each turns exactly its case red.
- **History:** The hands, 2026-07-26.

- **INV-HAND-2 — the receipt is re-derived inside the executing transaction.**
  Age is a proxy; changed-ness is the thing. Before any write,
  `staxis_execute_finding_action` re-queries the live rows the finding rests on
  and compares them to the frozen `verify` payload. If the facts moved — work
  orders closed, a reorder point already changed by a human, an item archived —
  the action DECLINES, records what moved in `changed_facts`, and writes
  nothing. "The AI declined and explained" is the good outcome; "the AI did
  something wrong" is the one this exists to make impossible.
- **Enforced by:** the function being plpgsql. The verification read and the
  write are in ONE transaction, so there is no window between them. Doing this
  from the app was not an option: PostgREST has no transactions, and
  verify-then-write over two round trips is exactly the gap this closes.
- **Also enforced by:** the write sitting inside a plpgsql exception block — a
  SUBTRANSACTION. A failed write rolls back completely while the `state='failed'`
  row, written by the handler in the OUTER transaction, survives. Failure is
  therefore always recorded and never partial.
- **NOT expressible as a CHECK:** the constraint is a relationship between a
  frozen payload and rows in three other tables at a moment in time.
- **Tested by:** `findings-actions.integration.test.ts` — "THE DECLINE: the work
  orders were closed between the offer and the tap" (the change is planted
  between proposal and tap), "a reorder point somebody already changed declines,
  and does not overwrite them", "an item that left the list declines rather than
  erroring", "more work orders than when it was offered still executes — it got
  worse, not better", "a decline is final", and "the state is failed, the reason
  is kept, and NOTHING was half-written". Verified by making the verification
  never fire, and by recording a failed write as executed; each turns exactly
  its case red.
- **History:** The hands, 2026-07-26.

- **INV-HAND-3 — every action in the catalog has a real undo, and Staxis never
  undoes a human.** An action kind may not exist without a stated reversal, and
  the reversal refuses when somebody has touched the result.
  `create_work_order` removes the row Staxis created — and only while it is
  still exactly as created (status still 'submitted', unassigned, unpriced, no
  completion note, photo or name). `raise_inventory_reorder_point` writes back
  the previous value frozen in the plan — and only while the current value is
  still the one it set. Either way the `finding_actions` receipt survives, so
  nothing is lost from the audit trail.
- **Why removal rather than a 'cancelled' status:** the maintenance board has
  exactly two states (`src/types/index.ts`: open ↔ 'submitted', done ↔
  'resolved'). Marking an undone suggestion 'resolved' would put a job NOBODY
  DID into the hotel's completed-maintenance history, where it would go on to
  skew the repair-cost samples this very layer prices findings from. A worse lie
  than the card ever told.
- **Enforced by:** `validateActionDefinition` (`actions/registry.ts`) refusing an
  entry with an empty `undoDescription` or `outcomeCheckDays < 1` at module
  load, plus `staxis_undo_finding_action`'s touched-checks. Code-level for the
  first (a catalog is a TypeScript map), DB-level for the second.
- **Tested by:** `findings-actions.integration.test.ts` — "undo removes the work
  order Staxis created, and records it", "undo restores the exact previous
  reorder point", "undo REFUSES once somebody has started on the work order",
  "undo REFUSES once somebody has changed the reorder point themselves",
  "undoing twice is not an error", "an action that never ran cannot be undone";
  plus "an entry with no undo is refused" in `findings-actions.test.ts`.
  Verified by dropping the touched-check; the refusal cases go red.
- **History:** The hands, 2026-07-26.

- **INV-HAND-4 — a double tap is exactly one action.** Two requests carrying the
  same approval produce one work order, not two, and the second one is answered
  with the FIRST one's receipt rather than an error.
- **Enforced by:** two DB guarantees, neither of them politeness. (1) UNIQUE
  index `finding_actions_idempotency_uq` on `idempotency_key`, which the trigger
  derives as `<finding_id>:<params_fingerprint>` — one proposal per problem per
  exact plan, so a nightly re-find and a retried write are both one row.
  (2) `staxis_execute_finding_action` takes `FOR UPDATE` on the row and refuses
  to leave `'proposed'` twice; concurrent taps serialise on the lock and the
  loser reads the state the winner already moved it to. Partial unique index
  `finding_actions_one_open_per_finding_uq` additionally allows at most one live
  offer per finding, because the card has one button and two rows would make it
  ambiguous. **DB-ENFORCED.**
- **Assumed by:** the API route, which therefore does not have to be careful
  about retries, and the card, which does not disable itself defensively.
- **Tested by:** `findings-actions.integration.test.ts` — "two taps arriving
  together produce exactly ONE work order" (concurrent, through the real route),
  "the replay is answered with the FIRST tap receipt, not an error", "the
  idempotency key is UNIQUE — two identical proposals cannot both land", "a
  re-run with the same plan does not stack a second offer", "a re-run with a
  DIFFERENT plan supersedes the old offer rather than duplicating it".
  Verified by removing the state guard, which turns the concurrency case red.
- **History:** The hands, 2026-07-26.

- **INV-HAND-5 — the judge can quieten a fix, never author one.** The AI judge
  may re-sort a card down (`propose` → `recommend`/`fyi`/`drop`), and doing so
  takes the button with it. It can never add, remove, retarget or reparameterise
  an action.
- **Enforced by:** three independent mechanisms. (1) The judge's output contract
  is a CLOSED key set (`ITEM_KEYS` = id/d/en/es/why); an item carrying `action`
  or `params` refuses the WHOLE reply. (2) `persistJudgments` writes only
  `judged_*` columns on `findings`; `finding_actions` is a table the judge module
  does not import. (3) A plan is frozen and immutable (INV-HAND-1), so even a
  hypothetical write would be refused by Postgres. The downgrade half is
  `offersApproval` in `finding-cards.ts`, which requires the EFFECTIVE
  disposition to be `propose`.
- **Tested by:** `findings-actions.test.ts` — "a reply naming an action refuses
  the WHOLE reply", "a reply carrying action parameters refuses the whole reply
  too", "the judge module has no handle on the actions table at all", "a card
  the judge sorted down to an FYI loses the button", "undo survives a downgrade";
  and `findings-actions.integration.test.ts` — "a judging pass leaves the action
  row byte-identical", "a judging pass cannot CREATE an action for a finding
  that has none". Verified by making `offersApproval` ignore the disposition.
- **History:** The hands, 2026-07-26.

- **INV-HAND-6 — only the runner turns a plan into a button, and only for a live
  proposal.** A detector returns a plan; the runner decides whether it becomes an
  offer, and refuses on three counts: no `actionTemplate` on the declaration, a
  post-demotion disposition that is not `propose`, or a finding the manager has
  silenced. A detector cannot bypass any of them, because a detector never
  writes.
- **Enforced by:** structure — `DetectorDeclaration.actionTemplate` is a PURE
  function of a draft with no database handle, and `registerDetector` refuses an
  action template on any detector whose `defaultDisposition` is not `propose`
  (an offer rendered as an FYI is a button on a card that says it needs no
  decision). NOT DB-enforceable: the registry is an in-process map.
- **Tested by:** `findings-actions.integration.test.ts` — "a proposal gets its
  fix frozen on the night the card is written", "the RUNNER refuses to button a
  recommendation, even when the template offers one" (driven through a probe
  whose template never declines, so the runner's gate is what is measured), "a
  problem the manager silenced is never answered with a button", "a decision the
  manager already made is never re-offered"; plus "an action template on a
  recommend-by-default detector is refused at registration" in
  `findings-actions.test.ts`. Verified by removing each runner gate in turn.
- **History:** The hands, 2026-07-26.

- **INV-COMPANY-1 — a hotel a person was never given is a hotel they cannot
  reach.** Two walls, one statement. WALL A, inside one company: a
  property-scope job covers exactly the hotels named on its own row, so the
  front-desk person at hotel #7 cannot list, read, or write hotel #12, and a GM
  sees their own hotels fully and nothing sideways. WALL B, across companies:
  coverage is only ever drawn from `organization_property_relationships` rows
  belonging to the job's OWN organization, so company A's VP can never reach
  company B's data — whatever ids they send.
- **Enforced by:** structure plus the database. (1) There is exactly ONE
  function that turns a person into hotels — `loadHats` in
  `src/lib/company/access.ts` — and every query inside it is filtered by the
  hat's own `organization_id`. No union, no wildcard, no caller-supplied
  organization. (2) `covered_property_ids` is validated on INSERT and UPDATE by
  trigger `trg_organization_memberships_validate_hat` (migration 0364), which
  refuses any hotel the company does not currently operate — so a hat naming
  another company's hotel cannot exist even if a route were wrong.
  (3) `organization_memberships` grants service_role SELECT only (0325, restated
  in 0364), so the ONLY writer is `staxis_set_membership_hat`, which re-checks
  authority under the same per-organization advisory lock the rest of the
  Company Hub uses. **DB-ENFORCED.**
  (4) **Added 2026-07-26.** Coverage is drawn only from GOVERNING relationship
  rows — `relationship_type in ('operator','owner')` AND `is_primary_grouping`
  — in all three readers (`loadHats`, `propertiesOfOrganization`,
  `companyForProperty`). Before this, a `brand` or `franchisor` link counted as
  operating a hotel, and `companyForProperty` resolved a hotel claimed by two
  live companies with `real[0]`, i.e. the lowest UUID: whose rulebook, whose
  money thresholds and whose staff list applied to a hotel was decided
  alphabetically and silently. The DB already guarantees at most one governing
  row per hotel (partial UNIQUE `organization_property_one_open_primary_idx`),
  so with the filter there is nothing left to tie-break; if two ever survive,
  `companyForProperty` returns `null` and logs, so the hotel behaves as an
  independent one rather than borrowing a company that may be the wrong one.
  (5) **Added 2026-07-26.** `staxis_set_membership_hat` (0370) refuses a target
  who holds no membership or live invitation at the organization (Staxis-admin
  actors exempt, for bootstrap), refuses a Staxis administrator as a target, and
  refuses anyone attaching a job to a person who already holds a job the actor
  could not have granted. **DB-ENFORCED.**
- **Assumed by:** `userHasPropertyAccess` (`src/lib/api-auth.ts`) — the gate
  every hotel-scoped route already calls, which as of 2026-07-26 also refuses a
  deactivated account, matching every other account reader;
  `callerReachesHotel` / `managerManagesHotel` / `canManageHotel` /
  `callerControlsEveryTargetHotel` (`src/lib/team-auth.ts`);
  `resolveAuthoritativeInviteScope`
  (`src/lib/company/account-invite-authority.ts`).
- **INV-COMPANY-1b — CAPACITY is resolved at the hotel being asked about, never
  from the global `accounts.role`.** Reach ("may you open this hotel?") and
  capacity ("in what job?") are two questions and the manager gates used to
  answer them from two different places without ever intersecting them:
  `loadManagerCaller` read the GLOBAL `accounts.role`, and `managerManagesHotel`
  then admitted the hotel if ANY hat covered it, whatever that hat's job was. A
  person with a legacy `general_manager` login and a HOUSEKEEPING hat at a
  company hotel passed both halves — 200 on that hotel's findings queue and the
  right to mute its manager-only cards — while `effectiveRole` told anybody who
  asked that she was a housekeeper there. The hat was meant to be the demotion;
  it was read only as an admission ticket.
  **Enforced by:** `managerManagesHotel` and `canManageHotel`
  (`src/lib/team-auth.ts`) now intersect reach with
  `resolveEffectiveRole(…, propertyId)` — the SAME pure function `effectiveRole`
  is built from, so there is one rule and not two. `callerCan` /
  `callerCapabilityDecision` / `callerCapabilityDecisionFresh` resolve the
  per-hotel role too, so a per-hotel capability override applies to the job the
  caller actually holds there. Legacy behaviour is untouched: an account with no
  hat at the hotel still answers from `accounts.role` gated on the legacy array,
  which is every account in the product today. **NOT DB-enforceable.**
  **Assumed by:** every findings route (`/api/findings`, `…/actions`,
  `…/badge`, `…/brief`, `…/for-target`), `/api/memory/question`, and the invite
  and hats routes through `verifyTeamManager`.
  **Deliberately NOT applied to** the two surfaces that need reach WITHOUT
  manager capacity — `/api/company/rulebook` (GET and the intake POST) — which
  call `callerReachesHotel` and let `rulebookStandingFor` be the authority. A
  company's finance lead degrades to `front_desk` on purpose (least privilege,
  `legacyRoleForHat`), so a manager question there would refuse the exact person
  the screen was written for.
  **Tested by:** `company-capacity.integration.test.ts` — the housekeeping-hat
  holder with a legacy manager login is refused every findings route at that
  hotel and served at the hotel her legacy array names; the finance lead still
  reads the rulebook and the portfolio; the legacy control group is unmoved.
  **History:** walls/injection red-team pass, 2026-07-26.
- **Tested by:** `company-spine.integration.test.ts` — "the front-desk person at
  Beaumont cannot learn Lufkin exists" and "a GM sees his own hotel fully and
  nothing sideways" (both through the REAL `/api/home/summary` handler, with the
  allowed hotel asserted NOT 403 so the suite cannot pass on a route that
  refuses everything); "Piney Woods' VP is refused every Gulf Coast hotel
  through the real read route"; "a VP's invitation is REFUSED a hotel outside
  their company" plus "and nothing was written"; "a hat cannot name a hotel its
  company does not operate"; "a company owner cannot reach into the other
  company"; "a manager at one company cannot touch a person's job at another".
  Verified by mutation: widening `loadHats` to ignore `covered_property_ids`
  turns 8 cases red; making `canManageHotel` blind to hats turns 8 red; deleting
  the cross-company hotel check in `resolveAuthoritativeInviteScope` turns 1 red; skipping the
  authority check inside `staxis_set_membership_hat` turns 3 red.

  Wall B specifically needs BOTH of its mechanisms broken before anything leaks —
  removing the organization filter on the relationship read alone changes nothing,
  because coverage is then still looked up by the hat's own `organization_id` in
  the map; removing the map key alone changes nothing, because the read never
  fetched another company's rows. Breaking both together turns 7 cases red. That
  belt-and-braces property is deliberate, and it is why neither half may be
  "simplified away" as redundant.
- **History:** The company spine, 2026-07-26.

- **INV-COMPANY-2 — an account with no company job resolves exactly as it did
  before the company spine existed.** `effectiveRole` returns `accounts.role`
  with `source: 'legacy'`, and `accessibleProperties` returns
  `accounts.property_access` verbatim. A hat is only ever ADDITIVE: it can add a
  hotel the legacy array never mentioned and it can name a different job at a
  hotel the array did mention, but it can never take a hotel away.
- **Enforced by:** the shape of the code plus one CHECK. Every new gate is
  written as `legacy answer first, then ALSO ask about hats` — the legacy branch
  returns before the hat branch is reached, so a hat failure cannot turn a
  legacy `true` into a `false`. `organization_memberships_hat_shape_check`
  (0364) requires `membership_scope`, `staxis_role` and `covered_property_ids`
  to be absent TOGETHER, so a pre-0364 employment row can never be read as a
  half-written job. Trigger `_staxis_validate_membership_hat` additionally
  refuses any hat inside a `single_hotel` compatibility anchor, which is what
  makes every legacy reconcile path in 0325 provably unable to see one.
  **DB-ENFORCED.**
- **Assumed by:** every one of the ~5,100 tests that existed before this
  migration, all of which describe an account with no hat.
- **Tested by:** `company-spine.integration.test.ts` — the whole "the control
  group" suite: "a legacy owner is still the owner of the hotel in her
  property_access, and nothing else", "a legacy housekeeper resolves to
  housekeeping, and reaches exactly her one hotel" (asserting the answer IS the
  array, verbatim), "loadManagerCaller returns the same manager it always did,
  plus empty company fields", "an invitation at the independent hotel stays
  exactly the invitation it always was", "an invitation at the independent hotel
  still creates the plain old account". Verified by making the legacy fallback in
  `effectiveRole` unreachable, which turns 2 control-group cases red while every
  company test stays green.
- **History:** The company spine, 2026-07-26.

- **INV-COMPANY-3 — the pre-0364 one-membership-per-company rule still holds for
  employment records, and the reconciler still fires.** Multi-hat means several
  open `organization_memberships` rows for one person in one company. The 0325
  invariant "at most one open membership per (organization, account)" is still
  true — of EMPLOYMENT records, the rows with `staxis_role IS NULL`.
- **Enforced by:** `organization_memberships_one_current_idx` re-created in 0364
  with the predicate `where ended_at is null and staxis_role is null`, plus
  `organization_memberships_one_open_hat_idx` for the hats. Because that index
  is also the ON CONFLICT arbiter inside
  `_staxis_reconcile_legacy_organization_access`, 0364 re-creates that function
  with the matching predicate — without it, Postgres cannot infer the index and
  EVERY property and account INSERT in the product fails with SQLSTATE 42P10.
  For the same reason 0364 re-creates `staxis_accept_organization_invitation`,
  whose bare `SELECT ... INTO` would otherwise silently adopt a hat row as
  somebody's employment record. **DB-ENFORCED.**
- **Assumed by:** `_staxis_reconcile_property_trigger` and
  `_staxis_reconcile_account_trigger` (0325), which run on every property and
  account write in the product.
- **Tested by:** `company-spine.integration.test.ts` — "the legacy
  one-membership-per-company rule still holds for employment records", "the same
  job at the same scope is one hat with a wider list, never two rows"; and,
  less obviously but more importantly, every test in the file, because the
  fixture inserts four properties and eleven accounts and would fail in `before`
  if the reconciler's ON CONFLICT no longer matched. That is exactly how this
  invariant was discovered.
- **History:** The company spine, 2026-07-26.

## Cross-hotel chat (no migration — 2026-07-26)

The portfolio surface lets a company-scope person (owner / VP / finance) ask the
copilot about the exact hotel set authorized for that turn. The route resolves
that set into a receipt, runs bounded deterministic readers, and gives the model
only the resulting evidence package for final wording.

- **INV-PORTFOLIO-1 — deterministic portfolio evidence is bounded by one exact
  authorization receipt.** Selected hotels must be a subset of the receipt's
  authorized hotels, and every mounted metric reader receives only the selected
  hotel candidates.
- **Enforced by:** `runPortfolioIntelligence` in
  `src/lib/agent/portfolio-intelligence/engine.ts`, which checks the selector
  against the receipt before reading. The booked-room and operational adapters
  use `scopedDb(propertyId)` for each selected hotel, and the route asserts the
  receipt before and after each mounted reader. **NOT DB-enforceable:** the
  receipt and the application scope are not visible to Postgres.
- **Consequence, stated because it is the point:** a source may be unavailable
  for one selected hotel and produce conservative coverage, but a deterministic
  reader cannot reach a hotel outside the exact authorized set.
- **Tested by:** `portfolio-chat-leak.integration.test.ts`, including
  "company A's VP is let in, with exactly company A's hotels", the
  cross-company refusal cases, and the deterministic aggregate and drill-down
  route cases.
- **History:** cross-hotel chat, 2026-07-26; deterministic evidence route,
  2026-07-30.

- **INV-PORTFOLIO-2 — the route does not trust browser-supplied scope.** The
  current request resolves authorization and the company switch server-side,
  then reasserts the receipt while deterministic reads are running. A stale
  browser organization or selector cannot expand the answer.
- **Enforced by:** `/api/agent/portfolio` through
  `resolvePortfolioAccessUncached`, the scope receipt helpers, and
  `runPortfolioIntelligence`'s pre-reader and post-reader receipt assertions.
  The route also checks the receipt before releasing synthesized output.
- **Tested by:** the route admission, switch, cross-company, availability,
  mid-load revocation, and final-release tests in
  `portfolio-chat-leak.integration.test.ts`.
- **History:** cross-hotel chat, 2026-07-26; deterministic evidence route,
  2026-07-30.

- **INV-PORTFOLIO-3 — a plan cannot select outside the exact receipt.** The
  planner's selected scope must match the freshly resolved receipt, and the
  engine rejects a selector/receipt mismatch or a selected hotel absent from
  the authorized set. It never silently widens or substitutes another hotel.
- **Enforced by:** `expectedIds` and the exact-scope checks in
  `src/lib/agent/portfolio-intelligence/engine.ts`, followed by the route's
  final receipt assertion.
- **Tested by:** the naming-the-other-company refusal, stale-scope refusal, and
  unsupported-measure cases in `portfolio-chat-leak.integration.test.ts`.
- **History:** deterministic evidence route, 2026-07-30.

- **INV-PORTFOLIO-4 — portfolio synthesis mounts no agent tools.** The
  portfolio route passes `tools: []` to the synthesis runtime and rejects any
  nonzero tool-call count. The generic per-hotel tool registry has no
  portfolio-surface registration, so the replaced tool-chat path cannot be
  reached through the command runtime.
- **Enforced by:** `/api/agent/portfolio/route.ts`, the empty synthesis tool
  list, and its `validateAssistantResponse` guard. The route's deterministic
  readers run before synthesis and provide the only factual input.
- **Tested by:** the portfolio route's no-tool synthesis fixtures and the
  catalog/registry tests that assert only live tools are registered.
- **History:** cross-hotel chat, 2026-07-26; deterministic evidence route,
  2026-07-30.
- **INV-PORTFOLIO-5 — an individual hotel's private facts never enter a
  portfolio prompt.** The portfolio prompt carries hotel NAMES and ROOM COUNTS
  and no other hotel-supplied fact: no hotel-identity tier, no PMS-family tier,
  no `<staxis-memory>` block.
- **Enforced by:** `buildPortfolioSystemPrompt` is a separate assembler with its
  own typed `StableTier` union, which contains no `hotel_identity` and no
  `pms_family` member — adding one is a compile error, not a review catch.
  **NOT DB-enforceable** (prompt assembly is code).
- **Why it matters twice:** one hotel's internal setup in front of a question
  about a different hotel is a correctness problem; twenty hotels' identity
  blocks in one CACHED prompt is a cost problem that has no visible symptom at
  all.
- **Tested by:** `portfolio-prompt-assembly.test.ts` — a control case first
  proves the per-hotel prompt genuinely renders those facts (otherwise the
  absence assertions would be vacuous), then the portfolio prompt for a
  portfolio containing that same hotel is asserted to contain none of them.
- **History:** cross-hotel chat, 2026-07-26.

- **INV-PORTFOLIO-6 — the portfolio prompt obeys the same cache contract as the
  hotel prompt.** Names and room counts are stable; live counts and every as-of
  value live in the dynamic half.
- **Enforced by:** the disjoint tier unions above, plus
  `agent-prompt-cache-purity.test.ts` ("prompt cache purity — the portfolio
  surface") and the purity cases in `portfolio-prompt-assembly.test.ts`, which
  build twice at different data ages and require a byte-identical stable block
  while requiring the dynamic blocks to differ. The PRINTED stamp is constant
  for the conversation; the PERSISTED label carries the per-turn reach digest
  and the company id, and asserting that the company id is NOT printed is what
  keeps the two apart. Same split as INV-TIER-6.
- **History:** cross-hotel chat, 2026-07-26.

- **INV-PORTFOLIO-7 — a company-wide transcript is readable only while its
  reader still passes the gate.** Owning the row is not enough.
- **Enforced by:** code — `/api/agent/conversations/[id]` re-runs
  `resolvePortfolioAccessUncached` for any conversation carrying an org scope
  and answers 404 when it fails. **NOT DB-enforced**, and the scope marker is
  NOT a column: `agent_conversations.property_id` is `NOT NULL` and this work
  ships no migration, so a portfolio conversation is ANCHORED to one hotel the
  caller genuinely covers and the company id rides as a trailing `+org:<uuid>`
  segment in `prompt_version` (see `portfolio/conversation.ts`, which is the
  only reader and the only writer of that format). The anchor is read BACK from
  the row on later turns, never recomputed — a company that acquires a hotel
  sorting before the old anchor would otherwise fail its VP's next message at
  `staxis_lock_load_and_record_user_turn`'s property check.
  **Trigger condition: the day `agent_conversations` gains a nullable
  `organization_id`, `portfolio/conversation.ts` is the only file to move.**
- **Tested by:** "an org-scoped row reads back for its owner, and stops when the
  gate closes", "a per-hotel conversation is unaffected and cannot be continued
  as a company one", "somebody else's company conversation is not readable".
- **History:** cross-hotel chat, 2026-07-26.

### INV-43: agent_costs is the BOOKS; findings_ai_spend is the GATE. Nothing sums both

- **The rule:** every provider call Staxis pays for is booked exactly once, in
  `agent_costs`, and any screen quoting spend reads that table and no other.
  `findings_ai_spend` (0361) is a per-hotel daily CEILING holding worst-case
  reservations — most of the money in it was never charged. The judge, the sweep
  and the brief each write to BOTH: a hold in the gate before the call, a real
  row in the books after it. Adding the two together triple-counts nothing and
  double-counts those three; reading the gate alone quotes hold-sized money.
- **Enforced by:** code — `spendByFeature` in
  [/api/admin/mission/ai-staff](src/app/api/admin/mission/ai-staff/route.ts)
  reads `agent_costs` only, filtered to `state='finalized'` and
  `swept_at IS NULL`, over the index `agent_costs_feature_day_idx` (0374). NOT
  DB-enforced — no constraint can express "do not join these two tables", so the
  guard is the test below plus this entry.
- **Both windows, one read.** The AI Staff card quotes thirty days and Mission
  Control's roster quotes today. They come from ONE query folded twice
  (`foldSpendRows`), so the day cannot end up sourced from a different ledger
  than the month — which is exactly what happened before 0374, when the day
  figure was added against the GATE because it was the only ledger with a
  feature column. The day boundary is LOCAL midnight, matching
  `/api/agent/metrics`, because it sits beside that figure on one screen; the
  UTC boundary the cap math uses is for caps, and this is display.
- **Attribution:** `agent_costs.feature` (0374) is what makes a per-job figure
  possible at all. It is REQUIRED at every ledger writer's signature
  (`recordNonRequestCost`, `finalizeCostReservation`) and typed to the closed
  `AiCostFeature` union, so a new caller cannot omit or invent one. It is
  NULLABLE in the database and NEVER backfilled: rows written before 0374 have
  no recoverable job, so they read as unattributed and the AI Staff payload
  reports `attributedSince` rather than letting a partial window pass for a full
  one. `staxis_finalize_agent_spend` COALESCEs the label and keeps its
  pre-0374 8-argument signature as a delegating shim, so applying the migration
  by hand ahead of the deploy cannot break a running finalize.
- **Assumed by:** the per-employee spend figure on /admin/ai-staff.
- **Tested by:** `agent-costs-feature-attribution.integration.test.ts` — "the
  figure is the books, once — a hold in the gate is not money", "holds, swept
  holds and unattributed history stay out of the figure", "a build that predates
  0374 still finalizes", "the AI-spend screen counts the same money it always
  did, labelled or not", "today's figure is the same books-only read, narrowed
  to the day".
- **History:** 0374, 2026-07-26. Before it, the AI Staff page had to read the
  GATE because it was the only ledger with a feature column — which both quoted
  reservation-shaped money and could only ever describe three features.

### INV-42: the situational-awareness block never enters the cached system block

- **Enforced by:** three layers, none of them DB (prompt assembly is code, so no
  constraint can reach it): (1) compile time — `'right_now'` is a member of
  `DynamicTier` in [prompts.ts](src/lib/agent/prompts.ts), and the two unions
  are disjoint, so moving it into `STABLE_TIER_ORDER` is a type error;
  (2) runtime — `AWARENESS_HEADER` and `</staxis-awareness>` are members of
  `DYNAMIC_ONLY_MARKERS` in [llm.ts](src/lib/agent/llm.ts), so
  `assertStableBlockIsCacheable` throws outside production and reports-and-serves
  in production, covering the summarizer and eval runner which hand-roll their
  own blocks; (3) behaviour —
  `src/lib/__tests__/agent-awareness.test.ts` builds twice with different
  awareness and asserts a byte-identical `stable` plus a differing `dynamic`.
- **Why it matters:** this block contains a WALL CLOCK. It is the most
  per-turn content in the entire prompt. A misplacement has no visible symptom —
  the copilot keeps answering correctly — while every turn of every conversation
  misses the Anthropic prompt cache, indefinitely and silently. Verified live:
  a second turn on the same conversation reports `cache_read` of the full stable
  prefix (`scripts/prove-awareness-live.ts`).
- **NOT DB-enforceable.** Same class as INV-33 and INV-TIER-5.
- **History:** situational awareness, 2026-07-27.

### INV-43: the browser's pathname is never interpolated into a prompt

- **Statement:** the `pathname` field on `POST /api/agent/command` selects a row
  from an allowlist; the string PRINTED is that row's own constant. No byte of
  client input reaches the model.
- **Enforced by:** `resolveSurface()` in [awareness.ts](src/lib/agent/awareness.ts)
  returns `SurfaceRoute.surface` — a literal from that file — or `null`. There is
  no code path that returns its argument. Bounded at 512 chars and refused unless
  it matches `^\/[A-Za-z0-9\-._~/%]*$` (no `<`, no whitespace, no quotes) before
  any matcher runs. Backed by the injection cases in
  `agent-awareness.test.ts`, including one that asserts the rendered block
  contains exactly ONE `</staxis-awareness>` — the formatter's own.
- **Why the allowlist rather than escaping:** escaping is right when the value
  must be DISPLAYED (a hotel name). Here nothing needs displaying — a path either
  IS a known screen or is uninteresting — so the safest use of the input is to
  let it select and never to print it. An unlisted new page is invisible to the
  copilot until someone adds it, which is a visible, self-correcting gap; echoing
  the path would be an open prompt-injection channel through a query string.
- **NOT DB-enforceable** — the value never reaches the database.
- **History:** situational awareness, 2026-07-27.

### INV-44: a failing awareness feed drops its own line and nothing else

- **Enforced by:** two nested layers, because one is the wrong granularity for a
  composite feed. (1) `loadFeedsUncached` runs each of the five feeds in its own
  `Promise.allSettled` slot; a rejection is `captureException`'d and that field is
  omitted. (2) `feedOnYourPlate` assembles FOUR sources into one line, so it wraps
  each source in its own `item()` helper — without that, a bad row in the
  preventive schedule suppressed the approvals count on the same line. Backed by
  `agent-awareness.test.ts` ("survives every single feed throwing at once" and
  "one broken feed does not suppress the others"); the second case was written
  after the first version of the code failed it.
- **Assumed by:** the chat turn itself. Nothing in this block may be the reason a
  manager's message fails to send — it is context, not content.
- **Related honesty rule:** an empty feed renders NOTHING, never "0 items". For
  most of these feeds a zero is unsupportable — data intake is off for nearly
  every hotel, so "0 rooms changed" means "no feed", not "nothing happened". The
  PMS-derived feeds (`justChanged`, `tonight`) are gated on
  `snapshot.pmsDataSource`, which is set if and only if the hotel is on a live
  PMS, exactly as INV-32/A2 established.
- **NOT DB-enforceable.**
- **History:** situational awareness, 2026-07-27.
