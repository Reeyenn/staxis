// ═══════════════════════════════════════════════════════════════════════════
// Properties — the top-level entity. One row per hotel.
// ═══════════════════════════════════════════════════════════════════════════

import type { Property } from '@/types';
import { supabase, logErr } from './_common';
import { toPropertyRow, fromPropertyRow } from '../db-mappers';

export async function getProperties(_uid: string): Promise<Property[]> {
  const { data, error } = await supabase.from('properties').select('*');
  if (error) { logErr('getProperties', error); throw error; }
  return (data ?? []).map(fromPropertyRow);
}

export async function getProperty(_uid: string, pid: string): Promise<Property | null> {
  const { data, error } = await supabase.from('properties').select('*').eq('id', pid).maybeSingle();
  if (error) { logErr('getProperty', error); throw error; }
  return data ? fromPropertyRow(data) : null;
}

export async function createProperty(_uid: string, data: Omit<Property, 'id' | 'createdAt'>): Promise<string> {
  const row = toPropertyRow(data);
  const { data: { user } } = await supabase.auth.getUser();
  if (user?.id) row.owner_id = user.id;
  const { data: inserted, error } = await supabase
    .from('properties').insert(row).select('id').single();
  if (error) { logErr('createProperty', error); throw error; }
  return String(inserted.id);
}

export async function updateProperty(_uid: string, pid: string, data: Partial<Property>): Promise<void> {
  const { error } = await supabase.from('properties').update(toPropertyRow(data)).eq('id', pid);
  if (error) { logErr('updateProperty', error); throw error; }
}
