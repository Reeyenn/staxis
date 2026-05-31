// Server-side data access for engineering compliance (service role).
//
// Everything that touches the compliance_* tables lives here. /api/* routes
// (engineer mobile + manager) call these; the browser never touches the tables
// directly (RLS deny-all — see migration 0229 / CLAUDE.md RLS bug class).

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import { APP_TIMEZONE, todayStr } from '@/lib/utils';
import {
  currentReadingPeriodKey,
  currentPmPeriodKey,
  previousPmPeriodKey,
  pmNextDueISO,
  readingPeriodLabel,
  pmPeriodLabel,
  ratioToStatus,
} from './periods';
import {
  autoActOnOutOfRangeReading,
  autoActOnFailedPmCheck,
} from './autoact';
import type {
  ReadingType,
  PmTask,
  Reading,
  PmCheck,
  ReadingCategory,
  ReadingCadence,
  PmCategory,
  PmCadence,
  ReadingSource,
  PmStatus,
  ComplianceOverview,
  ComplianceSummary,
  ReadingTypeStatus,
  PmTaskStatus,
  ComplianceReport,
  ComplianceReportRow,
} from './types';
import type { ReadingTypeSeed, PmTaskSeed } from './templates';

// ─── Coercion helpers (PostgREST may return numeric as string) ──────────────

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

// ─── Row mappers ─────────────────────────────────────────────────────────────

function mapReadingType(r: Record<string, unknown>): ReadingType {
  return {
    id: String(r.id),
    propertyId: String(r.property_id ?? ''),
    category: (r.category as ReadingCategory) ?? 'other',
    name: String(r.name ?? ''),
    unit: String(r.unit ?? ''),
    cadence: (r.cadence as ReadingCadence) ?? 'daily',
    assignedDepartment: String(r.assigned_department ?? 'maintenance'),
    minValue: numOrNull(r.min_value),
    maxValue: numOrNull(r.max_value),
    templateKey: strOrNull(r.template_key),
    sortOrder: Number(r.sort_order ?? 0),
    active: r.active !== false,
  };
}

function mapPmTask(r: Record<string, unknown>): PmTask {
  return {
    id: String(r.id),
    propertyId: String(r.property_id ?? ''),
    category: (r.category as PmCategory) ?? 'life_safety',
    name: String(r.name ?? ''),
    equipmentType: strOrNull(r.equipment_type),
    unitCount: Number(r.unit_count ?? 1),
    cadence: (r.cadence as PmCadence) ?? 'monthly',
    assignedDepartment: String(r.assigned_department ?? 'maintenance'),
    templateKey: strOrNull(r.template_key),
    sortOrder: Number(r.sort_order ?? 0),
    active: r.active !== false,
  };
}

function mapReading(r: Record<string, unknown>): Reading {
  return {
    id: String(r.id),
    propertyId: String(r.property_id ?? ''),
    readingTypeId: String(r.reading_type_id ?? ''),
    value: numOrNull(r.value),
    textValue: strOrNull(r.text_value),
    unit: String(r.unit ?? ''),
    readingDate: String(r.reading_date ?? ''),
    periodKey: String(r.period_key ?? ''),
    outOfRange: r.out_of_range === true,
    source: (r.source as ReadingSource) ?? 'manual',
    note: strOrNull(r.note),
    photoPath: strOrNull(r.photo_path),
    loggedByStaffId: strOrNull(r.logged_by_staff_id),
    loggedByName: strOrNull(r.logged_by_name),
    loggedAt: String(r.logged_at ?? ''),
    workOrderId: strOrNull(r.work_order_id),
  };
}

function mapPmCheck(r: Record<string, unknown>): PmCheck {
  return {
    id: String(r.id),
    propertyId: String(r.property_id ?? ''),
    pmTaskId: String(r.pm_task_id ?? ''),
    periodKey: String(r.period_key ?? ''),
    status: (r.status as PmStatus) ?? 'pass',
    unitsChecked: numOrNull(r.units_checked),
    note: strOrNull(r.note),
    photoPath: strOrNull(r.photo_path),
    checkedByStaffId: strOrNull(r.checked_by_staff_id),
    checkedByName: strOrNull(r.checked_by_name),
    checkedAt: String(r.checked_at ?? ''),
    workOrderId: strOrNull(r.work_order_id),
  };
}

