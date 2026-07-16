/**
 * GET /api/home/summary?pid=<propertyId>
 *
 * One call powering the home-hub page: 8 department tiles, each with a
 * single short status line (EN + ES) and a tone. The page renders these
 * verbatim — no client-side math, no direct supabase.from() calls.
 *
 * Auth: requireSession (manager-facing) + userHasPropertyAccess tenant
 * gate, same pattern as /api/housekeeping/board — without the gate any
 * signed-in user could read another hotel's operational counts by
 * spraying property UUIDs.
 *
 * Resilience contract: every tile computes inside its own guard. If one
 * domain's query fails (missing table, RPC error, cold-start emptiness),
 * that tile alone degrades to its muted "Open …" fallback — the route
 * never 500s because one read broke. Enabled tiles run concurrently; disabled
 * sections are never queried.
 *
 * Sources per tile (all read-only, via supabaseAdmin):
 *   staxis         — agent_nudges (status='pending', scoped to the
 *                    caller's accounts.id — nudges are per-user)
 *   dashboard      — today_property_counts_v1 RPC (in_house / total_rooms)
 *   housekeeping   — cleaning_tasks for today's business_date
 *   communications — complaints with status open / in_progress
 *   maintenance    — work_orders not yet 'resolved' (legacy enum:
 *                    submitted/assigned/in_progress all mean open;
 *                    severity 'urgent' is the "high" bucket)
 *   inventory      — counted inventory current_stock vs par_level (same rule as Inventory)
 *   staff          — scheduled_shifts assigned for today (kind='shift')
 *   financials     — pms_revenue_daily via getMonthRevenue() (the same
 *                    single source of truth Dashboard + Financials use)
 */

import type { NextRequest } from 'next/server';
import type { NextResponse } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { validateUuid } from '@/lib/api-validate';
import { getPropertyOpsConfig } from '@/lib/property-config';
import { getMonthRevenue } from '@/lib/financials/revenue';
import { canForUserId } from '@/lib/capabilities/server';
import { getEnabledSections } from '@/lib/sections/server';
import { isSectionEnabled, type AppSection } from '@/lib/sections/registry';
import { summarizeHomeInventory } from '@/lib/home-inventory-summary';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ─── Tile shape ───────────────────────────────────────────────────────────

type TileTone = 'ok' | 'warn' | 'bad' | 'muted';

interface TileLine {
  en: string;
  es: string;
  tone: TileTone;
}

interface HomeSummaryTiles {
  staxis: TileLine;
  dashboard: TileLine;
  housekeeping: TileLine;
  communications: TileLine;
  maintenance: TileLine;
  inventory: TileLine;
  staff: TileLine;
  financials: TileLine;
}

// Muted "couldn't compute / nothing cheap to say" fallbacks. Also the
// per-tile error state — a failed query renders as a neutral door into
// the section, never as a red herring or a crashed page.
const FALLBACK: Record<keyof HomeSummaryTiles, TileLine> = {
  staxis:         { en: 'Open Staxis',      es: 'Abrir Staxis',        tone: 'muted' },
  dashboard:      { en: 'Open dashboard',   es: 'Abrir panel',         tone: 'muted' },
  housekeeping:   { en: 'Open housekeeping', es: 'Abrir limpieza',     tone: 'muted' },
  communications: { en: 'Open messages',    es: 'Abrir mensajes',      tone: 'muted' },
  maintenance:    { en: 'Open maintenance', es: 'Abrir mantenimiento', tone: 'muted' },
  inventory:      { en: 'Open inventory',   es: 'Abrir inventario',    tone: 'muted' },
  staff:          { en: 'Open staff',       es: 'Abrir personal',      tone: 'muted' },
  financials:     { en: 'Open financials',  es: 'Abrir finanzas',      tone: 'muted' },
};

/**
 * Run one tile's computation with a hard guarantee it can't take the
 * route down: any throw (or rejected promise) collapses to the tile's
 * muted fallback. Logged at warn — a broken tile is worth noticing but
 * isn't a Sentry-worthy incident on every page load.
 */
async function guarded(
  tile: keyof HomeSummaryTiles,
  requestId: string,
  fn: () => Promise<TileLine>,
): Promise<TileLine> {
  try {
    return await fn();
  } catch (e) {
    log.warn('home-summary: tile failed — using muted fallback', {
      requestId,
      tile,
      err: e instanceof Error ? e.message : String(e),
    });
    return FALLBACK[tile];
  }
}

// ─── Small helpers ────────────────────────────────────────────────────────

/** Today as YYYY-MM-DD in the property's local timezone (en-CA = ISO order). */
function todayInTz(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}

/** Local hour-of-day (0-23) in the property's timezone, for "late-day" checks. */
function localHourInTz(tz: string): number {
  return parseInt(
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz })
      .format(new Date()),
    10,
  );
}

/** "$41.2k" style compact dollars from integer cents. Keeps tile lines short. */
function formatCompactDollars(cents: number): string {
  const dollars = cents / 100;
  if (dollars >= 100_000) return `$${Math.round(dollars / 1000)}k`;
  if (dollars >= 1_000) return `$${(dollars / 1000).toFixed(1)}k`;
  return `$${Math.round(dollars)}`;
}

