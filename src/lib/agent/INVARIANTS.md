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

### INV-18 (RETIRED 2026-05-14): voice_recordings.expires_at = created_at + interval '7 days'

- **Status:** Retired with the ElevenLabs voice-surface switch. The `voice_recordings` table is no longer written by any code path — Whisper STT and the per-clip storage upload were replaced by ElevenLabs streaming ASR (which holds the audio on their side). The column + CHECK remain in the schema for legacy data only; a future migration will drop the table.
- **History:** Active 2026-05-13 → 2026-05-14. Retired when /api/agent/transcribe + /api/cron/voice-recordings-purge were deleted in the ElevenLabs cutover.

### INV-19 (RETIRED 2026-05-14): voice_recordings rows past expires_at are deleted within 24h

- **Status:** Retired alongside INV-18. The daily purge cron `/api/cron/voice-recordings-purge` was removed (no new rows to purge). The entry stays here so historical references in commit messages and the doctor route's git history make sense.
- **History:** Active 2026-05-13 → 2026-05-14.

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
