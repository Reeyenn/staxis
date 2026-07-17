/**
 * /api/inventory/accounting-summary — month-level financial summary for the
 * in-app accounting view. Computes opening / receipts / discards / closing
 * by category, plus YTD trend and budget vs actual.
 *
 * Strategy: replace the email-spreadsheet-to-accountant workflow. Hotels do
 * accounting inside Staxis. M3 stays as a secondary system Hilton-mandated
 * properties still feed; the source-of-truth math lives here.
 *
 * Query: GET ?propertyId=<uuid>&month=YYYY-MM
 *   Defaults month to the current UTC month if missing.
 *
 * Auth: requireFinanceAccess — owner / GM / admin only, per-hotel view_financials
 * honored, plus property scope. This endpoint exposes budget + spend dollars, so
 * it rides the SAME money gate as /api/financials/* (line staff are denied here
 * before any aggregation runs). Switched off the old requireSession +
 * userHasPropertyAccess gate, which had no money capability — line staff could
 * read inventory budgets/spend. (Pre-onboarding access cleanup 2026-06-26.)
 * Aggregation runs through supabaseAdmin so the multi-table joins don't
 * collide with RLS.
 */

import { NextRequest } from 'next/server';
import { requireFinanceAccess } from '@/lib/financials/api-gate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getInventoryAccountingSummary } from '@/lib/db/inventory-accounting';
import { errToString } from '@/lib/utils';
import { log } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const isMonthString = (s: unknown): s is string =>
  typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

export async function GET(req: NextRequest) {
  const url = new URL(req.url);

  // Auth: route through the SAME gate as /api/financials/* — session + finance
  // role floor + the per-hotel Access-tab `view_financials` capability +
  // property scope (validates the pid UUID too). Previously this checked only
  // requireSession + userHasPropertyAccess (no role check), so any signed-in
  // line-staff member (front desk, housekeeping, maintenance) with the property
  // in their access list could read month spend/budget value-by-category.
  // (Security audit 2026-06-26.) Run BEFORE input validation so an unauthorized
  // caller never learns the shape of the query params.
  const gate = await requireFinanceAccess(req, url.searchParams.get('propertyId'));
  if (!gate.ok) return gate.response;

  const monthParam = url.searchParams.get('month');
  if (monthParam != null && !isMonthString(monthParam)) {
    return err('invalid_month', {
      requestId: gate.requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  // Resolve monthStart in UTC. The page sends YYYY-MM; we anchor to day 1.
  const now = new Date();
  const fallbackMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const month = monthParam ?? fallbackMonth;
  const [yearStr, mStr] = month.split('-');
  const monthStart = new Date(Date.UTC(Number(yearStr), Number(mStr) - 1, 1));

  try {
    const summary = await getInventoryAccountingSummary(supabaseAdmin, gate.pid, monthStart);
    return ok(summary, { requestId: gate.requestId });
  } catch (e) {
    // Log the detail server-side; don't leak PostgREST table/column/constraint
    // names to the client (matches scan-invoice's hardening). (Audit fix 2026-06-18.)
    log.error('[inventory/accounting-summary] aggregation failed', { err: errToString(e) });
    return err('aggregation_failed', {
      requestId: gate.requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
