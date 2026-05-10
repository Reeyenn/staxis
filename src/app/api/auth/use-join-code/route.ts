// POST /api/auth/use-join-code
//
// Public endpoint. Body: { code, email, displayName, password, role, phone? }
//
// Looks up the code, verifies it's active (not revoked, not expired,
// used_count < max_uses), then creates the auth.users + accounts rows on
// the code's hotel with the role the staff member chose at signup.
//
// Role assignment:
//   - New-flow codes (role = null): the user picks their role at signup.
//     Restricted to staff roles — front_desk / housekeeping / maintenance —
//     so a shared code cannot be used to self-promote to owner or admin.
//   - Legacy codes (role set on the row): the baked-in role wins for
//     back-compat. We still accept role/phone in the payload but ignore
//     the legacy code's role.

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { writeAudit } from '@/lib/audit';
import type { AppRole } from '@/lib/roles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Roles a staff member can self-assign with a shared join code. Owner / GM
// are intentionally NOT in this list — those should come through an
// admin-issued invite where the inviter explicitly picks the elevated role.
const STAFF_SIGNUP_ROLES: ReadonlySet<AppRole> = new Set(['front_desk', 'housekeeping', 'maintenance']);

function isEmail(s: string) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }

function deriveUsername(email: string): string {
  const local = email.split('@')[0]?.toLowerCase().replace(/[^a-z0-9._+-]/g, '') ?? '';
  return local.slice(0, 40) || `user${Date.now().toString(36)}`;
}

// Minimal phone normalization — strip everything except digits, +, leading
// space. Accept anything that looks vaguely phone-like; we surface this to
// owners for outreach, not for SMS routing yet.
function normalizePhone(p: string | undefined | null): string | null {
  if (!p) return null;
  const trimmed = p.trim();
  if (!trimmed) return null;
  // Reject obvious junk but don't be strict — international formats vary.
  if (!/[\d]{7,}/.test(trimmed)) return null;
  return trimmed;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const body = await req.json() as {
    code?: string;
    email?: string;
    displayName?: string;
    password?: string;
    role?: string;
    phone?: string;
  };
  const { code, email, displayName, password, role: requestedRole, phone } = body;
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

  // Pick the role:
  //   - Legacy code with row.role set → use it (back-compat).
  //   - New-flow code (row.role null) → require role from the payload,
  //     restricted to STAFF_SIGNUP_ROLES so users can't grant themselves
  //     owner/admin via a shared code.
  let finalRole: AppRole;
  if (row.role) {
    finalRole = row.role as AppRole;
  } else {
    if (!requestedRole || !STAFF_SIGNUP_ROLES.has(requestedRole as AppRole)) {
      return err(
        'role required (front_desk, housekeeping, or maintenance)',
        { requestId, status: 400, code: ApiErrorCode.ValidationFailed },
      );
    }
    finalRole = requestedRole as AppRole;
  }

  const normalizedPhone = normalizePhone(phone);

  let username = deriveUsername(normalizedEmail);
  for (let i = 0; i < 5; i++) {
    const { data: ex } = await supabaseAdmin.from('accounts').select('id').eq('username', username).maybeSingle();
    if (!ex) break;
    username = (username + Math.floor(Math.random() * 10000)).slice(0, 40);
  }

  // email_confirm:true so signInWithOtp (called by /signup right after)
  // triggers Supabase's MAGIC-LINK template — the one we customized to
  // show a 6-digit {{ .Token }} prominently. With email_confirm:false
  // Supabase instead sends its "Confirm Your Signup" template, which is
  // a link-only email with no code — useless for the verify-then-trust
  // flow we route the user to.
  //
  // Account-level "verification" is still gated behind the OTP step:
  // /signup redirects to /signin/verify, the user can't reach the
  // dashboard without entering the code, and the device-trust check on
  // the regular /signin path also requires an OTP for untrusted browsers.
  // So email-ownership is still proven before the user gets in; the only
  // thing email_confirm:true changes is which Supabase template is sent.
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
    role: finalRole,
    property_access: [row.hotel_id],
    data_user_id: authData.user.id,
    phone: normalizedPhone,
  });
  if (insErr) {
    console.error('[use-join-code] accounts insert failed', insErr);
    await supabaseAdmin.auth.admin.deleteUser(authData.user.id).catch(() => {});
    return err('Failed to create account', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }

  await supabaseAdmin
    .from('hotel_join_codes')
    .update({ used_count: row.used_count + 1 })
    .eq('id', row.id);

  await writeAudit({
    action: 'join_code.use',
    actorUserId: authData.user.id,
    actorEmail: normalizedEmail,
    targetType: 'join_code',
    targetId: row.id,
    hotelId: row.hotel_id,
    metadata: { code: normalizedCode, role: finalRole, username, hasPhone: !!normalizedPhone },
  });

  return ok({ email: normalizedEmail }, { requestId });
}