// ─── Per-tile computations ────────────────────────────────────────────────
// Each returns a TileLine or THROWS — the guard turns throws into the
// muted fallback. Supabase errors are re-thrown explicitly because the
// JS client returns { error } instead of throwing.

/** staxis — pending AI decisions (agent_nudges are per-user rows). */
async function staxisTile(pid: string, userId: string): Promise<TileLine> {
  // Nudges key on accounts.id, not the auth uuid — resolve it first.
  const { data: account, error: acctErr } = await supabaseAdmin
    .from('accounts')
    .select('id')
    .eq('data_user_id', userId)
    .maybeSingle();
  if (acctErr) throw new Error(acctErr.message);
  if (!account) throw new Error('no accounts row for caller');

  const { count, error } = await supabaseAdmin
    .from('agent_nudges')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', account.id as string)
    .eq('property_id', pid)
    .eq('status', 'pending');
  if (error) throw new Error(error.message);

  const n = count ?? 0;
  if (n > 0) {
    return { en: `${n} need you`, es: `${n} te esperan`, tone: 'warn' };
  }
  return { en: 'All handled', es: 'Todo gestionado', tone: 'ok' };
}

/** dashboard — occupancy % today from the Plan-v4 counts RPC. */
async function dashboardTile(pid: string, today: string): Promise<TileLine> {
  const { data, error } = await supabaseAdmin.rpc('today_property_counts_v1', {
    p_property_id: pid,
    p_date: today,
  });
  if (error) throw new Error(error.message);
  const row = ((data ?? []) as Array<{ in_house?: unknown; total_rooms?: unknown }>)[0];
  const inHouse = Number(row?.in_house);
  const totalRooms = Number(row?.total_rooms);
  // Cold start / no CUA yet: total_rooms is 0 — occupancy isn't derivable,
  // fall back muted rather than showing a fabricated 0%.
  if (!Number.isFinite(inHouse) || !Number.isFinite(totalRooms) || totalRooms <= 0) {
    return FALLBACK.dashboard;
  }
  const pct = Math.round((inHouse / totalRooms) * 100);
  return { en: `${pct}% occupied`, es: `${pct}% ocupado`, tone: 'ok' };
}

/** housekeeping — rooms still to clean today (cleaning_tasks not finished). */
async function housekeepingTile(pid: string, today: string, localHour: number): Promise<TileLine> {
  const { count, error } = await supabaseAdmin
    .from('cleaning_tasks')
    .select('id', { count: 'exact', head: true })
    .eq('property_id', pid)
    .eq('business_date', today)
    // Same "dead task" set the board route uses — everything else is
    // still work to do (pending / assigned / in_progress …).
    .not('status', 'in', '(completed,cancelled,skipped)');
  if (error) throw new Error(error.message);

  const n = count ?? 0;
  if (n === 0) {
    return { en: 'All rooms done', es: 'Todo listo', tone: 'ok' };
  }
  // Rooms left mid-morning is normal (ok); rooms left late-day is worth a
  // nudge (warn). 3pm local is the simple cut line.
  const tone: TileTone = localHour >= 15 ? 'warn' : 'ok';
  return n === 1
    ? { en: '1 room left', es: '1 habitación', tone }
    : { en: `${n} rooms left`, es: `${n} habitaciones`, tone };
}

/** communications — open complaints (open or in_progress). */
async function communicationsTile(pid: string): Promise<TileLine> {
  const { count, error } = await supabaseAdmin
    .from('complaints')
    .select('id', { count: 'exact', head: true })
    .eq('property_id', pid)
    .in('status', ['open', 'in_progress']);
  if (error) throw new Error(error.message);

  const n = count ?? 0;
  if (n === 0) {
    return { en: 'All clear', es: 'Todo al día', tone: 'ok' };
  }
  return n === 1
    ? { en: '1 open item', es: '1 pendiente', tone: 'warn' }
    : { en: `${n} open items`, es: `${n} pendientes`, tone: 'warn' };
}

/** maintenance — open work orders + how many are urgent. */
async function maintenanceTile(pid: string): Promise<TileLine> {
  // One read, count severities in JS. DB status is the legacy enum:
  // anything except 'resolved' reads as open (see db-mappers.ts).
  const { data, error } = await supabaseAdmin
    .from('work_orders')
    .select('severity')
    .eq('property_id', pid)
    .neq('status', 'resolved')
    .limit(500);
  if (error) throw new Error(error.message);

  const rows = data ?? [];
  const open = rows.length;
  const high = rows.filter((r) => (r as { severity?: unknown }).severity === 'urgent').length;

  if (open === 0) {
    return { en: 'No open work orders', es: 'Sin órdenes abiertas', tone: 'ok' };
  }
  const enBase = open === 1 ? '1 open' : `${open} open`;
  const esBase = open === 1 ? '1 abierta' : `${open} abiertas`;
  if (high > 0) {
    return {
      en: `${enBase} · ${high} high`,
      es: `${esBase} · ${high} alta${high === 1 ? '' : 's'}`,
      tone: 'bad',
    };
  }
  return { en: enBase, es: esBase, tone: 'warn' };
}

