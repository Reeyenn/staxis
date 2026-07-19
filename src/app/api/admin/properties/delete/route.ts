/**
 * POST /api/admin/properties/delete   { propertyId }
 *
 * Hard-deletes a property and everything hanging off it. Used by the small
 * hover-✕ on the admin Onboarding timeline to clear out test / abandoned
 * hotels that pile up during onboarding QA.
 *
 * Safety:
 *   - Admin only (requireAdmin).
 *   - REFUSES to delete a hotel that has completed onboarding
 *     (onboarding_completed_at set) — those are live/claimed hotels with
 *     real data; nuking one by a stray click would be catastrophic. The
 *     timeline only renders not-yet-live hotels, so the button never even
 *     appears for these, but the server enforces it too.
 *   - Logs an admin audit event with the deleted hotel's name.
 *
 * Cascade: 129 FKs reference properties with ON DELETE CASCADE (sessions,
 * staff, pms_* data, join codes, inventory, …); 6 audit/log tables are ON
 * DELETE SET NULL. So a single delete is clean — verified 2026-06-09.
 */

import { NextRequest } from 'next/server';
import { isUuid } from '@/lib/api-validate';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { logSecurityEvent } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  let body: { propertyId?: unknown; confirmName?: unknown };
  try {
    body = await req.json();
  } catch {
    return err('Invalid JSON body', { requestId, status: 400 });
  }
  const propertyId = typeof body.propertyId === 'string' ? body.propertyId : '';
  if (!isUuid(propertyId)) {
    return err('propertyId must be a UUID', { requestId, status: 400 });
  }

  const { data: prop, error: readErr } = await supabaseAdmin
    .from('properties')
    .select('id, name, onboarding_completed_at')
    .eq('id', propertyId)
    .maybeSingle();
  if (readErr) return err(`Could not load property: ${readErr.message}`, { requestId, status: 500 });
  if (!prop) return err('Property not found', { requestId, status: 404 });

  // Typed-name confirmation (Live Hotels "Delete hotel" button). When the admin
  // types the hotel's EXACT name, that deliberate intent OVERRIDES the live-hotel
  // guard below — this is the only path that can delete a finished/claimed hotel
  // (e.g. the live customer), and it's the safety against a stray click wiping it.
  // The legacy onboarding-timeline hover-✕ sends no confirmName, so it keeps the
  // old behavior (live hotels stay blocked).
  const confirmName = typeof body.confirmName === 'string' ? body.confirmName.trim() : '';
  const confirmedByName =
    confirmName.length > 0 &&
    confirmName.toLowerCase() === (prop.name ?? '').trim().toLowerCase();
  if (confirmName.length > 0 && !confirmedByName) {
    return err(
      'The name you typed does not match this hotel — type its exact name to confirm.',
      { requestId, status: 400 },
    );
  }

  // Guard: never quick-delete a live, claimed hotel UNLESS the admin confirmed by
  // typing its exact name.
  if (prop.onboarding_completed_at && !confirmedByName) {
    return err(
      'This hotel has finished onboarding — type its exact name to confirm deletion.',
      { requestId, status: 409 },
    );
  }

  // Property deletion, hidden-anchor retirement, account pruning, and account
  // row deletion are one database transaction. If a linked person is still a
  // final owner in a real organization, the whole operation rolls back.
  const { data: cleanupData, error: cleanupError } = await supabaseAdmin.rpc(
    'staxis_delete_property_and_legacy_accounts',
    {
      p_actor_account_id: auth.accountId,
      p_property_id: propertyId,
      // The database compares this value again after locking the hotel row.
      // The pre-read above is only for friendly validation/UI messaging.
      p_confirmed_name: confirmName || null,
    },
  );
  if (cleanupError) {
    const conflict = cleanupError.code === '23514';
    const notFound = cleanupError.code === 'P0002';
    return err(
      conflict
        ? 'Hotel or owner access changed while deletion was being confirmed; transfer company ownership or reload and try again.'
        : notFound ? 'Property not found' : `Delete failed: ${cleanupError.message}`,
      { requestId, status: conflict ? 409 : notFound ? 404 : 500 },
    );
  }
  const cleanup = (cleanupData ?? {}) as {
    name?: string;
    authUserIds?: string[];
    accountsRemoved?: number;
    accountsPruned?: number;
  };

  // Free auth emails after the database transaction commits. A failed auth
  // deletion leaves only an orphan login (the account/property authority is
  // already gone); signup's guarded orphan-reclaim path remains the backstop.
  //
  // Retry the auth deleteUser up to 3 times before giving up. A flaked auth
  // delete here is exactly what leaves an ORPHAN login (auth.users row with
  // no accounts row), which used to block recreating the same email until the
  // 7-day sweeper ran. Signup now reclaims orphans in-line
  // (createOrReclaimAuthUser), but retrying here makes them rare in the first
  // place. The orphan-auth sweeper stays the final backstop if all 3 flake.
  let authUsersRemoved = 0;
  for (const uid of cleanup.authUserIds ?? []) {
    let deleted = false;
    for (let attempt = 1; attempt <= 3 && !deleted; attempt++) {
      try {
        const { error: authErr } = await supabaseAdmin.auth.admin.deleteUser(uid);
        if (!authErr) { deleted = true; break; }
        console.warn('[admin/properties/delete] deleteUser error', { uid, attempt, msg: authErr.message });
      } catch (e) {
        console.warn('[admin/properties/delete] deleteUser threw', { uid, attempt, msg: (e as Error).message });
      }
      if (attempt < 3) await new Promise(r => setTimeout(r, 200 * attempt));
    }
    if (deleted) authUsersRemoved += 1;
  }

  await logSecurityEvent({
    action: 'admin.property_deleted',
    propertyId,
    requestId,
    metadata: {
      name: cleanup.name ?? prop.name,
      accountsRemoved: cleanup.accountsRemoved ?? 0,
      accountsPruned: cleanup.accountsPruned ?? 0,
      authUsersRemoved,
      wasLive: !!prop.onboarding_completed_at,
      confirmedByName,
    },
  });

  return ok({
    deleted: true,
    name: cleanup.name ?? prop.name,
    accountsRemoved: cleanup.accountsRemoved ?? 0,
    authUsersRemoved,
  }, { requestId });
}
