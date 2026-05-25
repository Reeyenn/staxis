/**
 * Tests for the weekly-report Sunday-cron-ordering fallback:
 * if the daily cron hasn't yet stored Sunday's report_runs row by the
 * time the weekly cron runs (they share the same 30-min tick window),
 * the weekly aggregator should detect the missing day and build it
 * inline before computing the week total. Without this the week is
 * biased ~14% low (6 days of data instead of 7).
 *
 * Strategy: stub supabaseAdmin so report_runs returns only 6 of the 7
 * Mon–Sun days, then assert that buildWeeklyReport's accumulated
 * rooms-cleaned reflects all 7 — meaning the missing Sunday was
 * inline-built and folded in.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { buildWeeklyReport } from '@/lib/reports/weekly-report';
import type { DailyReportPayload } from '@/lib/reports/types';

const PROPERTY_ID = '00000000-0000-0000-0000-000000000010';
const SUNDAY = '2026-05-24';            // Sunday at the end of the week
const MONDAY = '2026-05-18';            // Start of the week
const ROOMS_PER_DAY = 10;
const SUNDAY_LIVE_ROOMS = 12;           // Different number so we can prove it came from the live build, not from stored payloads

interface StubReportRun {
  report_date: string;
  report_payload: DailyReportPayload;
}

interface MockState {
  /** Stored daily payloads we'll return from report_runs SELECT. */
  storedDailies: StubReportRun[];
  /** Whether the inline buildDailyReport for SUNDAY was called. */
  inlineBuildCalledForSunday: boolean;
  /**
   * If non-null, the race-recheck SELECT for Sunday's report_runs row
   * returns this payload (simulating the daily cron landing its row
   * between our initial load and the inline rebuild completing).
   */
  raceRecheckPayload: DailyReportPayload | null;
}

let state: MockState;
const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalAuth = supabaseAdmin.auth;

function dailyPayload(date: string, rooms: number): DailyReportPayload {
  return {
    propertyId: PROPERTY_ID,
    propertyName: 'Test Inn',
    reportDate: date,
    timezone: 'UTC',
    operations: {
      roomsCleanedToday: rooms,
      totalRoomsOnBoard: rooms,
      roomsOOO: 0, roomsOOS: 0,
      occupancyPct: 70,
      avgMinutesPerDeparture: 30,
      avgMinutesPerStayover: 20,
      avgMinutesPerDeepClean: 90,
      roomsPerHousekeeper: 5,
    },
    quality: {
      inspectionsCompleted: 0, inspectionsPassed: 0,
      passRatePct: 0, reclearRequestedCount: 0, reclearRatePct: 0,
      topFailureReasons: [],
    },
    labor: {
      totalHoursWorked: 0, totalOvertimeHours: 0,
      costPerOccupiedRoomCents: 0, laborCostCents: 0,
      laborBudgetCents: null, sickCalloutsToday: 0,
    },
    issues: { workOrdersCreatedToday: 0, urgentItemsStillPending: 0 },
    tomorrow: {
      arrivals: 0, departures: 0, projectedRoomsToClean: 0,
      recommendedHeadcount: null, recommendedLaborCostCents: null,
      roomsPendingOOO: 0, roomsPendingInspection: 0,
    },
    anomalies: [],
    dashboardUrl: 'https://x/housekeeping',
  };
}

function chainable<T>(value: T) {
  // A minimal PostgREST-style chainable that resolves to `{ data: value, error: null }`
  // for any sequence of .select/.eq/.gte/.lte/.in/.order/.limit/.maybeSingle.
  const promise = Promise.resolve({ data: value, error: null });
  const chain: Record<string, unknown> = {};
  const passthroughs = ['select', 'eq', 'gte', 'lte', 'in', 'lt', 'order', 'limit', 'or'];
  for (const k of passthroughs) chain[k] = () => chain;
  chain.maybeSingle = async () => ({ data: Array.isArray(value) ? value[0] ?? null : value, error: null });
  chain.then = promise.then.bind(promise);
  chain.catch = promise.catch.bind(promise);
  return chain as unknown as ReturnType<typeof supabaseAdmin.from>;
}

