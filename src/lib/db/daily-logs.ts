// ═══════════════════════════════════════════════════════════════════════════
// Daily Logs — one row per (property, date). Captures end-of-day totals.
// ═══════════════════════════════════════════════════════════════════════════

import type { DailyLog } from '@/types';
import { supabase, logErr } from './_common';
import { toDailyLogRow, fromDailyLogRow } from '../db-mappers';

// Matches fromDailyLogRow in db-mappers.ts. Audit follow-up 2026-05-17.
const DAILY_LOG_FIELDS =
  'date, property_id, occupied, checkouts, two_bed_checkouts, stayovers, vips, ' +
  'early_checkins, room_minutes, public_area_minutes, laundry_minutes, ' +
  'total_minutes, recommended_staff, actual_staff, hourly_wage, labor_cost, ' +
  'labor_saved, start_time, completion_time, public_areas_due_today, ' +
  'laundry_loads, rooms_completed, avg_turnaround_minutes';
type DailyLogRow = Record<string, unknown>;

export async function getDailyLog(_uid: string, pid: string, date: string): Promise<DailyLog | null> {
  const { data, error } = await supabase
    .from('daily_logs').select(DAILY_LOG_FIELDS)
    .eq('property_id', pid).eq('date', date).maybeSingle<DailyLogRow>();
  if (error) { logErr('getDailyLog', error); throw error; }
  return data ? fromDailyLogRow(data) : null;
}

export async function saveDailyLog(_uid: string, pid: string, log: DailyLog): Promise<void> {
  try {
    const row = { ...toDailyLogRow({ ...log, propertyId: pid }), property_id: pid, date: log.date };
    const { error } = await supabase
      .from('daily_logs').upsert(row, { onConflict: 'property_id,date' });
    if (error) throw error;
  } catch (err) { logErr('saveDailyLog', err); throw err; }
}

export async function getRecentDailyLogs(_uid: string, pid: string, days = 30): Promise<DailyLog[]> {
  const { data, error } = await supabase
    .from('daily_logs').select(DAILY_LOG_FIELDS)
    .eq('property_id', pid)
    .order('date', { ascending: false })
    .limit(days)
    .returns<DailyLogRow[]>();
  if (error) { logErr('getRecentDailyLogs', error); throw error; }
  return (data ?? []).map(fromDailyLogRow);
}
