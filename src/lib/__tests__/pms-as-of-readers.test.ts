/**
 * RESTATED REPORTS MUST COUNT ONCE.
 *
 * Migration 0343 made the daily facts restatable: a corrected report lands as a
 * NEW as_of generation next to the one it corrects, keyed
 * (property_id, business_date, as_of). Nothing is deleted, so what the hotel
 * believed on Tuesday morning stays queryable forever.
 *
 * That is only safe if every RANGE reader moves to the _current views. Summing
 * the base table over a month adds both generations of the same Tuesday, and
 * the owner is shown revenue the hotel never earned — the exact
 * "number without a receipt" failure the as-of grain exists to prevent.
 *
 * The fixture below is the trap: `pms_revenue_daily` holds two generations of
 * one day, `pms_revenue_daily_current` holds one. A reader pointed at the base
 * table returns double and fails; a reader on the view returns the corrected
 * figure. Same shape for payments and the forecast.
 *
 * Also covers get_future_bookings, which was rewritten off the dropped
 * pms_future_bookings table onto pms_reservations + pms_booking_pace.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { getMonthRevenue, getOccupancyPacingFactor } from '@/lib/financials/revenue';
import { getTool, type ToolContext } from '@/lib/agent/tools';
import '@/lib/agent/tools/pms-feeds';

const PID = '22222222-2222-2222-2222-222222222222';

type Row = Record<string, unknown>;

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);

/** Relations the last run touched, in order. Lets a test assert that the
 *  reader went to the view and not the base table even when both happen to
 *  return the same number for that particular fixture. */
let touched: string[] = [];

/**
 * A PostgREST-shaped stub over an in-memory relation map. Supports only the
 * chains these readers actually use: eq / gte / gt / lte / lt, order (repeated),
 * limit, maybeSingle, and awaiting the builder directly.
 */
function installStore(store: Record<string, Row[]>) {
  // @ts-expect-error monkey-patch the singleton for the test
  supabaseAdmin.from = (relation: string) => {
    touched.push(relation);
    const rows = store[relation];
    if (!rows) {
      // Mirror PostgREST's behavior for an unknown relation: an error, not an
      // empty list. A reader still pointed at a dropped table must FAIL here.
      const errored: Record<string, unknown> = {
        select: () => errored,
        eq: () => errored,
        gt: () => errored,
        gte: () => errored,
        lt: () => errored,
        lte: () => errored,
        order: () => errored,
        limit: () => errored,
        maybeSingle: async () => ({ data: null, error: { message: `relation "${relation}" does not exist`, code: '42P01' } }),
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: null, error: { message: `relation "${relation}" does not exist`, code: '42P01' } }).then(resolve),
      };
      return errored;
    }

    const preds: Array<(r: Row) => boolean> = [];
    const sorts: Array<{ col: string; asc: boolean }> = [];
    let cap: number | null = null;

    const evaluate = (): Row[] => {
      let out = rows.filter((r) => preds.every((p) => p(r)));
      for (const s of [...sorts].reverse()) {
        out = [...out].sort((a, b) => {
          const av = String(a[s.col] ?? '');
          const bv = String(b[s.col] ?? '');
          return s.asc ? av.localeCompare(bv) : bv.localeCompare(av);
        });
      }
      if (cap != null) out = out.slice(0, cap);
      return out;
    };

    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (col: string, val: unknown) => { preds.push((r) => r[col] === val); return builder; },
      gt: (col: string, val: unknown) => { preds.push((r) => String(r[col]) > String(val)); return builder; },
      gte: (col: string, val: unknown) => { preds.push((r) => String(r[col]) >= String(val)); return builder; },
      lt: (col: string, val: unknown) => { preds.push((r) => String(r[col]) < String(val)); return builder; },
      lte: (col: string, val: unknown) => { preds.push((r) => String(r[col]) <= String(val)); return builder; },
      order: (col: string, opts?: { ascending?: boolean }) => {
        sorts.push({ col, asc: opts?.ascending !== false });
        return builder;
      },
      limit: (n: number) => { cap = n; return builder; },
      maybeSingle: async () => {
        const out = evaluate();
        if (out.length > 1) {
          // PostgREST really does error here, and that error is the symptom a
          // reader left on a restatable base table would hit in production.
          return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } };
        }
        return { data: out[0] ?? null, error: null };
      },
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: evaluate(), error: null }).then(resolve),
    };
    return builder;
  };
}