function installStub() {
  (supabaseAdmin as { auth: unknown }).auth = {
    admin: { listUsers: async () => ({ data: { users: [] }, error: null }) },
  };
  (supabaseAdmin as { from: unknown }).from = (table: string) => {
    if (table === 'properties') {
      return chainable({
        id: PROPERTY_ID, name: 'Test Inn', timezone: 'UTC',
        total_rooms: 100, weekly_budget: null,
      });
    }
    if (table === 'report_runs') {
      // Two different report_runs query shapes hit this stub:
      //   (a) Initial week load: .select(...).eq(...).eq(...).gte(...).lte(...).order(...)
      //       — resolves to the stored daily list (await on the chain).
      //   (b) Race-recheck after inline rebuild: .select(...).eq(...).eq(...).eq(...).maybeSingle()
      //       — resolves to a single row (or null) for Sunday only.
      // The chainable's .then resolves with state.storedDailies and the
      // .maybeSingle override returns state.raceRecheckPayload — so the
      // two branches share one stub.
      const c = chainable(state.storedDailies);
      (c as unknown as { maybeSingle: () => Promise<unknown> }).maybeSingle = async () => ({
        data: state.raceRecheckPayload === null
          ? null
          : { report_payload: state.raceRecheckPayload },
        error: null,
      });
      return c;
    }
    // `callout_events` is unique to buildDailyReport — buildWeeklyReport
    // never queries it. So this is our signal that the inline rebuild
    // for Sunday actually ran.
    if (table === 'callout_events') {
      state.inlineBuildCalledForSunday = true;
      return chainable([]);
    }
    // For the cleaning_tasks query specifically inside the inline
    // buildDailyReport (business_date = SUNDAY), return enough rows to
    // produce SUNDAY_LIVE_ROOMS completed tasks. buildWeeklyReport also
    // hits cleaning_tasks (for the week's per-cleaning-type averages),
    // but it filters by gte/lte on business_date so a wide row list is
    // accepted by both — the test only asserts the count, not the type
    // breakdown.
    if (table === 'cleaning_tasks') {
      const rows = Array.from({ length: SUNDAY_LIVE_ROOMS }, (_, i) => ({
        id: `t${i}`, cleaning_type: 'departure', status: 'completed',
        started_at: `${SUNDAY}T08:00:00Z`, completed_at: `${SUNDAY}T08:30:00Z`,
        assignee_id: null, requires_inspection: false,
      }));
      return chainable(rows);
    }
    if (table === 'pms_in_house_snapshot') {
      return chainable(null);
    }
    // Default: empty list (works for inspections, work orders, staff, hk_assignments, pms_reservations).
    return chainable([]);
  };
}

function restoreStub() {
  (supabaseAdmin as { from: unknown }).from = originalFrom;
  (supabaseAdmin as { auth: unknown }).auth = originalAuth;
}

beforeEach(() => {
  state = { storedDailies: [], inlineBuildCalledForSunday: false, raceRecheckPayload: null };
  installStub();
});

afterEach(restoreStub);

