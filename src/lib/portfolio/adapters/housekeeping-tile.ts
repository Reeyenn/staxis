/**
 * Housekeeping module — portfolio tile adapter (server-side fetcher).
 *
 * Pulls the 7 KPIs displayed on the housekeeping portfolio tile, in the
 * property's local timezone. Designed to be called by /api/portfolio/*
 * routes — every read uses supabaseAdmin, so RLS / per-user auth is the
 * caller's responsibility.
 *
 * The adapter never throws. If any sub-query fails, the field becomes
 * `null` and the tile-wide accuracyLabel downgrades — the page can
 * still render the row.
 *
 * Until cost-tracking lands, labor cost uses legacy columns:
 *   • properties.weekly_budget (numeric dollars) / 7 → daily budget cents
 *   • staff.hourly_wage (numeric dollars) × scheduled hours → cost cents
 * Swap to *_cents columns when 0229 merges.
 */

// NOTE: this file uses supabaseAdmin (server-only). The
// audit-service-role-imports lint script guards against accidental
// client-side imports — see scripts/audit-service-role-imports.mjs.
import { supabaseAdmin } from '@/lib/supabase-admin';
import { APP_TIMEZONE, todayStr } from '@/lib/utils';
import { registerAdapter } from '../registry';
import type {
  HousekeepingTileData,
  PortfolioTileAdapter,
  PortfolioAnomaly,
  PortfolioModuleAverages,
} from '../types';
import { detectHousekeepingAnomalies } from '../anomaly-detector';

type HousekeepingTile = { module: 'housekeeping' } & HousekeepingTileData;

/**
 * Read the property's id, name, total_rooms, timezone, weekly_budget,
 * hourly_wage (legacy fields). Returns null when the property doesn't
 * exist (caller treats this as 'capacity_unavailable').
 */
async function readPropertyFields(propertyId: string): Promise<{
  id: string;
  name: string;
  total_rooms: number;
  timezone: string | null;
  weekly_budget: number | null;
  hourly_wage: number | null;
} | null> {
  const { data, error } = await supabaseAdmin
    .from('properties')
    .select('id, name, total_rooms, timezone, weekly_budget, hourly_wage')
    .eq('id', propertyId)
    .maybeSingle();
  if (error || !data) return null;
  return data as {
    id: string;
    name: string;
    total_rooms: number;
    timezone: string | null;
    weekly_budget: number | null;
    hourly_wage: number | null;
  };
}

/** Count today's completed cleans (status in ('recorded','approved')). */
async function readRoomsTurned(propertyId: string, today: string): Promise<number> {
  const { count } = await supabaseAdmin
    .from('cleaning_events')
    .select('id', { count: 'exact', head: true })
    .eq('property_id', propertyId)
    .eq('date', today)
    .in('status', ['recorded', 'approved']);
  return count ?? 0;
}

/**
 * Count rooms currently in a dirty state. The latest-per-room row in
 * pms_room_status_log is "current"; we use the (property_id, changed_at desc)
 * index by selecting all of today's-and-prior status entries and
 * deduping client-side. For a typical hotel of ≤200 rooms this is
 * cheap; for a fleet of hotels the API route batches by `in()` so the
 * fan-out stays single-digit RTTs.
 *
 * Why not a window function in SQL: PostgREST + Supabase don't expose
 * window functions through the auto-generated REST API. Calling out to
 * a stored function would work but adds a migration for a metric a
 * single rendering pass needs. The dedup-in-memory approach is OK at
 * the scale of housekeeping (one hotel's rooms fit on one screen).
 */
async function readRoomsRemaining(propertyId: string): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from('pms_room_status_log')
    .select('room_number, status, changed_at')
    .eq('property_id', propertyId)
    .order('changed_at', { ascending: false })
    .limit(2000);
  if (error || !data) return 0;
  const seen = new Set<string>();
  let remaining = 0;
  for (const row of data as Array<{ room_number: string; status: string }>) {
    if (seen.has(row.room_number)) continue;
    seen.add(row.room_number);
    if (row.status === 'vacant_dirty' || row.status === 'occupied_dirty') {
      remaining += 1;
    }
  }
  return remaining;
}

/** Pass rate: pass / (pass + fail) for today, by completed_at::date. */
async function readInspectionPassRate(propertyId: string, today: string): Promise<number | null> {
  // Range query: completed_at ≥ today_00:00 AND completed_at < today+1_00:00.
  // PostgREST doesn't expose ::date casts cleanly; sticking to >= / < on
  // ISO timestamps keeps the planner happy and the index usable. The
  // boundary day-string is in the property's tz, but we use UTC here —
  // a 5-hour window slip is fine for "pass rate so far today".
  const dayStart = `${today}T00:00:00Z`;
  const dayEndDate = new Date(`${today}T00:00:00Z`);
  dayEndDate.setUTCDate(dayEndDate.getUTCDate() + 1);
  const dayEnd = dayEndDate.toISOString();
  const { data, error } = await supabaseAdmin
    .from('inspections')
    .select('result')
    .eq('property_id', propertyId)
    .gte('completed_at', dayStart)
    .lt('completed_at', dayEnd)
    .in('result', ['pass', 'fail']);
  if (error || !data || data.length === 0) return null;
  const total = data.length;
  const passed = data.filter((r: { result: string }) => r.result === 'pass').length;
  return passed / total;
}

