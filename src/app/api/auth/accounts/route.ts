import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';

// ─── Admin CRUD on the accounts table ──────────────────────────────────────
// Guarded by the `x-account-id` header → accounts.role === 'admin' check.
// Service-role client bypasses RLS, so we do the authorization ourselves.
//
// New account creation flow:
//   1. Create an auth.users row: supabaseAdmin.auth.admin.createUser({
//        email: `${username}@staxis.local`, password, email_confirm: true })
//   2. Insert into public.accounts linking data_user_id → new auth user id
//
// Deletion cascades: the accounts row has `on delete cascade` via
// `data_user_id REFERENCES auth.users(id)`, so deleting the auth user
// removes both sides atomically.
// ───────────────────────────────────────────────────────────────────────────

type AccountRole = 'admin' | 'owner' | 'staff';

function syntheticEmail(username: string): string {
  return `${username.toLowerCase().trim()}@staxis.local`;
}

/**
 * Admin check.
 *
 * The caller must present BOTH:
 *   - `x-account-id`: the accounts.id of the row claiming admin
 *   - `Authorization: Bearer <jwt>`: a valid Supabase access token whose
 *     user.id matches accounts.data_user_id for that row
 *
 * Either alone is insufficient. Previously we accepted x-account-id alone
 * as a "legacy fallback" — that was a real privilege-escalation hole:
 * anyone who knew or could guess an admin's UUID could send the header
 * with no Authorization and impersonate the admin (full create/delete/
 * password-reset access). The bearer-token requirement is now mandatory.
 *
 * Returns the admin's accounts row on success, null on failure.
 */
async function verifyAdmin(req: NextRequest) {
  const accountId = req.headers.get('x-account-id');
  if (!accountId) return null;

  // Bearer token is REQUIRED — no fallback. Closes the spoofing backdoor.
  const authHeader = req.headers.get('authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;

  // Look up the account row (service role bypasses RLS).
  const { data: account, error: acctErr } = await supabaseAdmin
    .from('accounts')
    .select('id, role, data_user_id')
    .eq('id', accountId)
    .maybeSingle();

  if (acctErr || !account || account.role !== 'admin') return null;

  // Verify the JWT really belongs to the auth user this account row points
  // to. supabaseAdmin.auth.getUser(token) hits the auth server with the
  // service role to validate the token signature & expiry.
  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || userData.user?.id !== account.data_user_id) {
    return null;
  }

  return account;
}

// Translate an accounts row to the public-facing shape consumed by
// settings/accounts/page.tsx. Admin rows report propertyAccess = ['*'] for
// consistency with the AuthContext's translation.
function serializeAccount(row: {
  id: string;
  username: string;
  display_name: string;
  role: string;
  property_access: string[];
  created_at: string | null;
}) {
  return {
    accountId: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role as AccountRole,
    propertyAccess: row.role === 'admin' ? ['*'] : (row.property_access ?? []),
    createdAt: row.created_at,
  };
}

// GET /api/auth/accounts - list all accounts (admin only)
export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyAdmin(req);
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  const { data, error } = await supabaseAdmin
    .from('accounts')
    .select('id, username, display_name, role, property_access, created_at')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[accounts:GET] query failed', error);
    return err('Failed to load accounts', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }

  return ok({ accounts: (data ?? []).map(serializeAccount) }, { requestId });
}

