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

- **Enforced by:** Partial unique index `agent_prompts_active_per_role_uniq` (migration 0102)
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

---

## Data-layer invariants (pms_*) — migrations 0345–0349

Added by the schema-reshape workstream (D3-SHAPE). Same doctrine as the rest of
this file: an invariant enforced only by code is labelled **NOT ENFORCED**, and
the two honest gaps are listed at the bottom rather than papered over.

Every constraint, trigger and function name below is real — `grep` it in
`supabase/migrations/034*.sql`, and `src/lib/__tests__/pms-schema-reshape.integration.test.ts`
applies those files to a real Postgres and tries to violate each one.

### One reservation, one row (0345)

- **INV-RES-1 — a reservation has exactly one row for its whole life.**
  Cancellation and no-show are states of that row, not rows in other tables.
  **Enforced by:** structural — `pms_future_bookings`, `pms_no_shows` and
  `pms_cancellations` no longer exist. The pre-existing
  `UNIQUE (property_id, pms_reservation_id)` is now the only place a
  reservation can live.
- **INV-RES-2 — `status='cancelled'` if and only if `cancelled_date` is set;
  `status='no_show'` if and only if `no_show_date` is set; a cancellation fee
  can only exist on a cancelled reservation.** **Enforced by:** CHECKs
  `pms_res_cancel_coherent`, `pms_res_noshow_coherent`,
  `pms_res_fee_requires_cancel` (0345). Each uses `is not distinct from`, not
  `=`, because `NULL = 'cancelled'` is NULL and a CHECK treats NULL as
  satisfied. `sanitizeReservationLifecycle` in
  `cua-service/src/validators-phase2.ts` makes rows coherent BEFORE the write,
  so the CHECK is a backstop that never fires — the writer sends one
  `.upsert()` per batch, so one violating row would destroy the whole batch.
- **INV-RES-3 — departure is never before arrival; a booking is never created
  after the guest arrived.** **Enforced by:** CHECKs `pms_res_date_order`,
  `pms_res_booked_before_arrival` (0345). Neither existed before: the table had
  eight CHECKs and none of them ordered the dates.
- **INV-RES-4 — a reservation never moves backwards out of a terminal state.**
  cancelled / no_show / checked_out → booked / checked_in only when the incoming
  row carries a strictly later `status_changed_at`. **Enforced by:** BEFORE
  UPDATE trigger `staxis_pms_reservation_status_guard()` (0345). This is the
  reconciliation the four-table design never needed and the consolidation
  requires — three report feeds now upsert the same row. **Documented limit:**
  only `status` is guarded; every other column stays last-write-wins, so a stale
  cancellations report can still overwrite a fresher `guest_name`.
- **INV-RES-5 — the PMS-reported `num_nights` is never treated as truth.**
  **Enforced by:** GENERATED column `pms_reservations.nights_derived`
  `(departure_date - arrival_date)` (0345). Deliberately NOT a CHECK against
  `num_nights`: a PMS that counts day-use differently would fail whole batches.

### The PMS mirror / Staxis state split (0346)

- **INV-HK-1 — the PMS-report ingest cannot write Staxis-owned housekeeping
  state** (checklist progress, pause accounting, rush flags, manager and
  housekeeper notes, inspection marks, help-requested). **Enforced by:** two
  independent mechanisms. (1) Structural: those columns no longer exist on
  `pms_housekeeping_assignments`, the only table the ingest writes; they live on
  `public.room_work`. (2) Privilege: INSERT/UPDATE/DELETE on the mirror is
  REVOKEd from `service_role`, and the sole write path is SECURITY DEFINER
  `staxis_apply_hk_mirror()`, which names the mirror columns and nothing else.
  Both writers authenticate as `service_role`, so GRANTs alone could not
  separate them. **Before 0346 this was enforced by nothing** — the ingest
  descriptor merely happened to list five columns.
- **INV-HK-2 — a row handed to the generic writer can never carry a column the
  descriptor does not declare.** **Enforced by:** `validateRows()` in
  `cua-service/src/persistence/generic-table-writer.ts` now DELETES
  off-descriptor keys instead of only warning (its old comment claiming
  "Supabase strips unknown columns" is false for columns that exist), backed by
  tests in `blank-required-guard.test.ts`. This is a code-level chokepoint, so
  it is a **BACKSTOP** — the primary enforcement is INV-HK-1.
