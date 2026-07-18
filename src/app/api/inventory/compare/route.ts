/**
 * GET /api/inventory/compare?propertyId=&from=YYYY-MM-DD&to=YYYY-MM-DD&tz=
 *
 * Flow totals for ONE arbitrary local-date window, powering the Compare
 * overlay's month / year / custom side-by-side view (the client calls this
 * once per side):
 *
 *   - receiptsValue   — Σ inventory_orders.total_cost received in the window ($)
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

// Same delivery/discard valuation as getInventoryAccountingSummary: prefer the
// stored total, fall back to unit × quantity so Compare and Reports can never
// disagree about what the same row cost.
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
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || to < from) {
    return err('invalid_range', {
      requestId: gate.requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  const tzParam = url.searchParams.get('tz');
  let tz = 'UTC';
  if (tzParam && tzParam.length <= 64) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tzParam });
      tz = tzParam;
    } catch { /* unknown zone → UTC */ }
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
    const [orderRows, discardRows, countRows, firstItemQ, firstCountQ, firstOrderQ] = await Promise.all([
      fetchAllRows<{ total_cost: number | null; quantity: number | null; unit_cost: number | null }>(
        (a, b) => supabaseAdmin
          .from('inventory_orders')
          .select('total_cost, quantity, unit_cost')
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
    ]);
    const firstErr = firstItemQ.error ?? firstCountQ.error ?? firstOrderQ.error;
    if (firstErr) throw firstErr;

    const receiptsValue = orderRows.reduce(
      (s, r) => s + rowValue({ total: r.total_cost, quantity: r.quantity, unit_cost: r.unit_cost }), 0,
    );
    const discardsValue = discardRows.reduce(
      (s, r) => s + rowValue({ total: r.cost_value, quantity: r.quantity, unit_cost: r.unit_cost }), 0,
    );
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

    return ok(
      { receiptsValue, discardsValue, countSessions: sessions.size, firstActivityAt },
      { requestId: gate.requestId },
    );
  } catch (e) {
    log.error('[inventory/compare] aggregation failed', { err: errToString(e) });
    return err('aggregation_failed', {
      requestId: gate.requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