/** One business day, restated. The morning report said $1,000; the corrected
 *  afternoon report said $1,200. Both rows live in the base table forever. */
const REVENUE_BASE: Row[] = [
  { property_id: PID, business_date: '2026-06-09', as_of: '2026-06-10T08:00:00Z', total_revenue_cents: 100_000, occupied_rooms: 40 },
  { property_id: PID, business_date: '2026-06-09', as_of: '2026-06-10T16:00:00Z', total_revenue_cents: 120_000, occupied_rooms: 45 },
  { property_id: PID, business_date: '2026-06-10', as_of: '2026-06-11T08:00:00Z', total_revenue_cents: 90_000, occupied_rooms: 38 },
];
/** What DISTINCT ON (property_id, business_date) ORDER BY … as_of DESC gives. */
const REVENUE_CURRENT: Row[] = [REVENUE_BASE[1], REVENUE_BASE[2]];

describe('a restated day counts ONCE', () => {
  beforeEach(() => { touched = []; });
  afterEach(() => { supabaseAdmin.from = originalFrom; });

  test('getMonthRevenue sums the corrected figure, not both generations', async () => {
    installStore({
      pms_revenue_daily: REVENUE_BASE,
      pms_revenue_daily_current: REVENUE_CURRENT,
    });
    const r = await getMonthRevenue(PID, '2026-06');
    // $1,200 (corrected 6/9) + $900 (6/10) = $2,100. Reading the base table
    // would give $3,100 — a thousand dollars of revenue that never happened.
    assert.equal(r.revenueCents, 210_000);
    assert.equal(r.occupiedRoomNights, 83, 'room-nights double-count the same way money does');
    assert.equal(r.revenueIsLive, true);
  });

  test('… and it gets there by reading the _current view', async () => {
    installStore({
      pms_revenue_daily: REVENUE_BASE,
      pms_revenue_daily_current: REVENUE_CURRENT,
    });
    await getMonthRevenue(PID, '2026-06');
    assert.ok(touched.includes('pms_revenue_daily_current'), `expected the _current view, saw ${touched.join(', ')}`);
    assert.ok(!touched.includes('pms_revenue_daily'), 'the base table must not be range-summed');
  });

  test('cold start is still null, never 0 — a corrected-away month is not $0 of sales', async () => {
    installStore({ pms_revenue_daily: [], pms_revenue_daily_current: [] });
    const r = await getMonthRevenue(PID, '2026-06');
    assert.equal(r.revenueCents, null);
    assert.equal(r.occupiedRoomNights, null);
    assert.equal(r.revenueIsLive, false);
  });

  test('the month window is still half-open on business_date', async () => {
    installStore({
      pms_revenue_daily_current: [
        { property_id: PID, business_date: '2026-05-31', as_of: 'x', total_revenue_cents: 999_999, occupied_rooms: 1 },
        { property_id: PID, business_date: '2026-06-01', as_of: 'x', total_revenue_cents: 100, occupied_rooms: 1 },
        { property_id: PID, business_date: '2026-07-01', as_of: 'x', total_revenue_cents: 999_999, occupied_rooms: 1 },
      ],
      pms_revenue_daily: [],
    });
    const r = await getMonthRevenue(PID, '2026-06');
    assert.equal(r.revenueCents, 100, 'neither neighbouring month may leak in');
  });

  test('another tenant\'s restatement never reaches this hotel', async () => {
    installStore({
      pms_revenue_daily_current: [
        ...REVENUE_CURRENT,
        { property_id: 'other-hotel', business_date: '2026-06-09', as_of: 'z', total_revenue_cents: 500_000, occupied_rooms: 100 },
      ],
      pms_revenue_daily: REVENUE_BASE,
    });
    const r = await getMonthRevenue(PID, '2026-06');
    assert.equal(r.revenueCents, 210_000);
  });
});