// ─── Definition reads ────────────────────────────────────────────────────────

export async function listReadingTypes(pid: string, activeOnly = true): Promise<ReadingType[]> {
  let q = supabaseAdmin.from('compliance_reading_types').select('*').eq('property_id', pid);
  if (activeOnly) q = q.eq('active', true);
  const { data, error } = await q.order('sort_order', { ascending: true }).order('name', { ascending: true });
  if (error) { log.error('[compliance] listReadingTypes', { pid, msg: error.message }); return []; }
  return (data ?? []).map(mapReadingType);
}

export async function listPmTasks(pid: string, activeOnly = true): Promise<PmTask[]> {
  let q = supabaseAdmin.from('compliance_pm_tasks').select('*').eq('property_id', pid);
  if (activeOnly) q = q.eq('active', true);
  const { data, error } = await q.order('sort_order', { ascending: true }).order('name', { ascending: true });
  if (error) { log.error('[compliance] listPmTasks', { pid, msg: error.message }); return []; }
  return (data ?? []).map(mapPmTask);
}

// ─── Overview / summary (manager tab, engineer page, dashboard tile) ─────────

export async function getOverview(pid: string, now: Date = new Date()): Promise<ComplianceOverview> {
  const [types, tasks] = await Promise.all([listReadingTypes(pid, true), listPmTasks(pid, true)]);

  // Recent readings (40-day window covers a monthly cadence) grouped by type.
  const readingWindow = new Date(now.getTime() - 40 * 24 * 3600 * 1000).toISOString();
  const { data: readingRows } = await supabaseAdmin
    .from('compliance_readings')
    .select('*')
    .eq('property_id', pid)
    .gte('logged_at', readingWindow)
    .order('logged_at', { ascending: false });
  const readingsByType = new Map<string, Reading[]>();
  for (const raw of readingRows ?? []) {
    const r = mapReading(raw);
    const arr = readingsByType.get(r.readingTypeId) ?? [];
    arr.push(r);
    readingsByType.set(r.readingTypeId, arr);
  }

  // Recent checks (400-day window covers an annual cadence) grouped by task.
  const checkWindow = new Date(now.getTime() - 400 * 24 * 3600 * 1000).toISOString();
  const { data: checkRows } = await supabaseAdmin
    .from('compliance_pm_checks')
    .select('*')
    .eq('property_id', pid)
    .gte('checked_at', checkWindow)
    .order('checked_at', { ascending: false });
  const checksByTask = new Map<string, PmCheck[]>();
  for (const raw of checkRows ?? []) {
    const c = mapPmCheck(raw);
    const arr = checksByTask.get(c.pmTaskId) ?? [];
    arr.push(c);
    checksByTask.set(c.pmTaskId, arr);
  }

  const readings: ReadingTypeStatus[] = types.map((type) => {
    const group = readingsByType.get(type.id) ?? [];
    const currentKey = currentReadingPeriodKey(type.cadence, now);
    const latest = group[0] ?? null;
    const doneThisPeriod = group.some((r) => r.periodKey === currentKey);
    return {
      type,
      latest,
      doneThisPeriod,
      currentPeriodKey: currentKey,
      periodLabel: readingPeriodLabel(type.cadence, now),
      latestOutOfRange: latest?.outOfRange ?? false,
    };
  });

  const pmStatuses: PmTaskStatus[] = tasks.map((task) => {
    const group = checksByTask.get(task.id) ?? [];
    const currentKey = currentPmPeriodKey(task.cadence, now);
    const prevKey = previousPmPeriodKey(task.cadence, now);
    const latest = group[0] ?? null;
    const passKeys = new Set(group.filter((c) => c.status === 'pass').map((c) => c.periodKey));
    const doneThisPeriod = passKeys.has(currentKey);
    const neverChecked = group.length === 0;
    // Calendar-based overdue: not passed THIS period AND (never checked OR the
    // PREVIOUS period was also missed → at least one full period has lapsed).
    // This flips to overdue promptly at the period rollover rather than a
    // variable rolling window after the last check.
    const overdue = !doneThisPeriod && (neverChecked || !passKeys.has(prevKey));
    return {
      task,
      latest,
      doneThisPeriod,
      currentPeriodKey: currentKey,
      periodLabel: pmPeriodLabel(task.cadence),
      overdue,
      nextDueISO: pmNextDueISO(task.cadence, now),
    };
  });

  const readingsTotal = readings.length;
  const readingsDone = readings.filter((r) => r.doneThisPeriod).length;
  const readingsCompletePct = readingsTotal > 0 ? Math.round((readingsDone / readingsTotal) * 100) : 100;
  const pmOverdueCount = pmStatuses.filter((p) => p.overdue).length;

  return {
    readings,
    pmTasks: pmStatuses,
    readingsCompletePct,
    readingsDone,
    readingsTotal,
    pmOverdueCount,
    pmTotal: pmStatuses.length,
  };
}