describe('buildWeeklyReport — Sunday-cron-ordering fallback', () => {
  test('builds Sunday daily inline when report_runs has only Mon–Sat', async () => {
    // Pre-seed Mon–Sat (6 days) of daily payloads.
    const monThruSat = ['2026-05-18', '2026-05-19', '2026-05-20', '2026-05-21', '2026-05-22', '2026-05-23'];
    state.storedDailies = monThruSat.map(d => ({
      report_date: d,
      report_payload: dailyPayload(d, ROOMS_PER_DAY),
    }));

    const result = await buildWeeklyReport({ propertyId: PROPERTY_ID, reportDate: SUNDAY });
    assert.ok(result, 'expected a weekly payload');
    // The Sunday inline rebuild should have been triggered.
    assert.ok(state.inlineBuildCalledForSunday, 'expected inline daily build for Sunday');
    // 6 days * 10 rooms + 1 inline Sunday day * 12 rooms = 72 rooms.
    assert.equal(result.operations.roomsCleanedToday, 6 * ROOMS_PER_DAY + SUNDAY_LIVE_ROOMS);
  });

  test('does NOT rebuild when Sunday already exists in report_runs', async () => {
    const allSeven = ['2026-05-18', '2026-05-19', '2026-05-20', '2026-05-21', '2026-05-22', '2026-05-23', SUNDAY];
    state.storedDailies = allSeven.map(d => ({
      report_date: d,
      report_payload: dailyPayload(d, ROOMS_PER_DAY),
    }));

    const result = await buildWeeklyReport({ propertyId: PROPERTY_ID, reportDate: SUNDAY });
    assert.ok(result);
    assert.equal(state.inlineBuildCalledForSunday, false, 'should NOT re-build when Sunday already stored');
    // All 7 days from stored payloads (all 10 rooms each).
    assert.equal(result.operations.roomsCleanedToday, 7 * ROOMS_PER_DAY);
    assert.equal(MONDAY, result.weekStartDate);
  });

  test('race-recheck: prefers canonical daily payload if it lands mid-build', async () => {
    // Pre-seed Mon–Sat only — Sunday missing on the initial load.
    const monThruSat = ['2026-05-18', '2026-05-19', '2026-05-20', '2026-05-21', '2026-05-22', '2026-05-23'];
    state.storedDailies = monThruSat.map(d => ({
      report_date: d,
      report_payload: dailyPayload(d, ROOMS_PER_DAY),
    }));
    // Simulate the daily cron landing a CANONICAL Sunday row between
    // our initial load and the recheck — different rooms count so we
    // can prove the recheck row won over our inline-built copy.
    const CANONICAL_SUNDAY_ROOMS = 99;
    state.raceRecheckPayload = dailyPayload(SUNDAY, CANONICAL_SUNDAY_ROOMS);

    const result = await buildWeeklyReport({ propertyId: PROPERTY_ID, reportDate: SUNDAY });
    assert.ok(result);
    assert.ok(state.inlineBuildCalledForSunday, 'inline build attempted before recheck');
    // 6 days × 10 + 1 canonical Sunday × 99 = 159. The inline rebuild's
    // own SUNDAY_LIVE_ROOMS (12) would have produced 72, so the assert
    // proves the recheck row replaced our inline copy.
    assert.equal(result.operations.roomsCleanedToday, 6 * ROOMS_PER_DAY + CANONICAL_SUNDAY_ROOMS);
  });

  test('null report_payload on a stored row is skipped (not counted as 0)', async () => {
    // Mon–Sat with one of them having a null payload (e.g. a partially-
    // initialized report_runs row from a cron that crashed mid-build).
    state.storedDailies = [
      { report_date: '2026-05-18', report_payload: dailyPayload('2026-05-18', ROOMS_PER_DAY) },
      { report_date: '2026-05-19', report_payload: null as unknown as DailyReportPayload },  // null!
      { report_date: '2026-05-20', report_payload: dailyPayload('2026-05-20', ROOMS_PER_DAY) },
      { report_date: '2026-05-21', report_payload: dailyPayload('2026-05-21', ROOMS_PER_DAY) },
      { report_date: '2026-05-22', report_payload: dailyPayload('2026-05-22', ROOMS_PER_DAY) },
      { report_date: '2026-05-23', report_payload: dailyPayload('2026-05-23', ROOMS_PER_DAY) },
      { report_date: SUNDAY,       report_payload: dailyPayload(SUNDAY,       ROOMS_PER_DAY) },
    ];

    const result = await buildWeeklyReport({ propertyId: PROPERTY_ID, reportDate: SUNDAY });
    assert.ok(result);
    // 6 valid days * 10 = 60. The null payload is skipped, not folded
    // as 0 (which would silently bias the week down by ~14%).
    assert.equal(result.operations.roomsCleanedToday, 6 * ROOMS_PER_DAY);
  });

  test('inline rebuild error does not throw the whole weekly build', async () => {
    // Pre-seed only weekday data so the fallback fires.
    state.storedDailies = ['2026-05-18', '2026-05-19', '2026-05-20'].map(d => ({
      report_date: d,
      report_payload: dailyPayload(d, ROOMS_PER_DAY),
    }));
    // Override the from() stub so the daily-only query (pms_reservations)
    // throws — this simulates a partial DB outage during the inline
    // rebuild. The week-wide cleaning_tasks query that buildWeeklyReport
    // itself runs is unaffected, so the weekly should still complete with
    // the 3 stored daily payloads counted.
    (supabaseAdmin as { from: unknown }).from = (table: string) => {
      if (table === 'properties') {
        return chainable({ id: PROPERTY_ID, name: 'Test Inn', timezone: 'UTC', total_rooms: 100, weekly_budget: null });
      }
      if (table === 'report_runs') return chainable(state.storedDailies);
      // pms_reservations is queried only by buildDailyReport — throwing
      // here forces the inline rebuild to error.
      if (table === 'pms_reservations') {
        state.inlineBuildCalledForSunday = true;
        throw new Error('simulated DB outage during inline rebuild');
      }
      return chainable([]);
    };

    // The build should still succeed (the inline rebuild failure is logged
    // but swallowed — same posture as missing-baseline failures).
    const result = await buildWeeklyReport({ propertyId: PROPERTY_ID, reportDate: SUNDAY });
    assert.ok(result, 'weekly build should not throw on inline rebuild error');
    // The 3 stored days are still counted; Sunday was attempted but failed.
    assert.equal(state.inlineBuildCalledForSunday, true);
    assert.equal(result.operations.roomsCleanedToday, 3 * ROOMS_PER_DAY);
  });
});
