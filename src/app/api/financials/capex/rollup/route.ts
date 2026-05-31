/**
 * /api/financials/capex/rollup — multi-property CapEx rollup for owners.
 *
 *   GET → { rollup: { properties[], totals } }
 *
 * Aggregates CapEx across every property the caller may see, resolved server-
 * side from their own property_access (requireFinanceRollup). A caller can never
 * roll up a hotel they don't own; admins legitimately see all.
 */

import type { NextRequest } from 'next/server';
import { requireFinanceRollup } from '@/lib/financials/api-gate';
import { ok, err } from '@/lib/api-response';
import { capexRollup } from '@/lib/financials/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const gate = await requireFinanceRollup(req);
  if (!gate.ok) return gate.response;

  try {
    const rollup = await capexRollup(gate.propertyIds);
    return ok({ rollup }, { requestId: gate.requestId });
  } catch {
    return err('failed to build rollup', { requestId: gate.requestId, status: 500, code: 'rollup_failed' });
  }
}
