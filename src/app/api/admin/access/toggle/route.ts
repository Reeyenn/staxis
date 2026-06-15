/**
 * POST /api/admin/access/toggle
 * Body: { propertyId, capability, role, allowed }
 *
 * Admin-only. Sets one (capability, role) verdict for one hotel:
 *   allowed === false → write/keep an `allowed = false` restriction row.
 *   allowed === true  → delete the row (back to the everyone-everything default).
 *
 * Hard invariant: admin-only capabilities (access_admin, manage_pms_coverage)
 * can NEVER be written here — no override may grant or restrict a Staxis-internal
 * capability for a hotel role. The resolver enforces this independently too.
 */

import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';
import { requireAdmin } from '@/lib/admin-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { isCapabilityKey, isHotelRole, isAdminOnlyCapability } from '@/lib/capabilities/registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body { propertyId?: unknown; capability?: unknown; role?: unknown; allowed?: unknown }

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  let body: Body;
  try { body = (await req.json()) as Body; } catch { body = {}; }

  const idCheck = validateUuid(body.propertyId, 'propertyId');
  if (idCheck.error || !idCheck.value) {
    return err('propertyId is required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const propertyId = idCheck.value;

  if (!isCapabilityKey(body.capability)) {
    return err('unknown capability', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const capability = body.capability;

  // Never let an override touch a Staxis-internal capability.
  if (isAdminOnlyCapability(capability)) {
    return err('admin-only capabilities cannot be granted or restricted', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  if (!isHotelRole(body.role)) {
    return err('role must be one of the hotel roles', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const role = body.role;

  if (typeof body.allowed !== 'boolean') {
    return err('allowed must be a boolean', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const allowed = body.allowed;

  if (allowed) {
    // Back to default → remove any restriction row.
    const { error } = await supabaseAdmin
      .from('capability_overrides')
      .delete()
      .eq('property_id', propertyId)
      .eq('capability', capability)
      .eq('role', role);
    if (error) return err('could not clear restriction', { requestId, status: 500, code: ApiErrorCode.UpstreamFailure });
  } else {
    // Restrict → upsert allowed=false on the (property, capability, role) key.
    const { error } = await supabaseAdmin
      .from('capability_overrides')
      .upsert(
        { property_id: propertyId, capability, role, allowed: false, updated_by: auth.accountId, updated_at: new Date().toISOString() },
        { onConflict: 'property_id,capability,role' },
      );
    if (error) return err('could not save restriction', { requestId, status: 500, code: ApiErrorCode.UpstreamFailure });
  }

  return ok({ propertyId, capability, role, allowed }, { requestId });
}
