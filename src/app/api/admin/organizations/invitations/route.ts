/**
 * POST /api/admin/organizations/invitations
 *
 * Bootstrap a real organization's first customer leader without making the
 * internal Staxis administrator an organization member. The database RPC
 * re-checks the admin role and invitation constraints atomically; delivery is
 * best-effort and the one-time link is always returned as a fallback.
 */

import { createHash, randomBytes } from 'node:crypto';
import { NextRequest } from 'next/server';

import { requireAdmin } from '@/lib/admin-auth';
import { ApiErrorCode, err, ok } from '@/lib/api-response';
import { sendOrganizationAccessInvite } from '@/lib/email/organization-access-invite';
import { env } from '@/lib/env';
import { getOrMintRequestId, log } from '@/lib/log';
import { isJobCategory } from '@/lib/organization-access';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BOOTSTRAP_PROFILES = new Set(['organization_owner', 'organization_admin']);
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

interface BootstrapInviteBody {
  organizationId?: unknown;
  email?: unknown;
  accessProfile?: unknown;
  jobCategory?: unknown;
  jobTitle?: unknown;
}

function statusForRpcError(error: { code?: string }): number {
  if (error.code === '42501') return 403;
  if (error.code === '23503' || error.code === 'P0002') return 404;
  if (error.code === '23505' || error.code === '23514' || error.code === '55000') return 409;
  if (error.code === 'PGRST202' || error.code === 'PGRST205' || error.code === '42P01') return 503;
  if (error.code === '22023' || error.code === '23502') return 400;
  return 500;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  let body: BootstrapInviteBody;
  try {
    body = await req.json() as BootstrapInviteBody;
  } catch {
    return err('A valid JSON body is required', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }

  const organizationId = typeof body.organizationId === 'string' ? body.organizationId : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const accessProfile = typeof body.accessProfile === 'string' ? body.accessProfile : '';
  const fallbackCategory = accessProfile === 'organization_owner' ? 'owner_principal' : 'executive';
  const jobCategory = body.jobCategory === undefined ? fallbackCategory : body.jobCategory;
  const jobTitle = typeof body.jobTitle === 'string' ? body.jobTitle.trim().replace(/\s+/g, ' ') : '';

  if (!UUID.test(organizationId)) {
    return err('A valid organizationId is required', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }
  if (!EMAIL.test(email) || email.length > 320) {
    return err('A valid email address is required', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }
  if (!BOOTSTRAP_PROFILES.has(accessProfile)) {
    return err('The first company leader must be an organization owner or administrator', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }
  if (!isJobCategory(jobCategory)) {
    return err('Invalid job category', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }
  if (jobTitle.length > 120) {
    return err('Job title must be 120 characters or fewer', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }

  const { data: organization, error: organizationError } = await supabaseAdmin
    .from('organizations')
    .select('id, name, organization_type, status')
    .eq('id', organizationId)
    .maybeSingle();
  if (organizationError) {
    const status = statusForRpcError(organizationError);
    return err(status === 503 ? 'Organization access is not ready yet' : 'Could not verify organization', {
      requestId,
      status,
      code: status === 503 ? ApiErrorCode.UpstreamFailure : ApiErrorCode.InternalError,
    });
  }
  if (!organization || organization.status !== 'active' || organization.organization_type === 'single_hotel') {
    return err('Active customer organization not found', {
      requestId,
      status: 404,
      code: ApiErrorCode.NotFound,
    });
  }

  // Keep the bootstrap path byte-for-byte compatible with the customer
  // acceptance routes, which deliberately accept only 64-character hex
  // capability tokens.
  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  const { data: invitationId, error: invitationError } = await supabaseAdmin.rpc(
    'staxis_bootstrap_organization_leader_invitation',
    {
      p_actor_account_id: auth.accountId,
      p_organization_id: organizationId,
      p_email: email,
      p_token_hash: tokenHash,
      p_job_category: jobCategory,
      p_job_title: jobTitle || null,
      p_access_profile: accessProfile,
      p_expires_at: expiresAt,
    },
  );

  if (invitationError || typeof invitationId !== 'string') {
    const status = statusForRpcError(invitationError ?? {});
    return err(
      status === 409
        ? 'A pending invitation already exists for this person and scope'
        : status === 503
          ? 'Organization access is still being prepared. Try again shortly.'
          : invitationError?.message || 'Could not create organization invitation',
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
                : status === 400
                  ? ApiErrorCode.ValidationFailed
                  : ApiErrorCode.InternalError,
      },
    );
  }

  const inviteUrl = `${env.NEXT_PUBLIC_APP_URL.replace(/\/$/, '')}/company-invite/${encodeURIComponent(rawToken)}`;
  const delivery = await sendOrganizationAccessInvite({
    to: email,
    organizationName: organization.name,
    accessProfile,
    scopeLabel: organization.name,
    inviteUrl,
    expiresAt,
    auditContext: {
      actorUserId: auth.userId,
      actorEmail: auth.email ?? undefined,
      targetType: 'organization_invitation',
      targetId: invitationId,
      metadata: { organizationId, accessProfile, bootstrap: true },
    },
  });
  if (!delivery.ok) {
    log.warn('[admin/organizations/invitations:POST] email delivery failed', {
      requestId,
      organizationId,
      invitationId,
      error: errToString(delivery.error),
    });
  }

  return ok({
    invitation: {
      id: invitationId,
      organizationId,
      email,
      accessProfile,
      expiresAt,
      status: 'pending',
    },
    inviteLink: inviteUrl,
    emailSent: delivery.ok,
    emailError: delivery.ok ? null : delivery.error,
  }, { requestId, status: 201 });
}
