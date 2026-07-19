/**
 * GET /api/inventory/compare?propertyId=&from=YYYY-MM-DD&to=YYYY-MM-DD&basis=
 *
 * Flow totals for ONE arbitrary local-date window, powering the Compare
 * overlay's month / year / custom side-by-side view (the client calls this
 * once per side):
 *
 *   - receiptsValue   — complete logged-purchase total, or null when a line
 *                       lacks cost (knownReceiptsValue remains a subtotal)
 *   - actualUsageValue/status — immutable monthly close actual, never inferred
 *                       from purchases. Custom ranges return unavailable.
 *   - discardsValue   — Σ inventory_discards.cost_value discarded in the window ($)
 *   - countSessions   — distinct count saves (count_session_id, legacy rows
 *                       fall back to their exact timestamp) in the window
 *   - firstActivityAt — the property's earliest inventory signal (first item
 *                       created, first count, first delivery). The client uses
 *                       it to render an honest "No data" for windows that END
 *                       before the hotel started tracking, instead of a $0
 *                       that reads like a real number.
 *
 * Auth mirrors /api/inventory/accounting-summary: requireFinanceAccess
 * (session + finance role floor + view_financials capability + property
 * scope). Window is inclusive of `to` (…through the end of that local day).
 */

import { NextRequest } from 'next/server';
import { requireFinanceAccess } from '@/lib/financials/api-gate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { localDayStartUTC } from '@/lib/db/inventory-accounting';
import { fetchAllRows } from '@/lib/supabase-paginate';
import { errToString } from '@/lib/utils';
import { log } from '@/lib/log';
import { listInventoryMonthCloseHistory } from '@/lib/db/inventory-month-closes';
import { summarizeEffectivePurchasesForProperty } from '@/lib/db/inventory-effective-purchases';
import type { EffectivePurchaseOrderInput } from '@/lib/inventory-effective-purchases';
import {
  resolveInventoryCompareActual,
  type InventoryCompareBasis,
} from '@/lib/inventory-compare-actual';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
// A comparison window longer than ~2 years is a mis-tap, not a use case —
// keep the row scans bounded.
const MAX_WINDOW_DAYS = 750;

function parseDate(s: string): [number, number, number] {
  const [y, m, d] = s.split('-').map(Number);
  return [y, m, d];
}

function isCalendarDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [year, month1, day] = parseDate(value);
  const date = new Date(Date.UTC(year, month1 - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month1 && date.getUTCDate() === day;
}

function monthKeyInZone(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date(iso));
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  return year && month ? `${year}-${month}` : iso.slice(0, 7);
}

