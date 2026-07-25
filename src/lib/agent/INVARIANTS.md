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
  - Code: [`buildHotelSnapshot`](src/lib/agent/context.ts), [`get_occupancy`](src/lib/agent/tools/reports.ts), [`get_today_summary`](src/lib/agent/tools/queries.ts) all read `room_inventory.length` for `rooms.total` (falling back to seeded count only when inventory is empty).
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

### INV-32: The six PMS feed tables the model reads directly never record a capture time in the future

- **Enforced by:** `captured_at timestamptz NOT NULL DEFAULT now()` (already live on
  `pms_in_house_snapshot`, `pms_guest_balances`, `pms_payments_daily`,
  `pms_future_bookings`, `pms_no_shows`, `pms_cancellations` — verified in prod
  2026-07-24) **plus** six CHECK constraints `<table>_captured_at_not_future`
  in migration `0351_pms_capture_time_sanity.sql`. Code backstop:
  `freshnessAgeMinutes` ([feed-status.ts](src/lib/pms/feed-status.ts)) clamps a
  negative age to 0 and `console.warn`s.
- **Scope — read this before quoting it.** This covers the six feed tables and
  nothing else. It is explicitly **NOT** "every PMS row the model can see":
  the snapshot's room numbers flow from `pms_room_status_log`,
  `pms_housekeeping_assignments` and `pms_reservations`, **none of which have a
  `captured_at` column at all**. Adding one is an ingestion-schema decision
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

## Prompt tiers: global → PMS family → hotel (migration 0338)

The copilot's instructions have three tiers and exactly one home for each:

| Tier | Where it lives | Kind of content |
|---|---|---|
| global | `agent_prompts` rows with `pms_family IS NULL` | behaviour + hard rules |
| PMS family | `agent_prompts` rows with `role='family'`, keyed by `pms_family` | how that PMS's reports read |
| hotel | `agent_memory`, `knowledge_*` — **DATA, never a prompt row** | this hotel's own facts |

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
  text wins), and hotel facts are not in the prompt at all — they arrive via
  `search_knowledge` and the `<staxis-memory>` block in the DYNAMIC half, which
  the model reads after the entire stable block.
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
  rule and the version line go in the STABLE (cached) block. The hotel
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
  global hard rule** (approval gating, cross-property refusal,
  knowledge-hub-first answering). **NOT ENFORCEABLE by any constraint** — it is
  a semantic property of natural-language text. Backed by the adversarial
  `family_tier` cases in `evals/test-bank.ts`, run through `evals/runner.ts`
  with a hostile family addendum active. Those cost real Anthropic tokens and
  run **on demand, not in CI**. Activating any new family row is gated on that
  bank passing. **History:** A3 tiers, 2026-07-24.

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
  `src/app/api/cron/ml-retention-purge/route.ts` (a runtime refusal, not just a
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
