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

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(s: unknown): s is string {
  return typeof s === 'string' && UUID_RX.test(s);
}

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

  // 3) Load the caller's account ONCE: role + property scope + accounts PK + name.
  const { data: account, error } = await supabaseAdmin
    .from('accounts')
    .select('id, role, property_access, display_name')
    .eq('data_user_id', session.userId)
    .maybeSingle();
  if (error || !account) {
    return {
      ok: false,
      response: err('account not found for session', {
        requestId,
        status: 403,
        code: 'no_account',
      }),
    };
  }
  const role = ((account.role as string) ?? 'staff') as AppRole;

  // 4) Role gate — owner / GM / admin only.
  if (!canViewFinancials(role)) {
    return {
      ok: false,
      response: err('forbidden: financials are restricted to owner / general manager / admin', {
        requestId,
        status: 403,
        code: 'forbidden_role',
      }),
    };
  }

  // 5) Property scope — admins reach every property; everyone else must have
  //    the pid in property_access (or the '*' wildcard).
  const access = (account.property_access ?? []) as string[];
  const hasProperty = role === 'admin' || access.includes(pid) || access.includes('*');
  if (!hasProperty) {
    return {
      ok: false,
      response: err('forbidden: no access to this property', {
        requestId,
        status: 403,
        code: 'forbidden_property',
      }),
    };
  }

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
    .select('id, role, property_access, display_name')
    .eq('data_user_id', session.userId)
    .maybeSingle();
  if (error || !account) {
    return { ok: false, response: err('account not found for session', { requestId, status: 403, code: 'no_account' }) };
  }
  const role = ((account.role as string) ?? 'staff') as AppRole;
  if (!canViewFinancials(role)) {
    return {
      ok: false,
      response: err('forbidden: financials are restricted to owner / general manager / admin', {
        requestId,
        status: 403,
        code: 'forbidden_role',
      }),
    };
  }

  const access = (account.property_access ?? []) as string[];
  let propertyIds: string[];
  if (role === 'admin' || access.includes('*')) {
    const { data: all } = await supabaseAdmin.from('properties').select('id').limit(1000);
    propertyIds = (all ?? []).map((r) => (r as { id: string }).id);
  } else {
    propertyIds = access.filter((p) => isUuid(p));
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
