/**
 * Clean Times (Layer 1 — standard table): SERVER fetch/upsert.
 *
 * Service-role access to `hk_clean_time_standards` (migration 0244). Imported
 * ONLY by server code — the housekeeping rules-engine + auto-assign cron and
 * the /api/settings/clean-times route. The `server-only` import makes a build
 * fail loudly if this is ever pulled into a client bundle (belt-and-suspenders
 * on top of supabase-admin's module-load throw).
 *
 * Every read degrades gracefully: if the table doesn't exist yet (the
 * migration is applied to prod MANUALLY, so the code can deploy first) or the
 * query errors, the fetch returns an empty set and callers fall back to their
 * static defaults — i.e. exactly the pre-feature behaviour. Nothing breaks
 * before 0244 is applied.
 */

import 'server-only';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import {
  indexStandards,
  isEditableCleaningType,
  isValidBaseMinutes,
  standardsToBaseDurations,
  type CleanTimeStandardRow,
  type CleanTimeStandardsIndex,
} from '@/lib/clean-time-standards';

/** Read a property's clean-time standards. Returns [] on any error or when
 *  the table isn't present yet (graceful pre-migration degradation). */
export async function fetchCleanTimeStandards(
  propertyId: string,
): Promise<CleanTimeStandardRow[]> {
  const { data, error } = await supabaseAdmin
    .from('hk_clean_time_standards')
    .select('cleaning_type, room_type, base_minutes')
    .eq('property_id', propertyId);
  if (error) {
    log.warn('[clean-time-standards] fetch failed; using static defaults', {
      propertyId,
      msg: error.message,
    });
    return [];
  }
  return (data ?? []) as CleanTimeStandardRow[];
}

/** Fetch + build the indexed lookup the rules-engine merger consumes. */
export async function fetchCleanTimeStandardsIndex(
  propertyId: string,
): Promise<CleanTimeStandardsIndex> {
  return indexStandards(await fetchCleanTimeStandards(propertyId));
}

/** Fetch + flatten to the `cleaning_type -> minutes` map used as the
 *  board/timeline/auto-assign `baseDurations` fallback (all-rooms rows only). */
export async function fetchCleanTimeBaseDurations(
  propertyId: string,
): Promise<Record<string, number>> {
  return standardsToBaseDurations(await fetchCleanTimeStandards(propertyId));
}

/**
 * Upsert the all-rooms (room_type NULL) standard for one or more cleaning
 * types in a SINGLE bulk statement.
 *
 * One `INSERT ... ON CONFLICT DO UPDATE` (targeting the
 * (property_id, cleaning_type, room_type) NULLS NOT DISTINCT unique index
 * from migration 0244) means the whole save is atomic: a DB error writes
 * nothing (no partial update), and two managers saving concurrently resolve
 * as last-write-wins at the statement level rather than interleaving per
 * type. Both are the right behaviour for a low-frequency settings save.
 */
export async function upsertCleanTimeStandards(
  propertyId: string,
  updates: Array<{ cleaning_type: string; base_minutes: number }>,
  updatedByAccountId: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Validate up-front so a bad row can't write a partial update.
  for (const u of updates) {
    if (!isEditableCleaningType(u.cleaning_type)) {
      return { ok: false, error: `unknown cleaning type: ${String(u.cleaning_type)}` };
    }
    if (!isValidBaseMinutes(u.base_minutes)) {
      return { ok: false, error: `minutes for ${u.cleaning_type} must be an integer 1–240` };
    }
  }

  if (updates.length === 0) return { ok: true };

  const nowIso = new Date().toISOString();
  const rows = updates.map((u) => ({
    property_id: propertyId,
    cleaning_type: u.cleaning_type,
    room_type: null as string | null,
    base_minutes: u.base_minutes,
    updated_by: updatedByAccountId,
    updated_at: nowIso,
    // created_at intentionally omitted — on a conflict (update) the existing
    // row keeps its original created_at; on insert the column default fills it.
  }));

  const { error } = await supabaseAdmin
    .from('hk_clean_time_standards')
    .upsert(rows, { onConflict: 'property_id,cleaning_type,room_type' });
  if (error) return { ok: false, error: error.message };

  return { ok: true };
}