// POST /api/auth/accounts - create account (admin only)
export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyAdmin(req);
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  const body = await req.json();
  const { username, password, displayName, role, propertyAccess } = body as {
    username: string;
    password: string;
    displayName?: string;
    role: AccountRole;
    propertyAccess?: string[];
  };

  if (!username || !password || !role) {
    return err('username, password, and role are required', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }
  if (!['admin', 'owner', 'staff'].includes(role)) {
    return err('role must be one of admin, owner, staff', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }
  // Enforce a username shape compatible with the synthetic-email scheme.
  // Allowed: lowercase a–z, 0–9, dot, underscore, plus, hyphen.
  const normalizedUsername = username.toLowerCase().trim();
  if (!/^[a-z0-9._+-]{2,40}$/.test(normalizedUsername)) {
    return err('Username must be 2–40 chars: lowercase letters, digits, . _ + -', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  // Duplicate check (application-level — also enforced by DB unique index).
  const { data: existing, error: exErr } = await supabaseAdmin
    .from('accounts')
    .select('id')
    .eq('username', normalizedUsername)
    .maybeSingle();
  if (exErr) {
    console.error('[accounts:POST] duplicate check failed', exErr);
    return err('Failed to create account', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  if (existing) {
    return err('Username already exists', { requestId, status: 409, code: ApiErrorCode.IdempotencyConflict });
  }

  // Step 1: create the auth.users row. email_confirm: true skips the
  // email-verification step since these aren't real deliverable emails.
  const email = syntheticEmail(normalizedUsername);
  const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { username: normalizedUsername, displayName: displayName || normalizedUsername },
  });

  if (authErr || !authData.user) {
    console.error('[accounts:POST] auth.admin.createUser failed', authErr);
    // 422 is what Supabase returns for weak-password/invalid-email; surface
    // the message so the settings UI can display it.
    return err(authErr?.message ?? 'Failed to create auth user', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  // Admin accounts don't get explicit property_access — RLS grants them
  // access to everything via the accounts.role = 'admin' branch in
  // user_owns_property().
  const effectivePropertyAccess = role === 'admin' ? [] : (propertyAccess ?? []).filter(id => id !== '*');

  const { data: inserted, error: insErr } = await supabaseAdmin
    .from('accounts')
    .insert({
      username: normalizedUsername,
      display_name: displayName || normalizedUsername,
      role,
      property_access: effectivePropertyAccess,
      data_user_id: authData.user.id,
    })
    .select('id')
    .single();

  if (insErr || !inserted) {
    console.error('[accounts:POST] accounts insert failed, rolling back auth user', errToString(insErr));
    // Roll back the auth user so we don't leak orphaned auth rows.
    // Don't silently swallow the rollback failure — if the rollback ALSO
    // fails we end up with a permanent zombie auth.users row that future
    // account-creation will trip over with "email already exists" with
    // no record showing where it came from. Surface the rollback failure
    // alongside the original insert failure so the caller sees both and
    // can ask Reeyen to clean up by email in the Supabase dashboard.
    let rollbackError: string | null = null;
    try {
      const { error: delErr } = await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
      if (delErr) rollbackError = errToString(delErr);
    } catch (rollErr) {
      rollbackError = errToString(rollErr);
    }
    if (rollbackError) {
      console.error(`[accounts:POST] AUTH ROLLBACK FAILED — orphaned auth.users row id=${authData.user.id} email=${normalizedUsername}@staxis.local. Insert error: ${errToString(insErr)}. Rollback error: ${rollbackError}`);
      return err(
        `Failed to create account record. ALSO: rollback of the auth user failed — orphaned auth row remains for username "${normalizedUsername}". Have an admin delete the row manually in Supabase Authentication.`,
        { requestId, status: 500, code: ApiErrorCode.InternalError },
      );
    }
    return err('Failed to create account record', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }

  return ok({ accountId: inserted.id }, { requestId });
}

// PUT /api/auth/accounts - update account (admin only)
export async function PUT(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyAdmin(req);
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  const body = await req.json();
  const { accountId, displayName, role, propertyAccess, password } = body as {
    accountId: string;
    displayName?: string;
    role?: AccountRole;
    propertyAccess?: string[];
    password?: string;
  };

  if (!accountId) {
    return err('accountId required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  if (role !== undefined && !['admin', 'owner', 'staff'].includes(role)) {
    return err('role must be one of admin, owner, staff', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  // Fetch the target account so we know its data_user_id for the password
  // update path.
  const { data: target, error: fetchErr } = await supabaseAdmin
    .from('accounts')
    .select('id, data_user_id, role')
    .eq('id', accountId)
    .maybeSingle();

  if (fetchErr || !target) {
    return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }

  // Build the accounts-table update.
  const updates: Record<string, unknown> = {};
  if (displayName !== undefined) updates.display_name = displayName;
  if (role !== undefined) updates.role = role;
  if (propertyAccess !== undefined) {
    const effectiveRole = (role ?? target.role) as AccountRole;
    updates.property_access =
      effectiveRole === 'admin' ? [] : propertyAccess.filter(id => id !== '*');
  }

  if (Object.keys(updates).length > 0) {
    const { error: updErr } = await supabaseAdmin
      .from('accounts')
      .update(updates)
      .eq('id', accountId);
    if (updErr) {
      console.error('[accounts:PUT] accounts update failed', updErr);
      return err('Failed to update account', { requestId, status: 500, code: ApiErrorCode.InternalError });
    }
  }

  // Password rotation goes through Supabase Auth's admin API.
  if (password) {
    const { error: pwErr } = await supabaseAdmin.auth.admin.updateUserById(
      target.data_user_id,
      { password },
    );
    if (pwErr) {
      console.error('[accounts:PUT] password update failed', pwErr);
      return err(pwErr.message ?? 'Failed to update password', {
        requestId, status: 400, code: ApiErrorCode.ValidationFailed,
      });
    }
  }

  if (Object.keys(updates).length === 0 && !password) {
    return err('Nothing to update', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  return ok({ success: true }, { requestId });
}

// DELETE /api/auth/accounts?accountId=xxx - delete account (admin only)
export async function DELETE(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyAdmin(req);
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  const { searchParams } = new URL(req.url);
  const accountId = searchParams.get('accountId');
  if (!accountId) {
    return err('accountId required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  // Prevent deleting own account (same guard as the Firebase version).
  if (accountId === caller.id) {
    return err('Cannot delete your own account', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  const { data: target, error: fetchErr } = await supabaseAdmin
    .from('accounts')
    .select('data_user_id')
    .eq('id', accountId)
    .maybeSingle();

  if (fetchErr || !target) {
    return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }

  // Delete the auth user — the FK cascade removes the accounts row too.
  const { error: delErr } = await supabaseAdmin.auth.admin.deleteUser(target.data_user_id);
  if (delErr) {
    console.error('[accounts:DELETE] auth.admin.deleteUser failed', errToString(delErr));
    // If auth user was already gone, at least clean up the accounts row so
    // the admin isn't stuck with a zombie. PostgrestFilterBuilder is a
    // thenable but has no .catch — wrap in try/await.
    try {
      await supabaseAdmin.from('accounts').delete().eq('id', accountId);
    } catch { /* best effort — primary goal was deleting the auth user */ }
    return err('Failed to delete account', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }

  return ok({ success: true }, { requestId });
}
