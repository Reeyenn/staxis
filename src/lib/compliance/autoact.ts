// AI feature #3 — AUTO-ACT ON OUT-OF-RANGE.
//
// A reading outside its safe threshold, or a failed required PM check,
// automatically (a) creates a maintenance work order on the SAME table the
// manager's Maintenance > Work Orders tab + owner Dashboard read (`work_orders`),
// and (b) texts the on-shift maintenance staff via the existing Twilio queue.
//
// Server-only (service role). Called from the logging path in store.ts. All
// failures are swallowed + logged: a flaky SMS or work-order insert must never
// block the underlying reading/check from being recorded (audit integrity).

import { supabaseAdmin } from '@/lib/supabase-admin';
import { sanitizeForSms } from '@/lib/api-validate';
import { todayStr, APP_TIMEZONE } from '@/lib/utils';
import { log } from '@/lib/log';
import type { WorkOrderPriority } from '@/types';

/** US-centric E.164 normalizer (mirrors send-shift-confirmations). */
export function toE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (raw.startsWith('+')) return raw.trim();
  return null;
}

/**
 * Create a work order on the manager-facing `work_orders` table (the table the
 * Maintenance > Work Orders tab + owner Dashboard read). Inserts only the
 * columns that table actually has — `toWorkOrderRow` is stale (it still maps
 * dropped columns like submitter_role/completion_*; existing callers only dodge
 * that because dropUndefined removes the unset fields). status 'submitted'
 * reads back as "open" via STATUS_FROM_DB. Returns the new id, or null (logged).
 */
export async function createComplianceWorkOrder(
  pid: string,
  opts: { location: string; description: string; priority: WorkOrderPriority },
): Promise<string | null> {
  try {
    const severity = opts.priority === 'urgent' ? 'urgent' : opts.priority === 'low' ? 'low' : 'medium';
    const { data, error } = await supabaseAdmin
      .from('work_orders')
      .insert({
        property_id: pid,
        room_number: opts.location.slice(0, 120),
        description: opts.description.slice(0, 1000),
        severity,
        status: 'submitted',
        submitted_by_name: 'Staxis Compliance',
        source: 'compliance',
      })
      .select('id')
      .single();
    if (error) {
      log.error('[compliance/autoact] work order insert failed', { pid, msg: error.message });
      return null;
    }
    return String(data.id);
  } catch (e) {
    log.error('[compliance/autoact] work order threw', { pid, err: e instanceof Error ? e : new Error(String(e)) });
    return null;
  }
}

/**
 * Out-of-range reading → urgent work order + SMS. Returns the work order id
 * (so the caller can link it on the reading row), or null.
 */
export async function autoActOnOutOfRangeReading(opts: {
  pid: string;
  typeName: string;
  unit: string;
  value: number;
  minValue: number | null;
  maxValue: number | null;
}): Promise<string | null> {
  const { pid, typeName, unit, value, minValue, maxValue } = opts;
  const bound =
    minValue !== null && value < minValue ? `below safe minimum ${minValue}${unit}`
    : maxValue !== null && value > maxValue ? `above safe maximum ${maxValue}${unit}`
    : 'out of safe range';
  const desc = `${typeName} read ${value}${unit} — ${bound}. Auto-flagged by Staxis Compliance; verify and correct.`;
  const workOrderId = await createComplianceWorkOrder(pid, {
    location: typeName,
    description: desc,
    priority: 'urgent',
  });
  // (SMS notify removed 2026-07 — the urgent work order is the signal.)
  return workOrderId;
}

/**
 * Failed required PM check → urgent work order + SMS. Returns the work order id.
 */
export async function autoActOnFailedPmCheck(opts: {
  pid: string;
  taskName: string;
  note: string | null;
}): Promise<string | null> {
  const { pid, taskName, note } = opts;
  const desc = `Life-safety check FAILED: ${taskName}.${note ? ` Note: ${note}` : ''} Auto-flagged by Staxis Compliance; remediate immediately.`;
  const workOrderId = await createComplianceWorkOrder(pid, {
    location: taskName,
    description: desc,
    priority: 'urgent',
  });
  // (SMS notify removed 2026-07 — the urgent work order is the signal.)
  return workOrderId;
}
