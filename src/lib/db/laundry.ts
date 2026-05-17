// ═══════════════════════════════════════════════════════════════════════════
// Laundry Config — per-property laundry categories (sheets, towels, etc.).
// ═══════════════════════════════════════════════════════════════════════════

import type { LaundryCategory } from '@/types';
import { supabase, logErr } from './_common';
import { toLaundryRow, fromLaundryRow } from '../db-mappers';

// Matches fromLaundryRow in db-mappers.ts. Audit follow-up 2026-05-17.
const LAUNDRY_FIELDS =
  'id, name, units_per_checkout, two_bed_multiplier, stayover_factor, ' +
  'room_equivs_per_load, minutes_per_load';
type LaundryRow = Record<string, unknown>;

export async function getLaundryConfig(_uid: string, pid: string): Promise<LaundryCategory[]> {
  const { data, error } = await supabase.from('laundry_config').select(LAUNDRY_FIELDS).eq('property_id', pid).returns<LaundryRow[]>();
  if (error) { logErr('getLaundryConfig', error); throw error; }
  return (data ?? []).map(fromLaundryRow);
}

export async function setLaundryCategory(_uid: string, pid: string, cat: LaundryCategory): Promise<void> {
  const row = { ...toLaundryRow(cat), id: cat.id, property_id: pid };
  const { error } = await supabase.from('laundry_config').upsert(row);
  if (error) { logErr('setLaundryCategory', error); throw error; }
}
