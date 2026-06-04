// ─── Operational signal detection ("learn from every single thing") ──────────
// The deterministic half of operational learning. Each night, for one hotel, we
// scan the last 30 days of OPERATIONAL data the staff logged — complaints,
// maintenance work orders, compliance readings, inspections, cleaning times —
// and surface DURABLE patterns (e.g. "room 305 has had 4 AC work orders this
// month", "floor 4 gets weekend noise complaints", "pool pH keeps drifting out
// of range"). These become long-term copilot memory + dashboard insights.
//
// Design (why this layer is pure SQL + pure functions, not an LLM):
//   • Cheap + deterministic + scalable to 300+ hotels — the heavy lifting is
//     indexed aggregation; the LLM (in memory-consolidate.ts) only PHRASES the
//     significant signals into a readable sentence.
//   • Each signal carries a STABLE topic slug derived from the pattern IDENTITY
//     (room + category), NOT the measurement. So re-running tomorrow with a
//     higher count UPDATES the one memory row (idempotent) instead of spamming.
//     The count lives in `metric`/content, never in the slug.
//   • PII-safe: queries select only room / category / severity / counts — never
//     guest_name / guest_contact / free-text descriptions.
//
// All queries are property_id-scoped via supabaseAdmin (service-role); this
// module is server-only and intentionally not in the db.ts shim.

import 'server-only';
import { supabaseAdmin } from '@/lib/supabase-admin';

export const SIGNAL_WINDOW_DAYS = 30;
export const MAX_SIGNALS = 12; // cap the per-hotel LLM input / memory write fan-out

// Significance thresholds — the whole "what counts as a durable pattern" policy
// on one screen. Conservative by default (better to learn nothing than noise).
export const THRESHOLDS = {
  maintenancePerRoomCategory: 3, // ≥3 work orders, same room + category, in 30d
  complaintsPerRoomCategory: 3, // ≥3 complaints, same room + category, in 30d
  highSeverityComplaints: 2, // OR ≥2 high-severity complaints, same room + category
  weekendNoisePerFloor: 4, // ≥4 weekend noise complaints on one floor in 30d
  complianceOutOfRange: 3, // ≥3 out-of-range readings for one metric in 30d
  inspectionFailsPerRoom: 3, // ≥3 inspection fails, same room, in 30d
  slowCleanMinSamples: 5, // need ≥5 cleans to judge a room slow
  slowCleanRatio: 1.5, // room median > 1.5× property median
} as const;

const QUERY_ROW_CAP = 5000; // 30 days, one property — comfortably bounds any feed

export type SignalSeverity = 'attention' | 'info';

export interface OperationalSignal {
  /** STABLE deterministic slug = the dedupe key. Encodes pattern identity
   *  (room/category), never the count. ≤80 chars (agent_memory.topic CHECK). */
  topic: string;
  category: 'maintenance' | 'complaint' | 'noise' | 'compliance' | 'inspection' | 'cleaning';
  severity: SignalSeverity;
  targetLabel: string | null; // 'Room 305', 'Floor 4', 'Pool pH'
  metric: string; // human evidence: '4 hvac work orders in 30 days'
  count: number;
  windowDays: number;
}

// ─── helpers (pure) ──────────────────────────────────────────────────────────

/** Normalize a room number so "305", " 305 ", "0305" all group as one room. */
export function normalizeRoom(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = String(raw).trim();
  if (!t) return null;
  // Strip leading zeros but keep at least one char (so "0305"→"305", "007"→"7").
  return t.replace(/^0+(?=.)/, '');
}

/** Derive a floor label from a room number: "305"→"3", "1203"→"12", "12"→"12".
 *  ACCEPTED LIMITATION: the floor-based (weekend-noise) signal assumes ≥3-digit
 *  room numbering; a 2-digit-room hotel makes each room its own "floor" so the
 *  per-floor count never reaches threshold — the signal fails CLOSED (no false
 *  positives), the other signals are unaffected. */
export function floorOf(raw: string | null | undefined): string | null {
  const room = normalizeRoom(raw);
  if (!room) return null;
  const digits = (room.match(/^\d+/) || [''])[0];
  if (!digits) return null;
  return digits.length >= 3 ? digits.slice(0, digits.length - 2) : digits;
}

