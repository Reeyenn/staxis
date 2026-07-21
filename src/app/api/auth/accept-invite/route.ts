// POST /api/auth/accept-invite
//
// Public endpoint. Body: { token, displayName, password, username? }
//
// Looks up the invite by sha256(token), checks expiry + accepted_at, then:
//   1. Creates the auth.users row with the invite's email + provided password
//   2. Inserts an accounts row (role + property_access from invite)
//   3. Marks the invite accepted
// Returns success — caller redirects user to /signin.

import { NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { createOrReclaimAuthUser } from '@/lib/auth-create-user';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log, getOrMintRequestId } from '@/lib/log';
import { writeAudit } from '@/lib/audit';
import { checkAndIncrementRateLimit, rateLimitedResponse, clientIpRateLimitKey } from '@/lib/api-ratelimit';
import { capabilityDecisionForProperty } from '@/lib/capabilities/server';
import { capabilityUnavailableResponse } from '@/lib/capabilities/api-gate';
import {
  canGrantHotelRole,
  canManageTeam,
  isAssignableRole,
  type AppRole,
} from '@/lib/roles';
import { captureException } from '@/lib/sentry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function hashToken(t: string) { return createHash('sha256').update(t).digest('hex'); }

function deriveUsername(email: string): string {
  const local = email.split('@')[0]?.toLowerCase().replace(/[^a-z0-9._+-]/g, '') ?? '';
  return local.slice(0, 40) || `user${Date.now().toString(36)}`;
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

  const body = await req.json() as { token?: string; displayName?: string; password?: string; username?: string };
  const { token, displayName, password } = body;
  if (!token || !displayName || !password) {
    return err('token, displayName, and password required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  if (password.length < 6) {
    return err('Password must be at least 6 characters', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const tokenHash = hashToken(token);
  const { data: invite, error: invErr } = await supabaseAdmin
    .from('account_invites')
    .select('id, hotel_id, email, role, expires_at, accepted_at, invited_by')
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

  // Re-validate every mutable part of the inviter's authority at the moment
  // of acceptance: active account, manager tier, exact hotel scope, current
  // per-hotel capability override, and the role hierarchy. This closes the
  // time-of-check/time-of-use gap for invites sent before a manager was
  // deactivated, moved, restricted, or demoted. `invited_by` is NOT NULL with
  // ON DELETE CASCADE, but an account row can remain while its authority
  // changes, so existence alone is not sufficient.
  const { data: inviter } = await supabaseAdmin
    .from('accounts')
    .select('role, property_access, active')
    .eq('id', invite.invited_by)
    .maybeSingle();
  if (!inviter || inviter.active !== true || !canManageTeam(inviter.role as AppRole)) {
    return err('Invite no longer valid', { requestId, status: 410, code: ApiErrorCode.IdempotencyConflict });
  }
  // Non-admin scope is deliberately exact. The '*' convention belongs to the
  // platform-admin role and must not let a stale/non-admin account authorize a
  // hotel that is absent from its explicit property_access list.
  const inviterRole = inviter.role as AppRole;
  const inviterAccess = (inviter.property_access ?? []) as string[];
  if (inviterRole !== 'admin' && !inviterAccess.includes(invite.hotel_id)) {
    return err('Invite no longer valid', { requestId, status: 410, code: ApiErrorCode.IdempotencyConflict });
  }
  const capabilityDecision = await capabilityDecisionForProperty(
    { role: inviterRole },
    'manage_team',
    invite.hotel_id,
  );
  if (capabilityDecision === 'unavailable') return capabilityUnavailableResponse(requestId);
  if (capabilityDecision === 'denied') {
    return err('Invite no longer valid', { requestId, status: 410, code: ApiErrorCode.IdempotencyConflict });
  }
  if (!isAssignableRole(invite.role) || !canGrantHotelRole(inviterRole, invite.role)) {
    return err('Invite no longer valid', { requestId, status: 410, code: ApiErrorCode.IdempotencyConflict });
  }

  // Atomically CLAIM the invite BEFORE any side effect. Two concurrent accept
  // submissions with the same token would both pass the accepted_at check above,
  // both create the auth user, and the second's createOrReclaimAuthUser could
  // reclaim/delete the first's brand-new login. The compare-and-swap
  // (accepted_at IS NULL -> now) lets exactly one win. (Audit fix 2026-06-18.)
  const { data: claimed } = await supabaseAdmin
    .from('account_invites')
    .update({ accepted_at: new Date().toISOString() })
    .eq('id', invite.id)
    .is('accepted_at', null)
    .select('id')
    .maybeSingle();
  if (!claimed) {
    return err('Invite already used', { requestId, status: 410, code: ApiErrorCode.IdempotencyConflict });
  }
  // Release the claim if account creation fails below, so a legitimate retry can
  // re-accept (claim-then-release-on-failure pattern).
  const releaseInvite = async () => {
    try { await supabaseAdmin.from('account_invites').update({ accepted_at: null }).eq('id', invite.id); }
    catch { /* best-effort */ }
  };

  // Username from email local-part. Audit P3.1 (2026-05-17): previously
  // a SELECT-then-INSERT loop pre-checked uniqueness; now we trust the
  // UNIQUE constraint on accounts.username (migration 0001) and retry
  // the INSERT itself with a digit suffix on SQLSTATE 23505 — saves
  // N round-trips on the common no-collision path.
  let username = body.username?.toLowerCase().trim() || deriveUsername(invite.email);
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
    userMetadata: { username, displayName },
  });
  if (authResult.alreadyHasAccount) {
    await releaseInvite();
    return err(
      'An account with this email already exists — please sign in instead.',
      { requestId, status: 409, code: ApiErrorCode.IdempotencyConflict },
    );
  }
  if (!authResult.user) {
    log.error('[accept-invite] createOrReclaimAuthUser failed', { err: authResult.error, requestId });
    await releaseInvite();
    return err('Failed to create account', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const authUser = authResult.user;

  // Insert with collision-retry against the UNIQUE constraint.
  let insErr: { code?: string; message?: string } | null = null;
  for (let i = 0; i < 5; i++) {
    const { error } = await supabaseAdmin.from('accounts').insert({
      username,
      display_name: displayName,
      role: invite.role,
      property_access: [invite.hotel_id],
      data_user_id: authUser.id,
    });
    if (!error) { insErr = null; break; }
    insErr = error;
    if (error.code !== '23505') break;  // not a unique violation — won't fix itself
    username = (username + Math.floor(Math.random() * 10000)).slice(0, 40);
  }
  if (insErr) {
    log.error('[accept-invite] accounts insert failed', { err: insErr, requestId });
    // Audit finding #4: pre-2026-05-17 this was `.catch(() => {})` which
    // silently swallowed rollback failures, leaving orphan auth.users
    // rows that future signups with the same email tripped over with no
    // breadcrumb. Log loudly + Sentry so the orphan sweeper cron has
    // backup observability and on-call gets paged if rollback fails
    // routinely.
    await supabaseAdmin.auth.admin.deleteUser(authUser.id).catch(rollErr => {
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
    });
    await releaseInvite();
    return err('Failed to create account', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }

  // Invite was already claimed atomically up front (compare-and-swap), so no
  // separate "mark consumed" write is needed here.

  await writeAudit({
    action: 'invite.accept',
    actorUserId: authUser.id,
    actorEmail: invite.email,
    targetType: 'invite',
    targetId: invite.id,
    hotelId: invite.hotel_id,
    metadata: { role: invite.role, username },
  });

  return ok({ email: invite.email }, { requestId });
}
