// GET /api/inventory/spend-rollup?from=&to= — cross-property inventory spend
// for an owner, rolled up per property / vendor / category (in CENTS) from the
// existing inventory_orders ledger. Reuses requireFinanceRollup (financials
// gate) — same owner/GM/admin trio — which resolves the FULL set of property
// ids the caller may see server-side. Mirrors /api/financials/capex/rollup.

import { defineRoute } from '@/lib/api-route';
import { requireFinanceRollup } from '@/lib/financials/api-gate';
import { spendRollup } from '@/lib/ordering/db';
import { checkAndIncrementRateLimit, rateLimitedResponse, hashToRateLimitKey } from '@/lib/api-ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = defineRoute({
  resolve: (req) => requireFinanceRollup(req),
  handler: async (ctx) => {
    // Per-user bucket (multi-property read → no single pid). Non-billing →
    // fails open if the limiter RPC errors.
    const rl = await checkAndIncrementRateLimit('inventory-spend-rollup', hashToRateLimitKey(ctx.userId));
    if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

    const fromParam = ctx.req.nextUrl.searchParams.get('from');
    const toParam = ctx.req.nextUrl.searchParams.get('to');
    const toIso = toParam && !Number.isNaN(Date.parse(toParam)) ? new Date(toParam).toISOString() : new Date().toISOString();
    const fromIso = fromParam && !Number.isNaN(Date.parse(fromParam))
      ? new Date(fromParam).toISOString()
      : new Date(Date.now() - 90 * 86_400_000).toISOString();

    try {
      const rollup = await spendRollup(ctx.propertyIds, fromIso, toIso);
      return ctx.ok({ rollup });
    } catch {
      return ctx.err('failed to build spend rollup', { status: 500, code: 'rollup_failed' });
    }
  },
});
