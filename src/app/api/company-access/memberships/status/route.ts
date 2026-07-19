// POST /api/company-access/memberships/status
//
// Suspends, resumes, or removes one Company Hub membership. The database resolves the
// target organization and enforces leadership rank, self-service, and final-
// owner protections in the same transaction as the mutation.
//
// @tenant-scope session user -> accounts.id -> organization-wide owner/admin
// authority over the server-loaded membership; no organization id is accepted.

import { NextRequest } from 'next/server';

import { requireSession } from '@/lib/api-auth';
import { err, ok, ApiErrorCode } from '@/lib/api-response';
import { isCompanyAccessUnavailable } from '@/lib/company-access/database-errors';
import { validateMembershipLifecycleMutation } from '@/lib/company-access/mutations';
import { getOrMintRequestId, log } from '@/lib/log';
import { loadOrganizationActor } from '@/lib/organization-access/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function databaseError(error: { code?: string } | null) {
  if (isCompanyAccessUnavailable(error)) return { status: 503, code: ApiErrorCode.UpstreamFailure, message: 'Company membership changes are temporarily unavailable' };
  if (error?.code === '42501') return { status: 403, code: ApiErrorCode.Forbidden, message: 'You cannot change this membership' };
  if (error?.code === 'P0002' || error?.code === '23503') return { status: 404, code: ApiErrorCode.NotFound, message: 'Membership not found' };
  if (error?.code === '23514' || error?.code === '23505') return { status: 409, code: ApiErrorCode.IdempotencyConflict, message: 'This membership cannot be changed in its current state' };
  if (error?.code === '22023') return { status: 400, code: ApiErrorCode.ValidationFailed, message: 'Membership change details are not valid' };
  return { status: 500, code: ApiErrorCode.InternalError, message: 'Could not change membership' };
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const validation = validateMembershipLifecycleMutation(rawBody);
  if (!validation.ok) {
    return err(validation.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  try {
    const actor = await loadOrganizationActor(session.userId, session.email);
    if (!actor) return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
    const { data: changed, error: rpcError } = await supabaseAdmin.rpc(
      'staxis_change_organization_membership_status',
      {
        p_actor_account_id: actor.accountId,
        p_membership_id: validation.value.membershipId,
        p_action: validation.value.action,
        p_reason: validation.value.reason,
      },
    );
    if (rpcError) {
      const mapped = databaseError(rpcError);
      log.warn('[company-access:memberships:status] rejected', { requestId, code: rpcError.code ?? null });
      return err(mapped.message, { requestId, status: mapped.status, code: mapped.code });
    }
    return ok({
      membershipId: validation.value.membershipId,
      status: validation.value.action === 'suspend'
        ? 'suspended' as const
        : validation.value.action === 'resume' ? 'active' as const : 'revoked' as const,
      changed: Boolean(changed),
    }, { requestId });
  } catch (caught) {
    log.error('[company-access:memberships:status] failed', { requestId, error: errToString(caught) });
    if (isCompanyAccessUnavailable(caught)) {
      return err('Company membership changes are temporarily unavailable', {
        requestId, status: 503, code: ApiErrorCode.UpstreamFailure,
      });
    }
    return err('Could not change membership', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
