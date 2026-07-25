/**
 * PROOF, not assertion: the findings ledger keeps one row per problem, honours
 * a silence, lets a problem that outgrew that silence back out, and never shows
 * one hotel another hotel's findings — with a REAL Postgres deciding.
 *
 * WHY THIS CANNOT BE A UNIT TEST
 * The "one problem = one card" guarantee is a partial unique index (migration
 * 0360), not a policy the runner is polite enough to follow. Asserting it
 * against a fake would prove the runner intends to dedupe, which is exactly
 * what every one of the three older detection systems also intended. Here the
 * production migrations are applied to PGlite, the PostgREST shim compiles the
 * real query builder into real SQL, and the real runner + real store run
 * unmodified against two seeded hotels — hotel B's rows deliberately reachable,
 * every hotel-B uuid starting `bbbbbbbb-` and every free-text column carrying
 * `ZZLEAKB`.
 *
 * The runner is driven through a PROBE detector rather than the three shipped
 * ones so the drafts are controlled to the digit. The probe still declares a
 * real feed, so the feed loader is exercised against the real schema too.
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
import { registerDetector } from '@/lib/findings/registry';
import { runFindingsForProperty } from '@/lib/findings/runner';
import { listFindings, openFinding, setFindingStatus } from '@/lib/findings/store';
import type { Detector, DetectorParams, FindingDraft } from '@/lib/findings/types';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import {
  createPglitePostgrest,
  loadCatalog,
  type Catalog,
  type PglitePostgrest,
} from '../../../tests/fixtures/postgrest-pglite';
import { seedTwoHotels, LEAK_MARKER, PID_A, PID_B } from '../../../tests/fixtures/pglite-two-hotel-seed';

const LEAK_NEEDLES = ['bbbbbbbb-', LEAK_MARKER, PID_B];

function leaksIn(value: unknown): string[] {
  const text = JSON.stringify(value ?? null) ?? '';
  return LEAK_NEEDLES.filter((needle) => text.includes(needle));
}

// ─── the probe detector ─────────────────────────────────────────────────────
// What it finds is whatever the current test put in `probeDrafts`. Everything
// else about it — the declaration, the pure signature, the feed it reads — is
// exactly what a real detector looks like.

let probeDrafts: FindingDraft[] = [];

function probeDraft(magnitude: number, summary = `room 214 hvac: ${magnitude}`): FindingDraft {
  return {
    key: 'room_214:hvac',
    summary,
    severity: 'attention',
    magnitude,
    evidence: {
      queryId: 'probe_query',
      params: { room: '214' },
      values: { count: magnitude },
      basis: `${magnitude} hvac work orders in 30 days`,
    },
    price: null,
  };
}

const probe: Detector<DetectorParams> = {
  declaration: {
    id: 'probe_ledger',
    description: 'probe detector for the ledger integration test',
    inputs: ['operational_signals'],
    requires: [{ feed: 'operational_signals', minRecords: 0, because: 'no operational records' }],
    receiptQueryId: 'probe_query',
    defaultDisposition: 'fyi',
    defaultSeverity: 'attention',
    escalation: { factor: 2, minDelta: 3 },
    maxPerRun: 10,
    staleAfterDays: 7,
    evalCases: [{ name: 'noop', feeds: { operational_signals: [] }, expectKeys: [] }],
  },
  detect: () => probeDrafts,
};

/** Declares a minimum this hotel cannot possibly meet, so it always skips. */
const skipper: Detector<DetectorParams> = {
  declaration: {
    id: 'probe_skipper',
    description: 'probe detector that can never meet its declared minimum data',
    inputs: ['operational_signals'],
    requires: [
      { feed: 'operational_signals', minRecords: 999_999, because: 'not enough history yet' },
    ],
    receiptQueryId: 'probe_query',
    defaultDisposition: 'fyi',
    defaultSeverity: 'info',
    escalation: null,
    maxPerRun: 1,
    staleAfterDays: 1,
    evalCases: [{ name: 'noop', feeds: { operational_signals: [] }, expectKeys: [] }],
  },
  detect: () => [probeDraft(1)],
};

