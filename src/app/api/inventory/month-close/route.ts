/**
 * Finance-gated inventory month close.
 *
 * GET  ?propertyId=<uuid>&month=YYYY-MM (month optional)
 * POST { propertyId, month, action, requestId, ... }
 *
 * Finance evidence is service-role-only in Postgres. The route proves property
 * membership/financial access before every read; mutations additionally honor
 * the property's manage_inventory_orders capability.
 */

import { NextRequest } from 'next/server';
import { requireFinanceAccess, isUuid } from '@/lib/financials/api-gate';
import { capabilityDecisionForProperty } from '@/lib/capabilities/server';
import { capabilityUnavailableResponse } from '@/lib/capabilities/api-gate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  closeInventoryMonthClose,
  getInventoryMonthCloseDashboard,
  startInventoryMonthClose,
} from '@/lib/db/inventory-month-closes';
import {
  isMonthKey,
  inventoryMonthCloseMutationFailure,
  purchaseSource,
  validatePurchaseSelection,
  type InventoryMonthClosePostBody,
} from '@/lib/inventory-month-close';
import { inventoryMonthCloseMutationReceipt } from '@/lib/inventory-month-close-contract';
import { log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { requireSectionEnabled } from '@/lib/sections/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const gate = await requireFinanceAccess(req, url.searchParams.get('propertyId'));
  if (!gate.ok) return gate.response;
  const sectionGate = await requireSectionEnabled(req, gate.pid, 'inventory');
  if (!sectionGate.ok) return sectionGate.response;

  const month = url.searchParams.get('month');
  if (month != null && !isMonthKey(month)) {
    return err('month must be YYYY-MM', {
      requestId: gate.requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }

  try {
    const dashboard = await getInventoryMonthCloseDashboard(
      supabaseAdmin,
      gate.pid,
      month ?? undefined,
    );
    return ok(dashboard, { requestId: gate.requestId });
  } catch (error) {
    log.error('[inventory/month-close] dashboard failed', {
      propertyId: gate.pid,
      err: errToString(error),
    });
    return err('The inventory month close could not be loaded.', {
      requestId: gate.requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  }
}

export async function POST(req: NextRequest) {
  let body: InventoryMonthClosePostBody;
  try {
    const parsed: unknown = await req.json();
    if (!record(parsed)) throw new Error('body must be an object');
    body = parsed;
  } catch {
    return err('A valid JSON body is required.', {
      requestId: req.headers.get('x-request-id') ?? crypto.randomUUID(),
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }

  const propertyId = typeof body.propertyId === 'string' ? body.propertyId : null;
  const gate = await requireFinanceAccess(req, propertyId);
  if (!gate.ok) return gate.response;
  const sectionGate = await requireSectionEnabled(req, gate.pid, 'inventory');
  if (!sectionGate.ok) return sectionGate.response;

  const capabilityDecision = await capabilityDecisionForProperty(
    { role: gate.role },
    'manage_inventory_orders',
    gate.pid,
  );
  if (capabilityDecision === 'unavailable') {
    return capabilityUnavailableResponse(gate.requestId);
  }
  if (capabilityDecision === 'denied') {
    return err('You do not have permission to start or close inventory periods.', {
      requestId: gate.requestId,
      status: 403,
      code: ApiErrorCode.Forbidden,
    });
  }
  if (!isMonthKey(body.month)) {
    return err('month must be YYYY-MM', {
      requestId: gate.requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }
  if (!isUuid(body.requestId)) {
    return err('requestId must be a UUID', {
      requestId: gate.requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }
  if (body.action !== 'start' && body.action !== 'close') {
    return err('action must be start or close', {
      requestId: gate.requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }
  if (body.notes != null && (typeof body.notes !== 'string' || body.notes.length > 2_000)) {
    return err('notes must be at most 2000 characters', {
      requestId: gate.requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }

  try {
    if (body.action === 'start') {
      if (body.purchaseSource != null || body.manualPurchaseCents != null) {
        return err('purchase fields are only valid when closing', {
          requestId: gate.requestId,
          status: 400,
          code: ApiErrorCode.ValidationFailed,
        });
      }
      await startInventoryMonthClose(supabaseAdmin, {
        propertyId: gate.pid,
        month: body.month,
        requestId: body.requestId,
        actorId: gate.userId,
        actorName: gate.name,
      });
    } else {
      const source = purchaseSource(body.purchaseSource);
      if (!source) {
        return err('purchaseSource must be logged_deliveries, manual_total, or zero', {
          requestId: gate.requestId,
          status: 400,
          code: ApiErrorCode.ValidationFailed,
        });
      }
      const selection = validatePurchaseSelection(source, body.manualPurchaseCents);
      if (selection.error) {
        return err(selection.error, {
          requestId: gate.requestId,
          status: 400,
          code: ApiErrorCode.ValidationFailed,
        });
      }
      await closeInventoryMonthClose(supabaseAdmin, {
        propertyId: gate.pid,
        month: body.month,
        requestId: body.requestId,
        purchaseSource: source,
        manualPurchaseCents: selection.manualPurchaseCents,
        actorId: gate.userId,
        actorName: gate.name,
        notes: typeof body.notes === 'string' ? body.notes : null,
      });
    }
  } catch (error) {
    const mapped = inventoryMonthCloseMutationFailure(error, body.action);
    log.error('[inventory/month-close] mutation failed', {
      propertyId: gate.pid,
      month: body.month,
      action: body.action,
      dbCode: record(error) && typeof error.code === 'string' ? error.code : null,
      err: errToString(error),
    });
    return err(mapped.message, {
      requestId: gate.requestId,
      status: mapped.status,
      code: mapped.code,
    });
  }

  // The mutation above is already committed and idempotently tied to the
  // caller's request UUID. A follow-up read failure must never be described as
  // “nothing changed,” or the manager may retry with a new request and lose
  // confidence in a close that actually succeeded.
  try {
    const dashboard = await getInventoryMonthCloseDashboard(supabaseAdmin, gate.pid, body.month);
    return ok(dashboard, { requestId: gate.requestId });
  } catch (error) {
    log.error('[inventory/month-close] committed but dashboard hydration failed', {
      propertyId: gate.pid,
      month: body.month,
      action: body.action,
      requestId: body.requestId,
      err: errToString(error),
    });
    return ok(inventoryMonthCloseMutationReceipt({
      propertyId: gate.pid,
      action: body.action,
      month: body.month,
      mutationRequestId: body.requestId,
    }), { requestId: gate.requestId, status: 202 });
  }
}
