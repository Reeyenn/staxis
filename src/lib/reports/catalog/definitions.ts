/**
 * Report catalog — the report definitions.
 *
 * Each definition is a titled query + columns that runs server-side with
 * supabaseAdmin, scoped to one property + date window. These power BOTH the
 * on-demand display/export at /settings/reports AND the scheduled auto-email
 * cron — same data, two surfaces.
 *
 * Every report is built on data we already collect:
 *   - housekeeping  → cleaning_events (the Performance-tab source)
 *   - inspections   → inspections (0212)
 *   - maintenance   → work_orders
 *   - inventory     → getInventoryAccountingSummary + inventory (the accounting source)
 *   - occupancy     → daily_logs + dashboard_by_date (the dashboard source)
 *   - activity      → activity_log (the activity-log source)
 *   - compliance    → compliance_readings (0229, if present)
 *   - lost & found  → lost_and_found_items (0230, if present)
 *
 * Property scoping: EVERY query filters `.eq('property_id', ctx.propertyId)`.
 * The route layer additionally verifies the caller can access that property.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import { getInventoryAccountingSummary } from '@/lib/db/inventory-accounting';
import { ACTIVITY_CATEGORIES } from '@/lib/activity-log/types';
import type {
  ReportColumn,
  ReportDefinition,
  ReportRow,
  ReportRunResult,
} from './types';
import {
  avg,
  dateAddDays,
  getPropertyMeta,
  getStaffNameMap,
  groupBy,
  monthStartUtc,
  round,
  sum,
  utcBoundsForLocalRange,
} from './helpers';

// ─── column helpers ──────────────────────────────────────────────────────────
const col = (
  key: string,
  en: string,
  es: string,
  kind: ReportColumn['kind'] = 'text',
): ReportColumn => ({
  key,
  label: { en, es },
  kind,
  align: kind && kind !== 'text' && kind !== 'date' && kind !== 'datetime' ? 'right' : 'left',
});

// ════════════════════════════════════════════════════════════════════════════
// HOUSEKEEPING
// ════════════════════════════════════════════════════════════════════════════

interface CleaningRow {
  staff_id: string | null;
  staff_name: string | null;
  room_type: string | null;
  stayover_day: number | null;
  duration_minutes: number | null;
}

async function loadCleaningEvents(propertyId: string, from: string, to: string): Promise<CleaningRow[]> {
  const { data, error } = await supabaseAdmin
    .from('cleaning_events')
    .select('staff_id, staff_name, room_type, stayover_day, duration_minutes')
    .eq('property_id', propertyId)
    .gte('date', from)
    .lte('date', to)
    .in('status', ['recorded', 'approved'])
    .limit(20_000);
  if (error) throw error;
  return (data ?? []) as CleaningRow[];
}

const hkLeaderboard: ReportDefinition = {
  key: 'hk-leaderboard',
  title: { en: 'Housekeeper leaderboard', es: 'Tabla de limpiadores' },
  description: {
    en: 'Rooms cleaned and average clean time per housekeeper, fastest first.',
    es: 'Habitaciones limpiadas y tiempo promedio por limpiador, más rápido primero.',
  },
  category: 'housekeeping',
  defaultRange: 'last7',
  run: async (ctx): Promise<ReportRunResult> => {
    const rows = await loadCleaningEvents(ctx.propertyId, ctx.from, ctx.to);
    const byStaff = groupBy(rows, (r) => r.staff_id || r.staff_name || 'unknown');
    const out: ReportRow[] = [];
    for (const [, events] of byStaff) {
      const name = events[0].staff_name || 'Unknown';
      const durations = events.map((e) => Number(e.duration_minutes ?? 0)).filter((d) => d > 0);
      const checkout = events.filter((e) => e.room_type === 'checkout').map((e) => Number(e.duration_minutes ?? 0)).filter((d) => d > 0);
      const stayover = events.filter((e) => e.room_type === 'stayover').map((e) => Number(e.duration_minutes ?? 0)).filter((d) => d > 0);
      out.push({
        housekeeper: name,
        rooms: events.length,
        avgMin: durations.length ? round(avg(durations)!) : null,
        checkoutAvg: checkout.length ? round(avg(checkout)!) : null,
        stayoverAvg: stayover.length ? round(avg(stayover)!) : null,
      });
    }
    out.sort((a, b) => {
      const av = a.avgMin == null ? Infinity : Number(a.avgMin);
      const bv = b.avgMin == null ? Infinity : Number(b.avgMin);
      return av - bv;
    });
    const allDur = rows.map((r) => Number(r.duration_minutes ?? 0)).filter((d) => d > 0);
    return {
      columns: [
        col('housekeeper', 'Housekeeper', 'Limpiador'),
        col('rooms', 'Rooms', 'Habitaciones', 'number'),
        col('avgMin', 'Avg / room', 'Prom / hab.', 'minutes'),
        col('checkoutAvg', 'Checkout avg', 'Prom. salida', 'minutes'),
        col('stayoverAvg', 'Stayover avg', 'Prom. estancia', 'minutes'),
      ],
      rows: out,
      stats: [
        { label: { en: 'Rooms cleaned', es: 'Habitaciones limpiadas' }, value: String(rows.length) },
        { label: { en: 'Housekeepers', es: 'Limpiadores' }, value: String(byStaff.size) },
        { label: { en: 'Team avg / room', es: 'Prom. equipo / hab.' }, value: allDur.length ? `${round(avg(allDur)!)}m` : '—' },
      ],
    };
  },
};

const hkCleanTimes: ReportDefinition = {
  key: 'hk-clean-times',
  title: { en: 'Clean times by type', es: 'Tiempos por tipo' },
  description: {
    en: 'Average clean time by cleaning type — checkout vs stayover.',
    es: 'Tiempo promedio por tipo de limpieza — salida vs. estancia.',
  },
  category: 'housekeeping',
  defaultRange: 'last30',
  run: async (ctx): Promise<ReportRunResult> => {
    const rows = await loadCleaningEvents(ctx.propertyId, ctx.from, ctx.to);
    const buckets: Array<{ label: string; match: (r: CleaningRow) => boolean }> = [
      { label: 'Checkout', match: (r) => r.room_type === 'checkout' },
      { label: 'Stayover (light)', match: (r) => r.room_type === 'stayover' && r.stayover_day === 1 },
      { label: 'Stayover (full)', match: (r) => r.room_type === 'stayover' && r.stayover_day === 2 },
    ];
    const out: ReportRow[] = buckets.map((b) => {
      const matched = rows.filter(b.match);
      const dur = matched.map((r) => Number(r.duration_minutes ?? 0)).filter((d) => d > 0);
      return {
        type: b.label,
        rooms: matched.length,
        avgMin: dur.length ? round(avg(dur)!) : null,
        totalHours: dur.length ? round(sum(dur) / 60, 1) : 0,
      };
    });
    return {
      columns: [
        col('type', 'Clean type', 'Tipo'),
        col('rooms', 'Rooms', 'Habitaciones', 'number'),
        col('avgMin', 'Avg time', 'Tiempo prom.', 'minutes'),
        col('totalHours', 'Total hours', 'Horas totales', 'number'),
      ],
      rows: out,
    };
  },
};

// ════════════════════════════════════════════════════════════════════════════
// INSPECTIONS
// ════════════════════════════════════════════════════════════════════════════

interface InspectionRow {
  inspector_staff_id: string | null;
  result: string | null;
  failed_items: unknown;
}

async function loadInspections(propertyId: string, fromUtc: string, toUtcExclusive: string): Promise<InspectionRow[]> {
  const { data, error } = await supabaseAdmin
    .from('inspections')
    .select('inspector_staff_id, result, failed_items')
    .eq('property_id', propertyId)
    .gte('started_at', fromUtc)
    .lt('started_at', toUtcExclusive)
    .limit(20_000);
  if (error) throw error;
  return (data ?? []) as InspectionRow[];
}

const inspectionsByInspector: ReportDefinition = {
  key: 'inspections-by-inspector',
  title: { en: 'Inspections by inspector', es: 'Inspecciones por inspector' },
  description: {
    en: 'Pass rate per inspector — completed inspections, passes, and fails.',
    es: 'Tasa de aprobación por inspector — inspecciones, aprobadas y reprobadas.',
  },
  category: 'inspections',
  defaultRange: 'last30',
  run: async (ctx): Promise<ReportRunResult> => {
    const { fromUtc, toUtcExclusive } = utcBoundsForLocalRange(ctx.from, ctx.to, ctx.timezone);
    const [rows, staff] = await Promise.all([
      loadInspections(ctx.propertyId, fromUtc, toUtcExclusive),
      getStaffNameMap(ctx.propertyId),
    ]);
    const decided = rows.filter((r) => r.result === 'pass' || r.result === 'fail');
    const byInspector = groupBy(decided, (r) => r.inspector_staff_id || 'unassigned');
    const out: ReportRow[] = [];
    for (const [id, insp] of byInspector) {
      const passed = insp.filter((r) => r.result === 'pass').length;
      const failed = insp.filter((r) => r.result === 'fail').length;
      const total = passed + failed;
      out.push({
        inspector: id === 'unassigned' ? 'Unassigned' : staff.get(id) ?? 'Unknown',
        inspections: total,
        passed,
        failed,
        passRate: total ? round((passed / total) * 100) : null,
      });
    }
    out.sort((a, b) => Number(b.inspections) - Number(a.inspections));
    const totalPassed = decided.filter((r) => r.result === 'pass').length;
    const overall = decided.length ? round((totalPassed / decided.length) * 100) : null;
    return {
      columns: [
        col('inspector', 'Inspector', 'Inspector'),
        col('inspections', 'Inspections', 'Inspecciones', 'number'),
        col('passed', 'Passed', 'Aprobadas', 'number'),
        col('failed', 'Failed', 'Reprobadas', 'number'),
        col('passRate', 'Pass rate', 'Tasa aprob.', 'percent'),
      ],
      rows: out,
      stats: [
        { label: { en: 'Overall pass rate', es: 'Tasa de aprobación' }, value: overall == null ? '—' : `${overall}%` },
        { label: { en: 'Inspections', es: 'Inspecciones' }, value: String(decided.length) },
        { label: { en: 'Failed', es: 'Reprobadas' }, value: String(decided.length - totalPassed) },
      ],
    };
  },
};

const inspectionFailures: ReportDefinition = {
  key: 'inspection-failures',
  title: { en: 'Top failing items', es: 'Ítems que más fallan' },
  description: {
    en: 'The checklist items that fail inspection most often.',
    es: 'Los ítems de la lista que más fallan en inspección.',
  },
  category: 'inspections',
  defaultRange: 'last30',
  run: async (ctx): Promise<ReportRunResult> => {
    const { fromUtc, toUtcExclusive } = utcBoundsForLocalRange(ctx.from, ctx.to, ctx.timezone);
    const rows = await loadInspections(ctx.propertyId, fromUtc, toUtcExclusive);
    const counts = new Map<string, number>();
    let totalFailures = 0;
    for (const r of rows) {
      const items = Array.isArray(r.failed_items) ? (r.failed_items as Array<{ label?: string }>) : [];
      for (const it of items) {
        const label = (it && typeof it === 'object' && typeof it.label === 'string' && it.label.trim()) || 'Unlabeled item';
        counts.set(label, (counts.get(label) ?? 0) + 1);
        totalFailures += 1;
      }
    }
    const out: ReportRow[] = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50)
      .map(([label, count]) => ({ item: label, count }));
    return {
      columns: [
        col('item', 'Failing item', 'Ítem que falla'),
        col('count', 'Times failed', 'Veces fallado', 'number'),
      ],
      rows: out,
      stats: [
        { label: { en: 'Total failures', es: 'Fallos totales' }, value: String(totalFailures) },
        { label: { en: 'Distinct items', es: 'Ítems distintos' }, value: String(counts.size) },
      ],
    };
  },
};

// ════════════════════════════════════════════════════════════════════════════
// MAINTENANCE / WORK ORDERS
// ════════════════════════════════════════════════════════════════════════════

interface WorkOrderRow {
  severity: string | null;
  status: string | null;
  created_at: string;
  resolved_at: string | null;
}

const COMPLETED_WO_STATUSES = new Set(['resolved', 'closed', 'done', 'completed']);
function isWorkOrderDone(r: WorkOrderRow): boolean {
  return !!r.resolved_at || COMPLETED_WO_STATUSES.has((r.status ?? '').toLowerCase());
}

const workOrdersSummary: ReportDefinition = {
  key: 'work-orders-summary',
  title: { en: 'Work orders summary', es: 'Resumen de órdenes' },
  description: {
    en: 'Open vs completed work orders and average time-to-complete, by priority.',
    es: 'Órdenes abiertas vs. completadas y tiempo promedio de resolución, por prioridad.',
  },
  category: 'maintenance',
  defaultRange: 'last30',
  run: async (ctx): Promise<ReportRunResult> => {
    const { fromUtc, toUtcExclusive } = utcBoundsForLocalRange(ctx.from, ctx.to, ctx.timezone);
    const { data, error } = await supabaseAdmin
      .from('work_orders')
      .select('severity, status, created_at, resolved_at')
      .eq('property_id', ctx.propertyId)
      .gte('created_at', fromUtc)
      .lt('created_at', toUtcExclusive)
      .limit(20_000);
    if (error) throw error;
    const rows = (data ?? []) as WorkOrderRow[];

    // Currently-open (all time, point-in-time) — a separate count, not range-bound.
    const { count: openNow } = await supabaseAdmin
      .from('work_orders')
      .select('id', { count: 'exact', head: true })
      .eq('property_id', ctx.propertyId)
      .is('resolved_at', null)
      .not('status', 'in', '("resolved","closed","done","completed")');

    const bySeverity = groupBy(rows, (r) => (r.severity || 'unspecified').toLowerCase());
    const out: ReportRow[] = [];
    const allHrs: number[] = [];
    for (const [sev, wos] of bySeverity) {
      const completed = wos.filter(isWorkOrderDone);
      const hrs = completed
        .map((w) => (w.resolved_at ? (new Date(w.resolved_at).getTime() - new Date(w.created_at).getTime()) / 3_600_000 : null))
        .filter((h): h is number => h != null && h >= 0);
      allHrs.push(...hrs);
      out.push({
        priority: sev.charAt(0).toUpperCase() + sev.slice(1),
        created: wos.length,
        completed: completed.length,
        open: wos.length - completed.length,
        avgHrs: hrs.length ? round(avg(hrs)!, 1) : null,
      });
    }
    out.sort((a, b) => Number(b.created) - Number(a.created));
    const totalCompleted = rows.filter(isWorkOrderDone).length;
    return {
      columns: [
        col('priority', 'Priority', 'Prioridad'),
        col('created', 'Created', 'Creadas', 'number'),
        col('completed', 'Completed', 'Completadas', 'number'),
        col('open', 'Still open', 'Abiertas', 'number'),
        col('avgHrs', 'Avg hrs to close', 'Hrs prom. cierre', 'number'),
      ],
      rows: out,
      stats: [
        { label: { en: 'Created in range', es: 'Creadas en rango' }, value: String(rows.length) },
        { label: { en: 'Completed', es: 'Completadas' }, value: String(totalCompleted) },
        { label: { en: 'Avg time to close', es: 'Tiempo prom. cierre' }, value: allHrs.length ? `${round(avg(allHrs)!, 1)}h` : '—' },
        { label: { en: 'Open right now', es: 'Abiertas ahora' }, value: String(openNow ?? 0) },
      ],
    };
  },
};

// ════════════════════════════════════════════════════════════════════════════
// INVENTORY
// ════════════════════════════════════════════════════════════════════════════

const inventorySpend: ReportDefinition = {
  key: 'inventory-spend',
  title: { en: 'Inventory spend', es: 'Gasto de inventario' },
  description: {
    en: 'Month spend vs budget by category (the accounting summary).',
    es: 'Gasto mensual vs. presupuesto por categoría (resumen contable).',
  },
  category: 'inventory',
  defaultRange: 'mtd',
  run: async (ctx): Promise<ReportRunResult> => {
    // Month-based report: use the month containing the range end.
    const monthStart = monthStartUtc(ctx.to);
    const summary = await getInventoryAccountingSummary(supabaseAdmin, ctx.propertyId, monthStart);
    const out: ReportRow[] = summary.byCategory.map((c) => ({
      category: c.category.charAt(0).toUpperCase() + c.category.slice(1),
      spend: c.spendCents,
      budget: c.budgetCents,
      remaining: c.remainingCents,
      discards: Math.round(c.discardsValue * 100),
    }));
    return {
      columns: [
        col('category', 'Category', 'Categoría'),
        col('spend', 'Spend', 'Gasto', 'currency'),
        col('budget', 'Budget', 'Presupuesto', 'currency'),
        col('remaining', 'Remaining', 'Restante', 'currency'),
        col('discards', 'Discards', 'Descartes', 'currency'),
      ],
      rows: out,
      stats: [
        { label: { en: 'Total spend', es: 'Gasto total' }, value: `$${(summary.totals.spendCents / 100).toFixed(2)}` },
        { label: { en: 'Budget', es: 'Presupuesto' }, value: summary.totals.budgetCents == null ? '—' : `$${(summary.totals.budgetCents / 100).toFixed(2)}` },
        { label: { en: 'Discards', es: 'Descartes' }, value: `$${summary.totals.discardsValue.toFixed(2)}` },
      ],
      notes: {
        en: `Covers the calendar month of ${ctx.to.slice(0, 7)} (spend = stock received this month).`,
        es: `Cubre el mes calendario de ${ctx.to.slice(0, 7)} (gasto = inventario recibido este mes).`,
      },
    };
  },
};

interface InventoryItemLite {
  name: string;
  category: string;
  current_stock: number | null;
  par_level: number | null;
  reorder_at: number | null;
}

const inventoryLowStock: ReportDefinition = {
  key: 'inventory-low-stock',
  title: { en: 'Low / critical stock', es: 'Inventario bajo / crítico' },
  description: {
    en: 'Items at or below their reorder point right now.',
    es: 'Artículos en o por debajo de su punto de reorden ahora.',
  },
  category: 'inventory',
  defaultRange: 'last7',
  run: async (ctx): Promise<ReportRunResult> => {
    const { data, error } = await supabaseAdmin
      .from('inventory')
      .select('name, category, current_stock, par_level, reorder_at')
      .eq('property_id', ctx.propertyId)
      .is('archived_at', null)
      .limit(5_000);
    if (error) throw error;
    const items = (data ?? []) as InventoryItemLite[];
    let critical = 0;
    let low = 0;
    const out: ReportRow[] = [];
    for (const it of items) {
      const stock = Number(it.current_stock ?? 0);
      const par = Number(it.par_level ?? 0);
      const reorder = it.reorder_at != null ? Number(it.reorder_at) : par * 0.7;
      const needsReorder = par > 0 ? stock <= reorder : stock <= 0;
      if (!needsReorder) continue;
      // 70/30 thresholds vs par (CLAUDE.md status colors).
      const pct = par > 0 ? stock / par : 0;
      const status = pct <= 0.3 ? 'Critical' : pct <= 0.7 ? 'Low' : 'Reorder';
      if (status === 'Critical') critical += 1;
      else if (status === 'Low') low += 1;
      out.push({
        item: it.name,
        category: it.category,
        onHand: stock,
        par: par || null,
        reorderAt: it.reorder_at,
        status,
        _pct: round(pct * 100),
      });
    }
    out.sort((a, b) => Number(a._pct) - Number(b._pct));
    for (const r of out) delete r._pct;
    return {
      columns: [
        col('item', 'Item', 'Artículo'),
        col('category', 'Category', 'Categoría'),
        col('onHand', 'On hand', 'En existencia', 'number'),
        col('par', 'Par', 'Par', 'number'),
        col('reorderAt', 'Reorder at', 'Reordenar en', 'number'),
        col('status', 'Status', 'Estado'),
      ],
      rows: out,
      stats: [
        { label: { en: 'Below reorder', es: 'Bajo reorden' }, value: String(out.length) },
        { label: { en: 'Critical', es: 'Crítico' }, value: String(critical) },
        { label: { en: 'Low', es: 'Bajo' }, value: String(low) },
      ],
      notes: {
        en: 'Current snapshot — not affected by the date range.',
        es: 'Instantánea actual — no depende del rango de fechas.',
      },
    };
  },
};

// ════════════════════════════════════════════════════════════════════════════
// OCCUPANCY
// ════════════════════════════════════════════════════════════════════════════

const occupancySummary: ReportDefinition = {
  key: 'occupancy-summary',
  title: { en: 'Occupancy', es: 'Ocupación' },
  description: {
    en: 'Occupied rooms, occupancy %, arrivals, departures and turns by day.',
    es: 'Habitaciones ocupadas, % de ocupación, llegadas, salidas y rotaciones por día.',
  },
  category: 'occupancy',
  defaultRange: 'last30',
  run: async (ctx): Promise<ReportRunResult> => {
    const [logsRes, dashRes, meta] = await Promise.all([
      supabaseAdmin
        .from('daily_logs')
        .select('date, occupied, checkouts, stayovers')
        .eq('property_id', ctx.propertyId)
        .gte('date', ctx.from)
        .lte('date', ctx.to)
        .order('date', { ascending: true }),
      supabaseAdmin
        .from('dashboard_by_date')
        .select('date, arrivals, departures, in_house')
        .eq('property_id', ctx.propertyId)
        .gte('date', ctx.from)
        .lte('date', ctx.to),
      getPropertyMeta(ctx.propertyId),
    ]);
    if (logsRes.error) throw logsRes.error;
    if (dashRes.error) throw dashRes.error;
    const logs = (logsRes.data ?? []) as Array<{ date: string; occupied: number | null; checkouts: number | null; stayovers: number | null }>;
    const dash = (dashRes.data ?? []) as Array<{ date: string; arrivals: number | null; departures: number | null; in_house: number | null }>;
    const dashByDate = new Map(dash.map((d) => [d.date, d]));
    const totalRooms = meta.totalRooms;

    const byDate = new Map<string, { date: string; occupied: number | null; checkouts: number; stayovers: number; arrivals: number; departures: number }>();
    for (const l of logs) {
      const d = dashByDate.get(l.date);
      const occupied = l.occupied != null ? Number(l.occupied) : d?.in_house != null ? Number(d.in_house) : null;
      byDate.set(l.date, {
        date: l.date,
        occupied,
        checkouts: Number(l.checkouts ?? 0),
        stayovers: Number(l.stayovers ?? 0),
        arrivals: Number(d?.arrivals ?? 0),
        departures: Number(d?.departures ?? 0),
      });
    }
    // Include dashboard-only dates (occupancy without an HK daily log).
    for (const d of dash) {
      if (byDate.has(d.date)) continue;
      byDate.set(d.date, {
        date: d.date,
        occupied: d.in_house != null ? Number(d.in_house) : null,
        checkouts: 0,
        stayovers: 0,
        arrivals: Number(d.arrivals ?? 0),
        departures: Number(d.departures ?? 0),
      });
    }

    const sorted = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    const occPcts: number[] = [];
    let roomNights = 0;
    const out: ReportRow[] = sorted.map((r) => {
      const occPct = totalRooms > 0 && r.occupied != null ? round((r.occupied / totalRooms) * 100) : null;
      if (occPct != null) occPcts.push(occPct);
      if (r.occupied != null) roomNights += r.occupied;
      return {
        date: r.date,
        occupied: r.occupied,
        occPct,
        arrivals: r.arrivals,
        departures: r.departures,
        checkouts: r.checkouts,
        stayovers: r.stayovers,
      };
    });
    return {
      columns: [
        col('date', 'Date', 'Fecha', 'date'),
        col('occupied', 'Occupied', 'Ocupadas', 'number'),
        col('occPct', 'Occupancy', 'Ocupación', 'percent'),
        col('arrivals', 'Arrivals', 'Llegadas', 'number'),
        col('departures', 'Departures', 'Salidas', 'number'),
        col('checkouts', 'Checkouts', 'Salidas hab.', 'number'),
        col('stayovers', 'Stayovers', 'Estancias', 'number'),
      ],
      rows: out,
      stats: [
        { label: { en: 'Avg occupancy', es: 'Ocupación prom.' }, value: occPcts.length ? `${round(avg(occPcts)!)}%` : '—' },
        { label: { en: 'Room-nights', es: 'Noches-hab.' }, value: String(roomNights) },
        { label: { en: 'Total rooms', es: 'Habitaciones' }, value: totalRooms ? String(totalRooms) : '—' },
      ],
      notes: {
        en: 'Revenue, ADR and RevPAR are not tracked yet, so this report shows occupancy from real operational data only.',
        es: 'Los ingresos, ADR y RevPAR aún no se registran, por lo que este reporte muestra solo la ocupación con datos operativos reales.',
      },
    };
  },
};

// ════════════════════════════════════════════════════════════════════════════
// ACTIVITY
// ════════════════════════════════════════════════════════════════════════════

const activitySummary: ReportDefinition = {
  key: 'activity-summary',
  title: { en: 'Activity summary', es: 'Resumen de actividad' },
  description: {
    en: 'Count of logged events by category over the date range.',
    es: 'Conteo de eventos registrados por categoría en el rango de fechas.',
  },
  category: 'activity',
  defaultRange: 'last7',
  run: async (ctx): Promise<ReportRunResult> => {
    const { fromUtc, toUtcExclusive } = utcBoundsForLocalRange(ctx.from, ctx.to, ctx.timezone);
    const categories = ACTIVITY_CATEGORIES as readonly string[];
    const counts = await Promise.all(
      categories.map(async (category) => {
        const { count, error } = await supabaseAdmin
          .from('activity_log')
          .select('id', { count: 'exact', head: true })
          .eq('property_id', ctx.propertyId)
          .eq('event_category', category)
          .gte('occurred_at', fromUtc)
          .lt('occurred_at', toUtcExclusive);
        if (error) throw error;
        return { category, count: count ?? 0 };
      }),
    );
    counts.sort((a, b) => b.count - a.count);
    const total = sum(counts.map((c) => c.count));
    const out: ReportRow[] = counts.map((c) => ({
      category: c.category.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()),
      events: c.count,
    }));
    const top = counts.find((c) => c.count > 0);
    return {
      columns: [
        col('category', 'Category', 'Categoría'),
        col('events', 'Events', 'Eventos', 'number'),
      ],
      rows: out,
      stats: [
        { label: { en: 'Total events', es: 'Eventos totales' }, value: String(total) },
        { label: { en: 'Most active', es: 'Más activa' }, value: top ? top.category.replace(/_/g, ' ') : '—' },
      ],
    };
  },
};

// ════════════════════════════════════════════════════════════════════════════
// COMPLIANCE (0229 — if present)
// ════════════════════════════════════════════════════════════════════════════

const complianceReadings: ReportDefinition = {
  key: 'compliance-readings',
  title: { en: 'Compliance readings', es: 'Lecturas de cumplimiento' },
  description: {
    en: 'Logged readings by type, with out-of-range counts.',
    es: 'Lecturas registradas por tipo, con conteos fuera de rango.',
  },
  category: 'compliance',
  defaultRange: 'last30',
  run: async (ctx): Promise<ReportRunResult> => {
    const { data, error } = await supabaseAdmin
      .from('compliance_readings')
      .select('value, text_value, unit, out_of_range, reading_date, reading_type_id, compliance_reading_types(name, category)')
      .eq('property_id', ctx.propertyId)
      .gte('reading_date', ctx.from)
      .lte('reading_date', ctx.to)
      .order('reading_date', { ascending: false })
      .limit(20_000);
    if (error) throw error;
    type Row = {
      value: number | null;
      text_value: string | null;
      unit: string | null;
      out_of_range: boolean | null;
      reading_date: string;
      reading_type_id: string;
      compliance_reading_types: { name?: string; category?: string } | Array<{ name?: string; category?: string }> | null;
    };
    const rows = (data ?? []) as Row[];
    const typeName = (r: Row): { name: string; category: string } => {
      const t = Array.isArray(r.compliance_reading_types) ? r.compliance_reading_types[0] : r.compliance_reading_types;
      return { name: t?.name ?? 'Reading', category: t?.category ?? '' };
    };
    const byType = groupBy(rows, (r) => r.reading_type_id);
    const out: ReportRow[] = [];
    let oor = 0;
    for (const [, group] of byType) {
      const meta = typeName(group[0]);
      const outOfRange = group.filter((r) => r.out_of_range).length;
      oor += outOfRange;
      const latest = group[0];
      const latestVal = latest.value != null ? `${latest.value}${latest.unit ? ' ' + latest.unit : ''}` : latest.text_value ?? '—';
      out.push({
        reading: meta.name,
        category: meta.category,
        logged: group.length,
        outOfRange,
        latest: latestVal,
      });
    }
    out.sort((a, b) => Number(b.logged) - Number(a.logged));
    return {
      columns: [
        col('reading', 'Reading', 'Lectura'),
        col('category', 'Category', 'Categoría'),
        col('logged', 'Logged', 'Registradas', 'number'),
        col('outOfRange', 'Out of range', 'Fuera de rango', 'number'),
        col('latest', 'Latest', 'Última'),
      ],
      rows: out,
      stats: [
        { label: { en: 'Total readings', es: 'Lecturas totales' }, value: String(rows.length) },
        { label: { en: 'Out of range', es: 'Fuera de rango' }, value: String(oor) },
        { label: { en: 'Types logged', es: 'Tipos registrados' }, value: String(byType.size) },
      ],
    };
  },
};

// ════════════════════════════════════════════════════════════════════════════
// LOST & FOUND (0230 — if present)
// ════════════════════════════════════════════════════════════════════════════

const LF_STATUSES = ['open', 'matched', 'returned', 'shipped', 'disposed', 'expired'] as const;

const lostAndFoundSummary: ReportDefinition = {
  key: 'lost-and-found-summary',
  title: { en: 'Lost & found', es: 'Objetos perdidos' },
  description: {
    en: 'Lost & found items by status — found vs lost.',
    es: 'Objetos perdidos y encontrados por estado — encontrados vs. perdidos.',
  },
  category: 'lost_found',
  defaultRange: 'last30',
  run: async (ctx): Promise<ReportRunResult> => {
    const { fromUtc, toUtcExclusive } = utcBoundsForLocalRange(ctx.from, ctx.to, ctx.timezone);
    const { data, error } = await supabaseAdmin
      .from('lost_and_found_items')
      .select('type, status, created_at')
      .eq('property_id', ctx.propertyId)
      .gte('created_at', fromUtc)
      .lt('created_at', toUtcExclusive)
      .limit(20_000);
    if (error) throw error;
    const rows = (data ?? []) as Array<{ type: string | null; status: string | null }>;
    const out: ReportRow[] = LF_STATUSES.map((status) => {
      const inStatus = rows.filter((r) => (r.status ?? 'open') === status);
      return {
        status: status.charAt(0).toUpperCase() + status.slice(1),
        found: inStatus.filter((r) => r.type === 'found').length,
        lost: inStatus.filter((r) => r.type === 'lost').length,
        total: inStatus.length,
      };
    }).filter((r) => Number(r.total) > 0);
    return {
      columns: [
        col('status', 'Status', 'Estado'),
        col('found', 'Found', 'Encontrados', 'number'),
        col('lost', 'Lost', 'Perdidos', 'number'),
        col('total', 'Total', 'Total', 'number'),
      ],
      rows: out,
      stats: [
        { label: { en: 'Total items', es: 'Objetos totales' }, value: String(rows.length) },
        { label: { en: 'Open', es: 'Abiertos' }, value: String(rows.filter((r) => (r.status ?? 'open') === 'open').length) },
        { label: { en: 'Returned', es: 'Devueltos' }, value: String(rows.filter((r) => r.status === 'returned').length) },
      ],
    };
  },
};

// ════════════════════════════════════════════════════════════════════════════
// REGISTRY
// ════════════════════════════════════════════════════════════════════════════

export const REPORT_DEFINITIONS: ReportDefinition[] = [
  hkLeaderboard,
  hkCleanTimes,
  inspectionsByInspector,
  inspectionFailures,
  workOrdersSummary,
  inventorySpend,
  inventoryLowStock,
  occupancySummary,
  activitySummary,
  complianceReadings,
  lostAndFoundSummary,
];
