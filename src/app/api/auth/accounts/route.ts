import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';

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

const MIN_PASSWORD_LEN = 8;

function syntheticEmail(username: string): string {
  return `${username.toLowerCase().trim()}@staxis.local`;
}

// Admin check: requires both `x-account-id` header AND a verified Supabase
// Auth bearer token whose user id matches that account's data_user_id.
// Returns the admin's accounts row on success, null on failure.
//
// The bearer token is mandatory — the previous "legacy fallback" that
// accepted the header alone meant anyone who knew an admin's accountId UUID
// could become that admin. Bearer-only also kills CSRF (Authorization
// headers aren't auto-attached cross-origin).
async function verifyAdmin(req: NextRequest) {
  const accountId = req.headers.get('x-account-id');
  if (!accountId) return null;

  const authHeader = req.headers.get('authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;

  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData.user) return null;

  const { data: account, error: acctErr } = await supabaseAdmin
    .from('accounts')
    .select('id, role, data_user_id')
    .eq('id', accountId)
    .maybeSingle();

  if (acctErr || !account || account.role !== 'admin') return null;
  if (userData.user.id !== account.data_user_id) return null;

  return account;
}

// Returns true when the named account is the only remaining admin — used to
// block self-demotion / last-admin deletion that would lock everyone out.
async function isLastAdmin(accountId: string): Promise<boolean> {
  const { count, error } = await supabaseAdmin
    .from('accounts')
    .select('id', { head: true, count: 'exact' })
    .eq('role', 'admin');
  if (error || count === null) return false;
  if (count > 1) return false;
  // Exactly one admin left — confirm it's this one.
  const { data: row } = await supabaseAdmin
    .from('accounts')
    .select('id')
    .eq('id', accountId)
    .eq('role', 'admin')
    .maybeSingle();
  return !!row;
}

async function safeJson(req: NextRequest): Promise<Record<string, unknown> | null> {
  try { return await req.json(); } catch { return null; }
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
  const caller = await verifyAdmin(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  const { data, error } = await supabaseAdmin
    .from('accounts')
    .select('id, username, display_name, role, property_access, created_at')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[accounts:GET] query failed', error);
    return NextResponse.json({ error: 'Failed to load accounts' }, { status: 500 });
  }

  return NextResponse.json({ accounts: (data ?? []).map(serializeAccount) });
}

// POST /api/auth/accounts - create account (admin only)
export async function POST(req: NextRequest) {
  const caller = await verifyAdmin(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  const body = await safeJson(req);
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });

  const { username, password, displayName, role, propertyAccess } = body as {
    username: string;
    password: string;
    displayName?: string;
    role: AccountRole;
    propertyAccess?: string[];
  };

  if (!username || !password || !role) {
    return NextResponse.json(
      { error: 'username, password, and role are required' },
      { status: 400 },
    );
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LEN) {
    return NextResponse.json(
      { error: `Password must be at least ${MIN_PASSWORD_LEN} characters` },
      { status: 400 },
    );
  }
  if (!['admin', 'owner', 'staff'].includes(role)) {
    return NextResponse.json(
      { error: 'role must be one of admin, owner, staff' },
      { status: 400 },
    );
  }
  // Enforce a username shape compatible with the synthetic-email scheme.
  // Allowed: lowercase a–z, 0–9, dot, underscore, plus, hyphen.
  const normalizedUsername = username.toLowerCase().trim();
  if (!/^[a-z0-9._+-]{2,40}$/.test(normalizedUsername)) {
    return NextResponse.json(
      { error: 'Username must be 2–40 chars: lowercase letters, digits, . _ + -' },
      { status: 400 },
    );
  }

  // Duplicate check (application-level — also enforced by DB unique index).
  const { data: existing, error: exErr } = await supabaseAdmin
    .from('accounts')
    .select('id')
    .eq('username', normalizedUsername)
    .maybeSingle();
  if (exErr) {
    console.error('[accounts:POST] duplicate check failed', exErr);
    return NextResponse.json({ error: 'Failed to create account' }, { status: 500 });
  }
  if (existing) {
    return NextResponse.json({ error: 'Username already exists' }, { status: 409 });
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
    return NextResponse.json(
      { error: authErr?.message ?? 'Failed to create auth user' },
      { status: 400 },
    );
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
    await supabaseAdmin.auth.admin.deleteUser(authData.user.id).catch(() => {});
    return NextResponse.json({ error: 'Failed to create account record' }, { status: 500 });
  }

  return NextResponse.json({ accountId: inserted.id });
}

