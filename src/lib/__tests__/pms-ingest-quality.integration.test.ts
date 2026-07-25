/**
 * Migration 0339 against REAL Postgres (pglite).
 *
 * pms_feed_health_v1 is THE single definition of "is this hotel's PMS data
 * fresh", and it lives in SQL. There is deliberately no TypeScript copy of
 * the state machine to unit-test, so this file is where the rules are proved.
 *
 * The two design failures this migration exists to avoid are both pinned
 * here, because each of them passed review as an isolated idea and only broke
 * when combined with the rest:
 *
 *   FLAW A — a GLOBAL dedupe on quarantine fingerprint plus a per-delivery
 *   row-accounting CHECK is unsatisfiable. The second delivery carrying the
 *   same persistent bad row would insert nothing, report zero rejects against
 *   a short write count, and never be markable 'parsed'. The pipeline wedges
 *   on the second occurrence of any recurring bad row. Fix: scope the open
 *   dedupe per delivery; do the cross-delivery roll-up in a view.
 *
 *   FLAW B — "no enabled expectation row means unavailable" would flip every
 *   manual / skip-PMS hotel to all-unavailable and neutralise its dashboard
 *   and housekeeper board. Fix: a hotel with no expectations produces NO ROWS
 *   at all, and the app falls back to its existing manual-hotel fail-safe.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupRlsFixture, type PgliteFixture } from '../../../tests/fixtures/pglite-bootstrap';

const UID = 'd4000000-0000-0000-0000-0000000000c4';
/** Hotel on a 30-minute interval schedule. */
const PID_INTERVAL = 'd4000000-0000-0000-0000-0000000000a1';
/** Hotel on a once-a-night schedule — same code, different row. */
const PID_DAILY = 'd4000000-0000-0000-0000-0000000000b2';
/** Hotel with no PMS at all. Its dashboard must keep working. */
const PID_MANUAL = 'd4000000-0000-0000-0000-0000000000c3';

type Row = Record<string, unknown>;

