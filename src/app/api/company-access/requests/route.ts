// POST /api/company-access/requests
//
// Requests never grant access. The authenticated account's own active
// membership is resolved server-side and the database RPC atomically verifies
// the organization/scope before creating a pending review item.
//
// @tenant-scope session user -> accounts.id -> active organization membership;
// membership/account identifiers are never accepted from the client.

import { NextRequest } from 'next/server';

import { requireSession } from '@/lib/api-auth';
import { err, ok, ApiErrorCode } from '@/lib/api-response';
import { validateAccessRequestMutation } from '@/lib/company-access/mutations';
import { isCompanyAccessUnavailable } from '@/lib/company-access/database-errors';
import { getOrMintRequestId, log } from '@/lib/log';
import {
  activeMembershipsForActor,
  loadOrganizationAccessFacts,
  loadOrganizationActor,
} from '@/lib/organization-access/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function databaseError(error: { code?: string } | null) {
  if (isCompanyAccessUnavailable(error)) {
    return { status: 503, code: ApiErrorCode.UpstreamFailure, message: 'Company access requests are temporarily unavailable' };
  }
  if (error?.code === '23505') {
    return { status: 409, code: ApiErrorCode.IdempotencyConflict, message: 'A matching request is already pending' };
  }
  if (error?.code === '42501') {
    return { status: 403, code: ApiErrorCode.Forbidden, message: 'Your active membership could not be verified' };
  }
  if (error?.code === '23503' || error?.code === 'P0002') {
    return { status: 404, code: ApiErrorCode.NotFound, message: 'The selected company scope is no longer available' };
  }
  if (error?.code?.startsWith('22') || error?.code?.startsWith('23')) {
    return { status: 400, code: ApiErrorCode.ValidationFailed, message: 'The access request details are not valid' };
  }
  return { status: 500, code: ApiErrorCode.InternalError, message: 'Could not submit access request' };
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const validation = validateAccessRequestMutation(body);
  if (!validation.ok) {
    return err(validation.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const input = validation.value;

  try {
    const actor = await loadOrganizationActor(session.userId, session.email);
    if (!actor) return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
    const facts = await loadOrganizationAccessFacts(input.organizationId);
    const membership = activeMembershipsForActor(facts, actor.accountId, input.organizationId)[0];
    if (!membership) {
      return err('An active organization membership is required', {
        requestId, status: 403, code: ApiErrorCode.Forbidden,
      });
    }

    const { data: createdId, error: rpcError } = await supabaseAdmin.rpc(
      'staxis_create_organization_access_request',
      {
        p_actor_account_id: actor.accountId,
        p_membership_id: membership.id,
        p_requested_access_profile: input.requestedProfile,
        p_scope_type: input.scopeType,
        p_reason: input.reason,
        p_portfolio_id: input.portfolioId,
        p_property_id: input.propertyId,
      },
    );
    if (rpcError || !createdId) {
      const mapped = databaseError(rpcError);
      log.error('[company-access:requests:POST] mutation failed', {
        requestId, code: rpcError?.code ?? null, error: errToString(rpcError),
      });
      return err(mapped.message, { requestId, status: mapped.status, code: mapped.code });
    }

    return ok({
      request: {
        id: String(createdId),
        organizationId: input.organizationId,
        requestedProfile: input.requestedProfile,
        scopeType: input.scopeType,
        reason: input.reason,
        status: 'pending' as const,
        createdAt: new Date().toISOString(),
      },
    }, { requestId, status: 201 });
  } catch (caught) {
    log.error('[company-access:requests:POST] failed', { requestId, error: errToString(caught) });
    if (isCompanyAccessUnavailable(caught)) {
      return err('Company access requests are temporarily unavailable', {
        requestId, status: 503, code: ApiErrorCode.UpstreamFailure,
      });
    }
    return err('Could not submit access request', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