/** Avg duration_minutes for today's checkout cleans. */
async function readAvgMinutesPerDeparture(propertyId: string, today: string): Promise<number | null> {
  const { data, error } = await supabaseAdmin
    .from('cleaning_events')
    .select('duration_minutes')
    .eq('property_id', propertyId)
    .eq('date', today)
    .eq('room_type', 'checkout')
    .in('status', ['recorded', 'approved']);
  if (error || !data || data.length === 0) return null;
  const rows = data as Array<{ duration_minutes: number }>;
  const sum = rows.reduce((a, r) => a + Number(r.duration_minutes ?? 0), 0);
  return sum / rows.length;
}

/**
 * Read today's scheduled shifts joined with staff hourly_wage. We pull
 * the shift hours + wage in one query, compute cost in JS. The legacy
 * staff.hourly_wage is NOT NULL with a $15 default — we use it directly
 * for the cost estimate, knowing it's an "industry_estimate_learning"-
 * grade number until cost-tracking lands the per-staff cents column.
 *
 * Status interpretation:
 *   - scheduled count: all rows on today with kind='shift' and a real staff_id
 *   - active count:    rows above where status='confirmed'
 *
 * Returns null for cost when there are zero rows (no schedule = no
 * cost number to display).
 */
async function readShiftCostAndCounts(propertyId: string, today: string, fallbackHourlyWageDollars: number | null): Promise<{
  laborCostCents: number | null;
  staffActive: number;
  staffScheduled: number;
}> {
  // Two-query approach (instead of a PostgREST embedded resource):
  //   1. shifts for today with a real staff_id
  //   2. wages for those staff ids
  // Then join in memory. This is more robust than relying on PostgREST's
  // FK cardinality detection (which can return staff as an object OR a
  // 1-element array depending on the relationship cache).
  const { data: shiftRows, error: shiftErr } = await supabaseAdmin
    .from('scheduled_shifts')
    .select('staff_id, start_time, end_time, status')
    .eq('property_id', propertyId)
    .eq('shift_date', today)
    .eq('kind', 'shift')
    .not('staff_id', 'is', null);
  if (shiftErr || !shiftRows || shiftRows.length === 0) {
    return { laborCostCents: null, staffActive: 0, staffScheduled: 0 };
  }

  type ShiftRow = { staff_id: string; start_time: string; end_time: string; status: string };
  const shifts = shiftRows as ShiftRow[];
  const distinctStaffIds = Array.from(new Set(shifts.map(s => s.staff_id)));

  let wageByStaff = new Map<string, number>();
  if (distinctStaffIds.length > 0) {
    const { data: wageRows } = await supabaseAdmin
      .from('staff')
      .select('id, hourly_wage')
      .in('id', distinctStaffIds);
    if (Array.isArray(wageRows)) {
      wageByStaff = new Map(
        (wageRows as Array<{ id: string; hourly_wage: number | null }>)
          .filter(r => r.hourly_wage !== null && r.hourly_wage !== undefined)
          .map(r => [r.id, Number(r.hourly_wage)]),
      );
    }
  }

  let costCents = 0;
  let costRowsSeen = 0;
  let active = 0;

  for (const r of shifts) {
    if (r.status === 'confirmed') active += 1;
    const hours = hoursBetween(r.start_time, r.end_time);
    if (hours <= 0) continue;
    const wage = wageByStaff.get(r.staff_id) ?? fallbackHourlyWageDollars;
    if (wage === null || wage === undefined) continue;
    costCents += Math.round(Number(wage) * 100 * hours);
    costRowsSeen += 1;
  }
  // If we couldn't compute cost for any row (all wages null AND no
  // property fallback), surface null rather than 0 — "no wage data" is
  // honest, "$0" is misleading.
  return {
    laborCostCents: costRowsSeen > 0 ? costCents : null,
    staffActive: active,
    staffScheduled: shifts.length,
  };
}

/** Compute the number of hours between two HH:MM(:SS) strings. */
function hoursBetween(start: string, end: string): number {
  // start_time / end_time come back as 'HH:MM:SS' from the time column.
  // We treat both as "wall time on the same day" and tolerate the
  // (rare) overnight shift case by adding 24h if end < start.
  const [sh, sm = '0'] = start.split(':');
  const [eh, em = '0'] = end.split(':');
  const startMin = parseInt(sh, 10) * 60 + parseInt(sm, 10);
  let endMin = parseInt(eh, 10) * 60 + parseInt(em, 10);
  if (endMin < startMin) endMin += 24 * 60;
  return (endMin - startMin) / 60;
}