describe('forecast pacing reads one vintage per day', () => {
  beforeEach(() => { touched = []; });
  afterEach(() => { supabaseAdmin.from = originalFrom; });

  test('re-forecasting one day does not weight it more heavily than the others', async () => {
    // pms_forecast_daily has always been keyed (forecast_date, snapshot_date),
    // so the base table holds every vintage. Averaging over it lets whichever
    // day got re-forecast most often dominate the pacing factor.
    const base: Row[] = [
      { property_id: PID, forecast_date: '2026-06-05', snapshot_date: '2026-06-01', projected_occupancy_pct: 50 },
      { property_id: PID, forecast_date: '2026-06-05', snapshot_date: '2026-06-02', projected_occupancy_pct: 50 },
      { property_id: PID, forecast_date: '2026-06-05', snapshot_date: '2026-06-03', projected_occupancy_pct: 50 },
      { property_id: PID, forecast_date: '2026-06-20', snapshot_date: '2026-06-03', projected_occupancy_pct: 100 },
    ];
    installStore({
      pms_forecast_daily: base,
      pms_forecast_daily_current: [base[2], base[3]],
    });
    const factor = await getOccupancyPacingFactor(PID, '2026-06', '2026-06-10');
    // One elapsed day at 50%, one remaining day at 100% → 2.0, clamped to 1.5.
    assert.equal(factor, 1.5);
    assert.ok(touched.includes('pms_forecast_daily_current'));
    assert.ok(!touched.includes('pms_forecast_daily'));
  });
});

// ─── Agent tools ────────────────────────────────────────────────────────────

function ctx(): ToolContext {
  return {
    user: {
      uid: 'u1', accountId: 'a1', username: 'gm', displayName: 'GM',
      role: 'general_manager', propertyAccess: [PID],
    },
    propertyId: PID,
    staffId: null,
    requestId: 'req-test',
  } as ToolContext;
}

describe('get_payments_summary survives a restated day', () => {
  beforeEach(() => { touched = []; });
  afterEach(() => { supabaseAdmin.from = originalFrom; });

  test('returns the corrected total instead of erroring on two rows', async () => {
    installStore({
      properties: [{ id: PID, timezone: 'America/Chicago' }],
      pms_payments_daily: [
        { property_id: PID, business_date: '2026-06-09', as_of: '2026-06-10T08:00:00Z', total_collected_cents: 100_000, cash_collected_cents: 0, card_collected_cents: 100_000, deposits_collected_cents: 0 },
        { property_id: PID, business_date: '2026-06-09', as_of: '2026-06-10T16:00:00Z', total_collected_cents: 120_000, cash_collected_cents: 0, card_collected_cents: 120_000, deposits_collected_cents: 0 },
      ],
      pms_payments_daily_current: [
        { property_id: PID, business_date: '2026-06-09', as_of: '2026-06-10T16:00:00Z', total_collected_cents: 120_000, cash_collected_cents: 0, card_collected_cents: 120_000, deposits_collected_cents: 0 },
      ],
    });
    const tool = getTool('get_payments_summary');
    assert.ok(tool, 'get_payments_summary must be registered');
    const res = await tool.handler({ date: '2026-06-09' } as never, ctx());
    assert.equal(res.ok, true);
    assert.equal((res.data as Record<string, unknown>).total, '$1,200.00');
    assert.ok(touched.includes('pms_payments_daily_current'));
    assert.ok(!touched.includes('pms_payments_daily'));
  });
});

