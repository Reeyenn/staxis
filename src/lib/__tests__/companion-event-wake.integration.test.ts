/**
 * PROOF, against a real Postgres with every migration applied, that the
 * companion's ten-minute look actually looks at what the hotel actually writes.
 *
 * ─── WHY THIS ONE CANNOT BE A UNIT TEST ────────────────────────────────────
 *
 * The whole feature is keyed on strings that no TypeScript anywhere produces.
 * `INTERESTING_EVENT_TYPES` is a list of `activity_log.event_type` values, and
 * every one of them is composed inside a plpgsql trigger in a migration file:
 * `'work_order_' || new.status`, `'inspection_' || new.result`,
 * `'cleaning_task_' || new.status`. A hand-written list of those strings is a
 * guess, and a wrong guess produces a watcher that never fires and looks
 * exactly like a watcher that works.
 *
 * It has already caught one. `cleaning_paused_room` was in the first draft of
 * the set, straight out of migration 0228, where the trigger is still defined.
 * Migration 0272 dropped `room_pause_events` out from under it, so nothing has
 * produced one since, and the only way to know that is to make Postgres try.
 *
 * So this file drives the REAL source tables and reads back what the REAL
 * triggers wrote, then runs the real sweep over it.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';

import { supabaseAdmin } from '@/lib/supabase-admin';
import type { MessagesClient } from '@/lib/agent/llm';
import { AGENT_JOURNAL_SOURCE } from '@/lib/agent/journal';
import { INTERESTING_EVENT_TYPES, MAX_WAKES_PER_DAY } from '@/lib/companion/event-wake/events';
import { claimWakeWindow, readWakeState } from '@/lib/companion/event-wake/state';
import { sweepAllProperties } from '@/lib/companion/event-wake/runner';
import { buildCompanionCandidates } from '@/lib/companion/candidates';
import { invalidateAiFeatureConfigCache } from '@/lib/ai/model-config-store';
import {
  COMPANION_MAX_SPEECH_PER_DAY,
  COMPANION_DECLINES_BEFORE_DROP,
} from '@/lib/companion/charter';
import {
  EMPTY_COMPANION_MEMORY,
  decideCompanionSpeech,
  rememberDeclined,
  rememberSpoke,
  type CompanionMemory,
} from '@/lib/companion/manners';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import {
  createPglitePostgrest,
  loadCatalog,
  type Catalog,
  type PglitePostgrest,
} from '../../../tests/fixtures/postgrest-pglite';
import { seedTwoHotels, PID_A, PID_B } from '../../../tests/fixtures/pglite-two-hotel-seed';

let pg: PGlite;
let catalog: Catalog;
let shim: PglitePostgrest;
let ingestRunId: string;

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);

/** A scripted model. The sweep makes at most one call per hotel. */
function scriptedModel(replies: Array<string | (() => never)>) {
  const rec = {
    calls: 0,
    prompts: [] as string[],
    client: {
      messages: {
        create: async (body: { messages: Array<{ content: unknown }> }) => {
          const reply = replies[Math.min(rec.calls, replies.length - 1)];
          rec.calls += 1;
          rec.prompts.push(JSON.stringify(body.messages));
          if (typeof reply === 'function') reply();
          return {
            id: 'msg_test',
            model: 'claude-haiku-4-5-20251001',
            role: 'assistant',
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: reply as string }],
            usage: { input_tokens: 900, output_tokens: 60 },
          };
        },
        stream: () => { throw new Error('the event sweep never streams'); },
      },
    } as unknown as MessagesClient,
  };
  return rec;
}

/** Put this hotel's cursor `minutes` in the past so the next sweep has a window. */
async function setCursor(propertyId: string, minutesAgo: number): Promise<void> {
  await pg.query(
    `insert into public.companion_event_wake_state (property_id, last_looked_at)
     values ($1, now() - ($2 || ' minutes')::interval)
     on conflict (property_id) do update
       set last_looked_at = excluded.last_looked_at,
           wakes_day = null, wakes_today = 0`,
    [propertyId, String(minutesAgo)],
  );
}

async function cursorOf(
  propertyId: string,
): Promise<{ last: string; wakes: number; looks: number }> {
  const r = await pg.query<{ last_looked_at: string; wakes_today: number; looks_total: number }>(
    `select last_looked_at, wakes_today, looks_total
     from public.companion_event_wake_state where property_id = $1`,
    [propertyId],
  );
  const raw = r.rows[0]?.last_looked_at;
  // PGlite hands back a JS Date for timestamptz. `String(date)` is a local
  // wall-clock string with a timezone NAME in it, which Postgres then refuses
  // when it is fed back in as a parameter. ISO, always.
  return {
    last: raw ? new Date(raw as unknown as string).toISOString() : '',
    wakes: Number(r.rows[0]?.wakes_today ?? 0),
    // `looks_total` is written by `claimWakeWindow` and by nothing else, so it
    // is the field that proves a look actually happened. It read 0 for Home2 in
    // production while its six siblings read 5.
    looks: Number(r.rows[0]?.looks_total ?? 0),
  };
}

