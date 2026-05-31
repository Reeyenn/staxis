// Engineering Compliance v2 — anomaly ENGINE (server-side; service role).
//
// Orchestrates detection (pure math in anomaly.ts) → records an alert (deduped)
// → notifies the engineer + GM by SMS → auto-opens a work order for a
// high-confidence leak. Two entry points:
//   • checkReadingForAnomaly()  — hooked into the reading write-path (store.ts
//     seam): real-time spike/drift/flatline on each new reading.
//   • sweepPropertyForAnomalies() — the cron safety net: re-evaluates each
//     active type's recent history for slow trends / a meter that stopped
//     moving, and (optionally) AI-sharpens the wording.
//
// One-directional imports: store.ts imports THIS module (hook + getActiveAnomalies);
// this module does NOT import store (it fetches reading types inline) — no cycle.

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import { todayStr, APP_TIMEZONE } from '@/lib/utils';
import {
  analyzeReading,
  type AnomalyTypeInfo,
  type AnomalyResult,
  type HistoryPoint,
} from './anomaly';
import { createComplianceWorkOrder, smsMaintenance, smsGm } from './autoact';
import type { ReadingType, ReadingCategory, AnomalyAlert } from './types';

interface EngineType extends AnomalyTypeInfo {
  id: string;
}

