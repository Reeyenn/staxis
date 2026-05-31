/**
 * Favorites + schedules data access (service-role / supabaseAdmin).
 *
 * report_favorites and report_schedules are deny-all-browser (migration 0236);
 * every read/write here runs with supabaseAdmin and is called only from
 * /api/settings/reports/* after a manager capability + property-access check,
 * or from the run-scheduled-reports cron.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';

export type Cadence = 'daily' | 'weekly' | 'monthly';
export type ScheduleRangeKind = 'last7' | 'last30' | 'mtd' | 'prev_month';

export interface ReportSchedule {
  id: string;
  propertyId: string;
  reportKey: string;
  cadence: Cadence;
  hourLocal: number;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  rangeKind: ScheduleRangeKind;
  recipients: string[];
  enabled: boolean;
  lastRunDate: string | null;
  lastRunStatus: string | null;
}

function toSchedule(r: Record<string, unknown>): ReportSchedule {
  return {
    id: String(r.id),
    propertyId: String(r.property_id),
    reportKey: String(r.report_key),
    cadence: r.cadence as Cadence,
    hourLocal: Number(r.hour_local ?? 8),
    dayOfWeek: r.day_of_week == null ? null : Number(r.day_of_week),
    dayOfMonth: r.day_of_month == null ? null : Number(r.day_of_month),
    rangeKind: (r.range_kind as ScheduleRangeKind) ?? 'last7',
    recipients: Array.isArray(r.recipients) ? (r.recipients as string[]) : [],
    enabled: Boolean(r.enabled),
    lastRunDate: r.last_run_date ? String(r.last_run_date) : null,
    lastRunStatus: r.last_run_status ? String(r.last_run_status) : null,
  };
}

// ─── Favorites ───────────────────────────────────────────────────────────────

export async function listFavorites(accountId: string, propertyId: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from('report_favorites')
    .select('report_key')
    .eq('account_id', accountId)
    .eq('property_id', propertyId);
  if (error) throw error;
  return (data ?? []).map((r: { report_key: string }) => r.report_key);
}

/** Toggle a favorite. Returns the new state. */
export async function toggleFavorite(
  accountId: string,
  propertyId: string,
  reportKey: string,
): Promise<{ favorited: boolean }> {
  // Try to delete first; if nothing was deleted, insert.
  const { data: existing, error: selErr } = await supabaseAdmin
    .from('report_favorites')
    .select('id')
    .eq('account_id', accountId)
    .eq('property_id', propertyId)
    .eq('report_key', reportKey)
    .maybeSingle();
  if (selErr) throw selErr;

  if (existing) {
    const { error } = await supabaseAdmin.from('report_favorites').delete().eq('id', existing.id);
    if (error) throw error;
    return { favorited: false };
  }
  const { error } = await supabaseAdmin
    .from('report_favorites')
    .insert({ account_id: accountId, property_id: propertyId, report_key: reportKey });
  if (error) throw error;
  return { favorited: true };
}

// ─── Schedules ───────────────────────────────────────────────────────────────

export async function listSchedules(propertyId: string): Promise<ReportSchedule[]> {
  const { data, error } = await supabaseAdmin
    .from('report_schedules')
    .select('*')
    .eq('property_id', propertyId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []).map(toSchedule);
}

export async function getSchedule(id: string): Promise<ReportSchedule | null> {
  const { data, error } = await supabaseAdmin
    .from('report_schedules')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data ? toSchedule(data) : null;
}

export interface UpsertScheduleInput {
  id?: string;
  propertyId: string;
  reportKey: string;
  cadence: Cadence;
  hourLocal: number;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  rangeKind: ScheduleRangeKind;
  recipients: string[];
  enabled: boolean;
  createdByAccountId: string;
}

export async function upsertSchedule(input: UpsertScheduleInput): Promise<ReportSchedule> {
  const row = {
    property_id: input.propertyId,
    report_key: input.reportKey,
    cadence: input.cadence,
    hour_local: input.hourLocal,
    day_of_week: input.dayOfWeek,
    day_of_month: input.dayOfMonth,
    range_kind: input.rangeKind,
    recipients: input.recipients,
    enabled: input.enabled,
  };

  if (input.id) {
    // Scope the update by BOTH id and property_id so a caller can never edit a
    // schedule belonging to another property by guessing an id.
    const { data, error } = await supabaseAdmin
      .from('report_schedules')
      .update(row)
      .eq('id', input.id)
      .eq('property_id', input.propertyId)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('schedule_not_found');
    return toSchedule(data);
  }

  const { data, error } = await supabaseAdmin
    .from('report_schedules')
    .insert({ ...row, created_by_account_id: input.createdByAccountId })
    .select('*')
    .single();
  if (error) throw error;
  return toSchedule(data);
}

export async function deleteSchedule(id: string, propertyId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('report_schedules')
    .delete()
    .eq('id', id)
    .eq('property_id', propertyId)
    .select('id');
  if (error) throw error;
  return (data ?? []).length > 0;
}

/** All enabled schedules across every property — for the cron sweep. */
export async function listEnabledSchedules(): Promise<ReportSchedule[]> {
  const { data, error } = await supabaseAdmin
    .from('report_schedules')
    .select('*')
    .eq('enabled', true);
  if (error) throw error;
  return (data ?? []).map(toSchedule);
}

export async function markScheduleRun(id: string, localDate: string, status: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('report_schedules')
    .update({ last_run_date: localDate, last_run_status: status })
    .eq('id', id);
  if (error) throw error;
}