async function clearActivity(): Promise<void> {
  await pg.query('delete from public.activity_log');
}

/**
 * A fresh id space per test.
 *
 * The source tables carry real uniqueness guards (one cleaning task per
 * property/date/room, one work order per pms id), which is exactly what they
 * should do and exactly what makes a shared fixture between tests impossible.
 */
let run = 0;
function nextRun(): { id: (n: number) => string; room: (n: number) => string; key: string } {
  run += 1;
  const tag = String(run).padStart(4, '0');
  return {
    id: (n: number) => `${tag}${String(n).padStart(4, '0')}-0000-4000-8000-000000000001`,
    // Unique per run so the legacy plan guard on (property, date, room) does
    // not see two tests as one ambiguous day.
    room: (n: number) => `${run}${n}0`,
    key: `wake-${tag}`,
  };
}

async function journalRows(propertyId: string) {
  const r = await pg.query<{ event_type: string; description: string; metadata: Record<string, unknown> }>(
    `select event_type, description, metadata from public.activity_log
     where property_id = $1 and source = $2 order by occurred_at desc`,
    [propertyId, AGENT_JOURNAL_SOURCE],
  );
  return r.rows;
}

// ─── The events, produced by the real triggers ──────────────────────────────

/**
 * Drive every source table whose failure the companion watches, and let the
 * 0228 triggers write whatever they write.
 *
 * Nothing here touches `activity_log`. Every row in it after this runs was
 * composed by a trigger, which is the entire point of the file.
 */
async function produceRealEvents(propertyId: string): Promise<void> {
  const r = nextRun();
  const wo = `WO-${r.key}`;
  await pg.query(
    `insert into public.pms_work_orders_v2
       (property_id, pms_work_order_id, room_number, description, status, ingest_run_id)
     values ($1, $2, '214', 'Bathroom fan not working', 'open', $3)`,
    [propertyId, wo, ingestRunId],
  );
  // open -> resolved -> open is a REOPEN, which is a different and worse fact
  // than the original break.
  await pg.query(`update public.pms_work_orders_v2 set status = 'resolved' where pms_work_order_id = $1`, [wo]);
  await pg.query(`update public.pms_work_orders_v2 set status = 'open' where pms_work_order_id = $1`, [wo]);
  await pg.query(`update public.pms_work_orders_v2 set status = 'deferred' where pms_work_order_id = $1`, [wo]);

  const inspectionId = r.id(2);
  await pg.query(
    `insert into public.inspections (id, property_id, room_number, result)
     values ($1, $2, '305', 'in_progress')`,
    [inspectionId, propertyId],
  );
  await pg.query(
    `update public.inspections set result = 'fail', failed_items = '[{"item":"bathroom"}]'::jsonb,
       completed_at = now() where id = $1`,
    [inspectionId],
  );

  const flagged = r.id(3);
  await pg.query(
    `insert into public.cleaning_events
       (id, property_id, date, room_number, room_type, staff_name, started_at, completed_at, duration_minutes, status)
     values ($1, $2, current_date, '118', 'checkout', 'Ana', now() - interval '2 hours', now(), 95, 'flagged')`,
    [flagged, propertyId],
  );
  await pg.query(
    `update public.cleaning_events set status = 'rejected', reviewed_at = now() where id = $1`,
    [flagged],
  );
  await pg.query(
    `insert into public.cleaning_events
       (id, property_id, date, room_number, room_type, staff_name, started_at, completed_at, duration_minutes, status)
     values ($1, $2, current_date, '119', 'checkout', 'Ana', now() - interval '2 minutes', now(), 2, 'discarded')`,
    [r.id(4), propertyId],
  );

  const task = r.id(5);
  await pg.query(
    `insert into public.cleaning_tasks
       (id, property_id, room_number, business_date, dedupe_key, cleaning_type, status)
     values ($1, $2, $3, current_date, $4, 'departure', 'in_progress')`,
    [task, propertyId, r.room(1), r.key],
  );
  await pg.query(`update public.cleaning_tasks set status = 'inspected_fail' where id = $1`, [task]);
  await pg.query(`update public.cleaning_tasks set status = 'correction_pending' where id = $1`, [task]);

  const staff = await pg.query<{ id: string }>(
    'select id from public.staff where property_id = $1 limit 1', [propertyId],
  );
  if (staff.rows[0]) {
    await pg.query(
      `insert into public.callout_events (property_id, staff_id, business_date, reported_by, reason)
       values ($1, $2, current_date, 'manager', 'sick')`,
      [propertyId, staff.rows[0].id],
    );
  }
}

