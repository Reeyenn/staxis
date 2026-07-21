/**
 * GET /api/capabilities/overrides?propertyId=<uuid>
 *
 * Returns the per-hotel capability override map (the admin's restrictions) for
 * one property, so the browser's PropertyContext resolves capabilities from the
 * SAME data the server gates use — no "show the button then 403".
 *
 * Why a route (not a direct browser read): capability_overrides is deny-all RLS
 * (service-role only). An anon read would return [] and make every hotel look
 * unrestricted. This route reads via supabaseAdmin after verifying the caller is
 * signed in and has access to the property. The map itself isn't sensitive — it
 * just tells the user what THEY can/can't reach at their own hotel — and the
 * server re-checks every gated request regardless.
 */

import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import {
  isCapabilityLookupError,
  loadOverridesForProperty,
} from '@/lib/capabilities/server';
import { capabilityUnavailableResponse } from '@/lib/capabilities/api-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);

  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  const pid = new URL(req.url).searchParams.get('propertyId') ?? '';
  const idCheck = validateUuid(pid, 'propertyId');
  if (idCheck.error || !idCheck.value) {
    return err('propertyId is required', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }

  const hasAccess = await userHasPropertyAccess(session.userId, idCheck.value);
  if (!hasAccess) {
    return err('no access to this property', {
      requestId,
      status: 403,
      code: ApiErrorCode.Forbidden,
    });
  }

  try {
    const overrides = await loadOverridesForProperty(idCheck.value);
    return ok({ overrides }, { requestId });
  } catch (error) {
    if (isCapabilityLookupError(error)) {
      return capabilityUnavailableResponse(requestId);
    }
    throw error;
  }
}
