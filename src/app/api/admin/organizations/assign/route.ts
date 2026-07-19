/**
 * POST /api/admin/organizations/assign
 *
 * Atomically moves one hotel under a real organization, or makes it
 * independent when organizationId is null. The database RPC serializes moves,
 * ends the prior primary relationship, creates the replacement, and writes
 * immutable audit events in the same transaction.
 */

import { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { supabaseAdmin } from '@/lib/supabase-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface AssignBody {
  organizationId?: unknown;
  propertyId?: unknown;
  relationshipType?: unknown;
  isPrimary?: unknown;
}

function statusForRpcError(error: { code?: string; message?: string }): number {
  if (error.code === '42501') return 403;
  if (error.code === 'P0002' || error.code === '23503') return 404;
  if (error.code === '23505' || error.code === '23514') return 409;
  if (error.code === 'PGRST202' || error.code === 'PGRST205' || error.code === '42P01') return 503;
  return 500;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  let body: AssignBody;
  try {
    body = await req.json() as AssignBody;
  } catch {
    return err('A valid JSON body is required', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }

  const propertyId = typeof body.propertyId === 'string' ? body.propertyId : '';
  const organizationId = body.organizationId === null
    ? null
    : typeof body.organizationId === 'string' ? body.organizationId : '';
  const relationshipType = body.relationshipType ?? 'operator';

  if (!UUID.test(propertyId) || (organizationId !== null && !UUID.test(organizationId))) {
    return err('A valid propertyId and organizationId are required', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }
  if (body.isPrimary !== undefined && body.isPrimary !== true) {
    return err('This endpoint only manages the primary organization relationship', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }
  if (relationshipType !== 'operator' && relationshipType !== 'owner') {
    return err('Primary relationship type must be operator or owner', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }

  if (organizationId !== null) {
    const { data: target, error: targetError } = await supabaseAdmin
      .from('organizations')
      .select('id, organization_type, status')
      .eq('id', organizationId)
      .maybeSingle();
    if (targetError) {
      const status = statusForRpcError(targetError);
      return err(status === 503 ? 'Organization access is not ready yet' : 'Could not verify organization', {
        requestId,
        status,
        code: status === 503 ? ApiErrorCode.UpstreamFailure : ApiErrorCode.InternalError,
      });
    }
    if (!target || target.status !== 'active') {
      return err('Active organization not found', {
        requestId,
        status: 404,
        code: ApiErrorCode.NotFound,
      });
    }
    if (target.organization_type === 'single_hotel') {
      return err('Legacy single-hotel anchors cannot contain other hotels', {
        requestId,
        status: 409,
        code: ApiErrorCode.ValidationFailed,
      });
    }
  }

  const { data: relationshipId, error: moveError } = await supabaseAdmin.rpc(
    'staxis_set_primary_property_organization',
    {
      p_actor_account_id: auth.accountId,
      p_property_id: propertyId,
      p_organization_id: organizationId,
      p_relationship_type: relationshipType,
    },
  );

  if (moveError) {
    const status = statusForRpcError(moveError);
    return err(
      status === 503
        ? 'Organization access is still being prepared. Try again shortly.'
        : moveError.message || 'Could not assign hotel',
      {
        requestId,
        status,
        code: status === 403
          ? ApiErrorCode.Forbidden
          : status === 404
            ? ApiErrorCode.NotFound
            : status === 409
              ? ApiErrorCode.IdempotencyConflict
              : status === 503
                ? ApiErrorCode.UpstreamFailure
                : ApiErrorCode.InternalError,
      },
    );
  }

  return ok({
    assignment: {
      relationshipId: relationshipId as string | null,
      organizationId,
      propertyId,
      relationshipType,
      isPrimary: organizationId !== null,
    },
  }, { requestId });
}
