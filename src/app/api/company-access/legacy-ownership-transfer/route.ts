/**
 * Legacy single-hotel ownership handoff inside My Hotel > Access.
 *
 *   GET    ?propertyId=…
 *     Return only the minimal legacy-account roster needed to choose a valid
 *     replacement or settle an idempotent response-loss replay. Normalized
 *     company accounts are rejected and never projected by this route.
 *
 *   PUT
 *     Body: { propertyId, accountId, action: 'transfer_ownership',
 *             newOwnerAccountId }
 *     The normalized company access editor owns company authority. This route
 *     keeps only the atomic legacy-hotel ownership transfer required while an
 *     independent hotel still uses the legacy-hotel authority mode.
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
import { loadAuthoritativeHotelRoster } from '@/lib/authorization/hotel-account-roster';
import { listAuthoritativePropertyAccess } from '@/lib/authorization/server';

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
    .select('id, role, active, lifecycle_intent_version')
    .eq('data_user_id', authUserId)
    .maybeSingle();
  if (error || !data || data.active !== true
      || typeof data.lifecycle_intent_version !== 'number') return null;
  const authority = await listAuthoritativePropertyAccess(data.id);
  if (!authority) return null;
  return {
    authUserId,
    authEmail,
    accountId: data.id,
    role: data.role as AppRole,
    propertyAccess: authority.all ? ['*'] : authority.propertyIds,
    active: data.active === true,
    lifecycleIntentVersion: data.lifecycle_intent_version,
  };
}

interface UserRow {
  accountId: string;
  username: string;
  displayName: string;
  role: AppRole;
  active: boolean;
  propertyAccess: string[];
  managementSurface: 'legacy_hotel';
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
  let roster;
  try {
    roster = await loadAuthoritativeHotelRoster(pidV.value!, caller.role === 'admin');
  } catch (rosterError) {
    log.error('[company-access:legacy-ownership-transfer:GET] authoritative roster failed', {
      requestId,
      err: rosterError instanceof Error ? rosterError.message : String(rosterError),
    });
    return err('Team access is temporarily unavailable', {
      requestId, status: 503, code: ApiErrorCode.UpstreamFailure,
      headers: { 'Retry-After': '5' },
    });
  }
  const callerRoster = roster.accounts.find((account) => account.accountId === caller.accountId);
  if (!callerRoster) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }
  if (callerRoster.managementSurface !== 'legacy_hotel') {
    return err('Manage normalized company ownership from My Hotel > Access.', {
      requestId,
      status: 409,
      code: ApiErrorCode.IdempotencyConflict,
      details: { href: '/company?tab=access' },
    });
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

  const users: UserRow[] = roster.accounts
    .filter((account) => account.managementSurface === 'legacy_hotel')
    .map((account) => ({
    accountId: account.accountId,
    username: account.username,
    displayName: account.displayName,
    role: account.role,
    active: account.active,
    propertyAccess: account.propertyIds,
    managementSurface: 'legacy_hotel',
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

  // Settle only an exact immutable response-loss receipt before consulting the
  // current hotel roster. A completed transfer can legitimately be followed by
  // normalization or a company-topology move, but an unused operation id must
  // reveal no target-account existence before the ordinary tenant fence.
  const { data: replayData, error: replayError } = await supabaseAdmin.rpc(
    'staxis_check_ownership_transfer_replay',
    {
      p_operation_id: operationId,
      p_actor_account_id: caller.accountId,
      p_actor_auth_user_id: caller.authUserId,
      p_property_id: propertyId,
      p_old_owner_account_id: caller.accountId,
      p_new_owner_account_id: newOwnerId,
    },
  );
  if (replayError) {
    log.error('[company-access:legacy-ownership-transfer:PUT] replay check failed', {
      requestId, err: replayError.message,
    });
    return err('Ownership transfer is temporarily unavailable. It is safe to try again.', {
      requestId,
      status: 503,
      code: ApiErrorCode.UpstreamFailure,
      headers: { 'Retry-After': '5' },
    });
  }
  const replay = replayData && typeof replayData === 'object' && !Array.isArray(replayData)
    ? replayData as { status?: string }
    : null;
  if (replay?.status === 'already_applied') {
    return ok({
      newOwnerId,
      oldOwnerId: caller.accountId,
      operationId,
      replayed: true,
    }, { requestId });
  }
  if (replay?.status === 'conflict') {
    return err('This ownership transfer changed in another session. Refresh and try again.', {
      requestId,
      status: 409,
      code: ApiErrorCode.IdempotencyConflict,
      details: { operationId },
    });
  }
  if (replay?.status !== 'not_applied') {
    return err('Ownership transfer request is no longer valid. Refresh and try again.', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  let roster;
  try {
    roster = await loadAuthoritativeHotelRoster(propertyId, caller.role === 'admin');
  } catch (rosterError) {
    log.error('[company-access:legacy-ownership-transfer:PUT] authoritative roster failed', {
      requestId,
      err: rosterError instanceof Error ? rosterError.message : String(rosterError),
    });
    return err('Ownership transfer is temporarily unavailable. It is safe to try again.', {
      requestId,
      status: 503,
      code: ApiErrorCode.UpstreamFailure,
      headers: { 'Retry-After': '5' },
    });
  }
  const callerRoster = roster.accounts.find((account) => account.accountId === caller.accountId);
  if (!callerRoster || callerRoster.managementSurface !== 'legacy_hotel') {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }
  const capabilityDecision = await capabilityDecisionForProperty(
    { role: caller.role },
    'manage_users',
    propertyId,
  );
  if (capabilityDecision === 'unavailable') return capabilityUnavailableResponse(requestId);
  if (capabilityDecision === 'denied') {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }
  const targetRoster = roster.accounts.find((account) => account.accountId === newOwnerId);
  if (callerRoster.role !== 'owner'
      || !targetRoster
      || targetRoster.managementSurface !== 'legacy_hotel'
      || targetRoster.active !== true
      || targetRoster.role === 'admin'
      || targetRoster.role === 'owner') {
    return err('Only the current owner can transfer ownership to an eligible account.', {
      requestId, status: 403, code: ApiErrorCode.Forbidden,
    });
  }

  // This direct read supplies identity/lifecycle fields only. The roster above
  // is the canonical access snapshot; the guarded RPC locks and rechecks both
  // accounts, exact hotel sets, authority mode, topology, capability, and
  // pending lifecycle state in the mutating transaction.
  const { data: newOwner, error: noErr } = await supabaseAdmin
    .from('accounts')
    .select('id, role, active, data_user_id, lifecycle_intent_version')
    .eq('id', newOwnerId)
    .maybeSingle();
  if (noErr || !newOwner) return err('Proposed new owner not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  if (typeof newOwner.data_user_id !== 'string'
      || typeof newOwner.lifecycle_intent_version !== 'number') {
    return err('Ownership transfer is temporarily unavailable. It is safe to try again.', {
      requestId,
      status: 503,
      code: ApiErrorCode.UpstreamFailure,
      headers: { 'Retry-After': '5' },
    });
  }
  if (!targetRoster.propertyIds.includes(propertyId)) {
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
        p_expected_new_property_access: targetRoster.propertyIds,
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
    log.error('[company-access:legacy-ownership-transfer:PUT] guarded transfer rpc failed', {
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
    const normalizedOwner = [
      'normalized_organization_owner',
      'normalized_authority',
      'company_authority',
      'company_owned_hotel',
    ].includes(parsed.reason ?? '');
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
