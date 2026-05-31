// ═══════════════════════════════════════════════════════════════════════════
// Lost & Found — front-desk API gate.
//
// Front-desk routes are AUTHENTICATED (not magic-link), so the flow is:
//   requireSession → resolve account (id + role) → management-role check →
//   userHasPropertyAccess → rate limit.
//
// The management-role check is defense-in-depth: the page redirects non-managers
// client-side, but a housekeeper who happens to have property access must not be
// able to POST to the register (which carries guest PII) by calling the API
// directly. admin/owner/general_manager/front_desk only.
// ═══════════════════════════════════════════════════════════════════════════

import type { NextRequest } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';
import {
  checkAndIncrementRateLimit,
  rateLimitedResponse,
  type RateLimitEndpoint,
} from '@/lib/api-ratelimit';
import { supabaseAdmin } from '@/lib/supabase-admin';
import type { AppRole } from '@/lib/roles';

/** Roles allowed to use the Front-Desk Lost & Found surface. */
export const FRONT_DESK_ROLES: readonly AppRole[] = [
  'admin',
  'owner',
  'general_manager',
  'front_desk',
];

export interface FdGateOk<TBody> {
  ok: true;
  userId: string;
  accountId: string | null;
  role: AppRole;
  pid: string;
  requestId: string;
  body: TBody;
}
export interface FdGateFail {
  ok: false;
  response: Response;
}
export type FdGateResult<TBody> = FdGateOk<TBody> | FdGateFail;

async function resolveAccount(
  userId: string,
): Promise<{ accountId: string | null; role: AppRole | null }> {
  const { data } = await supabaseAdmin
    .from('accounts')
    .select('id, role')
    .eq('data_user_id', userId)
    .maybeSingle();
  return {
    accountId: data?.id ? String(data.id) : null,
    role: (data?.role as AppRole | undefined) ?? null,
  };
}

/** GET routes: pid comes from the query string. */
export async function gateFrontDeskRead(
  req: NextRequest,
  endpoint: RateLimitEndpoint,
): Promise<FdGateResult<Record<string, never>>> {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return { ok: false, response: session.response };

  const pidV = validateUuid(new URL(req.url).searchParams.get('pid'), 'pid');
  if (pidV.error || !pidV.value) {
    return {
      ok: false,
      response: err(pidV.error ?? 'invalid pid', {
        requestId,
        status: 400,
        code: ApiErrorCode.ValidationFailed,
      }),
    };
  }
  const pid = pidV.value;

  const { accountId, role } = await resolveAccount(session.userId);
  if (!role || !FRONT_DESK_ROLES.includes(role)) {
    return {
      ok: false,
      response: err('forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden }),
    };
  }
  if (!(await userHasPropertyAccess(session.userId, pid))) {
    return {
      ok: false,
      response: err('forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden }),
    };
  }

  const rl = await checkAndIncrementRateLimit(endpoint, pid);
  if (!rl.allowed) {
    return { ok: false, response: rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec) };
  }

  return { ok: true, userId: session.userId, accountId, role, pid, requestId, body: {} };
}

/** POST routes: pid comes from the JSON body. */
export async function gateFrontDeskWrite<TBody extends { pid?: unknown }>(
  req: NextRequest,
  endpoint: RateLimitEndpoint,
): Promise<FdGateResult<TBody>> {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return { ok: false, response: session.response };

  let body: TBody;
  try {
    body = (await req.json()) as TBody;
  } catch {
    return {
      ok: false,
      response: err('invalid json', {
        requestId,
        status: 400,
        code: ApiErrorCode.ValidationFailed,
      }),
    };
  }

  const pidV = validateUuid((body as { pid?: unknown }).pid, 'pid');
  if (pidV.error || !pidV.value) {
    return {
      ok: false,
      response: err(pidV.error ?? 'invalid pid', {
        requestId,
        status: 400,
        code: ApiErrorCode.ValidationFailed,
      }),
    };
  }
  const pid = pidV.value;

  const { accountId, role } = await resolveAccount(session.userId);
  if (!role || !FRONT_DESK_ROLES.includes(role)) {
    return {
      ok: false,
      response: err('forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden }),
    };
  }
  if (!(await userHasPropertyAccess(session.userId, pid))) {
    return {
      ok: false,
      response: err('forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden }),
    };
  }

  const rl = await checkAndIncrementRateLimit(endpoint, pid);
  if (!rl.allowed) {
    return { ok: false, response: rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec) };
  }

  return { ok: true, userId: session.userId, accountId, role, pid, requestId, body };
}
