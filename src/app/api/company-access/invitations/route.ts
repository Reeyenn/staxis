// POST /api/company-access/invitations
//
// Creates one email-specific, single-use organization invitation. The
// organization/scope in the body is untrusted: authority is resolved from the
// authenticated account, checked with the pure resolver, then checked again
// transactionally by the database RPC.
//
// @tenant-scope session user -> accounts.id -> active membership/grant in the
// requested organization; no Staxis-admin bypass is accepted by this route.

import { createHash, randomBytes } from 'node:crypto';
import { NextRequest } from 'next/server';

import { requireSession } from '@/lib/api-auth';
import { err, ok, ApiErrorCode } from '@/lib/api-response';
import { validateInvitationMutation } from '@/lib/company-access/mutations';
import { isCompanyAccessUnavailable } from '@/lib/company-access/database-errors';
import { sendOrganizationAccessInvite } from '@/lib/email/organization-access-invite';
import { env } from '@/lib/env';
import { getOrMintRequestId, log } from '@/lib/log';
import { canDelegateAccess } from '@/lib/organization-access';
import { loadOrganizationAccessFacts, loadOrganizationActor } from '@/lib/organization-access/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function databaseStatus(error: { code?: string } | null): { status: number; code: string; message: string } {
  if (isCompanyAccessUnavailable(error)) {
    return { status: 503, code: ApiErrorCode.UpstreamFailure, message: 'Company invitations are temporarily unavailable' };
  }
  if (error?.code === '23505') {
    return { status: 409, code: ApiErrorCode.IdempotencyConflict, message: 'A matching pending invitation already exists' };
  }
  if (error?.code === '42501') {
    return { status: 403, code: ApiErrorCode.Forbidden, message: 'You cannot grant that profile or scope' };
  }
  if (error?.code === 'P0002' || error?.code === '23503') {
    return { status: 404, code: ApiErrorCode.NotFound, message: 'The selected company scope is no longer available' };
  }
  if (error?.code?.startsWith('22') || error?.code?.startsWith('23')) {
    return { status: 400, code: ApiErrorCode.ValidationFailed, message: 'The invitation details are not valid' };
  }
  return { status: 500, code: ApiErrorCode.InternalError, message: 'Could not create invitation' };
}

async function scopeNames(organizationId: string, scopeType: string, targetId: string | null) {
  const organizationQuery = supabaseAdmin.from('organizations').select('name').eq('id', organizationId).maybeSingle();
  const targetQuery = scopeType === 'portfolio' && targetId
    ? supabaseAdmin.from('portfolios').select('name').eq('id', targetId).eq('organization_id', organizationId).maybeSingle()
    : scopeType === 'property' && targetId
      ? supabaseAdmin.from('properties').select('name').eq('id', targetId).maybeSingle()
      : Promise.resolve({ data: null, error: null });
  const [organization, target] = await Promise.all([organizationQuery, targetQuery]);
  if (organization.error) throw organization.error;
  if (target.error) throw target.error;
  return {
    organizationName: (organization.data?.name as string | undefined) ?? 'your organization',
    scopeLabel: scopeType === 'organization'
      ? ((organization.data?.name as string | undefined) ?? 'Entire organization')
      : ((target.data?.name as string | undefined) ?? (scopeType === 'portfolio' ? 'Portfolio' : 'Hotel')),
  };
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
  const validation = validateInvitationMutation(rawBody);
  if (!validation.ok) {
    return err(validation.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const input = validation.value;

  try {
    const actor = await loadOrganizationActor(session.userId, session.email);
    if (!actor) return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
    const facts = await loadOrganizationAccessFacts(input.organizationId);
    const decision = canDelegateAccess({
      actorAccountId: actor.accountId,
      organizationId: input.organizationId,
      requestedProfile: input.accessProfile,
      requestedScopeType: input.scopeType,
      requestedPortfolioId: input.portfolioId,
      requestedPropertyId: input.propertyId,
    }, facts);
    if (!decision.allowed) {
      return err('You cannot grant that profile or scope', {
        requestId, status: 403, code: ApiErrorCode.Forbidden,
      });
    }

    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const invitationExpiresAt = new Date(Date.now() + INVITATION_TTL_MS).toISOString();
    if (input.grantExpiresAt && new Date(input.grantExpiresAt).getTime() <= new Date(invitationExpiresAt).getTime()) {
      return err('Access expiration must be after the seven-day invitation window', {
        requestId, status: 400, code: ApiErrorCode.ValidationFailed,
      });
    }
    const { organizationName, scopeLabel } = await scopeNames(
      input.organizationId,
      input.scopeType,
      input.scopeType === 'portfolio' ? input.portfolioId : input.scopeType === 'property' ? input.propertyId : null,
    );

    const { data: invitationId, error: rpcError } = await supabaseAdmin.rpc(
      'staxis_create_organization_invitation',
      {
        p_actor_account_id: actor.accountId,
        p_organization_id: input.organizationId,
        p_email: input.email,
        p_token_hash: tokenHash,
        p_job_category: input.jobCategory,
        p_job_title: input.jobTitle,
        p_access_profile: input.accessProfile,
        p_scope_type: input.scopeType,
        p_portfolio_id: input.portfolioId,
        p_property_id: input.propertyId,
        p_expires_at: invitationExpiresAt,
        p_grant_expires_at: input.grantExpiresAt,
      },
    );
    if (rpcError || !invitationId) {
      const mapped = databaseStatus(rpcError);
      log.error('[company-access:invitations:POST] mutation failed', {
        requestId, code: rpcError?.code ?? null, error: errToString(rpcError),
      });
      return err(mapped.message, { requestId, status: mapped.status, code: mapped.code });
    }

    const inviteLink = `${env.NEXT_PUBLIC_APP_URL.replace(/\/$/, '')}/company-invite/${rawToken}`;
    const emailResult = await sendOrganizationAccessInvite({
      to: input.email,
      organizationName,
      accessProfile: input.accessProfile,
      scopeLabel,
      inviteUrl: inviteLink,
      expiresAt: invitationExpiresAt,
      auditContext: {
        actorUserId: actor.authUserId,
        actorEmail: actor.email ?? undefined,
        targetType: 'organization_invitation',
        targetId: String(invitationId),
        metadata: { organizationId: input.organizationId },
      },
    });
    if (!emailResult.ok) {
      log.warn('[company-access:invitations:POST] email delivery failed', {
        requestId, invitationId: String(invitationId), status: emailResult.status ?? undefined,
      });
    }

    return ok({
      invitation: {
        id: String(invitationId),
        organizationId: input.organizationId,
        accessProfile: input.accessProfile,
        scopeType: input.scopeType,
        status: 'pending' as const,
        expiresAt: invitationExpiresAt,
      },
      inviteLink,
      emailSent: emailResult.ok,
      emailError: emailResult.ok ? null : 'Email delivery failed; copy the invitation link instead.',
    }, { requestId, status: 201 });
  } catch (caught) {
    log.error('[company-access:invitations:POST] failed', { requestId, error: errToString(caught) });
    if (isCompanyAccessUnavailable(caught)) {
      return err('Company invitations are temporarily unavailable', {
        requestId, status: 503, code: ApiErrorCode.UpstreamFailure,
      });
    }
    return err('Could not create invitation', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
