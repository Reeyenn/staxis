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
//
// Rate limit is keyed on the bare property UUID (not pid:userId) ON PURPOSE: for
// the billing-impacting AI/SMS endpoints a per-property cap bounds spend
// regardless of how many staff accounts are involved. Don't "fix" it to per-user.
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
import { canForProperty } from '@/lib/capabilities/server';

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

/**
 * Where a route reads its property id from. GET routes read `pid` from the
 * query string (no body); POST routes parse the JSON body (which may fail
 * with a 400) and read `pid` from it. Everything after the pid is resolved —
 * management-role check, property-access check, rate limit — is identical, so
 * the read/write variants differ only in this source.
 */
type PidSource<TBody> = (
  req: NextRequest,
  requestId: string,
) => Promise<{ ok: true; pid: string; body: TBody } | FdGateFail>;

async function gateFrontDesk<TBody>(
  req: NextRequest,
  endpoint: RateLimitEndpoint,
  source: PidSource<TBody>,
): Promise<FdGateResult<TBody>> {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return { ok: false, response: session.response };

  const src = await source(req, requestId);
  if (!src.ok) return src;
  const { pid, body } = src;

  const { accountId, role } = await resolveAccount(session.userId);
  if (!role || !(await canForProperty({ role }, 'use_lost_and_found', pid))) {
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

/** GET routes: pid comes from the query string. */
export function gateFrontDeskRead(
  req: NextRequest,
  endpoint: RateLimitEndpoint,
): Promise<FdGateResult<Record<string, never>>> {
  return gateFrontDesk<Record<string, never>>(req, endpoint, async (r, requestId) => {
    const pidV = validateUuid(new URL(r.url).searchParams.get('pid'), 'pid');
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
    return { ok: true, pid: pidV.value, body: {} };
  });
}

/** POST routes: pid comes from the JSON body. */
export function gateFrontDeskWrite<TBody extends { pid?: unknown }>(
  req: NextRequest,
  endpoint: RateLimitEndpoint,
): Promise<FdGateResult<TBody>> {
  return gateFrontDesk<TBody>(req, endpoint, async (r, requestId) => {
    let body: TBody;
    try {
      body = (await r.json()) as TBody;
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
    return { ok: true, pid: pidV.value, body };
  });
}
