/**
 * Finance-gated cost overlay for the operational Inventory board.
 *
 * Browser table grants expose quantities, names, dates, and other operational
 * evidence only.  This route proves the caller's role, hotel membership,
 * per-hotel view_financials capability, and Financials section state before a
 * service-role RPC returns costs keyed by the immutable source-row ids.
 */

import { NextRequest } from 'next/server';
import { requireFinanceAccess } from '@/lib/financials/api-gate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { requireSectionEnabled } from '@/lib/sections/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type MoneyPair = Record<string, number | null>;

export interface InventoryFinancialEvidence {
  inventory: Record<string, MoneyPair & {
    unitCost: number | null;
    openingAdjustmentUnitCost: number | null;
  }>;
  counts: Record<string, MoneyPair & {
    unitCost: number | null;
    varianceValue: number | null;
  }>;
  orders: Record<string, MoneyPair & {
    unitCost: number | null;
    totalCost: number | null;
  }>;
  discards: Record<string, MoneyPair & {
    unitCost: number | null;
    costValue: number | null;
  }>;
  currentMonthSpend: {
    total: number;
    complete: boolean;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNullableFinite(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function validMoneyMap(
  value: unknown,
  fields: readonly string[],
): value is Record<string, MoneyPair> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => isRecord(entry)
    && fields.every((field) => isNullableFinite(entry[field])));
}

function isFinancialEvidence(value: unknown): value is InventoryFinancialEvidence {
  if (!isRecord(value) || !isRecord(value.currentMonthSpend)) return false;
  return validMoneyMap(value.inventory, ['unitCost', 'openingAdjustmentUnitCost'])
    && validMoneyMap(value.counts, ['unitCost', 'varianceValue'])
    && validMoneyMap(value.orders, ['unitCost', 'totalCost'])
    && validMoneyMap(value.discards, ['unitCost', 'costValue'])
    && typeof value.currentMonthSpend.total === 'number'
    && Number.isFinite(value.currentMonthSpend.total)
    && typeof value.currentMonthSpend.complete === 'boolean';
}

export async function GET(req: NextRequest) {
  const gate = await requireFinanceAccess(req, req.nextUrl.searchParams.get('propertyId'));
  if (!gate.ok) return gate.response;
  const sectionGate = await requireSectionEnabled(req, gate.pid, 'inventory');
  if (!sectionGate.ok) return sectionGate.response;

  try {
    const { data, error } = await supabaseAdmin.rpc(
      'staxis_list_inventory_financial_evidence',
      { p_property_id: gate.pid },
    );
    if (error) throw error;
    if (!isFinancialEvidence(data)) {
      throw new Error('inventory financial evidence returned an invalid shape');
    }
    return ok(data, {
      requestId: gate.requestId,
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    log.error('[inventory/financial-evidence] load failed', {
      propertyId: gate.pid,
      err: errToString(error),
    });
    return err('Inventory financial details are unavailable.', {
      requestId: gate.requestId,
      status: 503,
      code: ApiErrorCode.InternalError,
      headers: { 'Cache-Control': 'private, no-store' },
    });
  }
}
