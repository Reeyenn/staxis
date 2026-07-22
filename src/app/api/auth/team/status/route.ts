// Global account lifecycle controls for My Hotel -> People. Registration is
// inert and database-authorized; accounts.active changes only after Supabase
// Auth has been read back and verified by the shared lifecycle processor.

import { NextRequest } from 'next/server';

import {
  processAccountLifecycleIntent,
  type AccountLifecycleProcessResult,
} from '@/lib/account-lifecycle';
import { err, ok, ApiErrorCode } from '@/lib/api-response';
import { validateUuid } from '@/lib/api-validate';
import { getOrMintRequestId, log } from '@/lib/log';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { verifyTeamManager } from '@/lib/team-auth';
import { errToString } from '@/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type LifecycleAction = 'deactivate' | 'reactivate';

function isLifecycleAction(value: unknown): value is LifecycleAction {
  return value === 'deactivate' || value === 'reactivate';
}

function rpcObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

function lifecycleUnavailable(
  requestId: string,
  operationId: string,
  pending: boolean,
) {
  const message = pending
    ? 'Account status could not be verified yet. It will retry automatically.'
    : 'Account status is temporarily unavailable. It is safe to try again.';
  return err(message, {
    requestId,
    status: 503,
    code: ApiErrorCode.UpstreamFailure,
    headers: { 'Retry-After': '5' },
    details: { operationId, pending },
  });
}

function processResponse(
  result: AccountLifecycleProcessResult,
  requestId: string,
  requestedAccountId: string,
) {
  if (result.kind === 'committed') {
    return ok({
      operationId: result.operationId,
      accountId: result.accountId || requestedAccountId,
      active: result.active,
      noop: result.noop,
    }, { requestId });
  }
  if (result.kind === 'pending') {
    return lifecycleUnavailable(requestId, result.operationId, true);
  }
  if (result.kind === 'aborted') {
    return err('The account status change was not applied. Try again.', {
      requestId,
      status: 409,
      code: ApiErrorCode.IdempotencyConflict,
      details: { operationId: result.operationId, pending: false },
    });
  }
  if (result.kind === 'conflict') {
    return err('The account changed in another session. Refresh and try again.', {
      requestId,
      status: 409,
      code: ApiErrorCode.IdempotencyConflict,
      details: { operationId: result.operationId, pending: false },
    });
  }
  return lifecycleUnavailable(requestId, result.operationId, true);
}