export async function getSummary(pid: string, now: Date = new Date()): Promise<ComplianceSummary> {
  const o = await getOverview(pid, now);
  // The tile is "green only when readings are on track AND nothing is overdue".
  const readingRatio = o.readingsTotal > 0 ? o.readingsDone / o.readingsTotal : 1;
  let status = ratioToStatus(readingRatio);
  if (o.pmOverdueCount > 0 && status === 'good') status = 'low';
  if (o.pmOverdueCount >= 3) status = 'critical';
  return {
    readingsCompletePct: o.readingsCompletePct,
    readingsDone: o.readingsDone,
    readingsTotal: o.readingsTotal,
    pmOverdueCount: o.pmOverdueCount,
    pmTotal: o.pmTotal,
    status,
  };
}

// ─── Inspector-ready report (AI feature #6) ──────────────────────────────────

export async function getReport(pid: string, fromDate: string, toDate: string): Promise<ComplianceReport> {
  const [types, tasks] = await Promise.all([listReadingTypes(pid, false), listPmTasks(pid, false)]);
  const typeById = new Map(types.map((t) => [t.id, t]));
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  const fromISO = `${fromDate}T00:00:00Z`;
  const toISO = `${toDate}T23:59:59Z`;

  // Explicit row cap so PostgREST's default ~1000-row limit can't silently
  // truncate an inspector-facing artifact without a signal.
  const REPORT_ROW_CAP = 5000;
  const { data: readingRows } = await supabaseAdmin
    .from('compliance_readings')
    .select('*')
    .eq('property_id', pid)
    .gte('logged_at', fromISO)
    .lte('logged_at', toISO)
    .order('logged_at', { ascending: true })
    .limit(REPORT_ROW_CAP);
  const { data: checkRows } = await supabaseAdmin
    .from('compliance_pm_checks')
    .select('*')
    .eq('property_id', pid)
    .gte('checked_at', fromISO)
    .lte('checked_at', toISO)
    .order('checked_at', { ascending: true })
    .limit(REPORT_ROW_CAP);
  const truncated = (readingRows ?? []).length >= REPORT_ROW_CAP || (checkRows ?? []).length >= REPORT_ROW_CAP;

  const readingGroups = new Map<string, ComplianceReportRow>();
  let outOfRangeCount = 0;
  for (const raw of readingRows ?? []) {
    const r = mapReading(raw);
    if (r.outOfRange) outOfRangeCount += 1;
    const t = typeById.get(r.readingTypeId);
    const key = r.readingTypeId;
    if (!readingGroups.has(key)) {
      readingGroups.set(key, { category: t?.category ?? 'other', name: t?.name ?? 'Reading', unit: t?.unit ?? r.unit, entries: [] });
    }
    readingGroups.get(key)!.entries.push({
      when: r.loggedAt,
      value: r.value !== null ? `${r.value}${r.unit}` : (r.textValue ?? '—'),
      by: r.loggedByName ?? 'Unknown',
      status: r.outOfRange ? 'OUT OF RANGE' : 'ok',
    });
  }

  const pmGroups = new Map<string, ComplianceReportRow>();
  let pmFailCount = 0;
  for (const raw of checkRows ?? []) {
    const c = mapPmCheck(raw);
    if (c.status === 'fail') pmFailCount += 1;
    const t = taskById.get(c.pmTaskId);
    const key = c.pmTaskId;
    if (!pmGroups.has(key)) {
      pmGroups.set(key, { category: t?.category ?? 'life_safety', name: t?.name ?? 'PM check', entries: [] });
    }
    pmGroups.get(key)!.entries.push({
      when: c.checkedAt,
      value: `${c.status.toUpperCase()}${c.unitsChecked !== null ? ` (${c.unitsChecked} units)` : ''}`,
      by: c.checkedByName ?? 'Unknown',
      status: c.status,
    });
  }

  return {
    propertyId: pid,
    fromDate,
    toDate,
    readings: Array.from(readingGroups.values()),
    pmChecks: Array.from(pmGroups.values()),
    totals: {
      readingCount: (readingRows ?? []).length,
      outOfRangeCount,
      pmCheckCount: (checkRows ?? []).length,
      pmFailCount,
    },
    truncated,
  };
}

