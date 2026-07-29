// ════════════════════════════════════════════════════════════════════════════
// Financials API gate — the single auth choke point for /api/financials/*.
//
// Finance is the most sensitive surface in the app (revenue, expenses, budgets,
// owner metrics). EVERY financials route calls requireFinanceAccess(req, pid)
// before touching supabaseAdmin. It enforces, in order:
//   1. a valid authenticated session (cookie or bearer; 2FA enforced upstream),
//   2. a syntactically valid property UUID,
//   3. the caller's role is owner / general_manager / admin (canViewFinancials) —
//      front_desk / housekeeping / maintenance / staff are denied here,
//   4. the caller actually has access to THIS property (admins: all; others:
//      pid must be in property_access, or the '*' wildcard).
//
// One accounts read serves (3) + (4). On success it returns userId + accountId
// (for cost attribution) + role + the validated pid. The audit
// (scripts/audit-api-route-tenant-scope.mjs) recognizes requireFinanceAccess as
// a known guard, so any route that imports supabaseAdmin and calls this passes.
// ════════════════════════════════════════════════════════════════════════════

import type { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/api-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { canViewFinancials, type AppRole } from '@/lib/roles';
import { capabilityDecisionForProperty } from '@/lib/capabilities/server';
import { capabilityUnavailableResponse } from '@/lib/capabilities/api-gate';
import { requirePropertySectionEnabled } from '@/lib/sections/server';
import { isUuid } from '@/lib/api-validate';
import {
  authoritativeStandingForProperty,
  listAuthoritativePropertyAccess,
} from '@/lib/authorization/server';
import {
  readCompleteCompanyPages,
  type CompanyProjectionPage,
} from '@/lib/company-access/projection-query';

export { isUuid };

export type FinanceAccess =
  | {
      ok: true;
      userId: string;
      accountId: string;
      role: AppRole;
      name: string | null;
      pid: string;
      requestId: string;
    }
  | { ok: false; response: NextResponse };

function isReadOnlyRequest(req: NextRequest): boolean {
  return req.method === 'GET' || req.method === 'HEAD';
}

function authorityUnavailable(requestId: string): FinanceAccess & { ok: false } {
  return {
    ok: false,
    response: err('authorization is temporarily unavailable', {
      requestId,
      status: 503,
      code: 'authorization_unavailable',
      headers: { 'Retry-After': '5' },
    }),
  };
}

export async function requireFinanceAccess(
  req: NextRequest,
  pid: string | null | undefined,
): Promise<FinanceAccess> {
  const requestId = getOrMintRequestId(req);

  // 1) Authenticated session.
  const session = await requireSession(req);
  if (!session.ok) return { ok: false, response: session.response };

  // 2) Valid property id (syntactic).
  if (!isUuid(pid)) {
    return {
      ok: false,
      response: err('pid must be a valid property UUID', {
        requestId,
        status: 400,
        code: 'invalid_pid',
      }),
    };
  }

  // 3) Load identity, then resolve reach + capacity atomically from the one
  //    authority selected for this account.
  const { data: account, error } = await supabaseAdmin
    .from('accounts')
    .select('id, display_name, active')
    .eq('data_user_id', session.userId)
    .maybeSingle();
  if (error || !account || account.active !== true) {
    return {
      ok: false,
      response: err('account not found for session', {
        requestId,
        status: 403,
        code: 'no_account',
      }),
    };
  }
  const authority = await listAuthoritativePropertyAccess(account.id as string);
  if (!authority) return authorityUnavailable(requestId);
  const standing = authoritativeStandingForProperty(authority, pid);
  if (!standing) {
    return {
      ok: false,
      response: err('forbidden: no access to this property', {
        requestId,
        status: 403,
        code: 'forbidden_property',
      }),
    };
  }
  const role = standing.operationalRole;
  const readOnly = isReadOnlyRequest(req);

  // A finance hat is deliberately front_desk for operational permissions and
  // carries money visibility as a separate bit. It may read, never mutate.
  if (!standing.seesFinancials
      || (!readOnly && (!standing.hotelMutationAllowed || !canViewFinancials(role)))) {
    return {
      ok: false,
      response: err('forbidden: financials are restricted for your role', {
        requestId,
        status: 403,
        code: 'forbidden_role',
      }),
    };
  }

  // 4b) Per-hotel capability gate — view_financials, honoring this hotel's
  //     Access-tab restrictions (an admin can switch a manager OFF per hotel).
  //     Admin always passes; admin-only caps are unaffected here.
  // Owner/GM/admin continue to honor per-hotel role overrides. A finance hat
  // cannot use that legacy-role resolver because its least-privilege role is
  // front_desk and the manager floor would erase the explicit finance bit.
  if (canViewFinancials(role)) {
    const capabilityDecision = await capabilityDecisionForProperty({ role }, 'view_financials', pid);
    if (capabilityDecision === 'unavailable') {
      return { ok: false, response: capabilityUnavailableResponse(requestId) };
    }
    if (capabilityDecision === 'denied') {
      return {
        ok: false,
        response: err('forbidden: financials are restricted for your role at this property', {
          requestId,
          status: 403,
          code: 'forbidden_role',
        }),
      };
    }
  }

  // 6) Section gate — checked LAST (after the caller's property access is proven,
  //    so a stranger can't probe another hotel's section state) but it OVERRIDES
  //    the capability result: if Financials is turned off for this hotel, finance
  //    is gone for EVERY role including owner/admin. A section-state lookup
  //    failure is a retryable 503; it must never bypass the money gate or leak
  //    out as an unhandled exception.
  const sectionGate = await requirePropertySectionEnabled(pid, 'financials', { requestId });
  if (!sectionGate.ok) return sectionGate;

  return {
    ok: true,
    userId: session.userId,
    accountId: account.id as string,
    role,
    name: (account.display_name as string | null) ?? null,
    pid,
    requestId,
  };
}

export type FinanceMultiAccess =
  | {
      ok: true;
      userId: string;
      accountId: string;
      role: AppRole;
      name: string | null;
      propertyIds: string[];
      requestId: string;
    }
  | { ok: false; response: NextResponse };

/**
 * Multi-property gate for the owner CapEx rollup. Same role check as
 * requireFinanceAccess (owner/GM/admin) but resolves the FULL set of property
 * ids the caller may see: their property_access list, or — for an admin / '*'
 * wildcard — every property. The caller can never roll up a hotel they don't
 * own (admins legitimately see all). Returns [] (not all) for a non-wildcard
 * caller with no property_access.
 */
export async function requireFinanceRollup(req: NextRequest): Promise<FinanceMultiAccess> {
  const requestId = getOrMintRequestId(req);

  const session = await requireSession(req);
  if (!session.ok) return { ok: false, response: session.response };

  const { data: account, error } = await supabaseAdmin
    .from('accounts')
    .select('id, role, display_name, active')
    .eq('data_user_id', session.userId)
    .maybeSingle();
  if (error || !account || account.active !== true) {
    return { ok: false, response: err('account not found for session', { requestId, status: 403, code: 'no_account' }) };
  }
  const authority = await listAuthoritativePropertyAccess(account.id as string);
  if (!authority) return authorityUnavailable(requestId);
  const role = ((account.role as string) ?? 'staff') as AppRole;
  let propertyIds: string[];
  if (authority.all) {
    try {
      const all = await readCompleteCompanyPages<{ id: string }>((from, to) => (
        supabaseAdmin
          .from('properties')
          .select('id', { count: 'exact' })
          .order('id')
          .range(from, to) as unknown as PromiseLike<CompanyProjectionPage<{ id: string }>>
      ));
      propertyIds = all.map((row) => row.id);
    } catch {
      return authorityUnavailable(requestId);
    }
  } else {
    propertyIds = authority.propertyStandings
      .filter((standing) => standing.seesFinancials)
      .map((standing) => standing.propertyId);
  }

  // Per-hotel capability + section filter: the rollup only includes hotels where
  // this role is allowed Financials AND the hotel hasn't turned the Financials
  // section off — admins always; everyone else honors each hotel's Access-tab
  // restriction and section toggle. A role switched OFF (or a section switched
  // OFF) for Financials at a hotel can't see that hotel's money in the rollup
  // either (no leak via aggregation). A lookup outage fails the whole rollup
  // closed with the standard retryable 503 instead of silently widening it.
  {
    const allowed: string[] = [];
    for (const p of propertyIds) {
      const standing = authoritativeStandingForProperty(authority, p);
      if (!standing || !standing.seesFinancials) continue;
      if (canViewFinancials(standing.operationalRole)) {
        const capabilityDecision = await capabilityDecisionForProperty(
          { role: standing.operationalRole },
          'view_financials',
          p,
        );
      if (capabilityDecision === 'unavailable') {
        return { ok: false, response: capabilityUnavailableResponse(requestId) };
      }
      if (capabilityDecision === 'denied') continue;
      }
      const sectionGate = await requirePropertySectionEnabled(p, 'financials', { requestId });
      if (!sectionGate.ok) {
        if (sectionGate.response.status === 403) continue;
        return sectionGate;
      }
      allowed.push(p);
    }
    propertyIds = allowed;
  }

  return {
    ok: true,
    userId: session.userId,
    accountId: account.id as string,
    role,
    name: (account.display_name as string | null) ?? null,
    propertyIds,
    requestId,
  };
}
