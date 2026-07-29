// POST /api/auth/accept-invite
//
// Public endpoint. Body: { token, displayName, password, username? }
//
// Looks up the invite by sha256(token), validates current inviter authority,
// reserves the token for the external Auth-user creation window, then asks one
// database transaction to create the account + promised normalized entitlement,
// consume the invite, and audit it. Returns success only after that commit.

import { NextRequest } from 'next/server';
import { createHash, randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { createOrReclaimAuthUser } from '@/lib/auth-create-user';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log, getOrMintRequestId } from '@/lib/log';
import { checkAndIncrementRateLimit, rateLimitedResponse, clientIpRateLimitKey } from '@/lib/api-ratelimit';
import { capabilityUnavailableResponse } from '@/lib/capabilities/api-gate';
import {
  canGrantHotelRole,
  isAssignableRole,
  type AppRole,
} from '@/lib/roles';
import { captureException } from '@/lib/sentry';
import {
  resolveLocalHotelInviteAuthority,
  resolveStoredNormalizedInviteAuthority,
  type ResolvedAuthoritativeInviteScope,
} from '@/lib/company/account-invite-authority';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function hashToken(t: string) { return createHash('sha256').update(t).digest('hex'); }

function deriveUsername(email: string): string {
  const local = email.split('@')[0]?.toLowerCase().replace(/[^a-z0-9._+-]/g, '') ?? '';
  return local.slice(0, 40) || `user${Date.now().toString(36)}`;
}

type InviteClaimResult =
  | { ok: true; inviteId: string }
  | { ok: false; reason: 'not_found' | 'already_used' | 'expired' | 'busy' | 'unavailable' };

function parseInviteClaim(value: unknown): InviteClaimResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'unavailable' };
  }
  const row = value as Record<string, unknown>;
  if (row.ok === true && typeof row.inviteId === 'string') {
    return { ok: true, inviteId: row.inviteId };
  }
  const reason = row.reason;
  return reason === 'not_found' || reason === 'already_used' || reason === 'expired' || reason === 'busy'
    ? { ok: false, reason }
    : { ok: false, reason: 'unavailable' };
}

function acceptedInviteResult(value: unknown): value is {
  ok: true;
  accountId: string;
  normalized: boolean;
  membershipId: string | null;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.ok === true
    && typeof row.accountId === 'string'
    && typeof row.normalized === 'boolean'
    && (row.membershipId === null || typeof row.membershipId === 'string');
}

type AcceptanceCommitState = 'committed' | 'not_committed' | 'unavailable';

/**
 * An RPC response can be lost after PostgreSQL commits. Before deleting the
 * newly-created Auth identity, prove whether the atomic DB side committed.
 * Ambiguous state is preserved for reconciliation; destructive compensation
 * is allowed only after a primary read proves there is no account/acceptance.
 */
async function recoverAcceptanceCommit(
  inviteId: string,
  authUserId: string,
): Promise<AcceptanceCommitState> {
  try {
    const [inviteResult, accountResult] = await Promise.all([
      supabaseAdmin
        .from('account_invites')
        .select('accepted_at, accepted_by, acceptance_claim_token')
        .eq('id', inviteId)
        .maybeSingle(),
      supabaseAdmin
        .from('accounts')
        .select('id')
        .eq('data_user_id', authUserId)
        .maybeSingle(),
    ]);
    if (inviteResult.error || accountResult.error || !inviteResult.data) return 'unavailable';
    const acceptedBy = inviteResult.data.accepted_by as string | null;
    const accountId = accountResult.data?.id as string | undefined;
    if (inviteResult.data.accepted_at && accountId && acceptedBy === accountId) {
      return 'committed';
    }
    if (!inviteResult.data.accepted_at && !accountResult.data) return 'not_committed';
    return 'unavailable';
  } catch {
    return 'unavailable';
  }
}

