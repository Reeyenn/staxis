/**
 * Report favorites data access (service-role / supabaseAdmin).
 *
 * report_favorites is deny-all-browser (migration 0236); every read/write
 * here runs with supabaseAdmin and is called only from /api/settings/reports/*
 * after a manager capability + property-access check.
 *
 * 2026-07-19: the schedule store (report_schedules) was removed with the
 * automatic report emails — the table remains in the DB, unused.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';

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