// ─── Logging (engineer mobile + manager + voice/agent) ───────────────────────

export interface LogReadingInput {
  pid: string;
  readingTypeId: string;
  value: number | null;
  textValue?: string | null;
  source?: ReadingSource;
  note?: string | null;
  photoPath?: string | null;
  staffId?: string | null;
  staffName?: string | null;
  idempotencyKey?: string | null;
  now?: Date;
}

export interface LogReadingResult {
  reading: Reading;
  outOfRange: boolean;
  workOrderId: string | null;
  duplicate: boolean;
}

export async function logReading(input: LogReadingInput): Promise<LogReadingResult> {
  const now = input.now ?? new Date();
  const { data: typeRow, error: typeErr } = await supabaseAdmin
    .from('compliance_reading_types')
    .select('*')
    .eq('id', input.readingTypeId)
    .eq('property_id', input.pid)
    .maybeSingle();
  if (typeErr) throw new Error(`reading type lookup failed: ${typeErr.message}`);
  if (!typeRow) throw new Error('reading type not found for this property');
  const type = mapReadingType(typeRow);

  // Out-of-range detection against the type's safe thresholds.
  const value = input.value;
  const outOfRange =
    value !== null &&
    ((type.minValue !== null && value < type.minValue) ||
      (type.maxValue !== null && value > type.maxValue));

  const periodKey = currentReadingPeriodKey(type.cadence, now);
  const readingDate = todayStr(APP_TIMEZONE);

  const insertRow = {
    property_id: input.pid,
    reading_type_id: type.id,
    value,
    text_value: input.textValue ?? null,
    unit: type.unit,
    reading_date: readingDate,
    period_key: periodKey,
    out_of_range: outOfRange,
    source: input.source ?? 'manual',
    note: input.note ?? null,
    photo_path: input.photoPath ?? null,
    logged_by_staff_id: input.staffId ?? null,
    logged_by_name: input.staffName ?? null,
    logged_at: now.toISOString(),
    idempotency_key: input.idempotencyKey ?? null,
  };

  const { data: inserted, error: insErr } = await supabaseAdmin
    .from('compliance_readings')
    .insert(insertRow)
    .select('*')
    .single();

  if (insErr) {
    // Idempotency: a retried voice/agent log hits the partial-unique index.
    if ((insErr as { code?: string }).code === '23505' && input.idempotencyKey) {
      const { data: existing } = await supabaseAdmin
        .from('compliance_readings')
        .select('*')
        .eq('property_id', input.pid)
        .eq('idempotency_key', input.idempotencyKey)
        .maybeSingle();
      if (existing) {
        const reading = mapReading(existing);
        return { reading, outOfRange: reading.outOfRange, workOrderId: reading.workOrderId, duplicate: true };
      }
    }
    throw new Error(`reading insert failed: ${insErr.message}`);
  }

  const reading = mapReading(inserted);

  // ════════════════════════════════════════════════════════════════════════
  // v2 SEAM — leak/spike ANOMALY DETECTION on reading trends goes HERE.
  // Out of scope for v1 (explicitly deferred). A future version will compare
  // `value` against the recent trend for `type` and flag anomalies even when
  // the value is inside its static min/max band. Do NOT add anomaly logic in
  // v1 — only the static threshold check above is in scope.
  //   TODO(v2-anomaly): const anomaly = await detectReadingAnomaly(type, reading);
  // ════════════════════════════════════════════════════════════════════════

  // AI feature #3 — auto-act on out-of-range.
  let workOrderId: string | null = null;
  if (outOfRange && value !== null) {
    workOrderId = await autoActOnOutOfRangeReading({
      pid: input.pid,
      typeName: type.name,
      unit: type.unit,
      value,
      minValue: type.minValue,
      maxValue: type.maxValue,
    });
    if (workOrderId) {
      await supabaseAdmin.from('compliance_readings').update({ work_order_id: workOrderId }).eq('id', reading.id);
      reading.workOrderId = workOrderId;
    }
  }

  return { reading, outOfRange: !!outOfRange, workOrderId, duplicate: false };
}

