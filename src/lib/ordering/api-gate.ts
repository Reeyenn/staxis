// ════════════════════════════════════════════════════════════════════════════
// Inventory Ordering API gate — the single auth choke point for the
// /api/inventory/{orders,vendors,catalog}/* write + read surface.
//
// Ordering touches spend + external vendor relationships, so EVERY ordering
// route calls requireOrderingAccess(req, pid) before any supabaseAdmin access.
// It enforces, in order:
//   1. a valid authenticated session (cookie or bearer; 2FA enforced upstream),
//   2. a syntactically valid property UUID,
//   3. the caller's role is owner / general_manager / admin (canManageInventory)
//      — front_desk / housekeeping / maintenance / staff are denied here,
//   4. the caller actually has access to THIS property (admins: all; others:
//      pid must be in property_access, or the '*' wildcard).
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
