// POST /api/company-access/invitations/cancel
//
// Cancels one pending Company Hub invitation. Its organization/profile/scope is
// loaded inside the RPC and cannot be replaced with tenant ids from the body.
//
// @tenant-scope session user -> accounts.id -> live delegation authority over
// the server-loaded invitation; no organization or hotel id is accepted.

import { NextRequest } from 'next/server';

import { requireSession } from '@/lib/api-auth';
import { err, ok, ApiErrorCode } from '@/lib/api-response';
import { isCompanyAccessUnavailable } from '@/lib/company-access/database-errors';
import { validateInvitationCancellationMutation } from '@/lib/company-access/mutations';
import { getOrMintRequestId, log } from '@/lib/log';
import { loadOrganizationActor } from '@/lib/organization-access/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function databaseError(error: { code?: string } | null) {
  if (isCompanyAccessUnavailable(error)) return { status: 503, code: ApiErrorCode.UpstreamFailure, message: 'Company invitation changes are temporarily unavailable' };
  if (error?.code === '42501') return { status: 403, code: ApiErrorCode.Forbidden, message: 'You cannot cancel this invitation' };
  if (error?.code === 'P0002' || error?.code === '23503') return { status: 404, code: ApiErrorCode.NotFound, message: 'Invitation not found' };
  if (error?.code === '23514' || error?.code === '23505') return { status: 409, code: ApiErrorCode.IdempotencyConflict, message: 'Only a pending invitation can be cancelled' };
  if (error?.code === '22023') return { status: 400, code: ApiErrorCode.ValidationFailed, message: 'Cancellation details are not valid' };
  return { status: 500, code: ApiErrorCode.InternalError, message: 'Could not cancel invitation' };
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
  const validation = validateInvitationCancellationMutation(rawBody);
  if (!validation.ok) {
    return err(validation.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  try {
    const actor = await loadOrganizationActor(session.userId, session.email);
    if (!actor) return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
    const { data: changed, error: rpcError } = await supabaseAdmin.rpc(
      'staxis_cancel_organization_invitation',
      {
        p_actor_account_id: actor.accountId,
        p_invitation_id: validation.value.invitationId,
        p_reason: validation.value.reason,
      },
    );
    if (rpcError) {
      const mapped = databaseError(rpcError);
      log.warn('[company-access:invitations:cancel] rejected', { requestId, code: rpcError.code ?? null });
      return err(mapped.message, { requestId, status: mapped.status, code: mapped.code });
    }
    return ok({ invitationId: validation.value.invitationId, status: 'revoked' as const, changed: Boolean(changed) }, { requestId });
  } catch (caught) {
    log.error('[company-access:invitations:cancel] failed', { requestId, error: errToString(caught) });
    if (isCompanyAccessUnavailable(caught)) {
      return err('Company invitation changes are temporarily unavailable', {
        requestId, status: 503, code: ApiErrorCode.UpstreamFailure,
      });
    }
    return err('Could not cancel invitation', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