let pg: PGlite;
let catalog: Catalog;
let shim: PglitePostgrest;

const ONLY_PROBE = { detectorIds: ['probe_ledger'] as const };

async function countFindings(propertyId: string): Promise<number> {
  const r = await pg.query<{ n: number }>(
    `select count(*)::int n from findings where property_id = $1`,
    [propertyId],
  );
  return r.rows[0]?.n ?? 0;
}

/** A findings row put straight into the table, bypassing the runner. */
function insertRaw(status: string, key = 'probe_ledger:room_214:hvac') {
  return pg.query(
    `insert into findings (property_id, detector_id, dedupe_key, summary, severity,
                           receipt_query_id, status, magnitude)
     values ($1, 'probe_ledger', $2, 'x', 'attention', 'q', $3, 1)`,
    [PID_A, key, status],
  );
}

async function theRow(propertyId = PID_A) {
  const r = await pg.query<Record<string, unknown>>(
    `select * from findings where property_id = $1 and detector_id = 'probe_ledger'
       order by first_seen_at asc`,
    [propertyId],
  );
  return r.rows;
}

describe('the findings ledger, proven against a real database', () => {
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

    registerDetector(probe);
    registerDetector(skipper);
  });

  after(async () => {
    await pg.close().catch(() => undefined);
  });

  beforeEach(async () => {
    // Hotel A starts each scenario clean. Hotel B's seeded rows are left
    // exactly where they are — they are the thing that must never leak.
    await pg.query(`delete from findings where property_id = $1`, [PID_A]);
    await pg.query(`delete from finding_runs where property_id = $1`, [PID_A]);
    probeDrafts = [];
    shim.reset();
  });

  // ── the migration actually landed ────────────────────────────────────────

  test('0360 applied — without it every test below would prove nothing', () => {
    assert.ok(catalog.tables.has('findings'), 'findings table missing from the migrated schema');
    assert.ok(catalog.tables.has('finding_runs'), 'finding_runs table missing');
  });

  // ── one problem, one row: the DATABASE says so ───────────────────────────

  describe('one problem is one row, and Postgres is what enforces it', () => {
    const insert = insertRaw;

    test('a second open row for the same problem is refused', async () => {
      await insert('open');
      await assert.rejects(
        () => insert('open'),
        /duplicate key value|unique constraint/i,
        'the dedupe guarantee has to be the database, not the runner remembering to look first',
      );
    });

    test('a muted problem cannot be re-opened as a fresh card', async () => {
      await insert('muted');
      await assert.rejects(
        () => insert('open'),
        /duplicate key value|unique constraint/i,
        'if mute did not occupy the slot, tomorrow night would defeat it with a new insert',
      );
    });

    test('a known problem cannot be re-opened as a fresh card either', async () => {
      await insert('known_problem');
      await assert.rejects(() => insert('open'), /duplicate key value|unique constraint/i);
    });

    test('a RESOLVED problem may recur as a genuinely new row', async () => {
      await insert('resolved');
      await assert.doesNotReject(
        () => insert('open'),
        'a problem that comes back after being fixed is new information and deserves its own row',
      );
      assert.equal(await countFindings(PID_A), 2);
    });

    test('two different problems coexist', async () => {
      await insert('open', 'probe_ledger:room_214:hvac');
      await assert.doesNotReject(() => insert('open', 'probe_ledger:room_9:plumbing'));
    });
  });

  // ── the runner: update, never duplicate ──────────────────────────────────

  describe('finding the same problem again updates the card', () => {
    test('two runs of the same problem leave one row with two sightings', async () => {
      probeDrafts = [probeDraft(4)];
      const first = await runFindingsForProperty(PID_A, ONLY_PROBE);
      assert.equal(first.findingsOpened, 1);

      const second = await runFindingsForProperty(PID_A, ONLY_PROBE);
      assert.equal(second.findingsOpened, 0);
      assert.equal(second.findingsUpdated, 1);

      const rows = await theRow();
      assert.equal(rows.length, 1, 'a second card for the same problem is the failure this exists to prevent');
      assert.equal(rows[0].occurrence_count, 2);
      assert.equal(rows[0].status, 'open', 'nothing moved, so nothing is newly worth looking at');
    });

    test('when the numbers move, the same row moves with them and is marked updated', async () => {
      probeDrafts = [probeDraft(4)];
      await runFindingsForProperty(PID_A, ONLY_PROBE);

      probeDrafts = [probeDraft(5)];
      await runFindingsForProperty(PID_A, ONLY_PROBE);

      const rows = await theRow();
      assert.equal(rows.length, 1);
      assert.equal(Number(rows[0].magnitude), 5, '"now 5 work orders" is the same card with a new number');
      assert.equal(rows[0].status, 'updated');
      assert.equal(rows[0].summary, 'room 214 hvac: 5');
    });

    test('first_seen_at is when the problem started, not when we last looked', async () => {
      probeDrafts = [probeDraft(4)];
      await runFindingsForProperty(PID_A, ONLY_PROBE);
      const before = (await theRow())[0].first_seen_at;

      probeDrafts = [probeDraft(6)];
      await runFindingsForProperty(PID_A, ONLY_PROBE);
      const rows = await theRow();
      assert.deepEqual(rows[0].first_seen_at, before);
      assert.ok(
        new Date(rows[0].last_seen_at as string).getTime() >=
          new Date(before as string).getTime(),
      );
    });

    test('a concurrent run cannot produce two cards', async () => {
      probeDrafts = [probeDraft(4)];
      // Both runs read an empty ledger, both try to insert. The index refuses
      // one; the loser must turn its insert into the update it should have been.
      const runs = await Promise.all([
        runFindingsForProperty(PID_A, ONLY_PROBE),
        runFindingsForProperty(PID_A, ONLY_PROBE),
      ]);
      assert.equal(await countFindings(PID_A), 1);
      assert.deepEqual(
        runs.flatMap((r) => r.errors),
        [],
        'losing the race is normal operation, not an error to swallow',
      );
    });

    // The race above is real but its interleaving is not ours to schedule.
    // These two put the loser in the exact position the index puts it in, so
    // the recovery path is exercised every run rather than when the clock
    // happens to cooperate.
    const argsFor = (draft: FindingDraft) => ({
      propertyId: PID_A,
      detectorId: 'probe_ledger',
      dedupeKey: 'probe_ledger:room_214:hvac',
      draft,
      receiptQueryId: 'probe_query',
      disposition: 'fyi' as const,
      now: new Date(),
    });

    test('an insert that loses the race becomes the update it should have been', async () => {
      await insertRaw('open');
      const outcome = await openFinding(argsFor(probeDraft(9)));
      assert.equal(outcome, 'updated');
      assert.equal(await countFindings(PID_A), 1);
      assert.equal(Number((await theRow())[0].magnitude), 9);
    });

    test('an insert that loses the race to a silenced row does not un-silence it', async () => {
      await insertRaw('muted');
      const outcome = await openFinding(argsFor(probeDraft(900)));
      assert.equal(outcome, 'suppressed');
      const rows = await theRow();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'muted');
    });
  });

  // ── the silencer ─────────────────────────────────────────────────────────

  describe('a manager can silence a problem, and the silence holds', () => {
    async function openThenSilence(status: 'known_problem' | 'muted') {
      probeDrafts = [probeDraft(4)];
      await runFindingsForProperty(PID_A, ONLY_PROBE);
      const row = (await theRow())[0];
      return setFindingStatus(PID_A, row.id as string, status, null);
    }

    test('silencing a problem records the size the manager consented to', async () => {
      const after = await openThenSilence('known_problem');
      assert.equal(
        Number(after?.silencedAtMagnitude),
        4,
        'without the consent point, escalation has nothing honest to measure against',
      );
    });

    test('a known problem that barely grew stays quiet', async () => {
      await openThenSilence('known_problem');

      probeDrafts = [probeDraft(5)];
      const run = await runFindingsForProperty(PID_A, ONLY_PROBE);
      assert.equal(run.findingsSuppressed, 1);
      assert.equal(run.findingsEscalated, 0);

      const rows = await theRow();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'known_problem');
      assert.equal(rows[0].escalated_at, null);
      assert.equal(
        Number(rows[0].magnitude),
        5,
        'the evidence still moves under the silence — un-silencing must show today, not the day it was silenced',
      );
    });

    test('four known work orders does not silence nine', async () => {
      await openThenSilence('known_problem');

      probeDrafts = [probeDraft(9)];
      const run = await runFindingsForProperty(PID_A, ONLY_PROBE);
      assert.equal(run.findingsEscalated, 1);

      const rows = await theRow();
      assert.equal(rows.length, 1, 'escalation is the SAME problem getting louder, not a new one');
      assert.equal(rows[0].status, 'updated');
      assert.notEqual(rows[0].escalated_at, null);
    });

    test('mute means gone, at any size', async () => {
      await openThenSilence('muted');

      probeDrafts = [probeDraft(900)];
      const run = await runFindingsForProperty(PID_A, ONLY_PROBE);
      assert.equal(run.findingsSuppressed, 1);
      assert.equal(run.findingsEscalated, 0);

      const rows = await theRow();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'muted');
      assert.equal(rows[0].escalated_at, null);
    });

    test('a silenced problem is not in the queue a manager reads', async () => {
      await openThenSilence('muted');
      const open = await listFindings(PID_A);
      assert.equal(open.length, 0);
    });
  });

  // ── resolve and recur ────────────────────────────────────────────────────

  describe('a problem that comes back after a fix is new information', () => {
    test('recurrence after resolve opens a fresh card and keeps the old one', async () => {
      probeDrafts = [probeDraft(4)];
      await runFindingsForProperty(PID_A, ONLY_PROBE);
      const first = (await theRow())[0];
      await setFindingStatus(PID_A, first.id as string, 'resolved', null);

      probeDrafts = [probeDraft(2)];
      const run = await runFindingsForProperty(PID_A, ONLY_PROBE);
      assert.equal(run.findingsOpened, 1);

      const rows = await theRow();
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.map((r) => r.status).sort(), ['open', 'resolved']);

      const open = await listFindings(PID_A);
      assert.equal(open.length, 1);
      assert.equal(open[0].occurrenceCount, 1, 'the new card counts from its own beginning');
    });
  });

  // ── staleness ────────────────────────────────────────────────────────────

  describe('a card does not outlive the problem', () => {
    async function backdate(detectorId: string, days: number) {
      await pg.query(
        `insert into findings (property_id, detector_id, dedupe_key, summary, severity,
                               receipt_query_id, status, magnitude, first_seen_at, last_seen_at)
         values ($1, $2, $2 || ':old', 'stale', 'info', 'q', 'open', 1,
                 now() - ($3 || ' days')::interval, now() - ($3 || ' days')::interval)`,
        [PID_A, detectorId, String(days)],
      );
    }

    test('a detector that ran and no longer finds it expires the card', async () => {
      await backdate('probe_ledger', 30);
      probeDrafts = [];
      const run = await runFindingsForProperty(PID_A, ONLY_PROBE);
      assert.equal(run.findingsExpired, 1);
      const rows = await pg.query<{ status: string }>(
        `select status from findings where property_id=$1 and detector_id='probe_ledger'`,
        [PID_A],
      );
      assert.equal(rows.rows[0].status, 'expired');
    });

    test('a silenced card is never expired out from under the manager', async () => {
      await pg.query(
        `insert into findings (property_id, detector_id, dedupe_key, summary, severity,
                               receipt_query_id, status, magnitude, first_seen_at, last_seen_at)
         values ($1, 'probe_ledger', 'probe_ledger:silenced_old', 'stale', 'info', 'q',
                 'muted', 1, now() - interval '90 days', now() - interval '90 days')`,
        [PID_A],
      );
      probeDrafts = [];
      const run = await runFindingsForProperty(PID_A, ONLY_PROBE);
      assert.equal(run.findingsExpired, 0);
      const rows = await pg.query<{ status: string }>(
        `select status from findings where property_id=$1 and dedupe_key='probe_ledger:silenced_old'`,
        [PID_A],
      );
      assert.equal(
        rows.rows[0].status,
        'muted',
        'expiring a mute would quietly re-arm a problem the manager switched off',
      );
    });

    test('a detector SKIPPED for want of data expires nothing — silence is not a clean bill of health', async () => {
      await backdate('probe_skipper', 30);
      const run = await runFindingsForProperty(PID_A, { detectorIds: ['probe_skipper'] });
      assert.equal(run.detectorsSkipped, 1);
      assert.equal(run.detectorsChecked, 0);
      assert.equal(run.findingsExpired, 0);
      const rows = await pg.query<{ status: string }>(
        `select status from findings where property_id=$1 and detector_id='probe_skipper'`,
        [PID_A],
      );
      assert.equal(
        rows.rows[0].status,
        'open',
        'a detector that never ran has said nothing about whether the problem went away',
      );
    });
  });

  // ── the null-result artifact ─────────────────────────────────────────────

  describe('a quiet night and a dead runner must not look the same', () => {
    test('a run that finds nothing still leaves proof it happened', async () => {
      probeDrafts = [];
      await runFindingsForProperty(PID_A, ONLY_PROBE);

      const rows = await pg.query<Record<string, unknown>>(
        `select * from finding_runs where property_id = $1`,
        [PID_A],
      );
      assert.equal(rows.rows.length, 1, 'no row means nobody can tell the watcher is still alive');
      assert.equal(rows.rows[0].detectors_checked, 1);
      assert.equal(rows.rows[0].findings_opened, 0);
      assert.equal(rows.rows[0].detectors_skipped, 0);
    });

    test('the summary counts what actually happened', async () => {
      probeDrafts = [probeDraft(4)];
      await runFindingsForProperty(PID_A, ONLY_PROBE);
      probeDrafts = [probeDraft(7)];
      await runFindingsForProperty(PID_A, ONLY_PROBE);

      const rows = await pg.query<Record<string, unknown>>(
        `select * from finding_runs where property_id = $1 order by run_at asc`,
        [PID_A],
      );
      assert.equal(rows.rows.length, 2);
      assert.equal(rows.rows[0].findings_opened, 1);
      assert.equal(rows.rows[0].findings_updated, 0);
      assert.equal(rows.rows[1].findings_opened, 0);
      assert.equal(rows.rows[1].findings_updated, 1);
      assert.equal(rows.rows[1].detectors_registered as number >= 3, true);
    });

    test('a skipped detector is counted as skipped, never as checked-and-clear', async () => {
      const run = await runFindingsForProperty(PID_A, { detectorIds: ['probe_skipper'] });
      assert.deepEqual(run.skipped, [
        { detectorId: 'probe_skipper', because: 'not enough history yet' },
      ]);
      const rows = await pg.query<Record<string, unknown>>(
        `select * from finding_runs where property_id = $1`,
        [PID_A],
      );
      assert.equal(rows.rows[0].detectors_skipped, 1);
      assert.equal(rows.rows[0].detectors_checked, 0);
    });
  });

  // ── the tenant wall ──────────────────────────────────────────────────────

  describe("one hotel never sees another hotel's findings", () => {
    test('the queue read carries nothing from hotel B', async () => {
      probeDrafts = [probeDraft(4)];
      await runFindingsForProperty(PID_A, ONLY_PROBE);

      const forA = await listFindings(PID_A, { statuses: ['open', 'updated', 'known_problem', 'muted'] });
      assert.deepEqual(leaksIn(forA), [], "hotel B leaked into hotel A's queue");
      assert.ok(forA.every((f) => f.propertyId === PID_A));
    });

    test('hotel B has findings of its own that a forgotten filter WOULD have returned', async () => {
      const b = await pg.query<{ n: number }>(
        `select count(*)::int n from findings where property_id = $1`,
        [PID_B],
      );
      assert.ok(
        (b.rows[0]?.n ?? 0) > 0,
        'without a hotel-B row there is nothing to leak and the test above proves nothing',
      );
    });

    test("running hotel A's detectors does not touch hotel B's rows", async () => {
      const before = await pg.query<{ digest: string }>(
        `select md5(coalesce(string_agg(f::text, '|' order by f::text), '')) digest
           from findings f where f.property_id = $1`,
        [PID_B],
      );
      probeDrafts = [probeDraft(4)];
      await runFindingsForProperty(PID_A, ONLY_PROBE);
      const after = await pg.query<{ digest: string }>(
        `select md5(coalesce(string_agg(f::text, '|' order by f::text), '')) digest
           from findings f where f.property_id = $1`,
        [PID_B],
      );
      assert.equal(after.rows[0].digest, before.rows[0].digest);
    });

    test('every statement the run issued carried the hotel filter', async () => {
      shim.reset();
      probeDrafts = [probeDraft(4)];
      await runFindingsForProperty(PID_A, ONLY_PROBE);

      const unfiltered = shim.statements.filter(
        (s) =>
          s.kind === 'table' &&
          (s.target === 'findings' || s.target === 'finding_runs') &&
          !s.filters.some((f) => f.column === 'property_id') &&
          !JSON.stringify(s.payload ?? {}).includes(PID_A),
      );
      assert.deepEqual(unfiltered.map((s) => `${s.verb} ${s.target}`), []);
      assert.deepEqual(shim.unsupported, [], 'the shim silently skipped a builder feature');
    });
  });

  // ── the price tag ────────────────────────────────────────────────────────

  describe('the schema refuses a price that is not a range', () => {
    const withPrice = (low: number | null, high: number | null) =>
      pg.query(
        `insert into findings (property_id, detector_id, dedupe_key, summary, severity,
                               receipt_query_id, magnitude, price_low_cents, price_high_cents)
         values ($1, 'probe_ledger',
                 'price:' || coalesce($2::integer::text, 'n') || ':' || coalesce($3::integer::text, 'n'),
                 'x', 'info', 'q', 1, $2::integer, $3::integer)`,
        [PID_A, low, high],
      );

    test('a real range is accepted', async () => {
      await assert.doesNotReject(() => withPrice(20_000, 40_000));
    });

    test('no price at all is accepted', async () => {
      await assert.doesNotReject(() => withPrice(null, null));
    });

    test('a point estimate wearing a range is refused', async () => {
      await assert.rejects(() => withPrice(34_000, 34_000), /findings_price_is_a_range/);
    });

    test('an inverted range is refused', async () => {
      await assert.rejects(() => withPrice(40_000, 20_000), /findings_price_is_a_range/);
    });

    test('half a range is refused', async () => {
      await assert.rejects(() => withPrice(20_000, null), /findings_price_is_a_range/);
    });
  });

  // ── the browser cannot reach it ──────────────────────────────────────────

  describe('the browser roles cannot read the ledger at all', () => {
    for (const role of ['anon', 'authenticated'] as const) {
      for (const table of ['findings', 'finding_runs'] as const) {
        test(`${role} is denied on ${table}`, async () => {
          await pg.exec('begin');
          try {
            await pg.exec(`set local role ${role}`);
            await assert.rejects(
              () => pg.query(`select id from ${table} limit 1`),
              /permission denied/i,
              `${role} must not be able to read ${table} — it is service-role only`,
            );
          } finally {
            await pg.exec('rollback');
          }
        });
      }
    }
  });
});
