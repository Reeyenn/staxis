/**
 * Shared assign helper for /api/admin/coverage/{assign,bulk-assign}.
 *
 * Not a route (underscore prefix — the app router only treats route.ts /
 * page.tsx as endpoints), just the common write: set properties.pms_type and
 * UPSERT property_sessions(...,'starting') so the supervisor boots a driver.
 *
 * The 409 'no_active_map' guard lives in the routes (so bulk vs single can
 * phrase it differently); this helper assumes the family is already known to
 * have an active coverage.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';

export type AssignResult = { ok: true } | { ok: false; error: string };

/**
 * Put one hotel on a family's coverage:
 *   - properties.pms_type = pmsFamily (the assignment of record),
 *   - UPSERT property_sessions(property_id, pms_family, status='starting').
 *
 * On a SWITCH (the hotel was on another family), the session's pms_family is
 * re-pointed and status reset to 'starting' so the supervisor re-resolves the
 * recipe for the NEW family. Idempotent for a same-family re-assign.
 */
export async function assignPropertyToFamily(
  propertyId: string,
  pmsFamily: string,
): Promise<AssignResult> {
  // These two writes aren't wrapped in one transaction (that would need an
  // RPC). Do the session upsert FIRST so a partial failure fails toward
  // RUNNING: the supervisor boots drivers from property_sessions, not from
  // properties.pms_type, so if the second write fails the robot still starts
  // for the right family and only the display field lags. The reverse order
  // fails toward a hotel shown as "on" the family with NO driver ever booting —
  // silent and unmonitored, the worst outcome.
  const now = new Date().toISOString();
  const { error: sessErr } = await supabaseAdmin
    .from('property_sessions')
    .upsert(
      { property_id: propertyId, pms_family: pmsFamily, status: 'starting', updated_at: now },
      { onConflict: 'property_id' },
    );
  if (sessErr) return { ok: false, error: 'could not start the coverage session' };

  const { error: propErr } = await supabaseAdmin
    .from('properties')
    .update({ pms_type: pmsFamily })
    .eq('id', propertyId);
  if (propErr) return { ok: false, error: 'could not set the hotel’s PMS' };

  return { ok: true };
}
