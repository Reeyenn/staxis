/**
 * /api/financials/capex/forecast — upcoming capital spend by target month
 * (approved + in-progress projects, remaining = estimate − spent). Owner/GM/admin.
 *
 *   GET ?pid= → { forecast: CapexForecastMonth[] }
 */

import type { NextRequest } from 'next/server';
import { requireFinanceAccess } from '@/lib/financials/api-gate';
import { ok, err } from '@/lib/api-response';
import { capexForecastByMonth } from '@/lib/financials/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const pid = req.nextUrl.searchParams.get('pid');
  const gate = await requireFinanceAccess(req, pid);
  if (!gate.ok) return gate.response;

  try {
    const forecast = await capexForecastByMonth(gate.pid);
    return ok({ forecast }, { requestId: gate.requestId });
  } catch {
    return err('failed to build capex forecast', { requestId: gate.requestId, status: 500, code: 'forecast_failed' });
  }
}
