// ═══════════════════════════════════════════════════════════════════════════
// Laundry Config — per-property laundry categories (sheets, towels, etc.).
// ═══════════════════════════════════════════════════════════════════════════

import type { LaundryCategory } from '@/types';
import { supabase, logErr } from './_common';
import { toLaundryRow, fromLaundryRow } from '../db-mappers';

export async function getLaundryConfig(_uid: string, pid: string): Promise<LaundryCategory[]> {
  const { data, error } = await supabase.from('laundry_config').select('*').eq('property_id', pid);
  if (error) { logErr('getLaundryConfig', error); throw error; }
  return (data ?? []).map(fromLaundryRow);
}

export async function setLaundryCategory(_uid: string, pid: string, cat: LaundryCategory): Promise<void> {
  const row = { ...toLaundryRow(cat), id: cat.id, property_id: pid };
  const { error } = await supabase.from('laundry_config').upsert(row);
  if (error) { logErr('setLaundryCategory', error); throw error; }
}