export interface LogPmCheckInput {
  pid: string;
  pmTaskId: string;
  status: PmStatus;
  unitsChecked?: number | null;
  note?: string | null;
  photoPath?: string | null;
  staffId?: string | null;
  staffName?: string | null;
  now?: Date;
}

export interface LogPmCheckResult {
  check: PmCheck;
  workOrderId: string | null;
}

export async function logPmCheck(input: LogPmCheckInput): Promise<LogPmCheckResult> {
  const now = input.now ?? new Date();
  const { data: taskRow, error: taskErr } = await supabaseAdmin
    .from('compliance_pm_tasks')
    .select('*')
    .eq('id', input.pmTaskId)
    .eq('property_id', input.pid)
    .maybeSingle();
  if (taskErr) throw new Error(`pm task lookup failed: ${taskErr.message}`);
  if (!taskRow) throw new Error('PM task not found for this property');
  const task = mapPmTask(taskRow);

  const periodKey = currentPmPeriodKey(task.cadence, now);

  // APPEND-ONLY: every check is a new immutable row. A later pass NEVER
  // overwrites an earlier fail — the failed life-safety check stays in the
  // audit history (Codex adversarial finding). Current-period completion is
  // derived in getOverview ("a pass exists for the period"), so duplicates are
  // harmless for counts.
  const insertRow = {
    property_id: input.pid,
    pm_task_id: task.id,
    period_key: periodKey,
    status: input.status,
    units_checked: input.unitsChecked ?? null,
    note: input.note ?? null,
    photo_path: input.photoPath ?? null,
    checked_by_staff_id: input.staffId ?? null,
    checked_by_name: input.staffName ?? null,
    checked_at: now.toISOString(),
  };

  const { data: inserted, error: insErr } = await supabaseAdmin
    .from('compliance_pm_checks')
    .insert(insertRow)
    .select('*')
    .single();
  if (insErr) throw new Error(`pm check insert failed: ${insErr.message}`);

  const check = mapPmCheck(inserted);

  let workOrderId: string | null = null;
  if (input.status === 'fail') {
    workOrderId = await autoActOnFailedPmCheck({ pid: input.pid, taskName: task.name, note: input.note ?? null });
    if (workOrderId) {
      await supabaseAdmin.from('compliance_pm_checks').update({ work_order_id: workOrderId }).eq('id', check.id);
      check.workOrderId = workOrderId;
    }
  }

  return { check, workOrderId };
}

