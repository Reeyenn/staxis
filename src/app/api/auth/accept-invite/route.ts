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
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log, getOrMintRequestId } from '@/lib/log';
import { writeAudit } from '@/lib/audit';
import { checkAndIncrementRateLimit, rateLimitedResponse, ipToRateLimitKey } from '@/lib/api-ratelimit';
import { canManageTeam, type AppRole } from '@/lib/roles';

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
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || req.headers.get('x-real-ip')?.trim()
    || '';
  const ipKey = ipToRateLimitKey(ip);
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

  // Re-validate that the inviter still has authority to grant this role.
  // Without this, an admin who is later demoted to general_manager could
  // have an in-flight invite that still grants 'owner' — a time-of-check vs.
  // time-of-use gap. canManageTeam covers admin / owner / general_manager;
  // the DB CHECK on account_invites.role already restricts invite.role to
  // the assignable set, so the only new failure mode is "inviter no longer
  // a team manager." invited_by is NOT NULL with ON DELETE CASCADE, so the
  // account row is guaranteed to still exist if the invite does.
  const { data: inviter } = await supabaseAdmin
    .from('accounts')
    .select('role')
    .eq('id', invite.invited_by)
    .maybeSingle();
  if (!inviter || !canManageTeam(inviter.role as AppRole)) {
    return err('Invite no longer valid', { requestId, status: 410, code: ApiErrorCode.IdempotencyConflict });
  }

  // Username from email local-part. Audit P3.1 (2026-05-17): previously
  // a SELECT-then-INSERT loop pre-checked uniqueness; now we trust the
  // UNIQUE constraint on accounts.username (migration 0001) and retry
  // the INSERT itself with a digit suffix on SQLSTATE 23505 — saves
  // N round-trips on the common no-collision path.
  let username = body.username?.toLowerCase().trim() || deriveUsername(invite.email);
  if (!/^[a-z0-9._+-]{2,40}$/.test(username)) {
    username = deriveUsername(invite.email);
  }

  // Create auth user.
  const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.createUser({
    email: invite.email,
    password,
    email_confirm: true,
    user_metadata: { username, displayName },
  });
  if (authErr || !authData.user) {
    log.error('[accept-invite] createUser failed', { err: authErr, requestId });
    return err('Failed to create account', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  // Insert with collision-retry against the UNIQUE constraint.
  let insErr: { code?: string; message?: string } | null = null;
  for (let i = 0; i < 5; i++) {
    const { error } = await supabaseAdmin.from('accounts').insert({
      username,
      display_name: displayName,
      role: invite.role,
      property_access: [invite.hotel_id],
      data_user_id: authData.user.id,
    });
    if (!error) { insErr = null; break; }
    insErr = error;
    if (error.code !== '23505') break;  // not a unique violation — won't fix itself
    username = (username + Math.floor(Math.random() * 10000)).slice(0, 40);
  }
  if (insErr) {
    log.error('[accept-invite] accounts insert failed', { err: insErr, requestId });
    await supabaseAdmin.auth.admin.deleteUser(authData.user.id).catch(() => {});
    return err('Failed to create account', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }

  // Mark invite consumed.
  await supabaseAdmin
    .from('account_invites')
    .update({ accepted_at: new Date().toISOString() })
    .eq('id', invite.id);

  await writeAudit({
    action: 'invite.accept',
    actorUserId: authData.user.id,
    actorEmail: invite.email,
    targetType: 'invite',
    targetId: invite.id,
    hotelId: invite.hotel_id,
    metadata: { role: invite.role, username },
  });

  return ok({ email: invite.email }, { requestId });
}
