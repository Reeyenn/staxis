// POST /api/company-access/invitations/register
//
// Public, token-capability account creation for a new organization invitee.
// It creates the least-privileged legacy account (`staff`, no hotels), then
// atomically accepts the normalized invitation. It never maps an organization
// profile to a broad legacy role or property_access entry.
//
// @tenant-scope single-use 256-bit invitation token -> verified invitation
// email; the organization/profile/scope are loaded and enforced by the DB RPC.

import { createHash, randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

import { checkAndIncrementRateLimit, clientIpRateLimitKey, rateLimitedResponse } from '@/lib/api-ratelimit';
import { err, ok, ApiErrorCode, buildOkBody } from '@/lib/api-response';
import { createOrReclaimAuthUser } from '@/lib/auth-create-user';
import { isCompanyAccessUnavailable } from '@/lib/company-access/database-errors';
import { deleteCreatedIdentity } from '@/lib/company-access/registration-identity-rollback';
import { recordIdempotency } from '@/lib/idempotency';
import { getOrMintRequestId, log } from '@/lib/log';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RAW_TOKEN_RX = /^[0-9a-f]{64}$/i;
const CLAIM_ROUTE = 'company-invitation-register';

interface ClaimRow {
  claimed: boolean;
  existing_response: unknown;
  existing_status: number | null;
  existing_route: string | null;
}

function deriveUsername(email: string): string {
  const local = email.split('@')[0]?.toLowerCase().replace(/[^a-z0-9._+-]/g, '') ?? '';
  return local.slice(0, 40) || `user${Date.now().toString(36)}`;
}

async function releasePendingClaim(claimKey: string, requestId: string) {
  try {
    const { error } = await supabaseAdmin.from('idempotency_log')
      .delete()
      .eq('key', claimKey)
      .eq('route', CLAIM_ROUTE)
      .eq('status_code', 0)
      .contains('response', { __pending__: true });
    if (error) log.warn('[company-invite:register] pending claim release failed', { requestId, code: error.code ?? null });
  } catch (caught) {
    log.warn('[company-invite:register] pending claim release threw', {
      requestId, error: caught instanceof Error ? caught : new Error(String(caught)),
    });
  }
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const limit = await checkAndIncrementRateLimit('company-invitation-register', clientIpRateLimitKey(req));
  if (!limit.allowed) return rateLimitedResponse(limit.current, limit.cap, limit.retryAfterSec);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const input = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const token = typeof input.token === 'string' ? input.token.trim() : '';
  const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
  const password = typeof input.password === 'string' ? input.password : '';
  if (!RAW_TOKEN_RX.test(token)) {
    return err('Invitation is invalid or expired', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  if (displayName.length < 2 || displayName.length > 100) {
    return err('Display name must be between 2 and 100 characters', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  if (password.length < 8 || password.length > 128) {
    return err('Password must be between 8 and 128 characters', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const tokenHash = createHash('sha256').update(token).digest('hex');
  const claimKey = `orginvite_${tokenHash}`;
  // This derived atomic claim is load-bearing. It is acquired before reading
  // or creating auth identities so two concurrent submits can never race
  // through createOrReclaimAuthUser and mistake the winner for an orphan.
  const { data: claimData, error: claimError } = await supabaseAdmin.rpc('claim_idempotency_key', {
    p_key: claimKey,
    p_route: CLAIM_ROUTE,
  });
  if (claimError) {
    log.error('[company-invite:register] idempotency claim failed closed', { requestId, code: claimError.code ?? null });
    return err('Invitation acceptance is temporarily unavailable', {
      requestId, status: 503, code: ApiErrorCode.UpstreamFailure,
    });
  }
  const claim = (Array.isArray(claimData) ? claimData[0] : claimData) as ClaimRow | undefined;
  if (!claim?.claimed) {
    if (claim?.existing_route === CLAIM_ROUTE
      && claim.existing_response
      && typeof claim.existing_response === 'object'
      && (claim.existing_response as Record<string, unknown>).__pending__ !== true) {
      const existing = claim.existing_response as Record<string, unknown>;
      const data = existing.data && typeof existing.data === 'object'
        ? existing.data as Record<string, unknown>
        : {};
      if (data.claimMode === 'authenticated_accept') {
        return err('This invitation was accepted by an existing account. Sign in to continue.', {
          requestId, status: 409, code: ApiErrorCode.IdempotencyConflict,
        });
      }
      return NextResponse.json(claim.existing_response, { status: claim.existing_status ?? 200 });
    }
    return err('This invitation is already being accepted. Please wait and try again.', {
      requestId, status: 409, code: ApiErrorCode.IdempotencyConflict,
    });
  }

  let authUserId: string | null = null;
  let accountId: string | null = null;
  let acceptanceStarted = false;
  try {
    const { data: invitation, error: invitationError } = await supabaseAdmin
      .from('organization_invitations')
      .select('email, status, expires_at')
      .eq('token_hash', tokenHash)
      .maybeSingle();
    if (invitationError) {
      log.error('[company-invite:register] invitation lookup failed', {
        requestId, code: invitationError.code ?? null,
      });
      await releasePendingClaim(claimKey, requestId);
      return err('Invitation acceptance is temporarily unavailable', {
        requestId, status: 503, code: ApiErrorCode.UpstreamFailure,
      });
    }
    if (!invitation || invitation.status !== 'pending' || new Date(invitation.expires_at).getTime() <= Date.now()) {
      await releasePendingClaim(claimKey, requestId);
      return err('Invitation is invalid or expired', { requestId, status: 410, code: ApiErrorCode.IdempotencyConflict });
    }

    const preferredUsername = typeof input.username === 'string'
      ? input.username.toLowerCase().trim()
      : '';
    let username = /^[a-z0-9._+-]{2,40}$/.test(preferredUsername)
      ? preferredUsername
      : deriveUsername(invitation.email);
    const authResult = await createOrReclaimAuthUser({
      email: invitation.email,
      password,
      userMetadata: { username, displayName },
      allowOrphanReclaim: false,
    });
    if (authResult.unlinkedIdentity) {
      await releasePendingClaim(claimKey, requestId);
      return err('Account setup is still being reconciled. Please wait and try again.', {
        requestId, status: 503, code: ApiErrorCode.UpstreamFailure,
      });
    }
    if (authResult.alreadyHasAccount) {
      await releasePendingClaim(claimKey, requestId);
      return err('An account with this email already exists. Sign in to accept the invitation.', {
        requestId, status: 409, code: ApiErrorCode.IdempotencyConflict,
      });
    }
    if (!authResult.user) {
      log.warn('[company-invite:register] auth creation rejected', { requestId, status: authResult.error?.status ?? undefined });
      await releasePendingClaim(claimKey, requestId);
      return err('Could not create account', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    authUserId = authResult.user.id;
    // Supplying the UUID makes the compensating DELETE target knowable even
    // when the account INSERT response is lost after reaching the database.
    accountId = randomUUID();

    let accountError: { code?: string; message?: string } | null = null;
    let accountCreated = false;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { data: account, error } = await supabaseAdmin.from('accounts').insert({
        id: accountId,
        username,
        display_name: displayName,
        role: 'staff',
        property_access: [],
        data_user_id: authUserId,
      }).select('id').single();
      if (!error && account) {
        accountId = account.id as string;
        accountError = null;
        accountCreated = true;
        break;
      }
      accountError = error;
      if (error?.code !== '23505') break;
      username = `${deriveUsername(invitation.email).slice(0, 34)}${Math.floor(Math.random() * 1_000_000)}`.slice(0, 40);
    }
    if (!accountCreated) {
      log.error('[company-invite:register] account insert failed', { requestId, code: accountError?.code ?? null });
      await deleteCreatedIdentity(accountId, authUserId, requestId);
      authUserId = null;
      await releasePendingClaim(claimKey, requestId);
      return err('Could not create account', { requestId, status: 500, code: ApiErrorCode.InternalError });
    }

    acceptanceStarted = true;
    const { error: acceptError } = await supabaseAdmin.rpc('staxis_accept_organization_invitation', {
      p_token_hash: tokenHash,
      p_account_id: accountId,
    });
    if (acceptError) {
      log.warn('[company-invite:register] invitation acceptance rejected', { requestId, code: acceptError.code ?? null });
      const deploymentUnavailable = isCompanyAccessUnavailable(acceptError);
      // A SQLSTATE means the RPC transaction definitively rejected and rolled
      // back. A transport-shaped error without a code is uncertain: the DB may
      // have committed before the response was lost, so preserve identity +
      // claim and let support/retry reconciliation inspect the accepted token.
      if (!acceptError.code) {
        return err('Invitation acceptance is still being confirmed. Please wait and try signing in.', {
          requestId, status: 503, code: ApiErrorCode.UpstreamFailure,
        });
      }
      acceptanceStarted = false;
      await deleteCreatedIdentity(accountId, authUserId, requestId);
      accountId = null;
      authUserId = null;
      await releasePendingClaim(claimKey, requestId);
      if (deploymentUnavailable) {
        return err('Invitation acceptance is temporarily unavailable', {
          requestId, status: 503, code: ApiErrorCode.UpstreamFailure,
        });
      }
      return err('Invitation is invalid, expired, or no longer authorized', {
        requestId, status: acceptError.code === '42501' ? 403 : 410,
        code: acceptError.code === '42501' ? ApiErrorCode.Forbidden : ApiErrorCode.IdempotencyConflict,
      });
    }

    const responseBody = buildOkBody({
      created: true,
      redirectTo: '/company',
      claimMode: 'registration',
    }, requestId);
    await recordIdempotency(claimKey, CLAIM_ROUTE, responseBody, 201);
    return NextResponse.json(responseBody, { status: 201 });
  } catch (caught) {
    if (!acceptanceStarted) {
      if (accountId || authUserId) await deleteCreatedIdentity(accountId, authUserId, requestId);
      await releasePendingClaim(claimKey, requestId);
    }
    log.error('[company-invite:register] failed', { requestId, error: errToString(caught) });
    return err('Could not accept invitation', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