// ─── Fuzzy lookup for voice / agent logging ──────────────────────────────────

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Find the best-matching active reading type for a free-text metric name. */
export async function findReadingTypeByName(pid: string, query: string): Promise<ReadingType | null> {
  const types = await listReadingTypes(pid, true);
  const q = normalize(query);
  if (!q) return null;
  // Exact normalized match first, then "name contains query" or vice versa,
  // then token overlap.
  let best: { t: ReadingType; score: number } | null = null;
  for (const t of types) {
    const n = normalize(t.name);
    let score = 0;
    if (n === q) score = 100;
    else if (n.includes(q) || q.includes(n)) score = 60;
    else {
      const qTokens = new Set(q.split(' '));
      const overlap = n.split(' ').filter((tok) => qTokens.has(tok)).length;
      score = overlap * 10;
    }
    if (score > 0 && (!best || score > best.score)) best = { t, score };
  }
  return best?.t ?? null;
}

export async function findPmTaskByName(pid: string, query: string): Promise<PmTask | null> {
  const tasks = await listPmTasks(pid, true);
  const q = normalize(query);
  if (!q) return null;
  let best: { t: PmTask; score: number } | null = null;
  for (const t of tasks) {
    const n = normalize(t.name);
    let score = 0;
    if (n === q) score = 100;
    else if (n.includes(q) || q.includes(n)) score = 60;
    else {
      const qTokens = new Set(q.split(' '));
      const overlap = n.split(' ').filter((tok) => qTokens.has(tok)).length;
      score = overlap * 10;
    }
    if (score > 0 && (!best || score > best.score)) best = { t, score };
  }
  return best?.t ?? null;
}

// ─── Definition writes (manager config) ──────────────────────────────────────

export interface ReadingTypeWrite {
  category: ReadingCategory;
  name: string;
  unit: string;
  cadence: ReadingCadence;
  assignedDepartment?: string;
  minValue?: number | null;
  maxValue?: number | null;
  templateKey?: string | null;
  sortOrder?: number;
}

export async function createReadingType(pid: string, w: ReadingTypeWrite): Promise<ReadingType> {
  const { data, error } = await supabaseAdmin
    .from('compliance_reading_types')
    .insert({
      property_id: pid,
      category: w.category,
      name: w.name,
      unit: w.unit,
      cadence: w.cadence,
      assigned_department: w.assignedDepartment ?? 'maintenance',
      min_value: w.minValue ?? null,
      max_value: w.maxValue ?? null,
      template_key: w.templateKey ?? null,
      sort_order: w.sortOrder ?? 0,
    })
    .select('*')
    .single();
  if (error) throw new Error(`createReadingType failed: ${error.message}`);
  return mapReadingType(data);
}

export async function updateReadingType(pid: string, id: string, w: Partial<ReadingTypeWrite> & { active?: boolean }): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (w.category !== undefined) patch.category = w.category;
  if (w.name !== undefined) patch.name = w.name;
  if (w.unit !== undefined) patch.unit = w.unit;
  if (w.cadence !== undefined) patch.cadence = w.cadence;
  if (w.assignedDepartment !== undefined) patch.assigned_department = w.assignedDepartment;
  if (w.minValue !== undefined) patch.min_value = w.minValue;
  if (w.maxValue !== undefined) patch.max_value = w.maxValue;
  if (w.sortOrder !== undefined) patch.sort_order = w.sortOrder;
  if (w.active !== undefined) patch.active = w.active;
  if (Object.keys(patch).length === 0) return;
  const { error } = await supabaseAdmin
    .from('compliance_reading_types')
    .update(patch)
    .eq('id', id)
    .eq('property_id', pid);
  if (error) throw new Error(`updateReadingType failed: ${error.message}`);
}

export interface PmTaskWrite {
  category: PmCategory;
  name: string;
  equipmentType?: string | null;
  unitCount: number;
  cadence: PmCadence;
  assignedDepartment?: string;
  templateKey?: string | null;
  sortOrder?: number;
}

export async function createPmTask(pid: string, w: PmTaskWrite): Promise<PmTask> {
  const { data, error } = await supabaseAdmin
    .from('compliance_pm_tasks')
    .insert({
      property_id: pid,
      category: w.category,
      name: w.name,
      equipment_type: w.equipmentType ?? null,
      unit_count: w.unitCount,
      cadence: w.cadence,
      assigned_department: w.assignedDepartment ?? 'maintenance',
      template_key: w.templateKey ?? null,
      sort_order: w.sortOrder ?? 0,
    })
    .select('*')
    .single();
  if (error) throw new Error(`createPmTask failed: ${error.message}`);
  return mapPmTask(data);
}

