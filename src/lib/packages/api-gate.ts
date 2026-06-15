// ═══════════════════════════════════════════════════════════════════════════
// Packages — front-desk API gate.
//
// Authenticated routes. Flow:
//   requireSession → validate pid → resolve account (id + role) →
//   userHasPropertyAccess → rate limit.
//
// DELIBERATELY NOT management-gated (unlike Lost & Found's gateFrontDeskWrite).
// Logging / handing out parcels is a routine all-staff desk task, so the gate
// matches the Rooms tab's access level: ANY signed-in user with access to the
// property. The role is resolved for provenance/audit but is NOT a gate. The
// `packages` table is still deny-all-browser — this gate is the only thing that
// decides who may call the service-role-backed routes.
//
// Rate limit is keyed on the BARE property UUID (never pid:userId): for the
// billing-impacting AI/SMS endpoints a per-property cap bounds spend regardless
// of how many staff accounts are involved, and api_limits.property_id has an FK
// to properties(id) so a hashed composite key would FK-violate. Don't "fix" it
// to per-user.
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

export interface PkgGateOk<TBody> {
  ok: true;
  userId: string;
  accountId: string | null;
  role: AppRole | null;
  pid: string;
  requestId: string;
  body: TBody;
}
export interface PkgGateFail {
  ok: false;
  response: Response;
}
export type PkgGateResult<TBody> = PkgGateOk<TBody> | PkgGateFail;

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

/** GET / DELETE routes: pid comes from the query string. */
export async function gatePackagesRead(
  req: NextRequest,
  endpoint: RateLimitEndpoint,
): Promise<PkgGateResult<Record<string, never>>> {
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

  // Property access — NOT a role check. Any signed-in user scoped to this
  // property may use the package log (front-desk-staff access level).
  if (!(await userHasPropertyAccess(session.userId, pid))) {
    return {
      ok: false,
      response: err('forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden }),
    };
  }

  const { accountId, role } = await resolveAccount(session.userId);

  // use_packages capability gate (default: every role; an admin can switch a
  // role OFF per hotel from the Access tab).
  if (!(await canForProperty({ role }, 'use_packages', pid))) {
    return { ok: false, response: err('forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden }) };
  }

  const rl = await checkAndIncrementRateLimit(endpoint, pid);
  if (!rl.allowed) {
    return { ok: false, response: rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec) };
  }

  return { ok: true, userId: session.userId, accountId, role, pid, requestId, body: {} };
}

/** POST / PATCH routes: pid comes from the JSON body. */
export async function gatePackagesWrite<TBody extends { pid?: unknown }>(
  req: NextRequest,
  endpoint: RateLimitEndpoint,
): Promise<PkgGateResult<TBody>> {
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

  if (!(await userHasPropertyAccess(session.userId, pid))) {
    return {
      ok: false,
      response: err('forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden }),
    };
  }

  const { accountId, role } = await resolveAccount(session.userId);

  // use_packages capability gate (default: every role; an admin can switch a
  // role OFF per hotel from the Access tab).
  if (!(await canForProperty({ role }, 'use_packages', pid))) {
    return { ok: false, response: err('forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden }) };
  }

  const rl = await checkAndIncrementRateLimit(endpoint, pid);
  if (!rl.allowed) {
    return { ok: false, response: rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec) };
  }

  return { ok: true, userId: session.userId, accountId, role, pid, requestId, body };
}
