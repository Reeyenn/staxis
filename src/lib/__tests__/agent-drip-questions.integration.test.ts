/**
 * Drip questions — the whole loop, against a REAL Postgres holding TWO hotels.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE UNIT SUITE
 * `agent-drip-questions.test.ts` proves the never-ask-twice POLICY against
 * in-memory inputs. It cannot prove that the policy is reached with the right
 * inputs: that the ledger read is scoped to one hotel, that serving a question
 * actually writes the ask down, or that a "yes" lands in agent_memory as a
 * human-authored fact rather than another expiring guess. Those are properties
 * of real SQL against the real schema, so this file applies the production
 * migrations to PGlite, seeds two hotels, and drives the real functions.
 *
 * THE LEAK IT HUNTS
 * Hotel B's complaints are deliberately LOUDER than hotel A's — 5 on room 999
 * versus 3 on room 101. A missing `property_id` filter anywhere in the read
 * path would therefore not merely leak: it would change the ANSWER, and hotel A
 * would be asked about a room that does not exist in their building.
 *
 * NOTE ON RLS: PGlite runs as the table owner, exactly as the service-role key
 * bypasses policies in production. The boundary under test is app code.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';

import { getDripQuestion, answerDripQuestion } from '@/lib/agent/drip-questions';
import { loadManagerCaller, managerManagesHotel } from '@/lib/team-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import { createPglitePostgrest, loadCatalog, type PglitePostgrest } from '../../../tests/fixtures/postgrest-pglite';

const UID = 'aaaaaaaa-0000-4000-8000-0000000000f1';
/** A: answers "yes". B: the other hotel, and the decline path. */
const PID_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const PID_B = 'bbbbbbbb-0000-4000-8000-000000000001';
/** C: ignores the question. D: a brand-new hotel with no history at all. */
const PID_C = 'cccccccc-0000-4000-8000-000000000001';
const PID_D = 'dddddddd-0000-4000-8000-000000000001';
const ACCOUNT = 'aaaaaaaa-0000-4000-8000-0000000000f2';

const ROOM_A = '101';
const ROOM_B = '999';
const ROOM_C = '404';

const DAY = 86_400_000;

/**
 * A recent timestamp that is NOT Fri/Sat/Sun in UTC. The weekend-noise-by-floor
 * detector keys on UTC day-of-week; pinning to a weekday keeps each hotel to
 * exactly ONE signal so the assertions below are about selection, not luck.
 */