/** Everything the routine hotel day writes, none of which is news. */
async function produceRoutineEvents(propertyId: string): Promise<void> {
  const r = nextRun();
  await pg.query(
    `insert into public.pms_room_status_log (property_id, room_number, status, source, ingest_run_id)
     values ($1, '210', 'vacant_dirty', 'cua', $2), ($1, '211', 'vacant_clean', 'cua', $2)`,
    [propertyId, ingestRunId],
  );
  const task = r.id(6);
  await pg.query(
    `insert into public.cleaning_tasks
       (id, property_id, room_number, business_date, dedupe_key, cleaning_type, status)
     values ($1, $2, $3, current_date, $4, 'departure', 'in_progress')`,
    [task, propertyId, r.room(5), r.key],
  );
  await pg.query(`update public.cleaning_tasks set status = 'completed' where id = $1`, [task]);
  await pg.query(
    `insert into public.cleaning_events
       (id, property_id, date, room_number, room_type, staff_name, started_at, completed_at, duration_minutes, status)
     values ($1, $2, current_date, '501', 'checkout', 'Ana', now() - interval '30 minutes', now(), 28, 'recorded')`,
    [r.id(7), propertyId],
  );
}

// ═══════════════════════════════════════════════════════════════════════════

describe('the companion wakes on events, not on a clock', () => {
  before(async () => {
    const migrated = await applyMigrationsToPglite();
    pg = migrated.pg;
    catalog = await loadCatalog(pg);
    await seedTwoHotels(pg, catalog);
    shim = createPglitePostgrest(pg, catalog);
    // @ts-expect-error installing the pglite-backed client on the singleton
    supabaseAdmin.from = shim.from;
    // @ts-expect-error installing the pglite-backed client on the singleton
    supabaseAdmin.rpc = shim.rpc;

    const run = await pg.query<{ id: string }>('select id from public.pms_ingest_runs limit 1');
    ingestRunId = run.rows[0].id;

    // Hotel B is the demo hotel for the discovery test.
    await pg.query('update public.properties set is_test = true where id = $1', [PID_B]);
    await pg.query('update public.properties set is_test = false where id = $1', [PID_A]);
  });

  after(async () => {
    supabaseAdmin.from = originalFrom;
    supabaseAdmin.rpc = originalRpc;
    // The WASM backend exits the process with status 100 if it is still open
    // when the event loop drains, which turns a green run red.
    await pg?.close();
  });

  beforeEach(async () => {
    await clearActivity();
    await pg.query('delete from public.companion_event_wake_state');
    await pg.query('delete from public.findings_ai_spend');
    // The source tables carry real uniqueness guards, most sharply "one open
    // callout per person per day". Clearing between tests is what lets each one
    // drive the same shapes without fighting a constraint that is correct.
    await pg.query('delete from public.callout_events');
    shim.reset();
  });

  // ═══ 1. THE SET IS REAL ═════════════════════════════════════════════════
  test('every event type the gate watches is one a real trigger really writes', async () => {
    await produceRealEvents(PID_A);
    const rows = await pg.query<{ event_type: string }>(
      'select distinct event_type from public.activity_log where property_id = $1', [PID_A],
    );
    const written = new Set(rows.rows.map((r) => r.event_type));

    const missing = INTERESTING_EVENT_TYPES.filter((type) => !written.has(type));
    assert.deepEqual(
      missing,
      [],
      'the gate watches for an event type that no trigger in this schema produces, '
      + 'which is a watcher that can never fire',
    );
  });

  test('the routine hotel day writes plenty and none of it is on the list', async () => {
    await produceRoutineEvents(PID_A);
    const rows = await pg.query<{ event_type: string }>(
      'select distinct event_type from public.activity_log where property_id = $1', [PID_A],
    );
    assert.ok(rows.rows.length >= 3, 'the routine day should have written something');
    for (const row of rows.rows) {
      assert.equal(
        INTERESTING_EVENT_TYPES.includes(row.event_type),
        false,
        `"${row.event_type}" is the hotel working and must not wake anybody`,
      );
    }
  });

  // ═══ 2. END TO END ══════════════════════════════════════════════════════
  test('a real failure becomes a prepared note, and the cursor moves past it', async () => {
    await setCursor(PID_A, 5);
    await produceRealEvents(PID_A);
    const before = await cursorOf(PID_A);

    const model = scriptedModel([
      '{"do":"note","say":"A work order on Room 214 was opened again after being resolved.","why":"repeat"}',
    ]);
    const summary = await sweepAllProperties({ modelClient: model.client });

    const a = summary.results.find((r) => r.propertyId === PID_A);
    assert.equal(a?.outcome, 'prepared', JSON.stringify(summary.results));
    assert.ok((a?.events ?? 0) > 0);
    assert.equal(model.calls, 1, 'exactly one bounded call per waking hotel');

    const after = await cursorOf(PID_A);
    assert.ok(
      Date.parse(after.last) > Date.parse(before.last),
      'the cursor must advance or the same events are paid for again in ten minutes',
    );
    assert.equal(after.wakes, 1);

    const journal = await journalRows(PID_A);
    assert.equal(journal.length, 1);
    assert.equal(journal[0].event_type, 'agent_noticed');
    assert.match(journal[0].description, /^Staxis noticed this and made a note to mention it:/);
    // The DOMINANT department, derived in code. produceRealEvents drives six
    // housekeeping failures and three maintenance ones, so the handle a "no
    // thank you" would attach to is the housekeeping one.
    assert.equal(journal[0].metadata.topic, 'wake:housekeeping');
    assert.match(String(journal[0].metadata.say), /Room 214/);
  });

  test('a quiet hotel costs one read, writes nothing, and still moves its cursor', async () => {
    await setCursor(PID_A, 5);
    await produceRoutineEvents(PID_A);
    const before = await cursorOf(PID_A);

    const model = scriptedModel([() => { throw new Error('the model must never be reached'); }]);
    const summary = await sweepAllProperties({ modelClient: model.client });

    assert.equal(summary.results.find((r) => r.propertyId === PID_A)?.outcome, 'quiet');
    assert.equal(model.calls, 0);
    assert.deepEqual(await journalRows(PID_A), [], 'a quiet sweep must leave no noise in the timeline');
    assert.ok(
      Date.parse((await cursorOf(PID_A)).last) > Date.parse(before.last),
      'a quiet hotel that never advanced would re-read a widening window forever',
    );
  });

  // ═══ 3. THE LOOP THAT MUST NOT EXIST ════════════════════════════════════
  test('the note it just wrote does not wake it again', async () => {
    await setCursor(PID_A, 5);
    await produceRealEvents(PID_A);
    const first = scriptedModel([
      '{"do":"note","say":"A work order on Room 214 was opened again.","why":"repeat"}',
    ]);
    await sweepAllProperties({ modelClient: first.client });
    assert.equal(first.calls, 1);
    assert.equal((await journalRows(PID_A)).length, 1);

    // Nothing new happens at the hotel: every trigger-written row is cleared.
    // The companion's own journal entry stays, and is moved to strictly AFTER
    // the cursor so it lands inside the next window. That is the adversarial
    // shape, and it is not hypothetical: the journal row is written by the same
    // sweep, into the same table, on the same index.
    await pg.query(
      `delete from public.activity_log where property_id = $1 and source <> $2`,
      [PID_A, AGENT_JOURNAL_SOURCE],
    );
    await pg.query(
      `update public.activity_log set occurred_at = now()
       where property_id = $1 and source = $2`, [PID_A, AGENT_JOURNAL_SOURCE],
    );
    const cursorNow = await cursorOf(PID_A);
    assert.ok(
      (await pg.query<{ n: number }>(
        `select count(*)::int as n from public.activity_log
         where property_id = $1 and occurred_at > $2`, [PID_A, cursorNow.last],
      )).rows[0].n === 1,
      'the setup must actually put the companion\'s own row inside the next window',
    );
    const second = scriptedModel([() => { throw new Error('self-excitation: it woke on its own journal'); }]);
    const summary = await sweepAllProperties({ modelClient: second.client });

    assert.equal(summary.results.find((r) => r.propertyId === PID_A)?.outcome, 'quiet');
    assert.equal(second.calls, 0, 'the companion must never pay to react to itself');
    assert.equal((await journalRows(PID_A)).length, 1, 'and must not write a second row about it');
  });

  // ═══ 4. THE HOTELS THAT SIT OUT ═════════════════════════════════════════
  test('a demo hotel is never swept on the schedule, and is swept when an operator names it', async () => {
    await setCursor(PID_A, 5);
    await setCursor(PID_B, 5);
    await produceRealEvents(PID_B);

    const scheduled = scriptedModel(['{"do":"nothing","say":"","why":"x"}']);
    const summary = await sweepAllProperties({ modelClient: scheduled.client });
    assert.equal(
      summary.results.some((r) => r.propertyId === PID_B), false,
      'the seeded demo hotel must not cost real money on the schedule',
    );
    assert.equal(summary.results.some((r) => r.propertyId === PID_A), true);

    // Naming it is an operator's deliberate act.
    const named = scriptedModel(['{"do":"nothing","say":"","why":"x"}']);
    const scoped = await sweepAllProperties({ modelClient: named.client, propertyId: PID_B });
    assert.deepEqual(scoped.results.map((r) => r.propertyId), [PID_B]);
    assert.equal(named.calls, 1);
  });

  test('a hotel that switched a section off is not interrupted about that section', async () => {
    await setCursor(PID_A, 5);
    await pg.query(
      `update public.properties set enabled_sections = '{"housekeeping": false, "maintenance": false, "staff": false}'::jsonb
       where id = $1`, [PID_A],
    );
    await produceRealEvents(PID_A);
    const model = scriptedModel([() => { throw new Error('a switched-off section must not wake anybody'); }]);
    const summary = await sweepAllProperties({ modelClient: model.client });
    assert.equal(summary.results.find((r) => r.propertyId === PID_A)?.outcome, 'quiet');
    assert.equal(model.calls, 0);
    await pg.query(`update public.properties set enabled_sections = '{}'::jsonb where id = $1`, [PID_A]);
  });

  // ═══ THE DOCTOR'S PREDICATE, WHICH IS THE ACTUAL CONTRACT ═══════════════
  //
  // `companion_event_wake_health` warns when a cursor has not moved in thirty
  // minutes. These two tests pin both halves of what that warning is allowed to
  // mean, and they are a pair on purpose: the first alone could be satisfied by
  // claiming the window unconditionally at the top of the sweep, which would
  // silently discard events on any failed read. The second is what stops that.
  const THIRTY_MINUTES_MS = 30 * 60_000;

  async function staleByTheDoctorsRule(propertyId: string): Promise<boolean> {
    const r = await pg.query<{ n: number }>(
      `select count(*)::int as n from public.companion_event_wake_state
       where property_id = $1 and last_looked_at < now() - interval '30 minutes'`,
      [propertyId],
    );
    return r.rows[0].n > 0;
  }

  test('a hotel that switched the Staxis list off is still LOOKED at, so it never goes stale', async () => {
    // ─── THE PRODUCTION BUG, PINNED ───────────────────────────────────────
    // Home2 (b19f5a42) had exactly this configuration. The sweep returned at
    // the Staxis gate before claiming, so its cursor never moved, looks_total
    // sat at 0 while six sibling hotels reached 5, and the doctor reported it
    // stale for the rest of time. A hotel that is skipped on purpose is not a
    // hotel nobody is watching, and the doctor cannot tell the difference from
    // the cursor alone, so the runner has to.
    await pg.query(
      `update public.properties set enabled_sections = '{"staxis": false}'::jsonb where id = $1`,
      [PID_A],
    );
    try {
      // A cursor already old enough that the doctor would flag it. The fix has
      // to bring it back, not merely stop making it worse.
      await pg.query(
        `insert into public.companion_event_wake_state (property_id, last_looked_at, looks_total)
         values ($1, now() - interval '90 minutes', 0)
         on conflict (property_id) do update
           set last_looked_at = excluded.last_looked_at, looks_total = 0`,
        [PID_A],
      );
      assert.equal(await staleByTheDoctorsRule(PID_A), true, 'the setup must start from the broken state');
      await produceRealEvents(PID_A);

      const model = scriptedModel([() => { throw new Error('a switched-off list must never reach a model'); }]);
      const summary = await sweepAllProperties({ modelClient: model.client });
      const a = summary.results.find((r) => r.propertyId === PID_A);

      // Counted under its own name, not hidden inside "quiet". They are
      // different facts and only one of them is about the hotel's data.
      assert.equal(a?.outcome, 'list_switched_off', JSON.stringify(summary.results));
      assert.equal(model.calls, 0, 'zero model cost for a hotel with the list off');
      assert.deepEqual(await journalRows(PID_A), [], 'and nothing written to its timeline');

      const after = await cursorOf(PID_A);
      assert.ok(
        Date.now() - Date.parse(after.last) < THIRTY_MINUTES_MS,
        `the cursor did not advance: the doctor would call this hotel stale forever (${after.last})`,
      );
      assert.equal(
        await staleByTheDoctorsRule(PID_A), false,
        'the runner and the doctor must agree on what a moving cursor means',
      );
      // The one write that proves a look happened. This is the field that read
      // 0 in production while every other hotel read 5.
      assert.equal(after.looks, 1, 'a look that found nothing deliverable is still a look');
    } finally {
      await pg.query(`update public.properties set enabled_sections = '{}'::jsonb where id = $1`, [PID_A]);
    }
  });

  test('a hotel whose events could not be READ does not advance, so staleness stays a true signal', async () => {
    // The other half of the contract, and the guard against over-correcting the
    // test above. "Claim the window at the top of the sweep" would make every
    // hotel non-stale forever and would throw away events nobody ever read.
    await setCursor(PID_A, 5);
    await produceRealEvents(PID_A);
    const before = await cursorOf(PID_A);

    // One failing read of the event stream, and only that read.
    const shimFrom = supabaseAdmin.from.bind(supabaseAdmin);
    const broken = { message: 'activity_log read exploded', code: '57014' };
    const failingBuilder: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'gt', 'lte', 'neq', 'in', 'order', 'limit']) {
      failingBuilder[method] = () => failingBuilder;
    }
    failingBuilder.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: broken });
    // @ts-expect-error narrowing one table's reads to a failing builder
    supabaseAdmin.from = (table: string) => (
      table === 'activity_log' ? failingBuilder : shimFrom(table)
    );

    let summary;
    try {
      const model = scriptedModel([() => { throw new Error('a failed read must never reach a model'); }]);
      summary = await sweepAllProperties({ modelClient: model.client });
      assert.equal(model.calls, 0);
    } finally {
      supabaseAdmin.from = shimFrom;
    }

    assert.equal(summary.results.find((r) => r.propertyId === PID_A)?.outcome, 'read_failed');
    assert.equal(
      (await cursorOf(PID_A)).last, before.last,
      'claiming a window whose events never came back would discard them silently',
    );
    assert.equal((await cursorOf(PID_A)).looks, before.looks, 'a failed read is not a look');
  });

  test('a switched-off feature stops the whole sweep before any hotel is read', async () => {
    await setCursor(PID_A, 5);
    await produceRealEvents(PID_A);
    await pg.query(
      `insert into public.ai_feature_config_versions
         (feature_key, version, enabled, primary_provider, primary_model_id,
          validation_status, validated_at, is_active)
       values ('companion.event_wake', 1, false, 'anthropic', 'claude-haiku-4-5',
               'passed', now(), true)`,
    );
    // The store caches active configs for fifteen seconds, and a test that
    // wrote a switch nobody re-read would pass for the wrong reason.
    invalidateAiFeatureConfigCache();
    try {
      const model = scriptedModel([() => { throw new Error('a switched-off feature must not call a model'); }]);
      const summary = await sweepAllProperties({ modelClient: model.client });
      assert.equal(summary.switchedOff, true);
      assert.deepEqual(summary.results, []);
      assert.equal(model.calls, 0);
      assert.deepEqual(await journalRows(PID_A), []);
    } finally {
      // The config history is append-only in Postgres (0313), so the row is
      // retired rather than removed, exactly as the admin surface would do it.
      await pg.query(
        `update public.ai_feature_config_versions set is_active = false
         where feature_key = 'companion.event_wake'`,
      );
      invalidateAiFeatureConfigCache();
    }
  });

  // ═══ 5. TWO SWEEPS, ONE WINDOW ══════════════════════════════════════════
  test('two overlapping sweeps cannot both claim the same events', async () => {
    await setCursor(PID_A, 5);
    const state = await readWakeState(PID_A, new Date());
    assert.equal(state.ok, true);
    if (!state.ok) return;

    const args = {
      propertyId: PID_A,
      priorLastLookedAt: state.state.lastLookedAt,
      priorLooksTotal: state.state.looksTotal,
      untilIso: new Date().toISOString(),
      now: new Date(),
    };
    assert.equal(await claimWakeWindow(args), true, 'the first sweep claims the window');
    assert.equal(
      await claimWakeWindow(args), false,
      'the second sweep read the same cursor and must be told it lost',
    );
  });

  test('a hotel seen for the first time gets a cursor and does not wake on its whole history', async () => {
    await produceRealEvents(PID_A);
    const model = scriptedModel([() => { throw new Error('a first look must not wake on all of history'); }]);
    const summary = await sweepAllProperties({ modelClient: model.client });
    assert.equal(summary.results.find((r) => r.propertyId === PID_A)?.outcome, 'quiet');
    assert.equal(model.calls, 0);
    const cursor = await cursorOf(PID_A);
    assert.ok(cursor.last.length > 0, 'the first look must leave a cursor behind');
  });

  // ═══ 6. THE NOTE STILL HAS TO GET PAST THE MANNERS ══════════════════════
  test('a prepared note reaches the companion as an ordinary candidate, with no privileges', async () => {
    await setCursor(PID_A, 5);
    await produceRealEvents(PID_A);
    const model = scriptedModel([
      '{"do":"note","say":"A work order on Room 214 was opened again after being resolved.","why":"repeat"}',
    ]);
    await sweepAllProperties({ modelClient: model.client });

    const account = await pg.query<{ id: string }>('select id from public.accounts limit 1');
    const today = new Date().toISOString().slice(0, 10);
    const candidates = await buildCompanionCandidates({
      propertyId: PID_A,
      role: 'general_manager',
      hotelMutationAllowed: true,
      accountId: account.rows[0].id,
      today,
      timezone: null,
    });

    const noticed = candidates.find((c) => c.topic === 'wake:housekeeping');
    assert.ok(noticed, `the prepared note never reached the companion: ${JSON.stringify(candidates)}`);
    assert.match(noticed.text, /Room 214/);
    assert.equal(noticed.sensitivity, 'operational');
    assert.equal(noticed.destination, 'staxis');

    const settled: CompanionMemory = {
      ...EMPTY_COMPANION_MEMORY,
      welcomedAt: '2026-01-01T00:00:00.000Z',
      tourDeclined: true,
    };
    const manners = (memory: CompanionMemory) => decideCompanionSpeech({
      now: new Date(),
      today,
      person: { firstName: 'Maria', role: 'general_manager', sharedLogin: false },
      memory,
      candidates: [noticed],
      onScreen: [],
      userIsBusy: false,
      quietThisSession: false,
      aiAwake: true,
      wizardAlreadyRan: true,
      multiHotel: false,
      hotelName: 'Comfort Suites',
    });

    // It is offerable.
    const offer = manners(settled);
    assert.equal(offer.kind, 'offer');
    assert.equal(offer.kind === 'offer' && offer.topic, 'wake:housekeeping');

    // A No is a No, and twice is forever. Nothing about being fresh exempts it.
    let declined = settled;
    for (let i = 0; i < COMPANION_DECLINES_BEFORE_DROP; i += 1) {
      declined = rememberDeclined(declined, 'wake:housekeeping', today);
    }
    assert.deepEqual(manners(declined), { kind: 'silent', reason: 'nothing_to_say' });

    // And it spends the same daily budget as everything else the companion
    // volunteers. A watcher that could talk past the budget would be the budget
    // quietly ending.
    let spent = settled;
    for (let i = 0; i < COMPANION_MAX_SPEECH_PER_DAY; i += 1) {
      spent = rememberSpoke(spent, `other:${i}`, new Date(), today);
    }
    assert.deepEqual(manners(spent), { kind: 'silent', reason: 'daily_cap_reached' });
  });

  test('an observation is written down and is never offered to anybody', async () => {
    await setCursor(PID_A, 5);
    await produceRealEvents(PID_A);
    const model = scriptedModel([
      '{"do":"observe","say":"Room 214 has come back twice today.","why":"worth remembering"}',
    ]);
    const summary = await sweepAllProperties({ modelClient: model.client });
    assert.equal(summary.results.find((r) => r.propertyId === PID_A)?.outcome, 'observed');

    const journal = await journalRows(PID_A);
    assert.equal(journal.length, 1);
    assert.match(journal[0].description, /^Staxis noticed this and wrote it down:/);
    assert.equal(journal[0].metadata.say, undefined,
      'an observation carrying a sayable sentence could become an interruption by accident');

    const account = await pg.query<{ id: string }>('select id from public.accounts limit 1');
    const candidates = await buildCompanionCandidates({
      propertyId: PID_A,
      role: 'general_manager',
      hotelMutationAllowed: true,
      accountId: account.rows[0].id,
      today: new Date().toISOString().slice(0, 10),
      timezone: null,
    });
    assert.equal(
      candidates.some((c) => c.topic.startsWith('wake:')), false,
      'an observation must never reach the companion as something to say',
    );
  });

  test('a later observation does not swallow an earlier note', async () => {
    // Both halves are the same event type, and only one of them carries a
    // sentence. Taking "the newest row" blindly means an observation written at
    // 3pm silently eats a real note from 2pm and the person never hears it.
    await setCursor(PID_A, 5);
    await produceRealEvents(PID_A);
    const noteRun = scriptedModel([
      '{"do":"note","say":"A work order on Room 214 was opened again.","why":"repeat"}',
    ]);
    await sweepAllProperties({ modelClient: noteRun.client });

    await pg.query(
      `update public.companion_event_wake_state
       set last_looked_at = now() - interval '5 minutes', wakes_today = 0 where property_id = $1`,
      [PID_A],
    );
    // A second round of failures at the same hotel on the same day. The callout
    // has to go first: one open callout per person per day is a real constraint
    // and the per-test cleanup only runs between tests, not within one.
    await pg.query('delete from public.callout_events');
    await produceRealEvents(PID_A);
    const observeRun = scriptedModel([
      '{"do":"observe","say":"Room 214 keeps coming back.","why":"pattern"}',
    ]);
    await sweepAllProperties({ modelClient: observeRun.client });
    assert.equal((await journalRows(PID_A)).length, 2);

    const account = await pg.query<{ id: string }>('select id from public.accounts limit 1');
    const candidates = await buildCompanionCandidates({
      propertyId: PID_A,
      role: 'general_manager',
      hotelMutationAllowed: true,
      accountId: account.rows[0].id,
      today: new Date().toISOString().slice(0, 10),
      timezone: null,
    });
    const noticed = candidates.find((c) => c.topic.startsWith('wake:'));
    assert.ok(noticed, 'the note was swallowed by the observation written after it');
    assert.match(noticed.text, /opened again/);
    assert.doesNotMatch(noticed.text, /keeps coming back/,
      'an observation must never reach the companion as something to say');
  });

  test('a model that dies leaves the hotel silent, the cursor moved, and the sweep standing', async () => {
    await setCursor(PID_A, 5);
    await produceRealEvents(PID_A);
    const model = scriptedModel([() => { throw new Error('provider exploded'); }]);
    const summary = await sweepAllProperties({ modelClient: model.client });

    assert.equal(summary.results.find((r) => r.propertyId === PID_A)?.outcome, 'model_unavailable');
    assert.deepEqual(await journalRows(PID_A), []);
    // The window is still spent. Losing one wake is the right direction to
    // lose in; re-firing on the same events every ten minutes is not.
    assert.equal((await cursorOf(PID_A)).wakes, 1);
  });

  test('a hotel that has woken enough today stops costing money, and says so', async () => {
    await setCursor(PID_A, 5);
    // The counter is HOTEL-LOCAL. Written as the day the sweep will compute for
    // itself, so this proves the wiring between the stored day and the clock
    // rather than just the pure gate.
    await pg.query(
      `update public.companion_event_wake_state
       set wakes_day = to_char(now(), 'YYYY-MM-DD'), wakes_today = $2
       where property_id = $1`,
      [PID_A, String(MAX_WAKES_PER_DAY)],
    );
    await produceRealEvents(PID_A);

    const model = scriptedModel([() => { throw new Error('the daily wake ceiling did not hold'); }]);
    const summary = await sweepAllProperties({ modelClient: model.client });
    const a = summary.results.find((r) => r.propertyId === PID_A);

    assert.equal(a?.outcome, 'daily_wake_cap');
    // LOUD, not silent: the events were counted and reported even though
    // nothing was spent on them, which is what lets an operator tell a hotel
    // being held back from a hotel with nothing going on.
    assert.ok((a?.events ?? 0) > 0, 'a capped hotel must still report what it saw');
    assert.equal(model.calls, 0);
    assert.deepEqual(await journalRows(PID_A), []);
  });

  test('yesterday\'s wake count does not hold today back', async () => {
    await setCursor(PID_A, 5);
    await pg.query(
      `update public.companion_event_wake_state
       set wakes_day = to_char(now() - interval '1 day', 'YYYY-MM-DD'), wakes_today = $2
       where property_id = $1`,
      [PID_A, String(MAX_WAKES_PER_DAY + 5)],
    );
    await produceRealEvents(PID_A);
    const model = scriptedModel(['{"do":"nothing","say":"","why":"ordinary"}']);
    const summary = await sweepAllProperties({ modelClient: model.client });
    assert.equal(summary.results.find((r) => r.propertyId === PID_A)?.outcome, 'nothing');
    assert.equal(model.calls, 1);
    assert.equal((await cursorOf(PID_A)).wakes, 1, 'a new day resets the counter rather than adding to it');
  });

  test('the shim never silently skipped a builder feature this file relies on', () => {
    assert.deepEqual(shim.unsupported, []);
  });
});
