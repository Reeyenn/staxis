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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  let body: { propertyId?: unknown };
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

  // Guard: never quick-delete a live, claimed hotel.
  if (prop.onboarding_completed_at) {
    return err(
      'This hotel has finished onboarding — quick-delete is blocked for live hotels.',
      { requestId, status: 409 },
    );
  }

  const { error: delErr } = await supabaseAdmin
    .from('properties')
    .delete()
    .eq('id', propertyId)
    .is('onboarding_completed_at', null); // re-assert the guard at write time
  if (delErr) return err(`Delete failed: ${delErr.message}`, { requestId, status: 500 });

  await logSecurityEvent({
    action: 'admin.property_deleted',
    propertyId,
    requestId,
    metadata: { name: prop.name },
  });

  return ok({ deleted: true, name: prop.name }, { requestId });
}
