// GET/POST /api/inventory/property-config — read/reconcile or persist the
// hotel's inventory tab layout and/or budget mode. Management-only
// (requireOrderingAccess — the same capability that shows the tab editor and
// Budgets panel).
//
// Exists because these two values live on the `properties` row, whose RLS only
// lets admins UPDATE. A general manager editing tabs through the anon client
// got a silent no-op (PostgREST returns 200 with no rows), the UI showed the
// change, and a reload brought the old tabs back. Writes go through
// supabaseAdmin here instead; failures now surface as real errors.

import type { NextRequest } from 'next/server';
import { ApiErrorCode, ok, err } from '@/lib/api-response';
import { validateUuid } from '@/lib/api-validate';
import { requireOrderingAccess } from '@/lib/ordering/api-gate';
import { isSectionEnabled } from '@/lib/sections/registry';
import { capabilityDecisionForProperty } from '@/lib/capabilities/server';
import { capabilityUnavailableResponse } from '@/lib/capabilities/api-gate';
import { canViewFinancials } from '@/lib/roles';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';
import { log } from '@/lib/log';
import {
  inventoryTabLayoutStateFromStored,
  parseInventoryTabLayout,
  parseInventoryTabLayoutWriteResult,
} from '@/lib/inventory-tab-layout-ordering';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  pid?: string;
  tabLayout?: { order?: unknown; hidden?: unknown };
  budgetMode?: unknown;
  operationId?: unknown;
  expectedRevision?: unknown;
}

const HIDEABLE_BUILTINS = ['general', 'breakfast'];
// PostgREST hoists the RPC's 8s statement_timeout before query execution. This
// outer bound also covers pool acquisition and response transport in the API
// process; a client safely retries the same operationId if it fires.
const ORDERED_LAYOUT_RPC_HTTP_TIMEOUT_MS = 12_000;

