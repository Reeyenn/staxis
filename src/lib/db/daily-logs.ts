// ═══════════════════════════════════════════════════════════════════════════
// Daily Logs — one row per (property, date). Captures end-of-day totals.
// ═══════════════════════════════════════════════════════════════════════════

import type { DailyLog } from '@/types';
import { supabase, logErr } from './_common';
import { fromDailyLogRow } from '../db-mappers';

export async function getRecentDailyLogs(_uid: string, pid: string, days = 30): Promise<DailyLog[]> {
  const { data, error } = await supabase
    .from('daily_logs').select('*')
    .eq('property_id', pid)
    .order('date', { ascending: false })
    .limit(days);
  if (error) { logErr('getRecentDailyLogs', error); throw error; }
  return (data ?? []).map(fromDailyLogRow);
}