function recentWeekday(daysBack: number): string {
  const d = new Date(Date.now() - daysBack * DAY);
  while ([0, 5, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString();
}

let pg: PGlite;
let shim: PglitePostgrest;
const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);

async function seedComplaints(propertyId: string, room: string, howMany: number) {
  for (let i = 0; i < howMany; i += 1) {
    await pg.query(
      `insert into complaints (property_id, room_number, category, severity, description, created_at)
       values ($1, $2, 'noise', 'low', $3, $4)`,
      [propertyId, room, `seeded complaint ${i} for ${propertyId}`, recentWeekday(3 + i)],
    );
  }
}

async function memoryRows(propertyId: string) {
  const r = await pg.query<{
    topic: string; content: string; source: string; confidence: string;
    expires_at: string | null; created_by_name: string | null; is_active: boolean;
  }>(
    `select topic, content, source, confidence, expires_at, created_by_name, is_active
       from agent_memory where property_id = $1`,
    [propertyId],
  );
  return r.rows;
}

async function ledgerRows(propertyId: string) {
  const r = await pg.query<{ topic: string; status: string; ask_count: number; last_asked_on: string }>(
    `select topic, status, ask_count, last_asked_on::text as last_asked_on
       from agent_knowledge_questions where property_id = $1`,
    [propertyId],
  );
  return r.rows;
}

describe('drip questions — the whole loop against a real two-hotel database', () => {
  before(async () => {
    const migrated = await applyMigrationsToPglite();
    pg = migrated.pg;
    const catalog = await loadCatalog(pg);
    shim = createPglitePostgrest(pg, catalog);

    await pg.query(`insert into auth.users (id, email) values ($1, 'gm@test') on conflict (id) do nothing`, [UID]);
    for (const [pid, name] of [
      [PID_A, 'Hotel A'], [PID_B, 'Hotel B'], [PID_C, 'Hotel C'], [PID_D, 'Hotel D'],
    ] as const) {
      await pg.query(
        `insert into properties (id, name, owner_id, total_rooms, timezone)
         values ($1, $2, $3, 50, 'America/Chicago') on conflict (id) do nothing`,
        [pid, name, UID],
      );
    }
    await pg.query(
      `insert into accounts (id, username, password_hash, display_name, role, property_access, data_user_id)
       values ($1, 'gm', 'x', 'Dana the GM', 'general_manager', $2, $3) on conflict (id) do nothing`,
      [ACCOUNT, `{${PID_A},${PID_B},${PID_C},${PID_D}}`, UID],
    );

    // Hotel B is LOUDER than hotel A on purpose — see the header.
    await seedComplaints(PID_A, ROOM_A, 3);
    await seedComplaints(PID_B, ROOM_B, 5);
    await seedComplaints(PID_C, ROOM_C, 4);
    // Hotel D gets nothing at all. Day zero.

    // @ts-expect-error installing the pglite-backed client on the singleton
    supabaseAdmin.from = shim.from;
    // @ts-expect-error installing the pglite-backed client on the singleton
    supabaseAdmin.rpc = shim.rpc;
  });

  after(async () => {
    supabaseAdmin.from = originalFrom;
    supabaseAdmin.rpc = originalRpc;
    // The WASM backend exits the process with status 100 if it is still open
    // when the event loop drains, which turns a green run red.
    await pg?.close().catch(() => undefined);
  });

  // ── who the route thinks is asking ────────────────────────────────────────
  //
  // This shipped broken once: the route's account lookup asked for a column
  // (`accounts.name`) that does not exist. PostgREST errors on an unknown
  // column, the route read that as "no such account", and EVERY manager
  // silently got no card — a green build, a green unit suite, and a dead
  // feature. Only the real schema can catch that, so it is pinned here.

  test('the manager behind a session is resolved against the REAL accounts schema', async () => {
    const caller = await loadManagerCaller(UID);
    assert.ok(caller, 'a general_manager with an account row must resolve');
    assert.equal(caller.accountId, ACCOUNT);
    assert.equal(caller.role, 'general_manager');
    assert.equal(caller.displayName, 'Dana the GM', 'the name shown on a fact they authored');
    assert.ok(managerManagesHotel(caller, PID_A));
  });

  test('a manager who does not have the hotel cannot be handed its question', async () => {
    const caller = await loadManagerCaller(UID);
    assert.ok(caller);
    assert.equal(
      managerManagesHotel({ ...caller, propertyAccess: [PID_B] }, PID_A),
      false,
      'access to hotel B is not access to hotel A',
    );
  });

  test('a housekeeper is never asked, and an unknown session resolves to nobody', async () => {
    const hkUid = 'aaaaaaaa-0000-4000-8000-0000000000f3';
    await pg.query(`insert into auth.users (id, email) values ($1, 'hk@test') on conflict (id) do nothing`, [hkUid]);
    await pg.query(
      `insert into accounts (id, username, password_hash, display_name, role, property_access, data_user_id)
       values (gen_random_uuid(), 'maria', 'x', 'Maria', 'housekeeping', $1, $2)`,
      [`{${PID_A}}`, hkUid],
    );
    assert.equal(await loadManagerCaller(hkUid), null, 'this card is not for the floor');
    assert.equal(
      await loadManagerCaller('aaaaaaaa-0000-4000-8000-00000000ffff'),
      null,
      'an unknown session resolves to nobody',
    );
  });

  // ── day zero ──────────────────────────────────────────────────────────────

  test('a brand-new hotel with no history is asked nothing, and nothing is recorded', async () => {
    assert.equal(await getDripQuestion(PID_D), null, 'never invent a question');
    assert.deepEqual(await ledgerRows(PID_D), [], 'no signal means no ledger row either');
  });

  // ── cross-property isolation ──────────────────────────────────────────────

  test('hotel A is asked about ITS room, never hotel B\'s louder one', async () => {
    const q = await getDripQuestion(PID_A);
    assert.ok(q, 'hotel A has a real pattern and should be asked about it');
    for (const text of [q.en, q.es, q.topic]) {
      assert.ok(text.includes(ROOM_A), `should name room ${ROOM_A}: ${text}`);
      assert.ok(!text.includes(ROOM_B), `must never name hotel B's room ${ROOM_B}: ${text}`);
      assert.ok(!text.includes(PID_B), `must never carry hotel B's id: ${text}`);
    }
    // The count is hotel A's three, not hotel B's five.
    assert.ok(q.en.includes('3'), `hotel A's own count: ${q.en}`);
    assert.ok(!q.en.includes('5 '), `hotel B's count must not appear: ${q.en}`);
  });

  test('hotel B is asked about its OWN room', async () => {
    const q = await getDripQuestion(PID_B);
    assert.ok(q);
    assert.ok(q.en.includes(ROOM_B));
    assert.ok(!q.en.includes(ROOM_A));
  });

  test('serving a question writes the ask down for that hotel only', async () => {
    const a = await ledgerRows(PID_A);
    const b = await ledgerRows(PID_B);
    assert.equal(a.length, 1, 'one ledger row for hotel A');
    assert.equal(b.length, 1, 'one ledger row for hotel B');
    assert.notEqual(a[0].topic, b[0].topic, 'each hotel has its own topic');
    assert.equal(a[0].status, 'asked');
    assert.equal(a[0].ask_count, 1);
  });

  // ── the same-day guard ────────────────────────────────────────────────────

  test('an IGNORED question does not come back the same day', async () => {
    const first = await getDripQuestion(PID_C);
    assert.ok(first, 'hotel C has a pattern');
    assert.equal(await getDripQuestion(PID_C), null, 'asked already today — stay quiet');
    assert.equal(await getDripQuestion(PID_C), null, 'and on every subsequent page load');
    const rows = await ledgerRows(PID_C);
    assert.equal(rows.length, 1, 'repeat calls must not pile up ledger rows');
    assert.equal(rows[0].ask_count, 1, 'a refused ask is not counted as an ask');
  });

  test('the same ignored question may return on a later day, then stops for good', async () => {
    const tomorrow = new Date(Date.now() + DAY);
    const second = await getDripQuestion(PID_C, tomorrow);
    assert.ok(second, 'a new day is a fair second try');
    assert.equal((await ledgerRows(PID_C))[0].ask_count, 2);

    const third = await getDripQuestion(PID_C, new Date(Date.now() + 2 * DAY));
    assert.ok(third, 'third and final try');
    assert.equal((await ledgerRows(PID_C))[0].ask_count, 3);

    assert.equal(
      await getDripQuestion(PID_C, new Date(Date.now() + 3 * DAY)),
      null,
      'after three unanswered asks it is dropped for good',
    );
    assert.equal(
      await getDripQuestion(PID_C, new Date(Date.now() + 400 * DAY)),
      null,
      'and it never returns, ever',
    );
  });

  // ── "yes" → a human-authored fact ─────────────────────────────────────────

  test('a "yes" becomes a human-authored, non-expiring fact for that hotel alone', async () => {
    const topic = (await ledgerRows(PID_A))[0].topic;
    const res = await answerDripQuestion({
      propertyId: PID_A,
      topic,
      answer: 'yes',
      actor: { accountId: ACCOUNT, name: 'Dana the GM', role: 'general_manager' },
    });
    assert.equal(res.ok, true);
    assert.equal(res.recorded, true);
    assert.equal(res.storedFact, true);

    const rows = await memoryRows(PID_A);
    assert.equal(rows.length, 1, 'exactly one fact');
    const fact = rows[0];
    assert.equal(fact.topic, topic, 'stored under the SAME topic the auto-learner uses, so it upgrades that row');
    assert.equal(fact.source, 'explicit_user', 'a manager confirming is a human authoring, not the learner guessing');
    assert.equal(fact.confidence, 'high');
    assert.equal(fact.expires_at, null, 'a confirmed fact must stop expiring');
    assert.equal(fact.is_active, true);
    assert.equal(fact.created_by_name, 'Dana the GM');
    assert.ok(fact.content.includes(ROOM_A), `the fact must name the room: ${fact.content}`);
    assert.ok(!fact.content.includes(ROOM_B), 'and never hotel B\'s');

    assert.deepEqual(await memoryRows(PID_B), [], 'answering for hotel A wrote nothing for hotel B');
    assert.equal((await ledgerRows(PID_A))[0].status, 'answered_yes');
  });

  test('an ANSWERED question is never asked again, on any later day', async () => {
    assert.equal(await getDripQuestion(PID_A, new Date(Date.now() + DAY)), null);
    assert.equal(await getDripQuestion(PID_A, new Date(Date.now() + 90 * DAY)), null);
  });

  test('answering twice is idempotent — the fact is not rewritten', async () => {
    const topic = (await ledgerRows(PID_A))[0].topic;
    const before = (await memoryRows(PID_A))[0];
    const replay = await answerDripQuestion({
      propertyId: PID_A,
      topic,
      answer: 'no',
      actor: { accountId: ACCOUNT, name: 'Dana the GM', role: 'general_manager' },
    });
    assert.equal(replay.ok, true);
    assert.equal(replay.recorded, false, 'nothing was outstanding to answer');
    assert.equal((await ledgerRows(PID_A))[0].status, 'answered_yes', 'the verdict does not flip');
    assert.deepEqual((await memoryRows(PID_A))[0], before, 'the fact is untouched');
  });

  // ── "no" → a recorded decline, and no fact ────────────────────────────────

  test('a "no" records a decline, writes NO fact, and is never asked again', async () => {
    const topic = (await ledgerRows(PID_B))[0].topic;
    const res = await answerDripQuestion({
      propertyId: PID_B,
      topic,
      answer: 'no',
      actor: { accountId: ACCOUNT, name: 'Dana the GM', role: 'general_manager' },
    });
    assert.equal(res.ok, true);
    assert.equal(res.recorded, true);
    assert.equal(res.storedFact, false);

    assert.deepEqual(await memoryRows(PID_B), [], 'a decline is NOT a fact and must not be stored as one');
    assert.equal((await ledgerRows(PID_B))[0].status, 'declined');

    assert.equal(await getDripQuestion(PID_B, new Date(Date.now() + DAY)), null, 'not tomorrow');
    assert.equal(await getDripQuestion(PID_B, new Date(Date.now() + 365 * DAY)), null, 'not next year');
  });

  test('answering for a topic this hotel was never asked changes nothing', async () => {
    const res = await answerDripQuestion({
      propertyId: PID_D,
      topic: 'op_maint_214_hvac',
      answer: 'yes',
      actor: { accountId: ACCOUNT, name: 'Dana the GM', role: 'general_manager' },
    });
    assert.equal(res.ok, true);
    assert.equal(res.recorded, false);
    assert.deepEqual(await memoryRows(PID_D), [], 'a forged topic cannot mint a fact');
  });

  // ── a fact a human deleted is not re-asked ────────────────────────────────

  test('a topic whose fact a human deleted is never turned back into a question', async () => {
    // Hotel A's fact, deactivated the way the "What Staxis knows" Remove does.
    await pg.query(`update agent_memory set is_active = false where property_id = $1`, [PID_A]);
    // …and clear the ledger so ONLY the deactivation could keep it quiet.
    await pg.query(`delete from agent_knowledge_questions where property_id = $1`, [PID_A]);
    assert.equal(
      await getDripQuestion(PID_A, new Date(Date.now() + 5 * DAY)),
      null,
      'they removed it once; asking about it again is the same nag with a question mark',
    );
  });
});