// PUT /api/auth/accounts - update account (admin only)
export async function PUT(req: NextRequest) {
  const caller = await verifyAdmin(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  const body = await safeJson(req);
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });

  const { accountId, displayName, role, propertyAccess, password } = body as {
    accountId: string;
    displayName?: string;
    role?: AccountRole;
    propertyAccess?: string[];
    password?: string;
  };

  if (!accountId) {
    return NextResponse.json({ error: 'accountId required' }, { status: 400 });
  }
  if (role !== undefined && !['admin', 'owner', 'staff'].includes(role)) {
    return NextResponse.json(
      { error: 'role must be one of admin, owner, staff' },
      { status: 400 },
    );
  }
  if (password !== undefined) {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LEN) {
      return NextResponse.json(
        { error: `Password must be at least ${MIN_PASSWORD_LEN} characters` },
        { status: 400 },
      );
    }
  }

  // Fetch the target account so we know its data_user_id for the password
  // update path.
  const { data: target, error: fetchErr } = await supabaseAdmin
    .from('accounts')
    .select('id, data_user_id, role')
    .eq('id', accountId)
    .maybeSingle();

  if (fetchErr || !target) {
    return NextResponse.json({ error: 'Account not found' }, { status: 404 });
  }

  // Block demoting the last remaining admin — would lock everyone out of
  // /api/auth/accounts with no in-app recovery path.
  if (role !== undefined && role !== 'admin' && target.role === 'admin') {
    if (await isLastAdmin(accountId)) {
      return NextResponse.json(
        { error: 'Cannot demote the last admin' },
        { status: 400 },
      );
    }
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
      return NextResponse.json({ error: 'Failed to update account' }, { status: 500 });
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
      return NextResponse.json(
        { error: pwErr.message ?? 'Failed to update password' },
        { status: 400 },
      );
    }
  }

  if (Object.keys(updates).length === 0 && !password) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
  }

  return NextResponse.json({ success: true });
}

// DELETE /api/auth/accounts?accountId=xxx - delete account (admin only)
export async function DELETE(req: NextRequest) {
  const caller = await verifyAdmin(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  const { searchParams } = new URL(req.url);
  const accountId = searchParams.get('accountId');
  if (!accountId) {
    return NextResponse.json({ error: 'accountId required' }, { status: 400 });
  }

  // Prevent deleting own account (same guard as the Firebase version).
  if (accountId === caller.id) {
    return NextResponse.json({ error: 'Cannot delete your own account' }, { status: 400 });
  }

  const { data: target, error: fetchErr } = await supabaseAdmin
    .from('accounts')
    .select('data_user_id, role')
    .eq('id', accountId)
    .maybeSingle();

  if (fetchErr || !target) {
    return NextResponse.json({ error: 'Account not found' }, { status: 404 });
  }

  // Block deleting the last remaining admin.
  if (target.role === 'admin' && await isLastAdmin(accountId)) {
    return NextResponse.json(
      { error: 'Cannot delete the last admin' },
      { status: 400 },
    );
  }

  // Delete the auth user — the FK cascade removes the accounts row too.
  const { error: delErr } = await supabaseAdmin.auth.admin.deleteUser(target.data_user_id);
  if (delErr) {
    console.error('[accounts:DELETE] auth.admin.deleteUser failed', errToString(delErr));
    // If auth user was already gone, at least clean up the accounts row so
    // the admin isn't stuck with a zombie. Track whether the cleanup
    // succeeded so we surface a clearer error if it didn't.
    let cleanupErr: unknown = null;
    try {
      const { error } = await supabaseAdmin.from('accounts').delete().eq('id', accountId);
      cleanupErr = error;
    } catch (e) { cleanupErr = e; }
    if (cleanupErr) {
      console.error('[accounts:DELETE] cleanup of accounts row also failed', errToString(cleanupErr));
      return NextResponse.json(
        { error: 'Failed to delete account; manual cleanup may be required' },
        { status: 500 },
      );
    }
    return NextResponse.json({ error: 'Failed to delete auth user; accounts row removed' }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
