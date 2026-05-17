// ═══════════════════════════════════════════════════════════════════════════
// Public Areas — lobby, hallways, breakfast room, etc. Configurable per
// property. Cleaning of these is tracked separately from rooms.
// ═══════════════════════════════════════════════════════════════════════════

import type { PublicArea } from '@/types';
import { supabase, logErr } from './_common';
import { toPublicAreaRow, fromPublicAreaRow } from '../db-mappers';

// Matches fromPublicAreaRow in db-mappers.ts. Audit follow-up 2026-05-17.
const PUBLIC_AREA_FIELDS =
  'id, name, floor, locations, frequency_days, minutes_per_clean, start_date, ' +
  'only_when_rented, is_rented_today';
type PublicAreaRow = Record<string, unknown>;

export async function getPublicAreas(_uid: string, pid: string): Promise<PublicArea[]> {
  const { data, error } = await supabase.from('public_areas').select(PUBLIC_AREA_FIELDS).eq('property_id', pid).returns<PublicAreaRow[]>();
  if (error) { logErr('getPublicAreas', error); throw error; }
  return (data ?? []).map(fromPublicAreaRow);
}

export async function setPublicArea(_uid: string, pid: string, area: PublicArea): Promise<void> {
  const row = { ...toPublicAreaRow(area), id: area.id, property_id: pid };
  const { error } = await supabase.from('public_areas').upsert(row);
  if (error) { logErr('setPublicArea', error); throw error; }
}

export async function deletePublicArea(_uid: string, _pid: string, aid: string): Promise<void> {
  const { error } = await supabase.from('public_areas').delete().eq('id', aid);
  if (error) { logErr('deletePublicArea', error); throw error; }
}

export async function bulkSetPublicAreas(_uid: string, pid: string, areas: PublicArea[]): Promise<void> {
  const rows = areas.map(a => ({ ...toPublicAreaRow(a), id: a.id, property_id: pid }));
  const { error } = await supabase.from('public_areas').upsert(rows);
  if (error) { logErr('bulkSetPublicAreas', error); throw error; }
}