describe('get_future_bookings after pms_future_bookings was dropped', () => {
  beforeEach(() => { touched = []; });
  afterEach(() => { supabaseAdmin.from = originalFrom; });

  const RESERVATIONS: Row[] = [
    { property_id: PID, pms_reservation_id: 'R1', guest_name: 'A', arrival_date: '2026-06-12', departure_date: '2026-06-14', status: 'booked', rate_per_night_cents: 12_000, total_amount_cents: 24_000 },
    { property_id: PID, pms_reservation_id: 'R2', guest_name: 'B', arrival_date: '2026-06-12', departure_date: '2026-06-13', status: null, rate_per_night_cents: 11_000, total_amount_cents: 11_000 },
    { property_id: PID, pms_reservation_id: 'R3', guest_name: 'C', arrival_date: '2026-06-13', departure_date: '2026-06-15', status: 'cancelled', rate_per_night_cents: 10_000, total_amount_cents: 20_000 },
  ];

  test('reads pms_reservations, never the dropped table', async () => {
    installStore({
      properties: [{ id: PID, timezone: 'America/Chicago' }],
      pms_reservations: RESERVATIONS,
      pms_booking_pace: [],
    });
    const tool = getTool('get_future_bookings');
    assert.ok(tool);
    const res = await tool.handler({ startDate: '2026-06-10', endDate: '2026-06-20' } as never, ctx());
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.ok(!touched.includes('pms_future_bookings'), 'the dropped table must never be queried');
    assert.ok(touched.includes('pms_reservations'));
  });

  test('cancelled reservations are not on the books', async () => {
    installStore({
      properties: [{ id: PID, timezone: 'America/Chicago' }],
      pms_reservations: RESERVATIONS,
      pms_booking_pace: [],
    });
    const res = await getTool('get_future_bookings')!.handler(
      { startDate: '2026-06-10', endDate: '2026-06-20' } as never, ctx(),
    );
    const data = res.data as Record<string, unknown>;
    assert.equal(data.totalBookings, 2, 'R3 is cancelled; a null status is still a real booking');
    assert.deepEqual(data.arrivalsByDate, { '2026-06-12': 2 });
  });

  test('the pickup curve is the whole point — one row per as-of, oldest first', async () => {
    installStore({
      properties: [{ id: PID, timezone: 'America/Chicago' }],
      pms_reservations: RESERVATIONS,
      pms_booking_pace: [
        { property_id: PID, stay_date: '2026-06-12', as_of_date: '2026-06-01', rooms_otb: 10, rooms_available: 60, revenue_otb_cents: 100_000 },
        { property_id: PID, stay_date: '2026-06-12', as_of_date: '2026-06-05', rooms_otb: 22, rooms_available: 60, revenue_otb_cents: 240_000 },
        { property_id: PID, stay_date: '2026-06-12', as_of_date: '2026-06-09', rooms_otb: 41, rooms_available: 60, revenue_otb_cents: 470_000 },
      ],
    });
    const res = await getTool('get_future_bookings')!.handler(
      { startDate: '2026-06-10', endDate: '2026-06-20' } as never, ctx(),
    );
    const data = res.data as Record<string, unknown>;
    const curve = (data.paceCurveByStayDate as Record<string, Array<{ asOf: string; rooms: number | null }>>)['2026-06-12'];
    assert.deepEqual(curve.map((p) => p.rooms), [10, 22, 41], 'the curve must build, not collapse to one number');
    assert.deepEqual(curve.map((p) => p.asOf), ['2026-06-01', '2026-06-05', '2026-06-09']);
    const latest = (data.onTheBooksByStayDate as Record<string, { rooms: number | null }>)['2026-06-12'];
    assert.equal(latest.rooms, 41, 'the newest as-of is what is on the books now');
  });

  test('a hotel with no pace report still gets its reservation list, and is told why', async () => {
    installStore({
      properties: [{ id: PID, timezone: 'America/Chicago' }],
      pms_reservations: RESERVATIONS,
      pms_booking_pace: [],
    });
    const res = await getTool('get_future_bookings')!.handler(
      { startDate: '2026-06-10', endDate: '2026-06-20' } as never, ctx(),
    );
    const data = res.data as Record<string, unknown>;
    assert.equal(data.totalBookings, 2);
    assert.equal(data.paceCurveByStayDate, undefined);
    assert.match(String(data.note), /pace history is not available/i);
  });
});
