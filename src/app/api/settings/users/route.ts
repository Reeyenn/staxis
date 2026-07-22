/**
 * Self-serve user management for hotel owners + GMs.
 *
 *   GET    ?propertyId=…
 *     List every account with access to the hotel, including their
 *     email, role, active flag, last_sign_in_at, and a friendly
 *     displayName. Visible to admin/owner/GM. Hides Staxis admins
 *     from non-admin viewers.
 *
 *   PUT
 *     Body: { propertyId, accountId, action: 'transfer_ownership',
 *             newOwnerAccountId }
 *     Role and lifecycle changes moved to My Hotel. This legacy endpoint keeps
 *     only the atomic ownership-transfer operation for the existing Settings UI.
 *
 * Ownership transfer writes a row to role_changes (the structured audit) AND
 * a parallel admin_audit_log entry (the generic audit). The structured
 * table makes a future "show me the history of this user's role" UI
 * cheap; the generic table keeps the security-review trail intact.
 *
 * Role guardrails:
 *   - Only an owner can run transfer_ownership.
 *   - Nobody can modify an admin account from this UI.
 *   - Transfer-ownership requires the caller to actually be an owner and
 *     for the target to be an active member of this hotel.
 *
 * Auth: requireSession (the manager/owner) — NOT requireCronSecret.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireSession } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';
import type { AppRole } from '@/lib/roles';
import { capabilityDecisionForProperty } from '@/lib/capabilities/server';
import { capabilityUnavailableResponse } from '@/lib/capabilities/api-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CallerContext {
  authUserId: string;
  authEmail: string | null;
  accountId: string;
  role: AppRole;
  propertyAccess: string[];
  active: boolean;
  lifecycleIntentVersion: number;
}

async function loadCaller(authUserId: string, authEmail: string | null): Promise<CallerContext | null> {
  const { data, error } = await supabaseAdmin
    .from('accounts')
    .select('id, role, property_access, active, lifecycle_intent_version')
    .eq('data_user_id', authUserId)
    .maybeSingle();
  if (error || !data || data.active !== true
      || typeof data.lifecycle_intent_version !== 'number') return null;
  return {
    authUserId,
    authEmail,
    accountId: data.id,
    role: data.role as AppRole,
    propertyAccess: Array.isArray(data.property_access) ? data.property_access : [],
    active: data.active === true,
    lifecycleIntentVersion: data.lifecycle_intent_version,
  };
}

function callerCanManageProperty(caller: CallerContext, propertyId: string): boolean {
  if (caller.role === 'admin') return true;
  if (caller.propertyAccess.includes('*')) return true;
  return caller.propertyAccess.includes(propertyId);
}

interface UserRow {
  accountId: string;
  username: string;
  displayName: string;
  email: string;
  role: AppRole;
  active: boolean;
  lastSignInAt: string | null;
  propertyAccess: string[];
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return session.response;

  const caller = await loadCaller(session.userId, session.email);
  if (!caller) return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  // The management gate is a per-hotel manage_users capability check below.

  const url = new URL(req.url);
  const pidV = validateUuid(url.searchParams.get('propertyId'), 'propertyId');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  if (!callerCanManageProperty(caller, pidV.value!)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }
  const capabilityDecision = await capabilityDecisionForProperty(
    { role: caller.role },
    'manage_users',
    pidV.value!,
  );
  if (capabilityDecision === 'unavailable') return capabilityUnavailableResponse(requestId);
  if (capabilityDecision === 'denied') {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  const { data: accountRows, error: qErr } = await supabaseAdmin
    .from('accounts')
    .select('id, username, display_name, role, active, data_user_id, property_access, created_at')
    .order('created_at', { ascending: true });
  if (qErr) {
    log.error('[settings/users:GET] accounts query failed', { requestId, err: qErr.message });
    return err('Failed to load users', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }

  // Filter to accounts with access to this hotel. Hide admins from
  // non-admin viewers (Staxis platform team is not part of the hotel
  // org chart).
  const rows = (accountRows ?? []).filter((r: { role: string; property_access: string[] | null }) => {
    if (r.role === 'admin') return caller.role === 'admin';
    return Array.isArray(r.property_access) && r.property_access.includes(pidV.value!);
  });

  const emailByUserId = new Map<string, string>();
  // Supabase Auth tracks last_sign_in_at natively on auth.users — that is
  // the single source of truth. There is intentionally NO last_sign_in_at
  // column on `accounts` (see migration 0220) — do not SELECT it here, or
  // the whole accounts query 500s.
  const lastSignInByUserId = new Map<string, string | null>();
  const { data: authPage } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
  for (const u of authPage?.users ?? []) {
    if (u.id) {
      if (u.email) emailByUserId.set(u.id, u.email);
      lastSignInByUserId.set(u.id, u.last_sign_in_at ?? null);
    }
  }

  const users: UserRow[] = rows.map((r: {
    id: string; username: string; display_name: string; role: string; active: boolean;
    data_user_id: string; property_access: string[] | null;
  }) => ({
    accountId: r.id,
    username: r.username,
    displayName: r.display_name,
    email: emailByUserId.get(r.data_user_id) ?? '',
    role: r.role as AppRole,
    active: r.active !== false,
    lastSignInAt: lastSignInByUserId.get(r.data_user_id) ?? null,
    propertyAccess: Array.isArray(r.property_access) ? r.property_access : [],
  }));

  return ok({ users }, { requestId });
}

interface ActionBody {
  propertyId?: unknown;
  accountId?: unknown;
  action?: unknown;
  newOwnerAccountId?: unknown;
  operationId?: unknown;
  reason?: unknown;
}

const MOVED_TO_MY_HOTEL_ACTIONS = new Set(['change_role', 'deactivate', 'reactivate']);

function isPendingLifecycleFenceError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as { code?: unknown; message?: unknown };
  return record.code === '55000'
    || (typeof record.message === 'string'
      && record.message.toLowerCase().includes('account lifecycle change pending'));
}

export async function PUT(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return session.response;

  const body = await req.json().catch(() => null) as ActionBody | null;
  if (!body) return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const caller = await loadCaller(session.userId, session.email);
  if (!caller) return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  // The management gate is a per-hotel manage_users capability check below.

  const pidV = validateUuid(body.propertyId, 'propertyId');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const accountIdV = validateUuid(body.accountId, 'accountId');
  if (accountIdV.error) return err(accountIdV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const action = typeof body.action === 'string' ? body.action : '';
  const propertyId = pidV.value!;
  const accountId = accountIdV.value!;

  if (MOVED_TO_MY_HOTEL_ACTIONS.has(action)) {
    return err('Manage roles and account status from My Hotel.', {
      requestId,
      status: 409,
      code: ApiErrorCode.IdempotencyConflict,
    });
  }
  if (action !== 'transfer_ownership') {
    return err('Unknown action', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const operationIdV = validateUuid(body.operationId, 'operationId');
  if (operationIdV.error) {
    return err(operationIdV.error, {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }
  const operationId = operationIdV.value!;
  const newOwnerV = validateUuid(body.newOwnerAccountId, 'newOwnerAccountId');
  if (newOwnerV.error) return err(newOwnerV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const newOwnerId = newOwnerV.value!;
  if (newOwnerId !== accountId) {
    return err('accountId must identify the proposed new owner', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }
  if (newOwnerId === caller.accountId) {
    return err('You are already the owner', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const reason = typeof body.reason === 'string' && body.reason.trim()
    ? body.reason.trim().slice(0, 500)
    : null;

  // This is only an optimistic snapshot. The guarded RPC locks and rechecks
  // both accounts, caller Auth identity, capabilities, hotel sets, and pending
  // lifecycle state in the transaction that changes both global roles.
  const { data: newOwner, error: noErr } = await supabaseAdmin
    .from('accounts')
    .select('id, role, active, data_user_id, property_access, lifecycle_intent_version')
    .eq('id', newOwnerId)
    .maybeSingle();
  if (noErr || !newOwner) return err('Proposed new owner not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  if (typeof newOwner.data_user_id !== 'string'
      || typeof newOwner.lifecycle_intent_version !== 'number'
      || !Array.isArray(newOwner.property_access)) {
    return err('Ownership transfer is temporarily unavailable. It is safe to try again.', {
      requestId,
      status: 503,
      code: ApiErrorCode.UpstreamFailure,
      headers: { 'Retry-After': '5' },
    });
  }
  if (!newOwner.property_access.includes(propertyId)) {
    return err('Proposed new owner does not have access to this hotel', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  let rpcRes: unknown = null;
  let rpcErr: { message?: string; code?: string } | null = null;
  try {
    const result = await supabaseAdmin.rpc(
      'staxis_transfer_ownership_guarded',
      {
        p_operation_id: operationId,
        p_actor_account_id: caller.accountId,
        p_actor_auth_user_id: caller.authUserId,
        p_actor_email: caller.authEmail,
        p_property_id: propertyId,
        p_old_owner_account_id: caller.accountId,
        p_new_owner_account_id: newOwnerId,
        p_expected_old_active: caller.active,
        p_expected_old_role: caller.role,
        p_expected_old_auth_user_id: caller.authUserId,
        p_expected_old_property_access: caller.propertyAccess,
        p_expected_old_intent_version: caller.lifecycleIntentVersion,
        p_expected_new_active: newOwner.active !== false,
        p_expected_new_role: newOwner.role,
        p_expected_new_auth_user_id: newOwner.data_user_id,
        p_expected_new_property_access: newOwner.property_access,
        p_expected_new_intent_version: newOwner.lifecycle_intent_version,
        p_reason: reason,
        p_request_id: requestId,
      },
    );
    rpcRes = result.data;
    rpcErr = result.error;
  } catch (error) {
    rpcErr = error && typeof error === 'object'
      ? error as { message?: string; code?: string }
      : { message: String(error) };
  }
  if (rpcErr) {
    log.error('[settings/users:PUT] guarded transfer rpc failed', {
      requestId, err: rpcErr.message ?? 'unknown error',
    });
    if (isPendingLifecycleFenceError(rpcErr)) {
      return err('Finish the pending account status change before transferring ownership.', {
        requestId,
        status: 409,
        code: ApiErrorCode.IdempotencyConflict,
      });
    }
    // Missing RPC/schema cache during rolling deploy must fail closed. The
    // legacy three-argument RPC remains only for older already-running code;
    // this route never falls back to its non-atomic audit behavior.
    return err('Ownership transfer is temporarily unavailable. It is safe to try again.', {
      requestId,
      status: 503,
      code: ApiErrorCode.UpstreamFailure,
      headers: { 'Retry-After': '5' },
    });
  }

  const parsed = rpcRes && typeof rpcRes === 'object' && !Array.isArray(rpcRes)
    ? rpcRes as { status?: string; reason?: string }
    : null;
  if (parsed?.status === 'ok' || parsed?.status === 'already_applied') {
    return ok({
      newOwnerId,
      oldOwnerId: caller.accountId,
      operationId,
      replayed: parsed.status === 'already_applied',
    }, { requestId });
  }
  if (parsed?.status === 'pending_conflict') {
    return err('Finish the pending account status change before transferring ownership.', {
      requestId, status: 409, code: ApiErrorCode.IdempotencyConflict,
    });
  }
  if (parsed?.status === 'retry') {
    return err('Ownership transfer is temporarily unavailable. It is safe to try again.', {
      requestId,
      status: 503,
      code: ApiErrorCode.UpstreamFailure,
      headers: { 'Retry-After': '5' },
    });
  }
  if (parsed?.status === 'conflict') {
    const message = parsed.reason === 'hotel_access_mismatch'
      ? 'Ownership can only be transferred between accounts with the same hotel access.'
      : 'This ownership transfer changed in another session. Refresh and try again.';
    return err(message, {
      requestId, status: 409, code: ApiErrorCode.IdempotencyConflict,
      details: { operationId },
    });
  }
  if (parsed?.status === 'forbidden') {
    const normalizedOwner = parsed.reason === 'normalized_organization_owner';
    return err(
      normalizedOwner
        ? 'Manage company ownership separately before changing this hotel owner.'
        : 'Only the current owner can transfer ownership to an eligible account.',
      {
        requestId,
        status: normalizedOwner ? 409 : 403,
        code: normalizedOwner ? ApiErrorCode.IdempotencyConflict : ApiErrorCode.Forbidden,
      },
    );
  }
  if (parsed?.status === 'not_found') {
    return err('An account or hotel in this transfer no longer exists.', {
      requestId, status: 404, code: ApiErrorCode.NotFound,
    });
  }
  if (parsed?.status === 'invalid') {
    return err('Ownership transfer request is no longer valid. Refresh and try again.', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }
  return err('Ownership transfer is temporarily unavailable. It is safe to try again.', {
    requestId,
    status: 503,
    code: ApiErrorCode.UpstreamFailure,
    headers: { 'Retry-After': '5' },
  });
}
