/**
 * Feed health — the app's half of "is this hotel's PMS data still arriving?"
 * (src/lib/pms/feed-health.ts, backed by pms_feed_health_v1 in 0339).
 *
 * The state machine itself lives in SQL and is exercised against real
 * Postgres in pms-ingest-quality.integration.test.ts. What is pinned HERE is
 * everything the database cannot decide:
 *
 *   • the manual-hotel fail-safe (zero expectation rows must NOT be read as
 *     "everything unavailable" — that would neutralise the dashboard and
 *     housekeeper board of every hotel that never had a PMS);
 *   • the alert policy (what wakes somebody up vs. what is merely amber);
 *   • the countsTrusted / countsFresh split that lets a real-but-old number
 *     be shown with a stamp instead of blanked.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateFeedSlos,
  evaluateQuarantineBacklog,
  evaluateUnmappedColumns,
  feedStatusFromHealth,
  newestSignalAt,
  parseFeedHealthRow,
  parseFeedHealthRows,
  requiredFeedKeys,
  type FeedHealthRow,
} from '@/lib/pms/feed-health';
import {
  countsFresh,
  countsTrusted,
  isDataPending,
  isStale,
  learningFeeds,
  staleFeeds,
} from '@/lib/pms/feed-status';

const PID = 'b93142b5-0000-0000-0000-000000000001';

function row(over: Partial<FeedHealthRow> = {}): FeedHealthRow {
  return {
    propertyId: PID,
    feedKey: 'roomStatus',
    label: 'Room status',
    required: true,
    targetTable: 'pms_room_status_log',
    legacyTarget: 'getRoomStatus',
    reportType: 'Housekeeping Status',
    enabled: true,
    cadenceKind: 'interval',
    expectedEveryMinutes: 30,
    expectedAtLocal: null,
    timezone: 'America/Chicago',
    graceMinutes: 20,
    alertChannel: 'doctor_warn',
    lastReportAt: '2026-07-24T11:40:00.000Z',
    lastDeliveryAt: '2026-07-24T11:40:00.000Z',
    lastSignalAt: '2026-07-24T11:40:00.000Z',
    minutesLate: 0,
    openQuarantineCount: 0,
    openUnmappedCount: 0,
    state: 'live',
    ...over,
  };
}

const ALL_FIVE: FeedHealthRow[] = [
  row({ feedKey: 'roomStatus' }),
  row({ feedKey: 'arrivals', targetTable: 'pms_reservations' }),
  row({ feedKey: 'departures', targetTable: 'pms_reservations' }),
  row({ feedKey: 'workOrders', targetTable: 'pms_work_orders_v2' }),
  row({ feedKey: 'dashboardCounts', required: false, targetTable: 'pms_in_house_snapshot' }),
];

// ─── The manual-hotel fail-safe ────────────────────────────────────────────

describe('feedStatusFromHealth — the manual-hotel fail-safe', () => {
  it('returns null for a hotel with no report expectations, so the caller falls back', () => {
    // This is THE regression guard for skip-PMS / manual hotels. If this ever
    // returns an all-unavailable status instead of null, every manual hotel's
    // dashboard tiles and housekeeper board go neutral overnight.
    assert.equal(feedStatusFromHealth([]), null);
  });

  it('returns null when the hotel has expectations but none for a rendered feed', () => {
    // A catalog feed no surface renders (housekeeping) must not paint every
    // tile 'unavailable' by itself.
    const status = feedStatusFromHealth([row({ feedKey: 'housekeeping', label: 'Housekeeping' })]);
    assert.equal(status, null);
  });

  it('a hotel WITH expectations is reported as live-mode with per-feed states', () => {
    const status = feedStatusFromHealth(ALL_FIVE);
    assert.ok(status);
    assert.equal(status.mode, 'live');
    assert.equal(status.connection, 'healthy');
    assert.deepEqual(status.feeds, {
      roomStatus: 'live',
      arrivals: 'live',
      departures: 'live',
      workOrders: 'live',
      dashboardCounts: 'live',
    });
  });

  it('a feed with no expectation row for a configured hotel reads unavailable, not live', () => {
    const status = feedStatusFromHealth([row({ feedKey: 'roomStatus' })]);
    assert.ok(status);
    assert.equal(status.feeds.roomStatus, 'live');
    // We are honestly not expecting the other four from this hotel.
    assert.equal(status.feeds.workOrders, 'unavailable');
    assert.equal(status.feeds.dashboardCounts, 'unavailable');
  });

  it('a disabled expectation reads unavailable — someone switched that report off', () => {
    const status = feedStatusFromHealth([
      ...ALL_FIVE.slice(0, 4),
      row({ feedKey: 'dashboardCounts', required: false, enabled: false, state: 'unavailable' }),
    ]);
    assert.ok(status);
    assert.equal(status.feeds.dashboardCounts, 'unavailable');
  });
});

describe('feedStatusFromHealth — what replaced isDataPending', () => {
  it('every expected report has never arrived → connection pending', () => {
    const never = ALL_FIVE.map((r) =>
      ({ ...r, lastReportAt: null, lastDeliveryAt: null, lastSignalAt: null, minutesLate: null, state: 'learning' as const }));
    const status = feedStatusFromHealth(never);
    assert.ok(status);
    assert.equal(status.connection, 'pending');
    assert.equal(isDataPending(status), true);
  });

  it('one report has arrived → connection healthy, even if the rest have not', () => {
    const mixed = [
      row({ feedKey: 'roomStatus' }),
      ...ALL_FIVE.slice(1).map((r) =>
        ({ ...r, lastReportAt: null, lastDeliveryAt: null, lastSignalAt: null, state: 'learning' as const })),
    ];
    const status = feedStatusFromHealth(mixed);
    assert.ok(status);
    assert.equal(status.connection, 'healthy');
    assert.equal(isDataPending(status), false);
  });

  it('disabled feeds do not count toward "never received"', () => {
    const status = feedStatusFromHealth([
      row({ feedKey: 'roomStatus', enabled: false, state: 'unavailable', lastSignalAt: null }),
      row({ feedKey: 'arrivals', lastSignalAt: '2026-07-24T11:40:00.000Z' }),
    ]);
    assert.ok(status);
    assert.equal(status.connection, 'healthy');
  });
});

// ─── stale: real but old ───────────────────────────────────────────────────

describe('the 4th state — a stale number is SHOWN with a stamp, not blanked', () => {
  const stale = ALL_FIVE.map((r) => ({ ...r, state: 'stale' as const, minutesLate: 45 }));

  it('countsTrusted stays true (the number came from a real report)', () => {
    const status = feedStatusFromHealth(stale);
    assert.ok(status);
    assert.equal(countsTrusted(status), true);
  });

  it('countsFresh goes false (nothing may speak first off it)', () => {
    const status = feedStatusFromHealth(stale);
    assert.ok(status);
    assert.equal(countsFresh(status), false);
  });

  it('stale is reported separately from learning, so it renders a chip not a banner', () => {
    const status = feedStatusFromHealth(stale);
    assert.ok(status);
    assert.equal(isStale(status), true);
    assert.deepEqual(staleFeeds(status).sort(), [
      'arrivals', 'dashboardCounts', 'departures', 'roomStatus', 'workOrders',
    ]);
    assert.deepEqual(learningFeeds(status), []);
  });

  it('a learning feed still blanks the counts — the number is NOT real there', () => {
    const learning = [
      ...ALL_FIVE.slice(0, 4),
      row({ feedKey: 'dashboardCounts', required: false, state: 'learning', openUnmappedCount: 1 }),
    ];
    const status = feedStatusFromHealth(learning);
    assert.ok(status);
    assert.equal(countsTrusted(status), false);
    assert.equal(countsFresh(status), false);
  });

  it('a required feed that is stale does NOT flip isPartial — only learning does', () => {
    const status = feedStatusFromHealth(stale);
    assert.ok(status);
    assert.equal(status.isPartial, false);

    const learning = feedStatusFromHealth(
      ALL_FIVE.map((r) => (r.feedKey === 'roomStatus' ? { ...r, state: 'learning' as const } : r)),
    );
    assert.ok(learning);
    assert.equal(learning.isPartial, true);
  });
});

describe('freshness — the D4 heartbeat seam', () => {
  it('carries the newest report signal, tagged as the ingest heartbeat', () => {
    const status = feedStatusFromHealth([
      row({ feedKey: 'roomStatus', lastSignalAt: '2026-07-24T11:40:00.000Z' }),
      row({ feedKey: 'arrivals', lastSignalAt: '2026-07-24T13:05:00.000Z' }),
    ]);
    assert.ok(status);
    assert.equal(status.freshness?.capturedAt, '2026-07-24T13:05:00.000Z');
    assert.equal(status.freshness?.source, 'heartbeat');
  });

  it('reports "no capture time" rather than inventing one when nothing has arrived', () => {
    const status = feedStatusFromHealth(ALL_FIVE.map((r) => ({ ...r, lastSignalAt: null })));
    assert.ok(status);
    assert.equal(status.freshness?.capturedAt, null);
    assert.equal(status.freshness?.source, 'none');
  });

  it('newestSignalAt ignores feeds that never reported', () => {
    assert.equal(
      newestSignalAt([
        row({ lastSignalAt: null }),
        row({ lastSignalAt: '2026-07-24T09:00:00.000Z' }),
        row({ lastSignalAt: '2026-07-24T10:00:00.000Z' }),
      ]),
      '2026-07-24T10:00:00.000Z',
    );
    assert.equal(newestSignalAt([row({ lastSignalAt: null })]), null);
  });
});

// ─── Alert policy ──────────────────────────────────────────────────────────

describe('evaluateFeedSlos — what actually wakes somebody up', () => {
  it('a fleet with no expectations configured is ok, not warn', () => {
    const v = evaluateFeedSlos([]);
    assert.equal(v.status, 'ok');
    assert.equal(v.propertiesEvaluated, 0);
  });

  it('a feed inside its grace window is ok', () => {
    assert.equal(evaluateFeedSlos(ALL_FIVE).status, 'ok');
  });

  it('a feed past its grace warns', () => {
    const v = evaluateFeedSlos([row({ state: 'stale', minutesLate: 25, graceMinutes: 20 })]);
    assert.equal(v.status, 'warn');
    assert.equal(v.breaches.length, 1);
    assert.equal(v.breaches[0]!.severity, 'warn');
  });

  it('past 2x grace on a REQUIRED doctor_fail feed escalates to fail', () => {
    const v = evaluateFeedSlos([
      row({ state: 'stale', minutesLate: 41, graceMinutes: 20, required: true, alertChannel: 'doctor_fail' }),
    ]);
    assert.equal(v.status, 'fail');
    assert.equal(v.breaches[0]!.severity, 'fail');
  });

  it('past 2x grace on a NON-required feed stays a warn', () => {
    const v = evaluateFeedSlos([
      row({ feedKey: 'dashboardCounts', state: 'stale', minutesLate: 200, graceMinutes: 20, required: false, alertChannel: 'doctor_fail' }),
    ]);
    assert.equal(v.status, 'warn');
  });

  it('exactly 2x grace does not yet fail — the escalation is strictly past it', () => {
    const v = evaluateFeedSlos([
      row({ state: 'stale', minutesLate: 40, graceMinutes: 20, required: true, alertChannel: 'doctor_fail' }),
    ]);
    assert.equal(v.status, 'warn');
  });

  it('alert_channel "none" opts a feed out entirely', () => {
    const v = evaluateFeedSlos([
      row({ state: 'stale', minutesLate: 500, graceMinutes: 20, required: true, alertChannel: 'none' }),
    ]);
    assert.equal(v.status, 'ok');
  });

  it('a disabled expectation is not a breach', () => {
    const v = evaluateFeedSlos([
      row({ enabled: false, state: 'unavailable', minutesLate: 999, alertChannel: 'doctor_fail' }),
    ]);
    assert.equal(v.status, 'ok');
  });

  it('a learning feed is not a LATE feed — that is the mapping problem, reported elsewhere', () => {
    const v = evaluateFeedSlos([
      row({ state: 'learning', minutesLate: null, openUnmappedCount: 1, alertChannel: 'doctor_fail' }),
    ]);
    assert.equal(v.status, 'ok');
  });

  it('two hotels on DIFFERENT cadences are both judged by the same code, no branches', () => {
    // Hotel A: 30-minute interval, 20-minute grace, 25 late → warn.
    // Hotel B: daily 03:00, 120-minute grace, 300 late on a required
    // doctor_fail feed → fail. One function, two rows, zero cadence branches.
    const v = evaluateFeedSlos([
      row({ propertyId: 'aaaaaaaa-0000-0000-0000-000000000001', cadenceKind: 'interval', expectedEveryMinutes: 30, graceMinutes: 20, minutesLate: 25, state: 'stale' }),
      row({
        propertyId: 'bbbbbbbb-0000-0000-0000-000000000002',
        feedKey: 'workOrders',
        cadenceKind: 'daily_at',
        expectedEveryMinutes: null,
        expectedAtLocal: '03:00:00',
        graceMinutes: 120,
        minutesLate: 300,
        required: true,
        alertChannel: 'doctor_fail',
        state: 'stale',
      }),
    ]);
    assert.equal(v.status, 'fail');
    assert.equal(v.propertiesEvaluated, 2);
    assert.equal(v.breaches.length, 2);
    // Worst first, so a truncated detail line always shows the real problem.
    assert.equal(v.breaches[0]!.severity, 'fail');
  });
});

describe('evaluateQuarantineBacklog — backlog warns, a total reject fails', () => {
  it('an empty queue is ok', () => {
    assert.equal(evaluateQuarantineBacklog({ perProperty: [] }).status, 'ok');
  });

  it('a few bad rows do not warn — they certainly do not blank the hotel', () => {
    const v = evaluateQuarantineBacklog({ perProperty: [{ propertyId: PID, openRows: 5 }] });
    assert.equal(v.status, 'ok');
  });

  it('a real backlog warns', () => {
    const v = evaluateQuarantineBacklog({ perProperty: [{ propertyId: PID, openRows: 40 }] });
    assert.equal(v.status, 'warn');
    assert.match(v.detail, /40 rows/);
  });

  it('a delivery where EVERY row was rejected fails — that is a format change', () => {
    const v = evaluateQuarantineBacklog({ perProperty: [], allRejectedDeliveriesLastHour: 1 });
    assert.equal(v.status, 'fail');
  });
});

describe('evaluateUnmappedColumns', () => {
  it('is ok with nothing open', () => {
    assert.equal(evaluateUnmappedColumns([]).status, 'ok');
  });

  it('warns and names the report and column so it can be acted on', () => {
    const v = evaluateUnmappedColumns([
      { propertyId: PID, reportType: 'Arrivals', columnLabel: 'Loyalty Tier' },
    ]);
    assert.equal(v.status, 'warn');
    assert.match(v.detail, /Arrivals/);
    assert.match(v.detail, /Loyalty Tier/);
  });

  it('never escalates to fail — the value is already captured in raw->_unmapped', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      propertyId: PID, reportType: 'Arrivals', columnLabel: `col${i}`,
    }));
    assert.equal(evaluateUnmappedColumns(many).status, 'warn');
  });
});

// ─── The anomaly / alert line ──────────────────────────────────────────────

describe('anomalies flag, they never alert', () => {
  it('the doctor verdict is unchanged by anomaly volume, but moves on an all-rejected batch', () => {
    // The structural guarantee: there is no input on any doctor evaluator
    // through which an anomaly can travel. Adding one would be a compile
    // error, and this test is what makes that a deliberate act rather than a
    // silent one.
    const before = evaluateQuarantineBacklog({ perProperty: [{ propertyId: PID, openRows: 3 }] });
    assert.equal(before.status, 'ok');
    const after = evaluateQuarantineBacklog({
      perProperty: [{ propertyId: PID, openRows: 3 }],
      allRejectedDeliveriesLastHour: 0,
    });
    assert.equal(after.status, 'ok');
    assert.equal(
      evaluateQuarantineBacklog({
        perProperty: [{ propertyId: PID, openRows: 3 }],
        allRejectedDeliveriesLastHour: 2,
      }).status,
      'fail',
    );
  });
});

// ─── Parsing ───────────────────────────────────────────────────────────────

describe('parseFeedHealthRow', () => {
  it('reads a PostgREST row, including numerics that arrive as strings', () => {
    const parsed = parseFeedHealthRow({
      property_id: PID,
      feed_key: 'roomStatus',
      label: 'Room status',
      required: true,
      target_table: 'pms_room_status_log',
      enabled: true,
      cadence_kind: 'interval',
      expected_every_minutes: 30,
      grace_minutes: 20,
      alert_channel: 'doctor_fail',
      last_signal_at: '2026-07-24T11:40:00.000Z',
      minutes_late: '45.5',
      open_quarantine_count: 3,
      open_unmapped_count: 0,
      state: 'stale',
    });
    assert.ok(parsed);
    assert.equal(parsed.minutesLate, 45.5);
    assert.equal(parsed.alertChannel, 'doctor_fail');
    assert.equal(parsed.state, 'stale');
  });

  it('refuses a row whose state is outside the known vocabulary', () => {
    // An unrecognised state must never be coerced into a confident 'live'.
    assert.equal(
      parseFeedHealthRow({ property_id: PID, feed_key: 'roomStatus', state: 'probably_fine' }),
      null,
    );
  });

  it('drops unusable rows without dropping the batch', () => {
    const rows = parseFeedHealthRows([
      { property_id: PID, feed_key: 'roomStatus', state: 'live', grace_minutes: 20, enabled: true },
      { property_id: PID, feed_key: 'arrivals', state: 'nonsense' },
      null,
    ]);
    assert.equal(rows.length, 1);
  });

  it('a non-array response yields no rows rather than throwing', () => {
    assert.deepEqual(parseFeedHealthRows(null), []);
    assert.deepEqual(parseFeedHealthRows({ property_id: PID }), []);
  });
});

describe('requiredFeedKeys — "required" comes from the catalog, not a constant', () => {
  it('reads required off the rows so a second hardcoded list cannot drift', () => {
    const keys = requiredFeedKeys(ALL_FIVE).sort();
    assert.deepEqual(keys, ['arrivals', 'departures', 'roomStatus', 'workOrders']);
  });

  it('a disabled required feed is not counted', () => {
    const keys = requiredFeedKeys([row({ feedKey: 'roomStatus', required: true, enabled: false })]);
    assert.deepEqual(keys, []);
  });
});