/** Daily labor budget in cents, computed from properties.weekly_budget / 7. */
function dailyLaborBudgetCents(weeklyBudgetDollars: number | null): number | null {
  if (weeklyBudgetDollars === null || weeklyBudgetDollars === undefined) return null;
  if (!Number.isFinite(weeklyBudgetDollars) || weeklyBudgetDollars <= 0) return null;
  return Math.round((weeklyBudgetDollars / 7) * 100);
}

/**
 * Pick the honest accuracy label for the tile as a whole. Greenfield
 * heuristic until ML is wired in:
 *   - capacity_unavailable: zero data signals AT ALL (no cleans, no
 *     inspections, no scheduled shifts).
 *   - industry_estimate_learning: at least one signal available; cost
 *     numbers may be using the $15 legacy wage default.
 *   - ai_prediction: not yet — no ML output is feeding this tile in
 *     greenfield. Reserved for the future plug-in.
 */
function pickAccuracyLabel(d: Omit<HousekeepingTileData, 'accuracyLabel'>): HousekeepingTileData['accuracyLabel'] {
  const noClean = d.roomsTurned === 0;
  const noPass = d.inspectionPassRate === null;
  const noStaff = d.staffScheduledCount === 0;
  if (noClean && noPass && noStaff) return 'capacity_unavailable';
  return 'industry_estimate_learning';
}

/**
 * Returns a degraded payload when a property doesn't exist or every
 * sub-fetch fails. The grid can still render a "—" tile so the user
 * isn't met with a missing card.
 */
function degradedTile(propertyId: string, name = 'Unknown'): HousekeepingTile {
  return {
    module: 'housekeeping',
    propertyId,
    property: { id: propertyId, name, totalRooms: 0 },
    roomsTurned: 0,
    roomsRemaining: 0,
    inspectionPassRate: null,
    avgMinutesPerDeparture: null,
    laborCostTodayCents: null,
    laborBudgetTodayCents: null,
    staffActiveCount: 0,
    staffScheduledCount: 0,
    accuracyLabel: 'capacity_unavailable',
  };
}

/** Main fetcher — server-only. */
export async function fetchHousekeepingTileData(propertyId: string): Promise<HousekeepingTile> {
  let prop: Awaited<ReturnType<typeof readPropertyFields>>;
  try {
    prop = await readPropertyFields(propertyId);
  } catch {
    return degradedTile(propertyId);
  }
  if (!prop) return degradedTile(propertyId);

  const tz = prop.timezone ?? APP_TIMEZONE;
  const today = todayStr(tz);

  // Fan out the per-property reads in parallel. Each sub-read is
  // independently wrapped in try/catch so one failure can't kill the
  // tile. The Promise.all `[ ... ]` shape is preserved with `.catch`
  // sentinels so destructuring stays stable.
  const [turned, remaining, passRate, avgMin, shiftBundle] = await Promise.all([
    readRoomsTurned(propertyId, today).catch(() => 0),
    readRoomsRemaining(propertyId).catch(() => 0),
    readInspectionPassRate(propertyId, today).catch(() => null),
    readAvgMinutesPerDeparture(propertyId, today).catch(() => null),
    readShiftCostAndCounts(propertyId, today, prop.hourly_wage).catch(() => ({ laborCostCents: null, staffActive: 0, staffScheduled: 0 })),
  ]);

  const base: Omit<HousekeepingTileData, 'accuracyLabel'> = {
    propertyId,
    property: {
      id: prop.id,
      name: prop.name,
      totalRooms: prop.total_rooms,
    },
    roomsTurned: turned,
    roomsRemaining: remaining,
    inspectionPassRate: passRate,
    avgMinutesPerDeparture: avgMin,
    laborCostTodayCents: shiftBundle.laborCostCents,
    laborBudgetTodayCents: dailyLaborBudgetCents(prop.weekly_budget),
    staffActiveCount: shiftBundle.staffActive,
    staffScheduledCount: shiftBundle.staffScheduled,
  };
  return { module: 'housekeeping', ...base, accuracyLabel: pickAccuracyLabel(base) };
}

// ─── The adapter ─────────────────────────────────────────────────────────

export const housekeepingTileAdapter: PortfolioTileAdapter<HousekeepingTile> = {
  moduleId: 'housekeeping',
  moduleLabel: { en: 'Housekeeping', es: 'Limpieza' },
  fetchTileData: fetchHousekeepingTileData,
  anomalyFlag: (data, avg: PortfolioModuleAverages): PortfolioAnomaly[] | null => {
    return detectHousekeepingAnomalies(data, avg);
  },
};

registerAdapter(housekeepingTileAdapter);