describe('migration 0339 — ingest quality foundation', () => {
  let fx: PgliteFixture;

  const health = async (propertyId: string): Promise<Row[]> => {
    const r = await fx.pg.query(
      `select feed_key, state, last_report_at, last_delivery_at, last_signal_at,
              minutes_late, open_quarantine_count, open_unmapped_count, required, enabled
         from public.pms_feed_health_v1 where property_id = $1 order by feed_key`,
      [propertyId],
    );
    return r.rows as Row[];
  };
  const stateOf = async (propertyId: string, feedKey: string): Promise<string | undefined> => {
    const rows = await health(propertyId);
    return rows.find((r) => r.feed_key === feedKey)?.state as string | undefined;
  };

  before(async () => {
    fx = await setupRlsFixture();
    await fx.pg.query(`insert into auth.users (id, email) values ($1, 'd4@test') on conflict do nothing`, [UID]);
    await fx.pg.exec(`insert into properties (id, name, owner_id, total_rooms, timezone) values
      ('${PID_INTERVAL}', 'Interval Hotel', '${UID}', 80, 'America/Chicago'),
      ('${PID_DAILY}',    'Nightly Hotel',  '${UID}', 60, 'America/New_York'),
      ('${PID_MANUAL}',   'Manual Hotel',   '${UID}', 40, 'America/Chicago')
      on conflict do nothing;`);
  });

  after(async () => {
    await fx.pg.close().catch(() => undefined);
  });

  // ─── The migration actually applied ─────────────────────────────────────

  test('the five tables, three helper views and two health views exist', async () => {
    const t = await fx.pg.query(
      `select table_name, table_type from information_schema.tables
        where table_schema = 'public' and table_name in (
          'pms_feed_catalog','pms_feed_expectations','pms_ingest_quarantine',
          'pms_unmapped_columns','pms_ingest_anomalies',
          'pms_feed_delivery_signal_v1','pms_feed_table_signal_v1',
          'pms_feed_health_v1','pms_property_health_v1','pms_quarantine_rollup_v1')`,
    );
    assert.equal(t.rows.length, 10, `expected all 10 objects, got ${t.rows.map((r) => (r as Row).table_name).join(', ')}`);
  });

  test('the catalog is seeded with the feeds the surfaces render', async () => {
    const r = await fx.pg.query(`select feed_key, required, target_table from public.pms_feed_catalog order by feed_key`);
    const keys = r.rows.map((x) => (x as Row).feed_key);
    for (const k of ['roomStatus', 'arrivals', 'departures', 'workOrders', 'dashboardCounts']) {
      assert.ok(keys.includes(k), `catalog is missing ${k}`);
    }
    const roomStatus = r.rows.find((x) => (x as Row).feed_key === 'roomStatus') as Row;
    assert.equal(roomStatus.required, true);
    assert.equal(roomStatus.target_table, 'pms_room_status_log');
  });

  // ─── FLAW B: the manual-hotel fail-safe ─────────────────────────────────

  test('FLAW B — a hotel with no expectations produces NO rows, not "everything unavailable"', async () => {
    assert.deepEqual(await health(PID_MANUAL), []);
    const roll = await fx.pg.query(`select * from public.pms_property_health_v1 where property_id = $1`, [PID_MANUAL]);
    assert.equal(roll.rows.length, 0);
  });

  // ─── Expectations are rows, and the DB refuses incoherent ones ──────────

  test('an interval expectation that also carries a clock time is refused', async () => {
    await assert.rejects(
      fx.pg.query(
        `insert into public.pms_feed_expectations
           (property_id, feed_key, cadence_kind, expected_every_minutes, expected_at_local)
         values ($1, 'roomStatus', 'interval', 30, '03:00')`,
        [PID_INTERVAL],
      ),
      /cadence_coherent/,
    );
  });

  test('a daily expectation with no clock time is refused', async () => {
    await assert.rejects(
      fx.pg.query(
        `insert into public.pms_feed_expectations (property_id, feed_key, cadence_kind)
         values ($1, 'roomStatus', 'daily_at')`,
        [PID_INTERVAL],
      ),
      /cadence_coherent/,
    );
  });

  test('a typo in the feed name cannot create a phantom SLO', async () => {
    await assert.rejects(
      fx.pg.query(
        `insert into public.pms_feed_expectations
           (property_id, feed_key, cadence_kind, expected_every_minutes)
         values ($1, 'getBanquets', 'interval', 30)`,
        [PID_INTERVAL],
      ),
      /foreign key|pms_feed_expectations_feed_key/i,
    );
  });

  test('a negative grace is refused', async () => {
    await assert.rejects(
      fx.pg.query(
        `insert into public.pms_feed_expectations
           (property_id, feed_key, cadence_kind, expected_every_minutes, grace_minutes)
         values ($1, 'roomStatus', 'interval', 30, -5)`,
        [PID_INTERVAL],
      ),
      /grace_minutes/,
    );
  });

  // ─── The state machine ──────────────────────────────────────────────────

  test('an expectation with nothing ever received reads learning, not stale', async () => {
    await fx.pg.query(
      `insert into public.pms_feed_expectations
         (property_id, feed_key, report_type, cadence_kind, expected_every_minutes, grace_minutes, alert_channel)
       values ($1, 'roomStatus', 'Housekeeping Status', 'interval', 30, 20, 'doctor_fail')`,
      [PID_INTERVAL],
    );
    const rows = await health(PID_INTERVAL);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.state, 'learning');
    assert.equal(rows[0]!.last_signal_at, null);
    assert.equal(rows[0]!.minutes_late, null, 'never-arrived is not "late", it is "nothing yet"');
  });

  test('a report inside its window reads live', async () => {
    await fx.pg.query(
      `insert into public.pms_room_status_log (property_id, room_number, status, last_synced_at)
       values ($1, '204', 'vacant_clean', now() - interval '10 minutes')`,
      [PID_INTERVAL],
    );
    assert.equal(await stateOf(PID_INTERVAL, 'roomStatus'), 'live');
  });

  test('a report 5 minutes past its grace reads STALE — and the number is still there', async () => {
    // 30-minute cadence + 20-minute grace = 50 minutes of headroom.
    await fx.pg.exec(`update public.pms_room_status_log
                         set last_synced_at = now() - interval '55 minutes'
                       where property_id = '${PID_INTERVAL}'`);
    const rows = await health(PID_INTERVAL);
    assert.equal(rows[0]!.state, 'stale');
    assert.ok(Number(rows[0]!.minutes_late) > 20, 'should be past grace');
    assert.ok(rows[0]!.last_report_at, 'a stale feed still carries its as-of time — it is stamped, never blanked');
  });

  test('open QUARANTINE rows do NOT blank a feed — they warn, they do not neutralise', async () => {
    // Five bad rows out of three hundred leaves 295 good ones. 'learning'
    // blanks user-visible numbers, so quarantine deliberately does not cause
    // it; the doctor + admin queue is where a human acts on the backlog.
    for (let i = 0; i < 6; i += 1) {
      await fx.pg.query(
        `insert into public.pms_ingest_quarantine
           (property_id, target_table, report_type, raw_row, reason_code, fingerprint)
         values ($1, 'pms_room_status_log', 'Housekeeping Status', $2, 'enum', $3)`,
        [PID_INTERVAL, JSON.stringify({ room: `30${i}` }), `fp-noise-${i}`],
      );
    }
    const rows = await health(PID_INTERVAL);
    assert.equal(rows[0]!.open_quarantine_count, 6);
    assert.equal(rows[0]!.state, 'stale', 'quarantine backlog must not promote the feed to learning');
  });

  test('an UNRECOGNISED COLUMN degrades the feed to learning, beating staleness', async () => {
    await fx.pg.query(
      `insert into public.pms_unmapped_columns
         (property_id, report_type, target_table, column_label, sample_values)
       values ($1, 'Housekeeping Status', 'pms_room_status_log', 'Loyalty Tier', '["<redacted>"]'::jsonb)`,
      [PID_INTERVAL],
    );
    assert.equal(await stateOf(PID_INTERVAL, 'roomStatus'), 'learning');
  });

  test('mapping that column releases the feed back to its freshness state', async () => {
    await fx.pg.query(
      `update public.pms_unmapped_columns set status = 'mapped', resolved_at = now()
        where property_id = $1 and column_label = 'Loyalty Tier'`,
      [PID_INTERVAL],
    );
    assert.equal(await stateOf(PID_INTERVAL, 'roomStatus'), 'stale');
    await fx.pg.exec(`update public.pms_room_status_log
                         set last_synced_at = now() - interval '5 minutes'
                       where property_id = '${PID_INTERVAL}'`);
    assert.equal(await stateOf(PID_INTERVAL, 'roomStatus'), 'live');
  });

  test('disabling an expectation reads unavailable — someone switched that report off', async () => {
    await fx.pg.query(
      `update public.pms_feed_expectations set enabled = false where property_id = $1 and feed_key = 'roomStatus'`,
      [PID_INTERVAL],
    );
    assert.equal(await stateOf(PID_INTERVAL, 'roomStatus'), 'unavailable');
    await fx.pg.query(
      `update public.pms_feed_expectations set enabled = true where property_id = $1 and feed_key = 'roomStatus'`,
      [PID_INTERVAL],
    );
    assert.equal(await stateOf(PID_INTERVAL, 'roomStatus'), 'live');
  });

  // ─── Hotel #2 on a different schedule is a ROW, not a code branch ───────

  test('a once-a-night hotel is judged correctly by the same view, zero branches', async () => {
    // Due three hours ago in the hotel's own zone; nothing has arrived since
    // yesterday morning, so it is hours late on a 120-minute grace.
    await fx.pg.query(
      `insert into public.pms_feed_expectations
         (property_id, feed_key, report_type, cadence_kind, expected_at_local, timezone,
          grace_minutes, alert_channel)
       values ($1, 'workOrders', 'Night Audit', 'daily_at',
               ((now() at time zone 'America/New_York') - interval '3 hours')::time,
               'America/New_York', 120, 'doctor_warn')`,
      [PID_DAILY],
    );
    await fx.pg.query(
      `insert into public.pms_work_orders_v2
         (property_id, pms_work_order_id, description, status, last_synced_at)
       values ($1, 'wo-1', 'leaky tap', 'open', now() - interval '26 hours')`,
      [PID_DAILY],
    );
    const rows = await health(PID_DAILY);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.state, 'stale');
    assert.ok(Number(rows[0]!.minutes_late) > 120);

    // A delivery after the due time clears it — same row, same code.
    await fx.pg.exec(`update public.pms_work_orders_v2
                         set last_synced_at = now() - interval '1 minute'
                       where property_id = '${PID_DAILY}'`);
    assert.equal(await stateOf(PID_DAILY, 'workOrders'), 'live');

    // And the interval hotel is unaffected — two cadences, one evaluation.
    assert.equal(await stateOf(PID_INTERVAL, 'roomStatus'), 'live');
  });

  test('the property roll-up reports the worst state across a hotel s feeds', async () => {
    await fx.pg.exec(`update public.pms_work_orders_v2
                         set last_synced_at = now() - interval '26 hours'
                       where property_id = '${PID_DAILY}'`);
    const r = await fx.pg.query(
      `select worst_state, feeds_total, feeds_stale, required_feeds_degraded, newest_signal_at
         from public.pms_property_health_v1 where property_id = $1`,
      [PID_DAILY],
    );
    assert.equal(r.rows.length, 1);
    const roll = r.rows[0] as Row;
    assert.equal(roll.worst_state, 'stale');
    assert.equal(roll.feeds_stale, 1);
    assert.equal(roll.required_feeds_degraded, 1);
    assert.ok(roll.newest_signal_at, 'the roll-up carries the "as of" the copilot quotes');
  });

  // ─── FLAW A: per-delivery accounting ────────────────────────────────────

  describe('FLAW A — quarantine dedupe is scoped per delivery', () => {
    const D1 = 'd4000000-0000-0000-0000-00000000d001';
    const D2 = 'd4000000-0000-0000-0000-00000000d002';
    const FP = 'fp-persistent-bad-row';

    const insertReject = (deliveryId: string | null, fingerprint = FP) =>
      fx.pg.query(
        `insert into public.pms_ingest_quarantine
           (property_id, delivery_id, target_table, report_type, raw_row, reason_code, fingerprint)
         values ($1, $2, 'pms_reservations', 'Arrivals', '{"guest":"x"}'::jsonb, 'range', $3)`,
        [PID_INTERVAL, deliveryId, fingerprint],
      );

    test('the SAME bad row in TWO deliveries produces TWO open rows — the wedge fix', async () => {
      await insertReject(D1);
      await insertReject(D2);
      const r = await fx.pg.query(
        `select delivery_id from public.pms_ingest_quarantine
          where fingerprint = $1 and status = 'open' order by delivery_id`,
        [FP],
      );
      assert.equal(r.rows.length, 2, 'each delivery must own its rejects or its row arithmetic can never balance');
      assert.equal(await countFor(D1), 1);
      assert.equal(await countFor(D2), 1);
    });

    test('the SAME bad row TWICE in ONE delivery is refused — one open item per problem per delivery', async () => {
      await assert.rejects(insertReject(D1), /pms_ingest_quarantine_open_per_delivery/);
    });

    test('a reject with NO delivery still collapses per hotel — nothing to account for', async () => {
      await insertReject(null, 'fp-ledgerless');
      await assert.rejects(insertReject(null, 'fp-ledgerless'), /pms_ingest_quarantine_open_no_delivery/);
    });

    test('resolving an item frees the slot, so a replay cannot create a duplicate open row', async () => {
      await fx.pg.query(
        `update public.pms_ingest_quarantine set status = 'reprocessed', resolved_at = now()
          where fingerprint = $1 and delivery_id = $2`,
        [FP, D1],
      );
      await insertReject(D1); // the same problem recurring in a later parse
      const open = await fx.pg.query(
        `select count(*)::int as n from public.pms_ingest_quarantine
          where fingerprint = $1 and delivery_id = $2 and status = 'open'`,
        [FP, D1],
      );
      assert.equal((open.rows[0] as Row).n, 1, 'exactly one OPEN item at a time');
    });

    test('the cross-delivery roll-up is where "this happened in N deliveries" is answered', async () => {
      const r = await fx.pg.query(
        `select open_rows, deliveries_affected, total_occurrences
           from public.pms_quarantine_rollup_v1
          where property_id = $1 and fingerprint = $2`,
        [PID_INTERVAL, FP],
      );
      assert.equal(r.rows.length, 1);
      const roll = r.rows[0] as Row;
      assert.equal(roll.open_rows, 2);
      assert.equal(roll.deliveries_affected, 2);
    });

    async function countFor(deliveryId: string): Promise<number> {
      const r = await fx.pg.query(`select public.pms_delivery_quarantine_count($1) as n`, [deliveryId]);
      return Number((r.rows[0] as Row).n);
    }

    test('pms_delivery_quarantine_count is the number the intake ledger stores, not one the writer supplies', async () => {
      const before = await countFor(D2);
      await insertReject(D2, 'fp-second-problem');
      assert.equal(await countFor(D2), before + 1);
    });
  });

  // ─── The delivery-signal seam ───────────────────────────────────────────

  describe('a legitimately EMPTY report must not go stale forever', () => {
    // A hotel with no open work orders sends a real, healthy, zero-row report.
    // Nothing lands in the target table, so its max(last_synced_at) never
    // moves. Judging freshness on the table stamp alone would call that feed
    // stale forever despite a perfect pipe — which is why the DELIVERY time is
    // the primary signal and the table stamp only the fallback.
    //
    // On this branch the ledger does not exist and the seam view is a stub, so
    // the test stands the seam up itself, exactly as the report-intake
    // workstream will, then puts the stub back.
    const PID_EMPTY = 'd4000000-0000-0000-0000-0000000000e5';

    before(async () => {
      await fx.pg.query(`insert into auth.users (id, email) values ($1, 'd4b@test') on conflict do nothing`, [UID]);
      await fx.pg.exec(`insert into properties (id, name, owner_id, total_rooms, timezone)
        values ('${PID_EMPTY}', 'Empty Report Hotel', '${UID}', 30, 'UTC') on conflict do nothing;`);
      await fx.pg.query(
        `insert into public.pms_feed_expectations
           (property_id, feed_key, report_type, cadence_kind, expected_every_minutes, grace_minutes)
         values ($1, 'workOrders', 'Work Orders', 'interval', 60, 30)`,
        [PID_EMPTY],
      );
      await fx.pg.exec(`
        create table if not exists test_delivery_ledger (
          property_id uuid not null, feed_key text not null, last_delivery_at timestamptz not null
        );
        create or replace view public.pms_feed_delivery_signal_v1
        with (security_invoker = true) as
          select property_id, feed_key, max(last_delivery_at) as last_delivery_at
            from test_delivery_ledger group by property_id, feed_key;
      `);
    });

    after(async () => {
      await fx.pg.exec(`
        create or replace view public.pms_feed_delivery_signal_v1
        with (security_invoker = true) as
        select null::uuid as property_id, null::text as feed_key, null::timestamptz as last_delivery_at
        where false;
        drop table if exists test_delivery_ledger;
      `);
    });

    test('with no rows AND no delivery, the feed is honestly "learning"', async () => {
      assert.equal(await stateOf(PID_EMPTY, 'workOrders'), 'learning');
    });

    test('a zero-row report that ARRIVED keeps the feed live', async () => {
      await fx.pg.query(
        `insert into test_delivery_ledger values ($1, 'workOrders', now() - interval '5 minutes')`,
        [PID_EMPTY],
      );
      const rows = await health(PID_EMPTY);
      assert.equal(rows[0]!.last_report_at, null, 'the target table is legitimately empty');
      assert.ok(rows[0]!.last_delivery_at, 'but a report did arrive');
      assert.equal(rows[0]!.state, 'live');
    });

    test('when the deliveries stop, the same feed goes stale', async () => {
      await fx.pg.exec(`update test_delivery_ledger set last_delivery_at = now() - interval '4 hours'`);
      assert.equal(await stateOf(PID_EMPTY, 'workOrders'), 'stale');
    });
  });

  // ─── View security ──────────────────────────────────────────────────────

  describe('the health views do not leak per-hotel data to the browser', () => {
    for (const view of [
      'pms_feed_health_v1',
      'pms_property_health_v1',
      'pms_quarantine_rollup_v1',
      'pms_feed_table_signal_v1',
      'pms_feed_delivery_signal_v1',
    ]) {
      test(`${view} runs with the caller's own privileges (security_invoker)`, async () => {
        // Without this, the view runs as its OWNER and hands per-hotel
        // freshness and quarantine data to anon through PostgREST, bypassing
        // the deny-all-browser policies on every base table.
        const r = await fx.pg.query(
          `select reloptions::text as opts from pg_class where relname = $1 and relkind = 'v'`,
          [view],
        );
        assert.equal(r.rows.length, 1, `${view} must exist as a view`);
        assert.match(String((r.rows[0] as Row).opts ?? ''), /security_invoker=(true|on)/);
      });

      test(`${view} is not readable by anon or authenticated`, async () => {
        const r = await fx.pg.query(
          `select grantee from information_schema.role_table_grants
            where table_schema = 'public' and table_name = $1
              and grantee in ('anon', 'authenticated', 'PUBLIC')`,
          [view],
        );
        assert.deepEqual(r.rows, [], `${view} grants leaked to ${r.rows.map((x) => (x as Row).grantee).join(', ')}`);
      });
    }
  });

  describe('the five new tables are service-role only', () => {
    for (const table of [
      'pms_feed_catalog',
      'pms_feed_expectations',
      'pms_ingest_quarantine',
      'pms_unmapped_columns',
      'pms_ingest_anomalies',
    ]) {
      test(`${table} has RLS on with an explicit deny-all-browser policy`, async () => {
        const rls = await fx.pg.query(
          `select relrowsecurity from pg_class where relname = $1 and relkind = 'r'`,
          [table],
        );
        assert.equal((rls.rows[0] as Row).relrowsecurity, true, `${table} must have RLS enabled`);
        const pol = await fx.pg.query(
          `select policyname from pg_policies where schemaname = 'public' and tablename = $1`,
          [table],
        );
        assert.ok(
          pol.rows.some((p) => String((p as Row).policyname).endsWith('_deny_all_browser')),
          `${table} has no deny-all-browser policy`,
        );
      });
    }
  });
});