function slugPart(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Build a stable, ≤80-char topic slug from already-safe parts. */
function makeTopic(...parts: string[]): string {
  return parts.map(slugPart).filter(Boolean).join('_').slice(0, 80);
}

// Topic-prefix → severity, for the dashboard. Operational facts carry a stable
// `op_*` topic prefix (set by the aggregators above); the proactive "What Staxis
// noticed" card surfaces the 'attention' ones. Returns null for non-operational
// (conversation-consolidation) topics. Keep in sync with the slug prefixes used
// by signalsFrom* above.
const ATTENTION_PREFIXES = ['op_maint_', 'op_complaint_', 'op_noise_floor_', 'op_compliance_', 'op_inspect_fail_'];
const INFO_PREFIXES = ['op_clean_slow_'];
export function insightSeverityFromTopic(topic: string): SignalSeverity | null {
  if (ATTENTION_PREFIXES.some((p) => topic.startsWith(p))) return 'attention';
  if (INFO_PREFIXES.some((p) => topic.startsWith(p))) return 'info';
  return null;
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** A deterministic, PII-free content sentence — the template fallback used when
 *  the LLM phrasing pass is unavailable. The engine prefers the LLM's wording
 *  but this guarantees a sensible fact even with no model call. */
export function templateContent(sig: OperationalSignal): string {
  const where = sig.targetLabel ?? 'this hotel';
  switch (sig.category) {
    case 'maintenance':
      return `${where} has had repeated maintenance issues (${sig.metric}).`;
    case 'complaint':
      return `${where} has had recurring guest complaints (${sig.metric}).`;
    case 'noise':
      return `${where} gets recurring weekend noise complaints (${sig.metric}).`;
    case 'compliance':
      return `${sig.targetLabel ?? 'A compliance reading'} has been out of range repeatedly (${sig.metric}).`;
    case 'inspection':
      return `${where} repeatedly fails housekeeping inspection (${sig.metric}).`;
    case 'cleaning':
      return `${where} consistently takes longer to clean than typical (${sig.metric}).`;
    default:
      return `${where}: ${sig.metric}.`;
  }
}

// ─── pure aggregators (raw rows → signals) — unit-tested without a DB ─────────

export interface WorkOrderRow { room_number: string | null; category: string | null }
export function signalsFromWorkOrders(rows: WorkOrderRow[]): OperationalSignal[] {
  const counts = new Map<string, { room: string; category: string; n: number }>();
  for (const r of rows) {
    const room = normalizeRoom(r.room_number);
    if (!room) continue;
    const category = (r.category || 'other').toLowerCase();
    const key = `${room}|${category}`;
    const cur = counts.get(key) || { room, category, n: 0 };
    cur.n += 1;
    counts.set(key, cur);
  }
  const out: OperationalSignal[] = [];
  for (const { room, category, n } of counts.values()) {
    if (n < THRESHOLDS.maintenancePerRoomCategory) continue;
    out.push({
      topic: makeTopic('op_maint', room, category),
      category: 'maintenance',
      severity: 'attention',
      targetLabel: `Room ${room}`,
      metric: `${n} ${category} work orders in ${SIGNAL_WINDOW_DAYS} days`,
      count: n,
      windowDays: SIGNAL_WINDOW_DAYS,
    });
  }
  return out;
}

export interface ComplaintRow {
  room_number: string | null;
  category: string | null;
  severity: string | null;
  created_at: string;
}
export function signalsFromComplaints(rows: ComplaintRow[]): OperationalSignal[] {
  const out: OperationalSignal[] = [];

  // (a) clustering by room + category (count ≥3, or ≥2 high-severity)
  const byRoomCat = new Map<string, { room: string; category: string; n: number; high: number }>();
  for (const r of rows) {
    const room = normalizeRoom(r.room_number);
    if (!room) continue;
    const category = (r.category || 'other').toLowerCase();
    const key = `${room}|${category}`;
    const cur = byRoomCat.get(key) || { room, category, n: 0, high: 0 };
    cur.n += 1;
    if ((r.severity || '').toLowerCase() === 'high') cur.high += 1;
    byRoomCat.set(key, cur);
  }
  for (const { room, category, n, high } of byRoomCat.values()) {
    if (n < THRESHOLDS.complaintsPerRoomCategory && high < THRESHOLDS.highSeverityComplaints) continue;
    out.push({
      topic: makeTopic('op_complaint', room, category),
      category: 'complaint',
      severity: 'attention',
      targetLabel: `Room ${room}`,
      metric:
        high >= THRESHOLDS.highSeverityComplaints
          ? `${n} ${category} complaints (${high} high-severity) in ${SIGNAL_WINDOW_DAYS} days`
          : `${n} ${category} complaints in ${SIGNAL_WINDOW_DAYS} days`,
      count: n,
      windowDays: SIGNAL_WINDOW_DAYS,
    });
  }

  // (b) weekend noise by floor — Fri/Sat/Sun (getUTCDay 5,6,0).
  // ACCEPTED LIMITATION: day-of-week is UTC, not property-local, so complaints
  // logged near local midnight can land in the adjacent day. Low impact (the
  // threshold is ≥4; only boundary complaints shift) and it never fabricates a
  // signal — revisit if we thread the property timezone through this layer.
  const byFloor = new Map<string, number>();
  for (const r of rows) {
    if ((r.category || '').toLowerCase() !== 'noise') continue;
    const dow = new Date(r.created_at).getUTCDay();
    if (dow !== 5 && dow !== 6 && dow !== 0) continue;
    const floor = floorOf(r.room_number);
    if (!floor) continue;
    byFloor.set(floor, (byFloor.get(floor) || 0) + 1);
  }
  for (const [floor, n] of byFloor) {
    if (n < THRESHOLDS.weekendNoisePerFloor) continue;
    out.push({
      topic: makeTopic('op_noise_floor', floor),
      category: 'noise',
      severity: 'attention',
      targetLabel: `Floor ${floor}`,
      metric: `${n} weekend noise complaints on floor ${floor} in ${SIGNAL_WINDOW_DAYS} days`,
      count: n,
      windowDays: SIGNAL_WINDOW_DAYS,
    });
  }
  return out;
}

export interface ComplianceRow { reading_type_id: string; out_of_range: boolean }
export function signalsFromCompliance(
  rows: ComplianceRow[],
  typeNames: Map<string, string>,
): OperationalSignal[] {
  const bad = new Map<string, number>();
  for (const r of rows) {
    if (!r.out_of_range) continue;
    bad.set(r.reading_type_id, (bad.get(r.reading_type_id) || 0) + 1);
  }
  const out: OperationalSignal[] = [];
  for (const [typeId, n] of bad) {
    if (n < THRESHOLDS.complianceOutOfRange) continue;
    const name = typeNames.get(typeId) || 'A reading';
    out.push({
      // Topic keyed on the STABLE reading_type_id, never the editable `name` —
      // renaming a reading type must not fork the memory into a duplicate row.
      topic: makeTopic('op_compliance', typeId),
      category: 'compliance',
      severity: 'attention',
      targetLabel: name,
      metric: `out of range ${n} times in ${SIGNAL_WINDOW_DAYS} days`,
      count: n,
      windowDays: SIGNAL_WINDOW_DAYS,
    });
  }
  return out;
}

export interface InspectionRow { room_number: string | null; result: string | null }
export function signalsFromInspections(rows: InspectionRow[]): OperationalSignal[] {
  const fails = new Map<string, number>();
  for (const r of rows) {
    if ((r.result || '').toLowerCase() !== 'fail') continue;
    const room = normalizeRoom(r.room_number);
    if (!room) continue;
    fails.set(room, (fails.get(room) || 0) + 1);
  }
  const out: OperationalSignal[] = [];
  for (const [room, n] of fails) {
    if (n < THRESHOLDS.inspectionFailsPerRoom) continue;
    out.push({
      topic: makeTopic('op_inspect_fail', room),
      category: 'inspection',
      severity: 'attention',
      targetLabel: `Room ${room}`,
      metric: `failed inspection ${n} times in ${SIGNAL_WINDOW_DAYS} days`,
      count: n,
      windowDays: SIGNAL_WINDOW_DAYS,
    });
  }
  return out;
}

export interface CleaningRow {
  room_number: string | null;
  duration_minutes: number | string | null;
  status: string | null;
}
export function signalsFromCleaning(rows: CleaningRow[]): OperationalSignal[] {
  const all: number[] = [];
  const byRoom = new Map<string, number[]>();
  for (const r of rows) {
    if ((r.status || '').toLowerCase() === 'discarded') continue; // <3min junk taps
    const room = normalizeRoom(r.room_number);
    const dur = typeof r.duration_minutes === 'string' ? parseFloat(r.duration_minutes) : r.duration_minutes;
    if (!room || dur == null || !Number.isFinite(dur) || dur <= 0) continue;
    all.push(dur);
    const arr = byRoom.get(room) || [];
    arr.push(dur);
    byRoom.set(room, arr);
  }
  const propMedian = median(all);
  if (propMedian <= 0) return [];
  const out: OperationalSignal[] = [];
  for (const [room, durs] of byRoom) {
    if (durs.length < THRESHOLDS.slowCleanMinSamples) continue;
    const roomMedian = median(durs);
    if (roomMedian <= propMedian * THRESHOLDS.slowCleanRatio) continue;
    out.push({
      topic: makeTopic('op_clean_slow', room),
      category: 'cleaning',
      severity: 'info',
      targetLabel: `Room ${room}`,
      metric: `~${Math.round(roomMedian)} min to clean vs ~${Math.round(propMedian)} min typical`,
      count: durs.length,
      windowDays: SIGNAL_WINDOW_DAYS,
    });
  }
  return out;
}

/** Rank + cap: attention before info, then higher count first; stable by topic. */
export function rankAndCapSignals(signals: OperationalSignal[]): OperationalSignal[] {
  const sevRank = (s: SignalSeverity) => (s === 'attention' ? 0 : 1);
  return [...signals]
    .sort((a, b) => {
      const sr = sevRank(a.severity) - sevRank(b.severity);
      if (sr !== 0) return sr;
      if (a.count !== b.count) return b.count - a.count;
      return a.topic < b.topic ? -1 : 1;
    })
    .slice(0, MAX_SIGNALS);
}

// ─── orchestrator (queries + aggregate) ──────────────────────────────────────

/**
 * Gather durable operational patterns for one hotel over the last 30 days.
 * Bounded, property-scoped, PII-safe. Returns [] when nothing is significant
 * (the common case → the engine then makes ZERO LLM calls for this hotel).
 */
export async function gatherOperationalSignals(propertyId: string): Promise<OperationalSignal[]> {
  const sinceIso = new Date(Date.now() - SIGNAL_WINDOW_DAYS * 86400_000).toISOString();
  const sinceDate = sinceIso.slice(0, 10);

  const [woRes, complaintRes, complianceRes, typeRes, inspRes, cleanRes] = await Promise.all([
    // Maintenance work orders (PMS-fed; empty until the robot's on → auto-activates).
    supabaseAdmin
      .from('pms_work_orders_v2')
      .select('room_number, category, created_at')
      .eq('property_id', propertyId)
      .gte('created_at', sinceIso)
      .limit(QUERY_ROW_CAP),
    supabaseAdmin
      .from('complaints')
      .select('room_number, category, severity, created_at')
      .eq('property_id', propertyId)
      .gte('created_at', sinceIso)
      .limit(QUERY_ROW_CAP),
    supabaseAdmin
      .from('compliance_readings')
      .select('reading_type_id, out_of_range, logged_at')
      .eq('property_id', propertyId)
      .gte('logged_at', sinceIso)
      .limit(QUERY_ROW_CAP),
    supabaseAdmin
      .from('compliance_reading_types')
      .select('id, name')
      .eq('property_id', propertyId)
      .limit(500),
    supabaseAdmin
      .from('inspections')
      .select('room_number, result, started_at')
      .eq('property_id', propertyId)
      .eq('result', 'fail')
      .gte('started_at', sinceIso)
      .limit(QUERY_ROW_CAP),
    supabaseAdmin
      .from('cleaning_events')
      .select('room_number, duration_minutes, status, date')
      .eq('property_id', propertyId)
      .gte('date', sinceDate)
      .limit(QUERY_ROW_CAP),
  ]);

  // Observability: a failed query is otherwise indistinguishable from "no data"
  // (empty → no signals), which would make operational learning silently vanish
  // for a source. Log per-source errors; still aggregate whatever did return.
  for (const [label, res] of [
    ['pms_work_orders_v2', woRes],
    ['complaints', complaintRes],
    ['compliance_readings', complianceRes],
    ['compliance_reading_types', typeRes],
    ['inspections', inspRes],
    ['cleaning_events', cleanRes],
  ] as const) {
    if (res.error) console.error(`[operational-signals] ${label} query failed for ${propertyId}: ${res.error.message}`);
  }

  const typeNames = new Map<string, string>();
  for (const t of (typeRes.data ?? []) as Array<{ id: string; name: string }>) {
    typeNames.set(t.id, t.name);
  }

  const signals: OperationalSignal[] = [
    ...signalsFromWorkOrders((woRes.data ?? []) as WorkOrderRow[]),
    ...signalsFromComplaints((complaintRes.data ?? []) as ComplaintRow[]),
    ...signalsFromCompliance((complianceRes.data ?? []) as ComplianceRow[], typeNames),
    ...signalsFromInspections((inspRes.data ?? []) as InspectionRow[]),
    ...signalsFromCleaning((cleanRes.data ?? []) as CleaningRow[]),
  ];

  return rankAndCapSignals(signals);
}
