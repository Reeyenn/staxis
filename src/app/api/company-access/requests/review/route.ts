// POST /api/company-access/requests/review
//
// Reviews a pending request only after resolving its organization/profile/scope
// from the database and checking the authenticated reviewer against that exact
// tuple. The RPC repeats the check and creates an approved grant atomically.
//
// @tenant-scope session user -> accounts.id -> live delegation authority over
// the server-loaded request; organization/scope cannot be overridden by body.

import { NextRequest } from 'next/server';

import { requireSession } from '@/lib/api-auth';
import { err, ok, ApiErrorCode } from '@/lib/api-response';
import { isUuid } from '@/lib/api-validate';
import { isCompanyAccessUnavailable } from '@/lib/company-access/database-errors';
import { getOrMintRequestId, log } from '@/lib/log';
import { canDelegateAccess, type AccessProfile, type AccessScopeType } from '@/lib/organization-access';
import { loadOrganizationAccessFacts, loadOrganizationActor } from '@/lib/organization-access/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RequestRow {
  id: string;
  organization_id: string;
  membership_id: string;
  requested_access_profile: AccessProfile;
  scope_type: AccessScopeType;
  portfolio_id: string | null;
  property_id: string | null;
  status: string;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;
  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  if (!isUuid(body.requestId)) {
    return err('requestId must be a valid UUID', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  if (body.decision !== 'approved' && body.decision !== 'denied') {
    return err('Decision must be approved or denied', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const reviewNote = typeof body.reviewNote === 'string' ? body.reviewNote.trim() : '';
  if (reviewNote.length > 1000 || (body.decision === 'denied' && !reviewNote)) {
    return err('A denial reason is required and must be at most 1000 characters', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  let expiresAt: string | null = null;
  if (body.expiresAt !== undefined && body.expiresAt !== null && body.expiresAt !== '') {
    if (typeof body.expiresAt !== 'string') {
      return err('Expiration must be a date', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(body.expiresAt)
      ? `${body.expiresAt}T23:59:59.999Z`
      : body.expiresAt);
    if (!Number.isFinite(parsed.getTime()) || parsed.getTime() <= Date.now()) {
      return err('Expiration must be in the future', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    expiresAt = parsed.toISOString();
  }

  try {
    const actor = await loadOrganizationActor(session.userId, session.email);
    if (!actor) return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
    const { data, error: queryError } = await supabaseAdmin.from('organization_access_requests')
      .select('id, organization_id, membership_id, requested_access_profile, scope_type, portfolio_id, property_id, status')
      .eq('id', body.requestId)
      .maybeSingle();
    if (queryError) throw queryError;
    if (!data) return err('Access request not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
    const request = data as RequestRow;
    if (request.status !== 'pending') {
      return err('Access request has already been reviewed', { requestId, status: 409, code: ApiErrorCode.IdempotencyConflict });
    }
    if (request.requested_access_profile === 'organization_owner' && expiresAt) {
      return err('Organization owner access cannot expire', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    if (body.decision === 'approved' && request.requested_access_profile === 'external_collaborator' && !expiresAt) {
      return err('External collaborator access requires an expiration', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    const facts = await loadOrganizationAccessFacts(request.organization_id);
    const decision = canDelegateAccess({
      actorAccountId: actor.accountId,
      organizationId: request.organization_id,
      requestedProfile: request.requested_access_profile,
      requestedScopeType: request.scope_type,
      requestedPortfolioId: request.portfolio_id,
      requestedPropertyId: request.property_id,
    }, facts);
    if (!decision.allowed) {
      return err('You cannot review this profile or scope', { requestId, status: 403, code: ApiErrorCode.Forbidden });
    }

    const { data: grantId, error: rpcError } = await supabaseAdmin.rpc(
      'staxis_review_organization_access_request',
      {
        p_actor_account_id: actor.accountId,
        p_request_id: request.id,
        p_decision: body.decision,
        p_review_note: reviewNote || null,
        p_expires_at: body.decision === 'approved' ? expiresAt : null,
      },
    );
    if (rpcError) {
      const unavailable = isCompanyAccessUnavailable(rpcError);
      const stale = rpcError.code === 'P0002' || rpcError.code === '23503' || rpcError.code === '55000';
      const status = unavailable ? 503 : rpcError.code === '42501' ? 403 : stale ? 409 : rpcError.code?.startsWith('22') ? 400 : 500;
      log.warn('[company-access:requests:review] rejected', { requestId, code: rpcError.code ?? null });
      return err(status === 503 ? 'Company access reviews are temporarily unavailable' : status === 403 ? 'You cannot review this profile or scope' : status === 409 ? 'Access request or scope is no longer pending' : status === 400 ? 'Review details are invalid' : 'Could not review access request', {
        requestId,
        status,
        code: status === 503 ? ApiErrorCode.UpstreamFailure : status === 403 ? ApiErrorCode.Forbidden : status === 409 ? ApiErrorCode.IdempotencyConflict : status === 400 ? ApiErrorCode.ValidationFailed : ApiErrorCode.InternalError,
      });
    }

    return ok({
      request: { id: request.id, status: body.decision },
      grantId: body.decision === 'approved' ? grantId ?? null : null,
    }, { requestId });
  } catch (caught) {
    log.error('[company-access:requests:review] failed', { requestId, error: errToString(caught) });
    if (isCompanyAccessUnavailable(caught)) {
      return err('Company access reviews are temporarily unavailable', {
        requestId, status: 503, code: ApiErrorCode.UpstreamFailure,
      });
    }
    return err('Could not review access request', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
