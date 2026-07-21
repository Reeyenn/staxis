// POST /api/inventory/property-config — persist the hotel's inventory tab
// layout and/or budget mode. Management-only (requireOrderingAccess — the same
// capability that shows the tab editor and Budgets panel).
//
// Exists because these two values live on the `properties` row, whose RLS only
// lets admins UPDATE. A general manager editing tabs through the anon client
// got a silent no-op (PostgREST returns 200 with no rows), the UI showed the
// change, and a reload brought the old tabs back. Writes go through
// supabaseAdmin here instead; failures now surface as real errors.

import type { NextRequest } from 'next/server';
import { ok, err } from '@/lib/api-response';
import { requireOrderingAccess } from '@/lib/ordering/api-gate';
import { isSectionEnabledForProperty, requireSectionEnabled } from '@/lib/sections/server';
import { canForProperty } from '@/lib/capabilities/server';
import { canViewFinancials } from '@/lib/roles';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';
import { log } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  pid?: string;
  tabLayout?: { order?: unknown; hidden?: unknown };
  budgetMode?: unknown;
}

const HIDEABLE_BUILTINS = ['general', 'breakfast'];

export async function POST(req: NextRequest): Promise<Response> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return err('invalid json', { requestId: 'pre-auth', status: 400, code: 'validation_failed' });
  }

  const gate = await requireOrderingAccess(req, body.pid);
  if (!gate.ok) return gate.response;
  const { pid, requestId } = gate;

  const sectionGate = await requireSectionEnabled(req, pid, 'inventory');
  if (!sectionGate.ok) return sectionGate.response;

  const update: Record<string, unknown> = {};

  if (body.tabLayout !== undefined) {
    const t = body.tabLayout;
    const order = Array.isArray(t?.order)
      ? t.order.filter((k): k is string => typeof k === 'string' && k.length > 0 && k.length <= 64).slice(0, 40)
      : null;
    const hidden = Array.isArray(t?.hidden)
      ? t.hidden.filter((k): k is string => typeof k === 'string' && HIDEABLE_BUILTINS.includes(k))
      : null;
    if (order === null || hidden === null) {
      return err('tabLayout must have order[] and hidden[]', {
        requestId, status: 400, code: 'validation_failed',
      });
    }
    update.inventory_tab_layout = { order, hidden };
  }

  if (body.budgetMode !== undefined) {
    if (body.budgetMode !== 'total' && body.budgetMode !== 'sections') {
      return err('budgetMode must be total or sections', {
        requestId, status: 400, code: 'validation_failed',
      });
    }
    // Budget mode changes the dimension whose dollar caps are snapshotted at
    // month close.  The tab-layout half of this endpoint is operational, but
    // budget configuration must keep the same manager floor + per-property
    // view_financials restriction as the budget rows themselves.  Do not rely
    // on the client hiding the Budgets panel: this route uses service role and
    // would otherwise let any delivery-capable hotel member change accounting
    // behavior with a direct request.
    if (
      !canViewFinancials(gate.role)
      || !(await canForProperty({ role: gate.role }, 'view_financials', pid))
      || !(await isSectionEnabledForProperty(pid, 'financials'))
    ) {
      return err('You do not have permission to change inventory budget settings.', {
        requestId, status: 403, code: 'forbidden_role',
      });
    }
    update.inventory_budget_mode = body.budgetMode;
  }

  if (Object.keys(update).length === 0) {
    return err('nothing to update', { requestId, status: 400, code: 'validation_failed' });
  }

  const { data: saved, error } = await supabaseAdmin.rpc('staxis_update_inventory_property_config', {
    p_property_id: pid,
    p_tab_layout: update.inventory_tab_layout ?? null,
    p_budget_mode: update.inventory_budget_mode ?? null,
    p_actor_id: gate.userId,
    p_actor_name: gate.name,
  });
  if (error) {
    // Log detail server-side; don't leak table/constraint names to the client.
    log.error('[inventory/property-config] update failed', { err: errToString(error) });
    return err('save_failed', { requestId, status: 500, code: 'internal_error' });
  }
  if (saved !== true) {
    return err('property_not_found', { requestId, status: 404, code: 'not_found' });
  }

  return ok({ saved: true }, { requestId });
}
