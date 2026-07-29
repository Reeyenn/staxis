// ════════════════════════════════════════════════════════════════════════════
// Inventory Ordering API gate — the single auth choke point for the
// /api/inventory/{orders,vendors,catalog}/* write + read surface.
//
// Ordering touches spend + external vendor relationships, so EVERY ordering
// route calls requireOrderingAccess(req, pid) before any supabaseAdmin access.
// It enforces, in order:
//   1. a valid authenticated session (cookie or bearer; 2FA enforced upstream),
//   2. a syntactically valid property UUID,
//   3. current exact property reach + per-hotel operational role from the
//      authoritative entitlement projection (never accounts.property_access),
//   4. the inventory capability and, for writes, mutation capacity carried by
//      the winning normalized entitlement.
//
// Mirrors src/lib/financials/api-gate.ts:requireFinanceAccess exactly (one
// accounts read serves 3 + 4). The cross-property spend rollup reuses
// requireFinanceRollup from the financials gate (same owner/GM/admin trio).
// ════════════════════════════════════════════════════════════════════════════

import type { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/api-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { type AppRole } from '@/lib/roles';
import { capabilityDecisionForProperty } from '@/lib/capabilities/server';
import { capabilityUnavailableResponse } from '@/lib/capabilities/api-gate';
import { isUuid } from '@/lib/api-validate';
import { requireSectionEnabled } from '@/lib/sections/server';
import type { EnabledSections } from '@/lib/sections/registry';
import {
  authoritativeStandingForProperty,
  listAuthoritativePropertyAccess,
} from '@/lib/authorization/server';

export { isUuid };

export type OrderingAccess =
  | {
      ok: true;
      userId: string;
      accountId: string;
      role: AppRole;
      name: string | null;
      email: string | null;
      pid: string;
      requestId: string;
      enabledSections: EnabledSections;
    }
  | { ok: false; response: NextResponse };

function authorityUnavailable(requestId: string): OrderingAccess & { ok: false } {
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

function isReadOnlyRequest(req: NextRequest): boolean {
  return req.method === 'GET' || req.method === 'HEAD';
}

export async function requireOrderingAccess(
  req: NextRequest,
  pid: string | null | undefined,
): Promise<OrderingAccess> {
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

  // 3) Load identity, then resolve reach + per-hotel capacity atomically from
  //    the account's selected authority mode.
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

  // A portfolio/viewer grant may use read-only inventory endpoints at hotels
  // in its exact scope, but it never inherits delivery/vendor writes from the
  // front_desk compatibility lens used to present that grant.
  if (!isReadOnlyRequest(req) && !standing.hotelMutationAllowed) {
    return {
      ok: false,
      response: err('forbidden: your current company access is read-only at this property', {
        requestId,
        status: 403,
        code: 'forbidden_role',
      }),
    };
  }

  // 4) Capability gate — manage_inventory_orders, honoring this hotel's Access-tab
  //    restrictions (default: every role; an admin can switch a role OFF per hotel).
  const capabilityDecision = await capabilityDecisionForProperty(
    { role },
    'manage_inventory_orders',
    pid,
  );
  if (capabilityDecision === 'unavailable') {
    return { ok: false, response: capabilityUnavailableResponse(requestId) };
  }
  if (capabilityDecision === 'denied') {
    return {
      ok: false,
      response: err('forbidden: ordering is restricted for your role at this property', {
        requestId,
        status: 403,
        code: 'forbidden_role',
      }),
    };
  }

  const sectionGate = await requireSectionEnabled(req, pid, 'inventory');
  if (!sectionGate.ok) return sectionGate;

  return {
    ok: true,
    userId: session.userId,
    accountId: account.id as string,
    role,
    name: (account.display_name as string | null) ?? null,
    email: session.email ?? null,
    pid,
    requestId,
    enabledSections: sectionGate.enabledSections,
  };
}