- **INV-HK-3 — every row of housekeeping work belongs to a room this property
  has.** **Enforced by:** FK `room_work_room_fk (property_id, room_number) →
  pms_rooms_inventory`, using the existing `pms_rooms_inventory_room_unique`.
- **INV-HK-4 — an assigned housekeeper is a real staff member at this hotel,
  identified by id.** **Enforced by:** FK `room_work_staff_fk
  (assigned_staff_id, property_id) → staff (id, property_id)`, using the
  existing `staff_id_property_id_key`. The composite form makes cross-property
  assignment structurally impossible.
- **INV-HK-5 — every assignment records how it was resolved, and provenance
  cannot linger after an assignment is cleared.** **Enforced by:** CHECK
  `room_work_assigned_source_chk` (0346).
- **INV-HK-6 — merge precedence: the app's explicit value beats the report,
  and an absent app value defers to the report.** `cleaning_type` and
  `dnd_active` exist on both halves because both sides genuinely write them;
  every reader takes `coalesce(room_work, mirror)`. **NOT ENFORCED** at the DB
  level — SQL cannot express "readers must merge this way". Backed by
  `mergeAssignment` / `assignmentBelongsToStaff` in `pms-rooms-server.ts` and
  `mergeHkHalves` in `rules-engine/context.ts`, all three pinned by
  `src/lib/__tests__/hk-mirror-state-split.test.ts`.

### Identity instead of spelling (0347)

- **INV-DIM-1 — one name string maps to at most one staff member per property,
  and name normalization is defined exactly once.** **Enforced by:** UNIQUE
  `(property_id, alias_norm)` on `staff_aliases`, where `alias_norm` is a
  GENERATED STORED column. This replaces two divergent TypeScript
  `normalizeName()` implementations (`pms-rooms-server.ts` keeps punctuation,
  `inventory-match.ts` strips it) with one definition the database computes.
- **INV-DIM-2 — one raw dimension string maps to at most one canonical code per
  property, and an unmapped value degrades to itself rather than vanishing.**
  **Enforced by:** UNIQUE `(property_id, dimension, value_norm)` + CHECK
  `pms_dimension_values_dimension_chk` (0347). The degrade-to-raw half is
  `coalesce(canonical_code, raw_value)` at every read — **NOT ENFORCED** by SQL,
  because SQL cannot express "the reader must not drop unmapped rows".

### Subtraction (0348–0349)

- **INV-DROP-1 — no table is dropped while it holds data.** **Enforced by:** a
  preflight DO block at the top of 0348 that re-asserts `count(*) = 0` for every
  table in the drop list and RAISEs otherwise. Same spirit as the scraper
  preflight in `FAILSAFES.md`. No per-table exemptions exist, which is why
  `agent_voice_sessions` (1 row) is NOT in the drop list.
- **INV-IDX-1 — no new index ships without a named query it serves.**
  **Enforced by:** `scripts/audit-index-justification.mjs` in `npm run lint`
  (CI-gated); requires a `-- @query:` comment above every `create index` in
  migrations numbered 0349+. The existing 734 indexes are grandfathered.

### Known gaps — real, and deliberately not closed here

- **GAP-HK-A — nothing at the database level stops the Staxis app from writing
  `room_work` columns that conceptually belong to a single actor** (e.g. a
  manager route setting `inspected_by`). **NOT ENFORCED.** Both the app and the
  ingest authenticate as `service_role`, and `room_work` is entirely app-owned,
  so there is no second party to fence off. Mitigated by `writeWorkflowFields`
  being the single funnel for the housekeeper endpoints and by INV-HK-5 for the
  one field where provenance actually matters.
- **GAP-HK-B — `today_room_work_v1` and `today_property_counts_v1` are SECURITY
  DEFINER with EXECUTE granted to `anon`**, so anyone holding the public anon
  key and a `property_id` can read per-room housekeeping data straight past the
  `pms_*` deny-all policies. **NOT ENFORCED — pre-existing, from migration
  0224, not introduced by this workstream.** 0346 repointed where
  `today_room_work_v1` reads from without widening who may execute it. The cheap
  fix is `REVOKE EXECUTE … FROM anon` plus routing its two callers through
  `/api`; that is a security decision, not a schema one.
- **GAP-HK-C — `room_work` is not in the `supabase_realtime` publication**, and
  neither is any `pms_*` table. `src/lib/db/today-room-work.ts` subscribes to it
  and the subscription is a silent no-op; the board is effectively polling.
  0346 repointed the subscription so it names the table that actually changes —
  it did NOT make live updates start working.
