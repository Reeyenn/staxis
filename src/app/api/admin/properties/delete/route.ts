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
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { logSecurityEvent } from '@/lib/audit';
import { classifyAccountsForPropertyDelete, type LinkedAccount } from '@/lib/property-delete';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (!UUID_RE.test(propertyId)) {
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

  // Figure out which accounts to remove vs keep BEFORE deleting the hotel.
  // property_access is a uuid[] (not an FK), so the property delete won't
  // touch these — handle them explicitly so a deleted test hotel frees its
  // owner's email too. (Classifier is unit-tested for the over-delete
  // failure modes: never an admin, never a multi-hotel owner.)
  const { data: linked } = await supabaseAdmin
    .from('accounts')
    .select('id, data_user_id, role, property_access')
    .contains('property_access', [propertyId]);
  const plan = classifyAccountsForPropertyDelete((linked ?? []) as LinkedAccount[], propertyId);

  // Accounts that also belong to other hotels: just drop this one.
  for (const p of plan.prune) {
    await supabaseAdmin.from('accounts').update({ property_access: p.remaining }).eq('id', p.id);
  }

  // Delete the hotel — 129 FKs cascade (sessions, staff rows, pms_* data,
  // join codes, …). Re-assert the live guard at write time UNLESS the admin
  // confirmed by typing the exact name (that path is allowed to delete a live
  // hotel, so the null re-assertion would otherwise match zero rows).
  let delQuery = supabaseAdmin.from('properties').delete().eq('id', propertyId);
  if (!confirmedByName) delQuery = delQuery.is('onboarding_completed_at', null);
  const { error: delErr } = await delQuery;
  if (delErr) return err(`Delete failed: ${delErr.message}`, { requestId, status: 500 });

  // Remove the accounts that existed ONLY for this hotel + free their
  // emails. Delete the account row first, then the auth user (both
  // accounts.data_user_id and properties.owner_id CASCADE from auth.users,
  // but the property is already gone).
  //
  // Retry the auth deleteUser up to 3 times before giving up. A flaked auth
  // delete here is exactly what leaves an ORPHAN login (auth.users row with
  // no accounts row), which used to block recreating the same email until the
  // 7-day sweeper ran. Signup now reclaims orphans in-line
  // (createOrReclaimAuthUser), but retrying here makes them rare in the first
  // place. The orphan-auth sweeper stays the final backstop if all 3 flake.
  let accountsRemoved = 0;
  for (const uid of plan.deleteUserIds) {
    await supabaseAdmin.from('accounts').delete().eq('data_user_id', uid);
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
    if (deleted) accountsRemoved += 1;
  }

  await logSecurityEvent({
    action: 'admin.property_deleted',
    propertyId,
    requestId,
    metadata: { name: prop.name, accountsRemoved, accountsPruned: plan.prune.length, wasLive: !!prop.onboarding_completed_at, confirmedByName },
  });

  return ok({ deleted: true, name: prop.name, accountsRemoved }, { requestId });
}
