// /api/auth/join-codes — manage the selected hotel's ordinary staff signup
// bearer link. Company-level People authority is intentionally insufficient:
// every read/create/revoke is committed by an actor-bound database RPC that
// rechecks exact hotelMutationAllowed + manager role + manage_team under lock.

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { validateUuid } from '@/lib/api-validate';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { verifyTeamManager, callerCapabilityDecision } from '@/lib/team-auth';
import { capabilityUnavailableResponse } from '@/lib/capabilities/api-gate';
import { generateJoinCode } from '@/lib/join-codes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STAFF_CODE_RX = /^[A-Z]{4}-[A-Z2-9]{10}$/;
const RETRYABLE_DATABASE_CODES = new Set([
  '40001', // serialization failure
  '55P03', // authority relation changed while the RPC acquired NOWAIT locks
  'PGRST202', // rolling deploy: function is not in the schema cache yet
  'PGRST205',
  '42883', // undefined function
]);

interface JoinCodeRow {
  id: string;
  code: string;
  role: null;
  expires_at: string;
  max_uses: number;
  used_count: number;
  created_at: string;
  revoked_at: null;
}

type ReadReceipt =
  | { status: 'empty'; hotelId: string; code: null }
  | { status: 'found'; hotelId: string; code: JoinCodeRow };

type GetOrCreateReceipt = {
  status: 'created' | 'existing';
  hotelId: string;
  created: boolean;
  code: JoinCodeRow;
};

type FailureReceipt = { reason: 'invalid' | 'denied' | 'not_found' | 'code_collision' };

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function parseFailureReceipt(value: unknown): FailureReceipt | null {
  const record = recordOf(value);
  if (!record || !hasExactKeys(record, ['ok', 'reason']) || record.ok !== false) return null;
  return record.reason === 'invalid'
    || record.reason === 'denied'
    || record.reason === 'not_found'
    || record.reason === 'code_collision'
    ? { reason: record.reason }
    : null;
}

function parseJoinCodeFields(
  record: Record<string, unknown>,
  expectedHotelId: string,
): JoinCodeRow | null {
  const codeId = validateUuid(record.codeId, 'codeId');
  if (codeId.error || !codeId.value
      || record.hotelId !== expectedHotelId
      || typeof record.code !== 'string'
      || !STAFF_CODE_RX.test(record.code)
      || record.role !== null
      || !validTimestamp(record.expiresAt)
      || !validTimestamp(record.createdAt)
      || Date.parse(record.expiresAt) <= Date.now()
      || Date.parse(record.expiresAt) <= Date.parse(record.createdAt)
      || !Number.isInteger(record.maxUses)
      || (record.maxUses as number) < 1
      || (record.maxUses as number) > 100
      || !Number.isInteger(record.usedCount)
      || (record.usedCount as number) < 0
      || (record.usedCount as number) >= (record.maxUses as number)) {
    return null;
  }
  return {
    id: codeId.value,
    code: record.code,
    role: null,
    expires_at: record.expiresAt,
    max_uses: record.maxUses as number,
    used_count: record.usedCount as number,
    created_at: record.createdAt,
    revoked_at: null,
  };
}

function parseReadReceipt(value: unknown, expectedHotelId: string): ReadReceipt | null {
  const record = recordOf(value);
  if (!record || record.ok !== true || record.hotelId !== expectedHotelId) return null;
  if (record.status === 'empty') {
    return hasExactKeys(record, ['ok', 'status', 'hotelId'])
      ? { status: 'empty', hotelId: expectedHotelId, code: null }
      : null;
  }
  if (record.status !== 'found'
      || !hasExactKeys(record, [
        'ok', 'status', 'hotelId', 'codeId', 'code', 'role', 'expiresAt',
        'maxUses', 'usedCount', 'createdAt',
      ])) {
    return null;
  }
  const code = parseJoinCodeFields(record, expectedHotelId);
  return code ? { status: 'found', hotelId: expectedHotelId, code } : null;
}

