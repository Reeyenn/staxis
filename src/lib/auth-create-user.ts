// src/lib/auth-create-user.ts
//
// createOrReclaimAuthUser — the single choke point for "create a Supabase
// Auth login by email" across the three account-creation flows:
//   • /api/auth/use-join-code   (public /signup form)
//   • /api/auth/accept-invite   (emailed invite)
//   • /api/auth/accounts POST   (admin-created accounts)
//
// THE BUG IT FIXES (2026-06-15)
// ─────────────────────────────
// Deleting a hotel/onboarding (/api/admin/properties/delete) removes the
// `accounts` row but only *best-effort* deletes the Supabase Auth login. If
// that auth delete flakes, the login lingers as an ORPHAN — an auth.users
// row with no matching accounts row. The orphan-sweeper cron only reaps
// orphans older than 7 days, so for up to a week, recreating an account with
// the same email hard-fails: createUser returns "email already registered",
// which surfaced to the user as the vague "Failed to create account".
//
// This helper reclaims the orphan in-line. On a createUser failure it looks
// up the existing login by email and:
//   • no existing login  → returns the original error (weak password, bad
//     email, transient — nothing to reclaim).
//   • login HAS an accounts row → it's a REAL account. Returns
//     { alreadyHasAccount: true }. It NEVER deletes it. This is the one hard
//     rule of this module.
//   • login has NO accounts row → it's an orphan. Deletes it and retries
//     createUser once → { user, reclaimed: true }.
//
// email_confirm:true is set here for all callers (each flow runs its own
// email verification afterward via signInWithOtp / the invite link).

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import type { AuthUser } from '@supabase/supabase-js';

export interface CreateOrReclaimParams {
  /** Caller is responsible for normalizing (trim + lowercase). */
  email: string;
  password: string;
  /** Passed through to createUser as user_metadata. */
  userMetadata?: Record<string, unknown>;
}

export interface CreateOrReclaimResult {
  /** The created (or recreated) auth user. Present on success. */
  user?: AuthUser;
  /** True when success came from reclaiming an orphan (delete + recreate). */
  reclaimed?: boolean;
  /**
   * True when the email already belongs to a REAL account (has an accounts
   * row). The login is NEVER deleted in this case — the caller should return
   * a 409 "sign in instead".
   */
  alreadyHasAccount?: boolean;
  /**
   * The original createUser error, surfaced when we couldn't — or mustn't —
   * reclaim (no existing login, lookup failed, or delete flaked). The caller
   * maps this through its existing failure path.
   */
  error?: { message?: string; status?: number } | null;
}

// supabase-js has no admin "get user by email", so we page through listUsers
// (1000/page — same call accounts/route.ts GET uses) and match on the
// already-normalized email. Returns null on miss OR on a listUsers error:
// a lookup that can't confirm the orphan must never lead to a delete.
async function findAuthUserByEmail(email: string): Promise<AuthUser | null> {
  const target = email.trim().toLowerCase();
  // 50 pages * 1000 = 50k accounts ceiling — orders of magnitude above scale;
  // the inner break exits on the first short page in practice.
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) {
      log.error('[auth-create-user] listUsers failed during reclaim lookup', { err: error.message });
      return null;
    }
    const users = data?.users ?? [];
    const hit = users.find(u => (u.email ?? '').toLowerCase() === target);
    if (hit) return hit;
    if (users.length < 1000) break; // last page
  }
  return null;
}

export async function createOrReclaimAuthUser(
  params: CreateOrReclaimParams,
): Promise<CreateOrReclaimResult> {
  const { email, password, userMetadata } = params;

  // 1) Happy path: just create.
  const first = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: userMetadata,
  });
  if (first.data?.user && !first.error) {
    return { user: first.data.user, reclaimed: false };
  }

  // 2) createUser failed. Is there already a login for this email?
  const existing = await findAuthUserByEmail(email);
  if (!existing) {
    // No existing login → the failure is something else (weak password,
    // invalid email, transient). Surface the original error unchanged.
    return { error: first.error ?? { message: 'Failed to create account' } };
  }

  // 3) A login exists. Does it have an accounts row? If so it's REAL.
  const { data: acct, error: acctErr } = await supabaseAdmin
    .from('accounts')
    .select('id')
    .eq('data_user_id', existing.id)
    .maybeSingle();
  if (acctErr) {
    // Couldn't confirm orphan status. Fail safe: do NOT delete; surface the
    // original createUser error so the caller's normal failure path runs.
    log.error('[auth-create-user] accounts lookup failed — refusing to reclaim', {
      authUserId: existing.id, err: acctErr.message,
    });
    return { error: first.error ?? { message: 'Failed to create account' } };
  }
  if (acct) {
    // HARD RULE: never delete a login that has an account.
    return { alreadyHasAccount: true };
  }

  // 4) Orphan login (auth row, no accounts row). Reclaim: delete + recreate.
  const { error: delErr } = await supabaseAdmin.auth.admin.deleteUser(existing.id);
  if (delErr) {
    log.error('[auth-create-user] orphan deleteUser failed — leaving for the sweeper', {
      authUserId: existing.id, err: delErr.message,
    });
    return { error: first.error ?? { message: 'Failed to create account' } };
  }

  const retry = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: userMetadata,
  });
  if (retry.data?.user && !retry.error) {
    log.info('[auth-create-user] reclaimed orphan auth login', { authUserId: retry.data.user.id });
    return { user: retry.data.user, reclaimed: true };
  }
  return { error: retry.error ?? { message: 'Failed to create account' } };
}
