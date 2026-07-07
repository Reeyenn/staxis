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
import { canForProperty } from '@/lib/capabilities/server';
import { isSectionEnabledForProperty } from '@/lib/sections/server';

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

  // 2b) Section gate (ABOVE role/capability): if Financials is turned off for this
  //     hotel, finance is gone for EVERY role including owner/admin. Fail-soft to
  //     ON via the helper, so a read hiccup never hides a live section.
  if (!(await isSectionEnabledForProperty(pid, 'financials'))) {
    return {
      ok: false,
      response: err('the financials section is turned off for this hotel', {
        requestId,
        status: 403,
        code: 'section_disabled',
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

  // 4a) Manager floor (defense in depth): finance is owner / GM / admin only.
  //     view_financials is a MANAGER_FLOOR capability, so the per-hotel resolver
  //     in (4b) already enforces this — but we assert it explicitly at the most
  //     sensitive choke point so it never rides on a single mechanism. Line-staff
  //     roles (front_desk / housekeeping / maintenance / legacy staff) are denied
  //     here before any override is even consulted.
  if (!canViewFinancials(role)) {
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
  if (!(await canForProperty({ role }, 'view_financials', pid))) {
    return {
      ok: false,
      response: err('forbidden: financials are restricted for your role at this property', {
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

  // Manager floor (defense in depth): finance is owner / GM / admin only. A
  // line-staff caller gets an empty rollup — no money leaks via aggregation —
  // without even resolving their property list. The per-property loop below would
  // also yield [] via the resolver floor; this is the explicit fast path that
  // mirrors requireFinanceAccess.
  if (role !== 'admin' && !canViewFinancials(role)) {
    return {
      ok: true,
      userId: session.userId,
      accountId: account.id as string,
      role,
      name: (account.display_name as string | null) ?? null,
      propertyIds: [],
      requestId,
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

  // Per-hotel capability filter: the rollup only includes hotels where this role
  // is allowed Financials — admins always; everyone else honors each hotel's
  // Access-tab restriction. A role switched OFF for Financials at a hotel can't
  // see that hotel's money in the rollup either (no leak via aggregation).
  if (role !== 'admin') {
    const allowed: string[] = [];
    for (const p of propertyIds) {
      if (await canForProperty({ role }, 'view_financials', p)) allowed.push(p);
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