function parseGetOrCreateReceipt(
  value: unknown,
  expectedHotelId: string,
): GetOrCreateReceipt | null {
  const record = recordOf(value);
  if (!record || record.ok !== true
      || (record.status !== 'created' && record.status !== 'existing')
      || record.hotelId !== expectedHotelId
      || typeof record.created !== 'boolean'
      || record.created !== (record.status === 'created')
      || !hasExactKeys(record, [
        'ok', 'status', 'created', 'hotelId', 'codeId', 'code', 'role',
        'expiresAt', 'maxUses', 'usedCount', 'createdAt',
      ])) {
    return null;
  }
  const code = parseJoinCodeFields(record, expectedHotelId);
  return code ? {
    status: record.status,
    hotelId: expectedHotelId,
    created: record.created,
    code,
  } : null;
}

function isRetryableDatabaseError(error: { code?: string; message?: string }): boolean {
  return RETRYABLE_DATABASE_CODES.has(error.code ?? '')
    || /schema cache|could not find the function|function .* does not exist/i.test(error.message ?? '');
}

function forbidden(requestId: string) {
  return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
}

function malformedReceipt(requestId: string, operation: string) {
  log.error(`[join-codes:${operation}] guarded RPC returned a malformed receipt`, { requestId });
  return err('Join-code authority could not be verified', {
    requestId,
    status: 500,
    code: ApiErrorCode.InternalError,
  });
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req, { capability: 'manage_team' });
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  const hotelIdValue = new URL(req.url).searchParams.get('hotelId');
  if (!hotelIdValue) {
    return err('hotelId required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const hotelIdCheck = validateUuid(hotelIdValue, 'hotelId');
  if (hotelIdCheck.error || !hotelIdCheck.value) {
    return err(hotelIdCheck.error ?? 'hotelId is invalid', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }
  const hotelId = hotelIdCheck.value;
  const capabilityDecision = await callerCapabilityDecision(caller, 'manage_team', hotelId);
  if (capabilityDecision === 'unavailable') return capabilityUnavailableResponse(requestId);
  if (capabilityDecision === 'denied') return forbidden(requestId);

  // This is the only bearer-code read. 0396 locks live authority and the
  // selected hotel's code row in one database transaction before returning it.
  const { data, error: readError } = await supabaseAdmin.rpc(
    'staxis_read_staff_join_code_guarded',
    {
      p_actor_account_id: caller.accountId,
      p_actor_auth_user_id: caller.authUserId,
      p_hotel_id: hotelId,
    },
  );
  if (readError) {
    log.error('[join-codes:GET] guarded read failed', {
      requestId, code: readError.code, msg: errToString(readError),
    });
    return isRetryableDatabaseError(readError)
      ? capabilityUnavailableResponse(requestId)
      : err('Failed to load join code', {
          requestId, status: 500, code: ApiErrorCode.InternalError,
        });
  }
  const failure = parseFailureReceipt(data);
  if (failure) {
    if (failure.reason === 'invalid') return malformedReceipt(requestId, 'GET');
    return forbidden(requestId);
  }
  const receipt = parseReadReceipt(data, hotelId);
  if (!receipt) return malformedReceipt(requestId, 'GET');
  return ok({ codes: receipt.code ? [receipt.code] : [] }, { requestId });
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req, { capability: 'manage_team' });
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  let body: { hotelId?: unknown };
  try {
    body = await req.json() as { hotelId?: unknown };
  } catch {
    return err('A valid JSON body is required', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }
  const hotelIdCheck = validateUuid(body.hotelId, 'hotelId');
  if (hotelIdCheck.error || !hotelIdCheck.value) {
    return err(hotelIdCheck.error ?? 'hotelId is invalid', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }
  const hotelId = hotelIdCheck.value;
  const capabilityDecision = await callerCapabilityDecision(caller, 'manage_team', hotelId);
  if (capabilityDecision === 'unavailable') return capabilityUnavailableResponse(requestId);
  if (capabilityDecision === 'denied') return forbidden(requestId);

  const { data: property, error: propertyError } = await supabaseAdmin
    .from('properties')
    .select('name')
    .eq('id', hotelId)
    .maybeSingle();
  if (propertyError) {
    log.error('[join-codes:POST] property lookup failed', {
      requestId, msg: errToString(propertyError),
    });
    return err('Failed to verify hotel', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
  if (!property || typeof property.name !== 'string') {
    return err('Hotel not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }

  // The candidate is only entropy. TTL, capacity, canonical-code selection,
  // fresh authorization and audit all belong to the guarded transaction.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = generateJoinCode(property.name);
    const { data, error: createError } = await supabaseAdmin.rpc(
      'staxis_get_or_create_staff_join_code_guarded',
      {
        p_actor_account_id: caller.accountId,
        p_actor_auth_user_id: caller.authUserId,
        p_hotel_id: hotelId,
        p_code: candidate,
        p_request_id: requestId,
      },
    );
    if (createError) {
      log.error('[join-codes:POST] guarded get-or-create failed', {
        requestId, code: createError.code, msg: errToString(createError),
      });
      return isRetryableDatabaseError(createError)
        ? capabilityUnavailableResponse(requestId)
        : err('Failed to create join code', {
            requestId, status: 500, code: ApiErrorCode.InternalError,
          });
    }
    const failure = parseFailureReceipt(data);
    if (failure?.reason === 'code_collision') continue;
    if (failure?.reason === 'invalid') return malformedReceipt(requestId, 'POST');
    if (failure) return forbidden(requestId);

    const receipt = parseGetOrCreateReceipt(data, hotelId);
    if (!receipt) return malformedReceipt(requestId, 'POST');
    return ok(
      { joinCode: receipt.code, created: receipt.created },
      { requestId, status: receipt.created ? 201 : 200 },
    );
  }

  log.error('[join-codes:POST] guarded get-or-create exhausted code collisions', { requestId });
  return err('Failed to create join code', {
    requestId, status: 500, code: ApiErrorCode.InternalError,
  });
}

export async function DELETE(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req, { capability: 'manage_team' });
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  const idValue = new URL(req.url).searchParams.get('id');
  if (!idValue) return err('id required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const idCheck = validateUuid(idValue, 'id');
  if (idCheck.error || !idCheck.value) {
    return err(idCheck.error ?? 'id is invalid', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }
  const codeId = idCheck.value;

  // The route never looks up the code's hotel. The guarded RPC resolves it,
  // checks exact current authority, locks the row, revokes, and audits as one
  // transaction. Missing and foreign ids are intentionally indistinguishable.
  const { data, error: revokeError } = await supabaseAdmin.rpc(
    'staxis_revoke_staff_join_code_guarded',
    {
      p_actor_account_id: caller.accountId,
      p_actor_auth_user_id: caller.authUserId,
      p_code_id: codeId,
      p_request_id: requestId,
    },
  );
  if (revokeError) {
    log.error('[join-codes:DELETE] guarded revoke failed', {
      requestId, code: revokeError.code, msg: errToString(revokeError),
    });
    return isRetryableDatabaseError(revokeError)
      ? capabilityUnavailableResponse(requestId)
      : err('Failed to revoke join code', {
          requestId, status: 500, code: ApiErrorCode.InternalError,
        });
  }
  const failure = parseFailureReceipt(data);
  if (failure) {
    if (failure.reason === 'invalid') {
      return err('Invalid join code', {
        requestId, status: 400, code: ApiErrorCode.ValidationFailed,
      });
    }
    return err('Not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }
  const receipt = recordOf(data);
  if (!receipt
      || !hasExactKeys(receipt, ['ok', 'status', 'codeId', 'hotelId'])
      || receipt.ok !== true
      || receipt.status !== 'revoked'
      || receipt.codeId !== codeId
      || validateUuid(receipt.hotelId, 'hotelId').error) {
    return malformedReceipt(requestId, 'DELETE');
  }
  return ok({ success: true }, { requestId });
}