/** inventory — items at/below the 70/30 stock thresholds vs par. */
async function inventoryTile(pid: string): Promise<TileLine> {
  const { data, error } = await supabaseAdmin
    .from('inventory')
    .select('current_stock, par_level, last_counted_at')
    .eq('property_id', pid)
    .is('archived_at', null)
    .limit(1000);
  if (error) throw new Error(error.message);
  return summarizeHomeInventory(data ?? []);
}

/** staff — distinct staff with an assigned shift today. */
async function staffTile(pid: string, today: string): Promise<TileLine> {
  const { data, error } = await supabaseAdmin
    .from('scheduled_shifts')
    .select('staff_id')
    .eq('property_id', pid)
    .eq('shift_date', today)
    .eq('kind', 'shift')
    .neq('status', 'declined')
    .not('staff_id', 'is', null)
    .limit(500);
  if (error) throw new Error(error.message);

  const distinct = new Set((data ?? []).map((r) => String((r as { staff_id?: unknown }).staff_id)));
  const n = distinct.size;
  // 0 assigned rows usually means "this hotel doesn't build schedules in
  // the app" rather than "nobody is working" — muted door, not a scary 0.
  if (n === 0) return FALLBACK.staff;
  return { en: `${n} on today`, es: `${n} en turno`, tone: 'ok' };
}

/** financials — month-to-date PMS revenue (single source of truth). */
async function financialsTile(pid: string, today: string): Promise<TileLine> {
  const month = today.slice(0, 7); // YYYY-MM
  // getMonthRevenue never throws — returns nulls on cold start / errors.
  const rev = await getMonthRevenue(pid, month);
  if (rev.revenueCents == null) return FALLBACK.financials;
  const compact = formatCompactDollars(rev.revenueCents);
  return { en: `${compact} MTD`, es: `${compact} del mes`, tone: 'ok' };
}

// ─── Route ────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = getOrMintRequestId(req);
  const auth = await requireSession(req, { requestId });
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const pidCheck = validateUuid(url.searchParams.get('pid'), 'pid');
  if (pidCheck.error) {
    return err(pidCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const pid = pidCheck.value!;

  // Tenant-scope gate — session alone isn't enough; the caller must have
  // this property in accounts.property_access (or be admin).
  const hasAccess = await userHasPropertyAccess(auth.userId, pid);
  if (!hasAccess) {
    log.warn('home-summary: forbidden — user lacks property access', {
      requestId, userId: auth.userId, pid,
    });
    return err('forbidden — no access to this property', {
      requestId, status: 403, code: ApiErrorCode.Forbidden,
    });
  }

  // Property-local "today" — never throws (getPropertyOpsConfig returns
  // defaults on any failure), so this is safe outside the tile guards.
  const [opsConfig, enabledSections] = await Promise.all([
    getPropertyOpsConfig(pid),
    getEnabledSections(pid),
  ]);
  const today = todayInTz(opsConfig.timezone);
  const localHour = localHourInTz(opsConfig.timezone);

  const runIfEnabled = (
    section: AppSection,
    tile: keyof HomeSummaryTiles,
    fn: () => Promise<TileLine>,
  ): Promise<TileLine> => isSectionEnabled(enabledSections, section)
    ? guarded(tile, requestId, fn)
    : Promise.resolve(FALLBACK[tile]);

  // Unlike the client-side tile filter, this prevents revenue from being read
  // or returned at all for roles that cannot view financials.
  const canViewFinancials = isSectionEnabled(enabledSections, 'financials')
    ? await canForUserId(auth.userId, 'view_financials', pid)
    : false;

  // Enabled tiles concurrently, each individually guarded. Disabled tiles
  // keep their neutral fallback without touching that domain's tables.
  const [
    staxis, dashboard, housekeeping, communications,
    maintenance, inventory, staff, financials,
  ] = await Promise.all([
    runIfEnabled('staxis', 'staxis', () => staxisTile(pid, auth.userId)),
    runIfEnabled('dashboard', 'dashboard', () => dashboardTile(pid, today)),
    runIfEnabled('housekeeping', 'housekeeping', () => housekeepingTile(pid, today, localHour)),
    runIfEnabled('communications', 'communications', () => communicationsTile(pid)),
    runIfEnabled('maintenance', 'maintenance', () => maintenanceTile(pid)),
    runIfEnabled('inventory', 'inventory', () => inventoryTile(pid)),
    runIfEnabled('staff', 'staff', () => staffTile(pid, today)),
    canViewFinancials
      ? guarded('financials', requestId, () => financialsTile(pid, today))
      : Promise.resolve(FALLBACK.financials),
  ]);

  const tiles: HomeSummaryTiles = {
    staxis, dashboard, housekeeping, communications,
    maintenance, inventory, staff, financials,
  };

  return ok({ tiles }, { requestId });
}
