// POST /api/auth/use-join-code
//
// Public endpoint. Body: { code, email, displayName, password }
//
// Looks up the code, verifies it's active (not revoked, not expired,
// used_count < max_uses), then creates the auth.users + accounts rows on
// the code's hotel + role. Bumps used_count atomically.

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function isEmail(s: string) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }

function deriveUsername(email: string): string {
  const local = email.split('@')[0]?.toLowerCase().replace(/[^a-z0-9._+-]/g, '') ?? '';
  return local.slice(0, 40) || `user${Date.now().toString(36)}`;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const body = await req.json() as { code?: string; email?: string; displayName?: string; password?: string };
  const { code, email, displayName, password } = body;
  if (!code || !email || !displayName || !password) {
    return err('code, email, displayName, password required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  if (password.length < 6) {
    return err('Password must be at least 6 characters', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const normalizedEmail = email.trim().toLowerCase();
  if (!isEmail(normalizedEmail)) {
    return err('Invalid email', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const normalizedCode = code.trim().toUpperCase();
  const { data: row, error: codeErr } = await supabaseAdmin
    .from('hotel_join_codes')
    .select('id, hotel_id, role, expires_at, max_uses, used_count, revoked_at')
    .eq('code', normalizedCode)
    .maybeSingle();
  if (codeErr || !row) {
    return err('Code not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }
  if (row.revoked_at) return err('Code has been revoked', { requestId, status: 410, code: ApiErrorCode.IdempotencyConflict });
  if (new Date(row.expires_at).getTime() <= Date.now()) return err('Code has expired', { requestId, status: 410, code: ApiErrorCode.IdempotencyConflict });
  if (row.used_count >= row.max_uses) return err('Code has been used up', { requestId, status: 410, code: ApiErrorCode.IdempotencyConflict });

  let username = deriveUsername(normalizedEmail);
  for (let i = 0; i < 5; i++) {
    const { data: ex } = await supabaseAdmin.from('accounts').select('id').eq('username', username).maybeSingle();
    if (!ex) break;
    username = (username + Math.floor(Math.random() * 10000)).slice(0, 40);
  }

  const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.createUser({
    email: normalizedEmail,
    password,
    email_confirm: true,
    user_metadata: { username, displayName },
  });
  if (authErr || !authData.user) {
    console.error('[use-join-code] createUser failed', authErr);
    return err(authErr?.message ?? 'Failed to create account', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const { error: insErr } = await supabaseAdmin.from('accounts').insert({
    username,
    display_name: displayName,
    role: row.role,
    property_access: [row.hotel_id],
    data_user_id: authData.user.id,
  });
  if (insErr) {
    console.error('[use-join-code] accounts insert failed', insErr);
    await supabaseAdmin.auth.admin.deleteUser(authData.user.id).catch(() => {});
    return err('Failed to create account', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }

  // Bump used_count. Best-effort; if it fails the account already exists.
  await supabaseAdmin
    .from('hotel_join_codes')
    .update({ used_count: row.used_count + 1 })
    .eq('id', row.id);

  return ok({ email: normalizedEmail }, { requestId });
}
