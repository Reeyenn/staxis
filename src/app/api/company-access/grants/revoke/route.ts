// POST /api/company-access/grants/revoke
//
// Revokes one normalized Company Hub grant. The body carries only an opaque
// grant id and reason; the RPC resolves the organization/profile/scope and
// re-checks the authenticated actor transactionally.
//
// @tenant-scope session user -> accounts.id -> live delegation authority over
// the server-loaded grant; no organization or hotel id is accepted.

import { NextRequest } from 'next/server';

import { requireSession } from '@/lib/api-auth';
import { err, ok, ApiErrorCode } from '@/lib/api-response';
import { isCompanyAccessUnavailable } from '@/lib/company-access/database-errors';
import { validateGrantRevocationMutation } from '@/lib/company-access/mutations';
import { getOrMintRequestId, log } from '@/lib/log';
import { loadOrganizationActor } from '@/lib/organization-access/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function databaseError(error: { code?: string } | null) {
  if (isCompanyAccessUnavailable(error)) return { status: 503, code: ApiErrorCode.UpstreamFailure, message: 'Company access changes are temporarily unavailable' };
  if (error?.code === '42501') return { status: 403, code: ApiErrorCode.Forbidden, message: 'You cannot revoke this access grant' };
  if (error?.code === 'P0002' || error?.code === '23503') return { status: 404, code: ApiErrorCode.NotFound, message: 'Access grant not found' };
  if (error?.code === '23514' || error?.code === '23505') return { status: 409, code: ApiErrorCode.IdempotencyConflict, message: 'This access grant cannot be revoked' };
  if (error?.code === '22023') return { status: 400, code: ApiErrorCode.ValidationFailed, message: 'Revocation details are not valid' };
  return { status: 500, code: ApiErrorCode.InternalError, message: 'Could not revoke access grant' };
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
  const validation = validateGrantRevocationMutation(rawBody);
  if (!validation.ok) {
    return err(validation.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  try {
    const actor = await loadOrganizationActor(session.userId, session.email);
    if (!actor) return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
    const { data: changed, error: rpcError } = await supabaseAdmin.rpc(
      'staxis_revoke_organization_access',
      {
        p_actor_account_id: actor.accountId,
        p_grant_id: validation.value.grantId,
        p_reason: validation.value.reason,
      },
    );
    if (rpcError) {
      const mapped = databaseError(rpcError);
      log.warn('[company-access:grants:revoke] rejected', { requestId, code: rpcError.code ?? null });
      return err(mapped.message, { requestId, status: mapped.status, code: mapped.code });
    }
    return ok({ grantId: validation.value.grantId, status: 'revoked' as const, changed: Boolean(changed) }, { requestId });
  } catch (caught) {
    log.error('[company-access:grants:revoke] failed', { requestId, error: errToString(caught) });
    if (isCompanyAccessUnavailable(caught)) {
      return err('Company access changes are temporarily unavailable', {
        requestId, status: 503, code: ApiErrorCode.UpstreamFailure,
      });
    }
    return err('Could not revoke access grant', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
