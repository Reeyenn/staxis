// ═══════════════════════════════════════════════════════════════════════════
// Public Areas — lobby, hallways, breakfast room, etc. Configurable per
// property. Cleaning of these is tracked separately from rooms.
// ═══════════════════════════════════════════════════════════════════════════

import type { PublicArea } from '@/types';
import { supabase, logErr } from './_common';
import { toPublicAreaRow, fromPublicAreaRow } from '../db-mappers';

export async function getPublicAreas(_uid: string, pid: string): Promise<PublicArea[]> {
  const { data, error } = await supabase.from('public_areas').select('*').eq('property_id', pid);
  if (error) { logErr('getPublicAreas', error); throw error; }
  return (data ?? []).map(fromPublicAreaRow);
}

export async function bulkSetPublicAreas(_uid: string, pid: string, areas: PublicArea[]): Promise<void> {
  const rows = areas.map(a => ({ ...toPublicAreaRow(a), id: a.id, property_id: pid }));
  const { error } = await supabase.from('public_areas').upsert(rows);
  if (error) { logErr('bulkSetPublicAreas', error); throw error; }
}