// Discards are not append-only correction chains, so their row valuation can
// stay local. Deliveries must use summarizeEffectivePurchasesForProperty below
// so Compare, Reports, and Month Close agree after a correction or full void.
function rowValue(r: { total: number | null; quantity: number | null; unit_cost: number | null }): number {
  if (r.total != null) return Number(r.total);
  if (r.unit_cost != null && r.quantity != null) return Number(r.unit_cost) * Number(r.quantity);
  return 0;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const gate = await requireFinanceAccess(req, url.searchParams.get('propertyId'));
  if (!gate.ok) return gate.response;

  const from = url.searchParams.get('from') ?? '';
  const to = url.searchParams.get('to') ?? '';
  if (!isCalendarDate(from) || !isCalendarDate(to) || to < from) {
    return err('invalid_range', {
      requestId: gate.requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }
  const basisParam = url.searchParams.get('basis');
  if (basisParam != null && basisParam !== 'months' && basisParam !== 'years' && basisParam !== 'custom') {
    return err('invalid_basis', {
      requestId: gate.requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }
  const basis: InventoryCompareBasis = basisParam === 'months' || basisParam === 'years' || basisParam === 'custom'
    ? basisParam
    : 'custom';

  let tz: string;
  try {
    const { data: property, error: propertyError } = await supabaseAdmin
      .from('properties')
      .select('timezone')
      .eq('id', gate.pid)
      .maybeSingle();
    if (propertyError) throw propertyError;
    const propertyTimezone = (property as { timezone?: string | null } | null)?.timezone?.trim();
    if (!propertyTimezone) throw new Error('property timezone is unavailable');
    new Intl.DateTimeFormat('en-US', { timeZone: propertyTimezone }).format(new Date());
    tz = propertyTimezone;
  } catch (e) {
    log.error('[inventory/compare] property timezone failed', { err: errToString(e) });
    return err('aggregation_failed', {
      requestId: gate.requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  const [fy, fm, fd] = parseDate(from);
  const [ty, tm, td] = parseDate(to);
  const start = localDayStartUTC(fy, fm, fd, tz);
  // Inclusive `to`: the exclusive bound is local midnight of the NEXT day.
  const endExclusive = localDayStartUTC(ty, tm, td + 1, tz);
  if ((endExclusive.getTime() - start.getTime()) / 86_400_000 > MAX_WINDOW_DAYS) {
    return err('range_too_long', {
      requestId: gate.requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  try {
    const startIso = start.toISOString();
    const endIso = endExclusive.toISOString();
    const [orderRows, discardRows, countRows, firstItemQ, firstCountQ, firstOrderQ, closeHistory] = await Promise.all([
      fetchAllRows<EffectivePurchaseOrderInput>(
        (a, b) => supabaseAdmin
          .from('inventory_orders')
          .select('id,item_id,total_cost,quantity,unit_cost,received_at,entry_kind,corrects_order_id,correction_event_id')
          .eq('property_id', gate.pid)
          .gte('received_at', startIso)
          .lt('received_at', endIso)
          .order('received_at', { ascending: true })
          .range(a, b),
      ),
      fetchAllRows<{ cost_value: number | null; quantity: number | null; unit_cost: number | null }>(
        (a, b) => supabaseAdmin
          .from('inventory_discards')
          .select('cost_value, quantity, unit_cost')
          .eq('property_id', gate.pid)
          .gte('discarded_at', startIso)
          .lt('discarded_at', endIso)
          .order('discarded_at', { ascending: true })
          .range(a, b),
      ),
      fetchAllRows<{ count_session_id: string | null; counted_at: string | null }>(
        (a, b) => supabaseAdmin
          .from('inventory_counts')
          .select('count_session_id, counted_at')
          .eq('property_id', gate.pid)
          .gte('counted_at', startIso)
          .lt('counted_at', endIso)
          .order('counted_at', { ascending: true })
          .range(a, b),
      ),
      supabaseAdmin
        .from('inventory')
        .select('created_at')
        .eq('property_id', gate.pid)
        .not('created_at', 'is', null)
        .order('created_at', { ascending: true })
        .limit(1),
      supabaseAdmin
        .from('inventory_counts')
        .select('counted_at')
        .eq('property_id', gate.pid)
        .order('counted_at', { ascending: true })
        .limit(1),
      supabaseAdmin
        .from('inventory_orders')
        .select('received_at')
        .eq('property_id', gate.pid)
        .not('received_at', 'is', null)
        .order('received_at', { ascending: true })
        .limit(1),
      listInventoryMonthCloseHistory(supabaseAdmin, gate.pid, 120),
    ]);
    const firstErr = firstItemQ.error ?? firstCountQ.error ?? firstOrderQ.error;
    if (firstErr) throw firstErr;

    const purchaseSummary = await summarizeEffectivePurchasesForProperty(
      supabaseAdmin,
      gate.pid,
      orderRows,
    );
    const knownReceiptsValue = purchaseSummary.knownLoggedPurchaseCents / 100;
    const purchasesComplete = purchaseSummary.uncostedDeliveryCount === 0;
    const receiptsValue = purchaseSummary.loggedPurchaseCents == null
      ? null
      : purchaseSummary.loggedPurchaseCents / 100;
    const knownDiscardsValue = discardRows.reduce(
      (s: number, r: { cost_value: number | null; quantity: number | null; unit_cost: number | null }) =>
        s + rowValue({ total: r.cost_value, quantity: r.quantity, unit_cost: r.unit_cost }), 0,
    );
    const discardsComplete = discardRows.every(
      (r: { cost_value: number | null; quantity: number | null; unit_cost: number | null }) =>
        r.cost_value != null || (r.unit_cost != null && r.quantity != null),
    );
    const discardsValue = discardsComplete ? knownDiscardsValue : null;
    const sessions = new Set<string>();
    for (const r of countRows) {
      sessions.add(r.count_session_id ?? `t:${r.counted_at}`);
    }

    const candidates = [
      (firstItemQ.data?.[0]?.created_at as string | undefined) ?? null,
      (firstCountQ.data?.[0]?.counted_at as string | undefined) ?? null,
      (firstOrderQ.data?.[0]?.received_at as string | undefined) ?? null,
    ].filter((s): s is string => s != null);
    const firstActivityAt = candidates.length ? candidates.sort()[0] : null;
    const currentMonth = monthKeyInZone(new Date().toISOString(), tz);
    const actual = resolveInventoryCompareActual({
      basis,
      from,
      to,
      currentMonth,
      closes: closeHistory,
    });

    return ok(
      {
        receiptsValue,
        knownReceiptsValue,
        purchasesComplete,
        ...actual,
        discardsValue,
        knownDiscardsValue,
        discardsComplete,
        countSessions: sessions.size,
        firstActivityAt,
      },
      { requestId: gate.requestId },
    );
  } catch (e) {
    log.error('[inventory/compare] aggregation failed', { err: errToString(e) });
    return err('aggregation_failed', {
      requestId: gate.requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
