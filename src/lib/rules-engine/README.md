# Rules engine

Turns live PMS data (the `pms_*` tables, written by the CUA worker) into
Staxis-side **cleaning tasks** (the `cleaning_tasks` table, written by
this engine).

## How it runs

A Vercel cron hits `/api/cron/run-rules-engine` every minute. The route
calls `runRulesEngineForAllProperties()`. For each property:

1. Build a `PropertyContext` (timezone, today's business date, day-of-week).
2. Build a `RoomContext` per room with reservation activity today, or a
   PMS HK plan entry for today.
3. Run every rule against each room context. Pure functions, no DB.
4. Merge the firing results into a `MergedTaskSpec`.
5. Look up the existing `cleaning_tasks` row for the same
   `(property_id, dedupe_key)`. If the existing row is past
   `scheduled` / `ready_now` (i.e. a human started it), skip — only
   bump `last_evaluated_at`. Otherwise upsert.

The cron route also accepts `?propertyId=<uuid>` to run the engine
against one property on demand. That entry point is reserved for the
CUA worker to hit on important state changes (departure flip, new VIP
booking) for sub-30s latency. Wiring up the CUA-side call is a
separate branch.

## Idempotency

Re-running the engine on the same PMS state produces the same row.
Idempotency is enforced by the unique
`(property_id, dedupe_key = "<room_number>::<business_date>")`
constraint. The upsert path overwrites all engine-set fields except
when the existing row is past `ready_now` — once a human starts the
task, the engine leaves it alone.

## The rule set

Each rule is a small pure function in `rules/<slug>.ts`. Adding a new
rule is three steps:

1. Drop a new file in `rules/` exporting a `Rule`.
2. Add it to the `ALL_RULES` array in `rules/index.ts`.
3. Add a test under `src/lib/__tests__/rules-engine-rules.test.ts` that
   proves it fires when its condition holds and stays silent otherwise.

Current rules:

| ID | What it does |
|---|---|
| `departure-clean` | Departing guest today → base `cleaning_type='departure'`. |
| `long-stay-weekly-deep` | 14+ night stay, day-of-stay multiple of 7 → `cleaning_type='deep'`. |
| `short-stay-every-other-day` | <14 night stay, even day-of-stay → `cleaning_type='refresh'`. |
| `eco-stay-opt-in` | Guest opted into eco-stay → `cleaning_type='room_check'` (5-min visual check). |
| `saturday-deep-rotation` | On a Saturday, ~25% of in-house rooms rotate into a `deep` clean (4-week cycle). |
| `vip-arrival` | VIP arriving → require supervisor inspection + place fruit basket. |
| `pet-stay` | Pet detected on the reservation → +10 min, pet-clean checklist, pet kit on arrival. |
| `late-checkout` | Approved late checkout → annotate the task with the late checkout time. |
| `early-checkin-boost-priority` | Early-check-in requested or approved → priority HIGH. |
| `honeymoon-anniversary` | Honeymoon or anniversary on incoming reservation → welcome amenity. |
| `tight-turnaround` | Earliest room-ready time within 3 hours of next arrival ETA → priority HIGH, due-by 15 min before arrival. |

## Merger semantics

When multiple rules fire on the same room (the common case), `merger.ts`
composes them:

- **cleaning_type** — highest rank wins. `departure_deep > departure > deep > stayover > refresh > room_check > inspection_only > no_clean`. Only one *base* rule typically fires per room; the rank is a tiebreaker.
- **priority** — strongest wins. `urgent > high > normal > low`.
- **due_by** — earliest wins.
- **estimated_minutes** — base from the winning cleaning_type + sum of `estimated_minutes_delta` from modifier rules.
- **requires_inspection** — logical OR.
- **extras** — union, de-duped.
- **notes** — concatenated with "; ".
- **status** — derived from current room status: `vacant_dirty` after a departure ⇒ `ready_now`; everything else ⇒ `scheduled`.

## What this branch does NOT do

- **Assignment** — `assignee_id` is always `null` here. A separate
  branch wires up the auto-assign logic.
- **UI** — no housekeeper-facing tab in this branch.
- **Cleanup** — yesterday's leftover tasks linger until a future
  cleanup branch sweeps them.
- **PMS writes** — engine NEVER writes to `pms_*`. Those tables are
  CUA-owned.

## Testing

- `npm test` runs the rule + merger unit tests under
  `src/lib/__tests__/rules-engine-*.test.ts`.
- The validation scenario (room 305, Tuesday morning, John departing,
  Mary VIP arriving at 2pm) lives in `rules-engine-scenario.test.ts`.
  It builds a fixture and asserts the merged task spec matches the
  expected output in the brief.