export async function GET(req: NextRequest): Promise<Response> {
  const requestedPid = req.nextUrl.searchParams.get('pid') ?? undefined;
  const gate = await requireOrderingAccess(req, requestedPid);
  if (!gate.ok) return gate.response;
  const { pid, requestId } = gate;

  const { data, error } = await supabaseAdmin
    .from('properties')
    .select('inventory_tab_layout')
    .eq('id', pid)
    .maybeSingle();
  if (error) {
    log.error('[inventory/property-config] reconciliation read failed', { err: errToString(error) });
    return err('read_failed', { requestId, status: 500, code: 'internal_error' });
  }
  if (!data) {
    return err('property_not_found', { requestId, status: 404, code: 'not_found' });
  }

  const operationIdRaw = req.nextUrl.searchParams.get('operationId');
  let operation: {
    operationId: string;
    expectedRevision: number;
    appliedRevision: number;
    tabLayout: ReturnType<typeof parseInventoryTabLayout>;
    budgetMode: 'total' | 'sections' | null;
    actorMatches: boolean;
  } | null = null;
  if (operationIdRaw !== null) {
    const operationId = validateUuid(operationIdRaw, 'operationId');
    if (operationId.error) {
      return err(operationId.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    const { data: receipt, error: receiptError } = await supabaseAdmin
      .from('inventory_tab_layout_operations')
      .select('operation_id, expected_revision, applied_revision, requested_layout, requested_budget_mode, actor_id')
      .eq('operation_id', operationId.value as string)
      .eq('property_id', pid)
      .maybeSingle();
    if (receiptError) {
      log.error('[inventory/property-config] operation reconciliation failed', {
        err: errToString(receiptError),
      });
      return err('read_failed', { requestId, status: 500, code: ApiErrorCode.InternalError });
    }
    if (receipt) {
      operation = {
        operationId: receipt.operation_id,
        expectedRevision: receipt.expected_revision,
        appliedRevision: receipt.applied_revision,
        tabLayout: parseInventoryTabLayout(receipt.requested_layout),
        budgetMode: receipt.requested_budget_mode === 'total'
          || receipt.requested_budget_mode === 'sections'
          ? receipt.requested_budget_mode
          : null,
        actorMatches: receipt.actor_id === gate.userId,
      };
    }
  }

  return ok({
    ...inventoryTabLayoutStateFromStored(data.inventory_tab_layout),
    operation,
  }, { requestId });
}

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
    const capabilityDecision = canViewFinancials(gate.role)
      ? await capabilityDecisionForProperty({ role: gate.role }, 'view_financials', pid)
      : 'denied';
    if (capabilityDecision === 'unavailable') {
      return capabilityUnavailableResponse(requestId);
    }
    if (capabilityDecision === 'denied' || !isSectionEnabled(gate.enabledSections, 'financials')) {
      return err('You do not have permission to change inventory budget settings.', {
        requestId, status: 403, code: 'forbidden_role',
      });
    }
    update.inventory_budget_mode = body.budgetMode;
  }

  if (Object.keys(update).length === 0) {
    return err('nothing to update', { requestId, status: 400, code: 'validation_failed' });
  }

  if (update.inventory_tab_layout !== undefined) {
    const operationId = validateUuid(body.operationId, 'operationId');
    if (operationId.error) {
      return err(operationId.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    if (
      typeof body.expectedRevision !== 'number'
      || !Number.isSafeInteger(body.expectedRevision)
      || body.expectedRevision < 0
    ) {
      return err('expectedRevision must be a non-negative safe integer', {
        requestId, status: 400, code: ApiErrorCode.ValidationFailed,
      });
    }

    const { data, error } = await supabaseAdmin
      .rpc('staxis_write_inventory_tab_layout_ordered', {
        p_property_id: pid,
        p_tab_layout: update.inventory_tab_layout,
        p_expected_revision: body.expectedRevision,
        p_operation_id: operationId.value as string,
        p_budget_mode: update.inventory_budget_mode ?? null,
        p_actor_id: gate.userId,
        p_actor_name: gate.name,
      })
      .abortSignal(AbortSignal.timeout(ORDERED_LAYOUT_RPC_HTTP_TIMEOUT_MS));
    if (error) {
      // 55P03 = lock_timeout; 57014 = statement_timeout/query cancellation.
      // Both are terminal for this HTTP attempt but safely retryable with the
      // SAME operationId and expected revision.
      const retryable = error.code === '55P03'
        || error.code === '57014'
        || /abort|timeout/i.test(`${error.message ?? ''} ${error.details ?? ''}`);
      log.error('[inventory/property-config] ordered layout update failed', {
        requestId,
        err: errToString(error),
        retryable,
      });
      return err(retryable ? 'save_timed_out' : 'save_failed', {
        requestId,
        status: retryable ? 503 : 500,
        code: retryable ? ApiErrorCode.UpstreamFailure : ApiErrorCode.InternalError,
        ...(retryable ? { headers: { 'Retry-After': '1' } } : {}),
      });
    }

    const result = parseInventoryTabLayoutWriteResult(data);
    if (!result) {
      log.error('[inventory/property-config] invalid ordered layout result', { requestId });
      return err('save_failed', { requestId, status: 500, code: ApiErrorCode.InternalError });
    }
    if (result.status === 'not_found') {
      return err('property_not_found', { requestId, status: 404, code: ApiErrorCode.NotFound });
    }
    if (result.status === 'operation_conflict') {
      return err('operation_id_reused', {
        requestId,
        status: 409,
        code: ApiErrorCode.IdempotencyConflict,
        details: result,
      });
    }
    if (result.status === 'revision_conflict') {
      return err('tab_layout_changed', {
        requestId,
        status: 409,
        code: 'layout_revision_conflict',
        details: result,
      });
    }

    return ok({ saved: true, ...result }, { requestId });
  }

  // Budget-only writes retain their existing contract. They never touch the
  // layout column, so they cannot bypass or weaken the ordered layout fence.
  const { data: saved, error } = await supabaseAdmin.rpc('staxis_update_inventory_property_config', {
    p_property_id: pid,
    p_tab_layout: null,
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
