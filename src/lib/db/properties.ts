// ═══════════════════════════════════════════════════════════════════════════
// Properties — the top-level entity. One row per hotel.
// ═══════════════════════════════════════════════════════════════════════════

import type { Property } from '@/types';
import { supabase, logErr } from './_common';
import { toPropertyRow, fromPropertyRow } from '../db-mappers';

// Matches fromPropertyRow in db-mappers.ts. Audit follow-up 2026-05-17.
const PROPERTY_FIELDS =
  'id, name, total_rooms, avg_occupancy, hourly_wage, checkout_minutes, ' +
  'stayover_minutes, stayover_day1_minutes, stayover_day2_minutes, ' +
  'prep_minutes_per_activity, shift_minutes, total_staff_on_roster, ' +
  'weekly_budget, morning_briefing_time, evening_forecast_time, pms_type, ' +
  'pms_url, pms_connected, last_synced_at, alert_phone, room_inventory, created_at';
type PropertyRow = Record<string, unknown>;

export async function getProperties(_uid: string): Promise<Property[]> {
  const { data, error } = await supabase.from('properties').select(PROPERTY_FIELDS).returns<PropertyRow[]>();
  if (error) { logErr('getProperties', error); throw error; }
  return (data ?? []).map(fromPropertyRow);
}

export async function getProperty(_uid: string, pid: string): Promise<Property | null> {
  const { data, error } = await supabase.from('properties').select(PROPERTY_FIELDS).eq('id', pid).maybeSingle<PropertyRow>();
  if (error) { logErr('getProperty', error); throw error; }
  return data ? fromPropertyRow(data) : null;
}

export async function updateProperty(_uid: string, pid: string, data: Partial<Property>): Promise<void> {
  const { error } = await supabase.from('properties').update(toPropertyRow(data)).eq('id', pid);
  if (error) { logErr('updateProperty', error); throw error; }
}