export async function PUT(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req, { capability: 'manage_users' });
  if (!caller) {
    return err('Unauthorized', {
      requestId,
      status: 403,
      code: ApiErrorCode.Unauthorized,
    });
  }

  const body = await req.json().catch(() => null) as {
    hotelId?: unknown;
    accountId?: unknown;
    action?: unknown;
    operationId?: unknown;
  } | null;
  if (!body) {
    return err('Invalid JSON body', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  const hotelId = validateUuid(body.hotelId, 'hotelId');
  const accountId = validateUuid(body.accountId, 'accountId');
  const operationId = validateUuid(body.operationId, 'operationId');
  const validationError = hotelId.error ?? accountId.error ?? operationId.error;
  if (validationError) {
    return err(validationError, {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }
  if (!isLifecycleAction(body.action)) {
    return err('action must be deactivate or reactivate', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  const targetAccountId = accountId.value!;
  const lifecycleOperationId = operationId.value!;
  const desiredActive = body.action === 'reactivate';

  // This read supplies only an optimistic snapshot. Authorization and the
  // exact snapshot comparison are both repeated atomically inside the RPC.
  const { data: target, error: targetError } = await supabaseAdmin
    .from('accounts')
    .select(
      'id, role, active, data_user_id, property_access, lifecycle_intent_version',
    )
    .eq('id', targetAccountId)
    .maybeSingle();
  if (targetError) {
    log.error('[team/status:PUT] lifecycle snapshot failed', {
      requestId, accountId: targetAccountId, msg: errToString(targetError),
    });
    return lifecycleUnavailable(requestId, lifecycleOperationId, false);
  }
  if (!target) {
    return err('Account not found', {
      requestId, status: 404, code: ApiErrorCode.NotFound,
    });
  }
  if (!Array.isArray(target.property_access)
      || typeof target.data_user_id !== 'string'
      || typeof target.lifecycle_intent_version !== 'number') {
    return lifecycleUnavailable(requestId, lifecycleOperationId, false);
  }

  let registrationData: unknown = null;
  let registrationError: unknown | null = null;
  try {
    const registration = await supabaseAdmin.rpc(
      'staxis_register_account_lifecycle_intent',
      {
        p_operation_id: lifecycleOperationId,
        p_actor_account_id: caller.accountId,
        p_actor_auth_user_id: caller.authUserId,
        p_actor_email: caller.authEmail ?? null,
        p_hotel_id: hotelId.value!,
        p_target_account_id: targetAccountId,
        p_desired_active: desiredActive,
        p_expected_active: target.active !== false,
        p_expected_role: target.role,
        p_expected_auth_user_id: target.data_user_id,
        p_expected_property_access: target.property_access,
        p_expected_intent_version: target.lifecycle_intent_version,
      },
    );
    registrationData = registration.data;
    registrationError = registration.error ?? null;
  } catch (error) {
    registrationError = error;
  }
  if (registrationError) {
    log.error('[team/status:PUT] lifecycle registration unavailable', {
      requestId,
      accountId: targetAccountId,
      operationId: lifecycleOperationId,
      msg: errToString(registrationError),
    });
    // Missing RPC/schema cache during a rolling deploy must fail closed. There
    // is deliberately no direct accounts.active fallback.
    return lifecycleUnavailable(requestId, lifecycleOperationId, false);
  }

  const registered = rpcObject(registrationData);
  const status = typeof registered?.status === 'string' ? registered.status : '';
  const reason = typeof registered?.reason === 'string' ? registered.reason : '';
  if (status === 'committed') {
    const registeredDesired = registered?.desired_active === true;
    const registeredPrior = registered?.prior_active === true;
    return ok({
      operationId: lifecycleOperationId,
      accountId: targetAccountId,
      active: registeredDesired,
      noop: registeredPrior === registeredDesired,
    }, { requestId });
  }
  if (status === 'pending' || status === 'superseded') {
    const result = await processAccountLifecycleIntent({
      operationId: lifecycleOperationId,
      requestId,
      source: 'route',
    });
    return processResponse(result, requestId, targetAccountId);
  }
  if (status === 'not_found') {
    return err('Account not found', {
      requestId, status: 404, code: ApiErrorCode.NotFound,
    });
  }
  if (status === 'forbidden') {
    if (reason === 'self') {
      return err('You cannot change your own account status', {
        requestId, status: 400, code: ApiErrorCode.ValidationFailed,
      });
    }
    if (reason === 'target_role' || reason === 'organization_owner') {
      return err('Transfer ownership before changing this account status', {
        requestId, status: 409, code: ApiErrorCode.IdempotencyConflict,
      });
    }
    return err(
      reason === 'manage_users'
        ? 'You need user-management permission at every hotel on this account'
        : 'Forbidden',
      { requestId, status: 403, code: ApiErrorCode.Forbidden },
    );
  }
  if (status === 'conflict') {
    return err('The account changed in another session. Refresh and try again.', {
      requestId,
      status: 409,
      code: ApiErrorCode.IdempotencyConflict,
      details: { operationId: lifecycleOperationId, pending: false },
    });
  }
  if (status === 'pending_conflict' || status === 'operation_mismatch') {
    // Do not reveal another actor's operation UUID or lifecycle details.
    return err('This account already has a status change in progress.', {
      requestId,
      status: 409,
      code: ApiErrorCode.IdempotencyConflict,
      details: { operationId: lifecycleOperationId, pending: false },
    });
  }
  if (status === 'retry') {
    return lifecycleUnavailable(requestId, lifecycleOperationId, false);
  }
  if (status === 'aborted') {
    return err('This account status request has ended. Start a new change.', {
      requestId,
      status: 409,
      code: ApiErrorCode.IdempotencyConflict,
      details: { operationId: lifecycleOperationId, pending: false },
    });
  }
  if (status === 'invalid') {
    return err('Invalid account status request', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  // identity_conflict and unknown/malformed RPC results are integrity or
  // rollout failures. Never touch Auth in this branch.
  return lifecycleUnavailable(requestId, lifecycleOperationId, false);
}