function sameNormalizedAuthority(
  left: ResolvedAuthoritativeInviteScope,
  right: ResolvedAuthoritativeInviteScope,
): boolean {
  return left.organizationId === right.organizationId
    && left.scope === right.scope
    && left.role === right.role
    && left.propertyIds.length === right.propertyIds.length
    && left.propertyIds.every((propertyId, index) => propertyId === right.propertyIds[index]);
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  // ── Rate limit (Codex audit 2026-05-12) ────────────────────────────────
  // Public endpoint that hashes attacker-supplied tokens and creates
  // auth.users on hit. Without a cap an attacker could spray candidate
  // tokens to enumerate live invites. 10/hour per source IP allows the
  // legitimate one-shot accept flow with retry headroom.
  // Non-spoofable client IP (security audit 2026-06-26).
  const ipKey = clientIpRateLimitKey(req);
  const rl = await checkAndIncrementRateLimit('auth-accept-invite', ipKey);
  if (!rl.allowed) {
    return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
  }

  let body: { token?: unknown; displayName?: unknown; password?: unknown; username?: unknown };
  try {
    body = await req.json() as typeof body;
  } catch {
    return err('A valid JSON body is required', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!token || token.length > 256 || !displayName || displayName.length > 120 || !password) {
    return err('token, displayName, and password required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  if (password.length < 6 || password.length > 256) {
    return err('Password must be between 6 and 256 characters', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const tokenHash = hashToken(token);
  const { data: invite, error: invErr } = await supabaseAdmin
    .from('account_invites')
    .select(
      'id, hotel_id, email, role, expires_at, accepted_at, invited_by, organization_id, membership_scope, covered_property_ids',
    )
    .eq('token_hash', tokenHash)
    .maybeSingle();
  if (invErr || !invite) {
    return err('Invite not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }
  if (invite.accepted_at) {
    return err('Invite already used', { requestId, status: 410, code: ApiErrorCode.IdempotencyConflict });
  }
  if (new Date(invite.expires_at).getTime() <= Date.now()) {
    return err('Invite has expired', { requestId, status: 410, code: ApiErrorCode.IdempotencyConflict });
  }

  // ── What job did this invitation actually promise? ──────────────────────
  // A plain hotel invitation promises a hotel role and nothing else: the
  // hierarchy check below is the one that has always run. A company invitation
  // promises a hat, and the login it creates carries the least-privilege
  // DEGRADED word (company VP/finance both remain front_desk operationally) so
  // the true organization authority lives only on the normalized entitlement.
  const invitedScope = (invite as { membership_scope?: string | null }).membership_scope ?? null;
  const invitedOrganizationId = (invite as { organization_id?: string | null }).organization_id ?? null;
  const invitedPropertyIds = (
    invite as { covered_property_ids?: unknown }
  ).covered_property_ids ?? null;
  const expectedNormalized = invitedScope !== null
    || invitedOrganizationId !== null
    || invitedPropertyIds !== null;
  const storedNormalizedInvite = {
    hotelId: invite.hotel_id,
    organizationId: invitedOrganizationId,
    membershipScope: invitedScope,
    role: invite.role,
    coveredPropertyIds: invitedPropertyIds,
  };
  let firstNormalizedAuthority: ResolvedAuthoritativeInviteScope | null = null;
  let inviterRole: AppRole;
  if (expectedNormalized) {
    const authority = await resolveStoredNormalizedInviteAuthority({
      accountId: invite.invited_by,
      invite: storedNormalizedInvite,
    });
    if (authority.kind === 'unavailable') return capabilityUnavailableResponse(requestId);
    if (authority.kind === 'denied') {
      return err('Invite no longer valid', { requestId, status: 410, code: ApiErrorCode.IdempotencyConflict });
    }
    firstNormalizedAuthority = authority.value;
  } else {
    const inviterAuthority = await resolveLocalHotelInviteAuthority(
      invite.invited_by,
      invite.hotel_id,
      { requireIndependentTopology: true },
    );
    if (inviterAuthority.kind === 'unavailable') return capabilityUnavailableResponse(requestId);
    if (inviterAuthority.kind === 'denied') {
      return err('Invite no longer valid', { requestId, status: 410, code: ApiErrorCode.IdempotencyConflict });
    }
    inviterRole = inviterAuthority.value.roleAtHotel;
    if (!isAssignableRole(invite.role) || !canGrantHotelRole(inviterRole, invite.role)) {
      return err('Invite no longer valid', { requestId, status: 410, code: ApiErrorCode.IdempotencyConflict });
    }
  }

  // Scope expansion and hierarchy work above can cross a revocation or hotel
  // transfer. Re-resolve immediately before claiming the token, then evaluate
  // the promised hotel role against the role held at this hotel now.
  if (expectedNormalized) {
    const commitAuthority = await resolveStoredNormalizedInviteAuthority({
      accountId: invite.invited_by,
      invite: storedNormalizedInvite,
    });
    if (commitAuthority.kind === 'unavailable') return capabilityUnavailableResponse(requestId);
    if (commitAuthority.kind === 'denied'
        || !firstNormalizedAuthority
        || !sameNormalizedAuthority(firstNormalizedAuthority, commitAuthority.value)) {
      return err('Invite no longer valid', { requestId, status: 410, code: ApiErrorCode.IdempotencyConflict });
    }
  } else {
    const commitAuthority = await resolveLocalHotelInviteAuthority(
      invite.invited_by,
      invite.hotel_id,
      { freshCapability: true, requireIndependentTopology: true },
    );
    if (commitAuthority.kind === 'unavailable') return capabilityUnavailableResponse(requestId);
    if (commitAuthority.kind === 'denied'
        || !isAssignableRole(invite.role)
        || !canGrantHotelRole(commitAuthority.value.roleAtHotel, invite.role)) {
      return err('Invite no longer valid', { requestId, status: 410, code: ApiErrorCode.IdempotencyConflict });
    }
  }

  // Reserve only the external Auth-user creation window. This is NOT the
  // acceptance marker and grants no access. The final database RPC locks the
  // current hotel topology, re-authorizes the inviter, and commits account +
  // normalized entitlement + accepted_at together.
  const claimToken = randomUUID();
  const { data: claimData, error: claimError } = await supabaseAdmin.rpc(
    'staxis_claim_account_invite_acceptance',
    { p_token_hash: tokenHash, p_claim_token: claimToken },
  );
  if (claimError) {
    log.error('[accept-invite] reservation store unavailable', { requestId, code: claimError.code });
    return err('Invitation service temporarily unavailable', {
      requestId, status: 503, code: ApiErrorCode.UpstreamFailure,
    });
  }
  const claim = parseInviteClaim(claimData);
  if (!claim.ok) {
    if (claim.reason === 'not_found') {
      return err('Invite not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
    }
    if (claim.reason === 'busy') {
      return err('Invite acceptance is already in progress', {
        requestId, status: 409, code: ApiErrorCode.IdempotencyConflict,
      });
    }
    if (claim.reason === 'unavailable') {
      return err('Invitation service temporarily unavailable', {
        requestId, status: 503, code: ApiErrorCode.UpstreamFailure,
      });
    }
    return err(claim.reason === 'expired' ? 'Invite has expired' : 'Invite already used', {
      requestId, status: 410, code: ApiErrorCode.IdempotencyConflict,
    });
  }

  const releaseInvite = async () => {
    try {
      const { data, error } = await supabaseAdmin.rpc('staxis_release_account_invite_acceptance', {
        p_invite_id: claim.inviteId,
        p_claim_token: claimToken,
      });
      if (error || data !== true) throw error ?? new Error('reservation was not released');
    } catch (releaseError) {
      log.error('[accept-invite] exact reservation release failed', {
        requestId, inviteId: claim.inviteId, err: releaseError,
      });
    }
  };

  // Username from email local-part. The final SQL transaction trusts the
  // UNIQUE constraint and retries deterministic suffixes on collisions.
  let username = typeof body.username === 'string'
    ? body.username.toLowerCase().trim()
    : deriveUsername(invite.email);
  if (!/^[a-z0-9._+-]{2,40}$/.test(username)) {
    username = deriveUsername(invite.email);
  }

  // Create auth user. createOrReclaimAuthUser reclaims an orphan login (an
  // auth.users row left behind by a flaked hotel-delete with no accounts
  // row) instead of failing with "email already registered" for a week. If
  // the email belongs to a REAL account it is never touched — we surface a
  // 409 telling the invitee to sign in instead.
  const authResult = await createOrReclaimAuthUser({
    email: invite.email,
    password,
    userMetadata: { username, displayName, staxisInviteId: claim.inviteId },
    // The exact database reservation serializes this invitation. The generic
    // helper still protects recent identities created by other signup flows.
    allowOrphanReclaim: true,
  });
  if (authResult.alreadyHasAccount) {
    await releaseInvite();
    return err(
      'An account with this email already exists. Please sign in instead.',
      { requestId, status: 409, code: ApiErrorCode.IdempotencyConflict },
    );
  }
  if (!authResult.user) {
    log.error('[accept-invite] createOrReclaimAuthUser failed', { err: authResult.error, requestId });
    await releaseInvite();
    return err('Failed to create account', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const authUser = authResult.user;

  const rollbackAuthUser = async () => {
    try {
      const { error } = await supabaseAdmin.auth.admin.deleteUser(authUser.id);
      if (error) throw error;
    } catch (rollErr) {
      log.error('[accept-invite] AUTH ROLLBACK FAILED', {
        auth_user_id: authUser.id,
        email: invite.email,
        err: rollErr,
        requestId,
      });
      captureException(rollErr, {
        subsystem: 'auth',
        failure_mode: 'rollback_failed',
        auth_user_id: authUser.id,
        flow: 'accept-invite',
      });
    }
  };

  let acceptedData: unknown = null;
  let acceptedError: { code?: string; message?: string } | null = null;
  let finalizeThrown: unknown = null;
  try {
    const finalized = await supabaseAdmin.rpc(
      'staxis_accept_account_invite',
      {
        p_token_hash: tokenHash,
        p_claim_token: claimToken,
        p_auth_user_id: authUser.id,
        p_username: username,
        p_display_name: displayName,
      },
    );
    acceptedData = finalized.data;
    acceptedError = finalized.error;
  } catch (finalizeError) {
    finalizeThrown = finalizeError;
  }
  const accepted = acceptedInviteResult(acceptedData) ? acceptedData : null;
  if (finalizeThrown
    || acceptedError
    || !accepted
    || accepted.normalized !== expectedNormalized
    || (expectedNormalized && !accepted.membershipId)) {
    log.error('[accept-invite] transactional acceptance failed', {
      requestId,
      inviteId: claim.inviteId,
      code: acceptedError?.code,
      normalized: expectedNormalized,
      threw: finalizeThrown instanceof Error ? finalizeThrown.message : finalizeThrown ? String(finalizeThrown) : null,
    });

    const recovery = await recoverAcceptanceCommit(claim.inviteId, authUser.id);
    if (recovery === 'committed') {
      log.warn('[accept-invite] recovered committed acceptance after lost/invalid final response', {
        requestId, inviteId: claim.inviteId, authUserId: authUser.id,
      });
      return ok({ email: invite.email }, { requestId });
    }
    if (recovery === 'unavailable') {
      const reconciliationError = finalizeThrown instanceof Error
        ? finalizeThrown
        : new Error('Invitation finalization result is ambiguous');
      captureException(reconciliationError, {
        subsystem: 'auth',
        failure_mode: 'invite_acceptance_reconciliation_required',
        auth_user_id: authUser.id,
        invite_id: claim.inviteId,
      });
      // Do not delete Auth or release the exact claim: either could destroy a
      // committed account or let a second attempt race ambiguous state. The
      // claim self-expires after ten minutes and the recent-identity guard
      // preserves this login for reconciliation.
      return err('Invitation completion is being reconciled. Please retry shortly.', {
        requestId, status: 503, code: ApiErrorCode.UpstreamFailure,
      });
    }

    await rollbackAuthUser();
    await releaseInvite();

    const busy = acceptedError?.code === '55P03';
    const conflict = acceptedError?.code === '42501'
      || acceptedError?.code === '40001'
      || acceptedError?.code === '23514';
    const duplicate = acceptedError?.code === '23505';
    return err(
      busy ? 'Invitation completion is busy. Please retry shortly.'
        : conflict ? 'Invite no longer valid'
        : duplicate ? 'An account with this email already exists — please sign in instead.'
          : 'Failed to create account',
      {
        requestId,
        status: busy ? 503 : conflict ? 410 : duplicate ? 409 : 500,
        code: busy ? ApiErrorCode.UpstreamFailure
          : conflict || duplicate ? ApiErrorCode.IdempotencyConflict
            : ApiErrorCode.InternalError,
      },
    );
  }

  return ok({ email: invite.email }, { requestId });
}