function toEngineType(t: ReadingType): EngineType {
  return { id: t.id, category: t.category, name: t.name, unit: t.unit, minValue: t.minValue, maxValue: t.maxValue };
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mapAlert(r: Record<string, unknown>): AnomalyAlert {
  return {
    id: String(r.id),
    propertyId: String(r.property_id ?? ''),
    readingTypeId: String(r.reading_type_id ?? ''),
    readingId: typeof r.reading_id === 'string' ? r.reading_id : null,
    kind: (r.kind as AnomalyAlert['kind']) ?? 'spike',
    severity: (r.severity as AnomalyAlert['severity']) ?? 'warn',
    baselineMean: numOrNull(r.baseline_mean),
    baselineStddev: numOrNull(r.baseline_stddev),
    observedValue: numOrNull(r.observed_value),
    score: numOrNull(r.score),
    confidence: numOrNull(r.confidence),
    reason: String(r.reason ?? ''),
    reasonEs: typeof r.reason_es === 'string' ? r.reason_es : null,
    aiPhrased: r.ai_phrased === true,
    detectedBy: (r.detected_by as AnomalyAlert['detectedBy']) ?? 'reading',
    status: (r.status as AnomalyAlert['status']) ?? 'active',
    workOrderId: typeof r.work_order_id === 'string' ? r.work_order_id : null,
    createdAt: String(r.created_at ?? ''),
  };
}

/** Fetch up to `limit` most-recent numeric readings for a type, excluding one id. */
async function fetchHistory(pid: string, typeId: string, excludeId: string | null, limit = 50): Promise<HistoryPoint[]> {
  const { data } = await supabaseAdmin
    .from('compliance_readings')
    .select('id, value, logged_at')
    .eq('property_id', pid)
    .eq('reading_type_id', typeId)
    .not('value', 'is', null)
    .order('logged_at', { ascending: false })
    .limit(limit + 1);
  return (data ?? [])
    .filter((r) => r.id !== excludeId)
    .slice(0, limit)
    .map((r) => ({ value: Number(r.value), at: Date.parse(String(r.logged_at)) }))
    .filter((h) => Number.isFinite(h.value) && Number.isFinite(h.at));
}

async function fetchActiveTypes(pid: string): Promise<EngineType[]> {
  const { data } = await supabaseAdmin
    .from('compliance_reading_types')
    .select('id, category, name, unit, min_value, max_value')
    .eq('property_id', pid)
    .eq('active', true);
  return (data ?? []).map((r) => ({
    id: String(r.id),
    category: (r.category as ReadingCategory) ?? 'other',
    name: String(r.name ?? ''),
    unit: String(r.unit ?? ''),
    minValue: numOrNull(r.min_value),
    maxValue: numOrNull(r.max_value),
  }));
}

/**
 * Record an alert (deduped per type+kind+day) and notify. Returns the new alert,
 * or null when an active alert already exists for this condition today (so we
 * never duplicate or re-text). All side effects are best-effort + logged — they
 * must never throw back into the reading write-path.
 */
async function recordAndNotify(
  pid: string,
  type: EngineType,
  readingId: string | null,
  result: AnomalyResult,
  detectedBy: 'reading' | 'sweep',
): Promise<AnomalyAlert | null> {
  const dedupeKey = `${type.id}:${result.kind}:${todayStr(APP_TIMEZONE)}`;

  // Suppress re-alerting (re-text, re-open work order) when an alert for this
  // exact condition already exists TODAY in a non-resolved state — including one
  // a manager ACKNOWLEDGED (dismissed). The partial-unique index only covers
  // status='active', so without this pre-check an ack would let the next
  // sweep/reading re-fire the same alert loop (Codex adversarial finding).
  const { data: existing } = await supabaseAdmin
    .from('compliance_anomaly_alerts')
    .select('id')
    .eq('property_id', pid)
    .eq('reading_type_id', type.id)
    .eq('dedupe_key', dedupeKey)
    .in('status', ['active', 'acknowledged'])
    .limit(1)
    .maybeSingle();
  if (existing) return null;

  const { data, error } = await supabaseAdmin
    .from('compliance_anomaly_alerts')
    .insert({
      property_id: pid,
      reading_type_id: type.id,
      reading_id: readingId,
      kind: result.kind,
      severity: result.severity,
      baseline_mean: result.baselineMean,
      baseline_stddev: result.baselineStddev,
      observed_value: result.observed,
      score: result.score,
      confidence: result.confidence,
      reason: result.reasonEn,
      reason_es: result.reasonEs,
      ai_phrased: false,
      detected_by: detectedBy,
      status: 'active',
      dedupe_key: dedupeKey,
    })
    .select('*')
    .single();

  if (error) {
    // 23505 = an active alert for this (type, kind, day) already exists → no
    // duplicate, no re-text. Any other error: log + give up (don't block).
    if ((error as { code?: string }).code !== '23505') {
      log.error('[compliance/anomaly] alert insert failed', { pid, typeId: type.id, msg: error.message });
    }
    return null;
  }
  const alert = mapAlert(data);

  // ── Notify (best-effort) ─────────────────────────────────────────────────
  const idem = `anomaly:${dedupeKey}`;
  try {
    if (result.severity === 'warn' || result.severity === 'critical') {
      await smsMaintenance(pid, `⚠️ ${result.reasonEn}`, idem);
    }
    if (result.highConfidenceLeak) {
      const woId = await createComplianceWorkOrder(pid, {
        location: type.name,
        description: `Anomaly (${result.kind}): ${result.reasonEn} Auto-flagged by Staxis Compliance; investigate.`,
        priority: 'urgent',
      });
      if (woId) {
        await supabaseAdmin.from('compliance_anomaly_alerts').update({ work_order_id: woId }).eq('id', alert.id);
        alert.workOrderId = woId;
      }
    }
    if (result.severity === 'critical') {
      await smsGm(pid, `⚠️ Compliance anomaly: ${result.reasonEn} Maintenance has been notified.`, idem);
    }
  } catch (e) {
    log.error('[compliance/anomaly] notify failed', { pid, alertId: alert.id, err: e instanceof Error ? e : new Error(String(e)) });
  }
  return alert;
}

/** Real-time hook — called from store.ts logReading after a reading is inserted. */
export async function checkReadingForAnomaly(
  pid: string,
  type: ReadingType,
  reading: { id: string; value: number | null; loggedAt: string },
): Promise<AnomalyAlert | null> {
  try {
    if (reading.value === null || !Number.isFinite(reading.value)) return null;
    const et = toEngineType(type);
    const history = await fetchHistory(pid, type.id, reading.id, 50);
    const at = Date.parse(reading.loggedAt);
    const outcome = analyzeReading(et, history, { value: reading.value, at: Number.isFinite(at) ? at : Date.now() });
    if (outcome.state !== 'anomaly') return null;
    return await recordAndNotify(pid, et, reading.id, outcome.result, 'reading');
  } catch (e) {
    log.error('[compliance/anomaly] checkReadingForAnomaly threw', { pid, typeId: type.id, err: e instanceof Error ? e : new Error(String(e)) });
    return null;
  }
}

/** Cron safety net: re-evaluate each active type's recent history for slow
 *  trends / stuck meters. Dedup makes re-detecting the same condition a no-op. */
export async function sweepPropertyForAnomalies(pid: string): Promise<{ recorded: number; checked: number }> {
  const types = await fetchActiveTypes(pid);
  let recorded = 0;
  for (const type of types) {
    try {
      const history = await fetchHistory(pid, type.id, null, 50);
      if (history.length === 0) continue;
      const sorted = [...history].sort((a, b) => b.at - a.at);
      const current = sorted[0];
      const rest = sorted.slice(1);
      const outcome = analyzeReading(type, rest, current);
      if (outcome.state === 'anomaly') {
        const alert = await recordAndNotify(pid, type, null, outcome.result, 'sweep');
        if (alert) recorded += 1;
      }
    } catch (e) {
      log.error('[compliance/anomaly] sweep type failed', { pid, typeId: type.id, err: e instanceof Error ? e : new Error(String(e)) });
    }
  }
  return { recorded, checked: types.length };
}

/** All active anomaly alerts for a property (for getOverview to attach to types). */
export async function getActiveAnomalies(pid: string): Promise<AnomalyAlert[]> {
  const { data, error } = await supabaseAdmin
    .from('compliance_anomaly_alerts')
    .select('*')
    .eq('property_id', pid)
    .eq('status', 'active')
    .order('created_at', { ascending: false });
  if (error) {
    log.error('[compliance/anomaly] getActiveAnomalies failed', { pid, msg: error.message });
    return [];
  }
  return (data ?? []).map(mapAlert);
}

/** Acknowledge / dismiss an alert (manager action). Property-scoped. */
export async function acknowledgeAnomaly(pid: string, alertId: string, by: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('compliance_anomaly_alerts')
    .update({ status: 'acknowledged', acknowledged_at: new Date().toISOString(), acknowledged_by: by })
    .eq('id', alertId)
    .eq('property_id', pid)
    .eq('status', 'active')
    .select('id')
    .maybeSingle();
  if (error) {
    log.error('[compliance/anomaly] acknowledge failed', { pid, alertId, msg: error.message });
    return false;
  }
  return !!data;
}

// ─── AI phrasing (the "edge" — used by the cron, rate-limited on raw pid) ─────

/** Active alerts that haven't been AI-sharpened yet (newest first, capped). */
export async function getUnphrasedActiveAlerts(pid: string, limit = 5): Promise<AnomalyAlert[]> {
  const { data } = await supabaseAdmin
    .from('compliance_anomaly_alerts')
    .select('*')
    .eq('property_id', pid)
    .eq('status', 'active')
    .eq('ai_phrased', false)
    .order('created_at', { ascending: false })
    .limit(limit);
  return (data ?? []).map(mapAlert);
}

export async function applyAiPhrasing(pid: string, alertId: string, en: string, es: string | null): Promise<void> {
  await supabaseAdmin
    .from('compliance_anomaly_alerts')
    .update({ reason: en.slice(0, 500), reason_es: es ? es.slice(0, 500) : null, ai_phrased: true })
    .eq('id', alertId)
    .eq('property_id', pid);
}
