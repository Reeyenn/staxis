/**
 * PROOF, not assertion: the day-zero hotel-identity briefing is confined to one
 * hotel when a REAL query planner decides which rows come back.
 *
 * WHY A SECOND FILE RATHER THAN A UNIT TEST
 * `agent-hotel-identity.test.ts` drives the derivation through a hand-written
 * fake. The fake applies `.eq()` itself, so it can show a filter was requested
 * — it cannot show the filter WORKS against the real schema, and it cannot
 * notice that `properties` scopes on `id` while everything else scopes on
 * `property_id`. Get that mapping wrong and the fake still returns hotel A.
 *
 * This reuses the harness `agent-tool-tenant-isolation.integration.test.ts`
 * already stands up: production migrations applied to PGlite, two hotels seeded
 * from the resulting catalog, hotel B's rows deliberately reachable — every
 * hotel-B uuid starts `bbbbbbbb-` and every free-text column carries `ZZLEAKB`.
 * A forgotten filter therefore shows up as hotel B's marker inside the text the
 * copilot is about to be told is a fact about hotel A.
 *
 * The identity block sits in the CACHED half of the system prompt, so a leak
 * here would not be a one-off wrong answer — it would be the other hotel's
 * details pinned into every turn of every conversation until the memo expired.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';

import {
  deriveHotelIdentityUncached,
  formatHotelIdentityForPrompt,
  clearHotelIdentityCache,
  type HotelIdentity,
} from '@/lib/agent/hotel-identity';
import { supabaseAdmin } from '@/lib/supabase-admin';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import {
  createPglitePostgrest,
  loadCatalog,
  type Catalog,
  type PglitePostgrest,
  type RecordedStatement,
} from '../../../tests/fixtures/postgrest-pglite';
import {
  seedTwoHotels,
  LEAK_MARKER,
  PID_A,
  PID_B,
} from '../../../tests/fixtures/pglite-two-hotel-seed';

/** Anything from this list on hotel A's side of the wall is a leak. */
const LEAK_NEEDLES = ['bbbbbbbb-', LEAK_MARKER, PID_B];

function leaksIn(value: unknown): string[] {
  const text = JSON.stringify(value ?? null) ?? '';
  return LEAK_NEEDLES.filter(needle => text.includes(needle));
}

let pg: PGlite;
let catalog: Catalog;
let shim: PglitePostgrest;
let identityA: HotelIdentity | null;
let identityB: HotelIdentity | null;
let blockA: string | null;
/** Only the statements hotel A's derivation ran. */
let statementsA: RecordedStatement[] = [];

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);

describe("the hotel-identity briefing is one hotel's, proven against a real database", () => {
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

    clearHotelIdentityCache();
    shim.reset();
    identityA = await deriveHotelIdentityUncached(PID_A);
    blockA = formatHotelIdentityForPrompt(identityA);
    statementsA = [...shim.statements];

    // Hotel B is derived only to prove the fixture is genuinely two-sided.
    shim.reset();
    identityB = await deriveHotelIdentityUncached(PID_B);
  });

  after(async () => {
    supabaseAdmin.from = originalFrom;
    supabaseAdmin.rpc = originalRpc;
    clearHotelIdentityCache();
    // The WASM backend exits the process with status 100 if it is still open
    // when the event loop drains, which turns a green run red.
    await pg?.close();
  });

  test('the fixture really holds two hotels, so a leak has somewhere to come from', () => {
    assert.ok(identityA, 'hotel A must derive');
    assert.ok(identityB, 'hotel B must derive');
    // If hotel B carried no marker anywhere, every leak assertion below would
    // pass for the wrong reason. (Its NAME is deliberately identical to hotel
    // A's — the seeder gives lookup columns the same value on both sides so a
    // forgotten filter can still MATCH the other hotel's row.)
    assert.ok(leaksIn(identityB).length > 0,
      "hotel B's own identity must contain its markers, or this suite proves nothing");
    assert.ok(
      formatHotelIdentityForPrompt(identityB)?.includes(LEAK_MARKER),
      "and its rendered block must too, or the block-level check below is vacuous",
    );
  });

  test("nothing of hotel B's reaches hotel A's identity", () => {
    assert.deepEqual(leaksIn(identityA), []);
  });

  test("nor the rendered block the model is handed", () => {
    assert.deepEqual(leaksIn(blockA), []);
  });

  test('every statement the derivation ran carried the hotel filter', () => {
    assert.ok(statementsA.length >= 7, `expected the full fan-out, saw ${statementsA.length}`);
    const unscoped: string[] = [];
    for (const statement of statementsA) {
      if (statement.kind !== 'table') continue;
      // `properties` is keyed on `id`; every other table on `property_id`.
      // Getting that mapping wrong is invisible to a fake client.
      const column = statement.target === 'properties' ? 'id' : 'property_id';
      const scoped = statement.filters.some(
        f => f.op === 'eq' && f.column === column && f.value === PID_A,
      );
      if (!scoped) unscoped.push(`${statement.verb} ${statement.target}`);
    }
    assert.deepEqual([...new Set(unscoped)], [],
      'each of these reached a hotel table with no hotel filter.');
  });

  test('the derivation only ever reads — it must never write during a prompt build', () => {
    const writes = statementsA.filter(s => s.verb !== 'select').map(s => `${s.verb} ${s.target}`);
    assert.deepEqual([...new Set(writes)], []);
  });

  test('no statement returned a row belonging to the other hotel', () => {
    const leaks: string[] = [];
    for (const statement of statementsA) {
      for (const row of statement.rows) {
        for (const needle of leaksIn(row)) {
          leaks.push(`${statement.verb} ${statement.target} read ${needle}`);
        }
      }
    }
    assert.deepEqual([...new Set(leaks)], [],
      'a statement crossed the hotel boundary at the database, even if the ' +
      'derivation later dropped the row.');
  });

  test('every query the shim could not compile is reported rather than silently passing', () => {
    assert.deepEqual([...new Set(shim.unsupported)], [],
      'the shim could not compile these, so those queries never actually ran.');
  });

  test('the counts describe hotel A alone', async () => {
    assert.ok(identityA);
    const seeded = async (table: string, pid: string) => {
      const r = await pg.query<{ n: number }>(
        `select count(*)::int as n from "${table}" where property_id = $1`, [pid],
      );
      return r.rows[0]?.n ?? 0;
    };
    // The seeder puts exactly one row per hotel in each table, so a filter that
    // widened to both hotels would double every number below.
    assert.equal(await seeded('pms_rooms_inventory', PID_B), 1,
      'hotel B must have a room row for this comparison to mean anything');
    assert.equal(identityA.rooms?.detailed, await seeded('pms_rooms_inventory', PID_A));
    assert.equal(identityA.team?.total, await seeded('staff', PID_A));
    assert.equal(identityA.cleaningChecklists.length,
      await seeded('cleaning_checklist_templates', PID_A));
    assert.equal(identityA.shiftPresets.length, await seeded('property_shift_presets', PID_A));
  });
});
