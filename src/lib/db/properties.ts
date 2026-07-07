// ═══════════════════════════════════════════════════════════════════════════
// Properties — the top-level entity. One row per hotel.
// ═══════════════════════════════════════════════════════════════════════════

import type { Property } from '@/types';
import { supabase, logErr, asRecordRows, asRecordRow } from './_common';
import { toPropertyRow, fromPropertyRow } from '../db-mappers';

// Explicit column list, in lock-step with fromPropertyRow() in db-mappers.ts.
// Replaces `.select('*')` per cost-hotpaths audit recommendation #5/#13 —
// the previous wide select returned every property column (including ML
// internals like dashboard_stale_minutes and scraper_window_* that the
// front-end never consumes) on every property fetch. Update both this
// constant and fromPropertyRow when adding a column the UI needs.
export const PROPERTY_COLS =
  'id, name, total_rooms, avg_occupancy, hourly_wage, checkout_minutes, ' +
  'stayover_minutes, stayover_day1_minutes, stayover_day2_minutes, ' +
  'prep_minutes_per_activity, shift_minutes, total_staff_on_roster, ' +
  'weekly_budget, morning_briefing_time, evening_forecast_time, ' +
  'pms_type, pms_url, pms_connected, last_synced_at, alert_phone, ' +
  'room_inventory, onboarding_completed_at, onboarding_state, enabled_sections, is_test, created_at';

export async function getProperties(_uid: string): Promise<Property[]> {
  const { data, error } = await supabase.from('properties').select(PROPERTY_COLS);
  if (error) { logErr('getProperties', error); throw error; }
  return asRecordRows(data).map(fromPropertyRow);
}

export async function getProperty(_uid: string, pid: string): Promise<Property | null> {
  const { data, error } = await supabase.from('properties').select(PROPERTY_COLS).eq('id', pid).maybeSingle();
  if (error) { logErr('getProperty', error); throw error; }
  const row = asRecordRow(data);
  return row ? fromPropertyRow(row) : null;
}

export async function updateProperty(_uid: string, pid: string, data: Partial<Property>): Promise<void> {
  const { error } = await supabase.from('properties').update(toPropertyRow(data)).eq('id', pid);
  if (error) { logErr('updateProperty', error); throw error; }
}