export async function updatePmTask(pid: string, id: string, w: Partial<PmTaskWrite> & { active?: boolean }): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (w.category !== undefined) patch.category = w.category;
  if (w.name !== undefined) patch.name = w.name;
  if (w.equipmentType !== undefined) patch.equipment_type = w.equipmentType;
  if (w.unitCount !== undefined) patch.unit_count = w.unitCount;
  if (w.cadence !== undefined) patch.cadence = w.cadence;
  if (w.assignedDepartment !== undefined) patch.assigned_department = w.assignedDepartment;
  if (w.sortOrder !== undefined) patch.sort_order = w.sortOrder;
  if (w.active !== undefined) patch.active = w.active;
  if (Object.keys(patch).length === 0) return;
  const { error } = await supabaseAdmin
    .from('compliance_pm_tasks')
    .update(patch)
    .eq('id', id)
    .eq('property_id', pid);
  if (error) throw new Error(`updatePmTask failed: ${error.message}`);
}

/**
 * Apply a set of reading-type + PM-task seeds to a property (used by one-line
 * setup + template loading). Skips a seed whose name already exists as an
 * active definition so re-running is idempotent. Returns counts created.
 */
export async function applySeeds(
  pid: string,
  readingSeeds: ReadingTypeSeed[],
  pmSeeds: PmTaskSeed[],
  templateKey: string | null,
): Promise<{ readingsCreated: number; pmCreated: number }> {
  const [existingTypes, existingTasks] = await Promise.all([listReadingTypes(pid, false), listPmTasks(pid, false)]);
  const existingTypeNames = new Set(existingTypes.map((t) => normalize(t.name)));
  const existingTaskNames = new Set(existingTasks.map((t) => normalize(t.name)));

  let readingsCreated = 0;
  let pmCreated = 0;
  let sort = existingTypes.length;
  for (const seed of readingSeeds) {
    if (existingTypeNames.has(normalize(seed.name))) continue;
    await createReadingType(pid, {
      category: seed.category,
      name: seed.name,
      unit: seed.unit,
      cadence: seed.cadence,
      minValue: seed.minValue,
      maxValue: seed.maxValue,
      templateKey,
      sortOrder: sort++,
    });
    readingsCreated += 1;
  }
  let psort = existingTasks.length;
  for (const seed of pmSeeds) {
    if (existingTaskNames.has(normalize(seed.name))) continue;
    await createPmTask(pid, {
      category: seed.category,
      name: seed.name,
      equipmentType: seed.equipmentType,
      unitCount: seed.unitCount,
      cadence: seed.cadence,
      templateKey,
      sortOrder: psort++,
    });
    pmCreated += 1;
  }
  return { readingsCreated, pmCreated };
}

// ─── Photo persistence (snap-to-log audit trail) ─────────────────────────────

/**
 * Upload a base64 photo to the existing maintenance-photos bucket and return
 * the storage path. Best-effort: returns null on failure (the reading/check
 * still logs without a photo).
 */
export async function uploadCompliancePhoto(
  pid: string,
  base64: string,
  mediaType: string,
): Promise<string | null> {
  try {
    const ext = mediaType.includes('png') ? 'png' : mediaType.includes('webp') ? 'webp' : 'jpg';
    // Path prefixed by property id (matches maintenance-photos per-property RLS).
    const rand = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const path = `${pid}/compliance/${rand}.${ext}`;
    const buffer = Buffer.from(base64, 'base64');
    const { error } = await supabaseAdmin.storage
      .from('maintenance-photos')
      .upload(path, buffer, { contentType: mediaType, upsert: false });
    if (error) {
      log.error('[compliance] photo upload failed', { pid, msg: error.message });
      return null;
    }
    return path;
  } catch (e) {
    log.error('[compliance] photo upload threw', { pid, err: e instanceof Error ? e : new Error(String(e)) });
    return null;
  }
}
