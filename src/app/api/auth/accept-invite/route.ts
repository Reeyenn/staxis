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
import { getOrMintRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function hashToken(t: string) { return createHash('sha256').update(t).digest('hex'); }

function deriveUsername(email: string): string {
  const local = email.split('@')[0]?.toLowerCase().replace(/[^a-z0-9._+-]/g, '') ?? '';
  return local.slice(0, 40) || `user${Date.now().toString(36)}`;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
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
    .select('id, hotel_id, email, role, expires_at, accepted_at')
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

  // Username from email local-part, plus a tiny suffix if needed.
  let username = body.username?.toLowerCase().trim() || deriveUsername(invite.email);
  if (!/^[a-z0-9._+-]{2,40}$/.test(username)) {
    username = deriveUsername(invite.email);
  }
  // Resolve username collisions by appending random digits.
  for (let i = 0; i < 5; i++) {
    const { data: ex } = await supabaseAdmin.from('accounts').select('id').eq('username', username).maybeSingle();
    if (!ex) break;
    username = (username + Math.floor(Math.random() * 10000)).slice(0, 40);
  }

  // Create auth user.
  const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.createUser({
    email: invite.email,
    password,
    email_confirm: true,
    user_metadata: { username, displayName },
  });
  if (authErr || !authData.user) {
    console.error('[accept-invite] createUser failed', authErr);
    return err(authErr?.message ?? 'Failed to create account', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const { error: insErr } = await supabaseAdmin.from('accounts').insert({
    username,
    display_name: displayName,
    role: invite.role,
    property_access: [invite.hotel_id],
    data_user_id: authData.user.id,
  });
  if (insErr) {
    console.error('[accept-invite] accounts insert failed', insErr);
    await supabaseAdmin.auth.admin.deleteUser(authData.user.id).catch(() => {});
    return err('Failed to create account', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }

  // Mark invite consumed.
  await supabaseAdmin
    .from('account_invites')
    .update({ accepted_at: new Date().toISOString() })
    .eq('id', invite.id);

  return ok({ email: invite.email }, { requestId });
}
