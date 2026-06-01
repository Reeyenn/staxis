// GET /api/inventory/spend-rollup?from=&to= — cross-property inventory spend
// for an owner, rolled up per property / vendor / category (in CENTS) from the
// existing inventory_orders ledger. Reuses requireFinanceRollup (financials
// gate) — same owner/GM/admin trio — which resolves the FULL set of property
// ids the caller may see server-side. Mirrors /api/financials/capex/rollup.

import type { NextRequest } from 'next/server';
import { ok, err } from '@/lib/api-response';
import { requireFinanceRollup } from '@/lib/financials/api-gate';
import { spendRollup } from '@/lib/ordering/db';
import { checkAndIncrementRateLimit, rateLimitedResponse, hashToRateLimitKey } from '@/lib/api-ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const gate = await requireFinanceRollup(req);
  if (!gate.ok) return gate.response;

  // Per-user bucket (multi-property read → no single pid). Non-billing →
  // fails open if the limiter RPC errors.
  const rl = await checkAndIncrementRateLimit('inventory-spend-rollup', hashToRateLimitKey(gate.userId));
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const fromParam = req.nextUrl.searchParams.get('from');
  const toParam = req.nextUrl.searchParams.get('to');
  const toIso = toParam && !Number.isNaN(Date.parse(toParam)) ? new Date(toParam).toISOString() : new Date().toISOString();
  const fromIso = fromParam && !Number.isNaN(Date.parse(fromParam))
    ? new Date(fromParam).toISOString()
    : new Date(Date.now() - 90 * 86_400_000).toISOString();

  try {
    const rollup = await spendRollup(gate.propertyIds, fromIso, toIso);
    return ok({ rollup }, { requestId: gate.requestId });
  } catch {
    return err('failed to build spend rollup', { requestId: gate.requestId, status: 500, code: 'rollup_failed' });
  }
}
