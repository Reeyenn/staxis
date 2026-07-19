/**
 * /api/inventory/accounting-summary — month-level financial summary for the
 * in-app accounting view. Keeps logged purchases separate from immutable
 * monthly beginning / ending / actual-usage snapshots.
 *
 * Strategy: replace the email-spreadsheet-to-accountant workflow. Hotels do
 * accounting inside Staxis. M3 stays as a secondary system Hilton-mandated
 * properties still feed; the source-of-truth math lives here.
 *
 * Query: GET ?propertyId=<uuid>&month=YYYY-MM
 *   Defaults to the current month in the authorized property's timezone.
 *
 * Auth: requireFinanceAccess — owner / GM / admin only, per-hotel view_financials
 * honored, plus property scope. This endpoint exposes budget + inventory dollars, so
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
import { getInventoryAccountingSummary, localMonthWindowUTC } from '@/lib/db/inventory-accounting';
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

  try {
    // Financial periods belong to the hotel, not to the browser. Never trust
    // a caller-controlled `tz` query to move a delivery into another month.
    const { data: property, error: propertyError } = await supabaseAdmin
      .from('properties')
      .select('timezone')
      .eq('id', gate.pid)
      .maybeSingle();
    if (propertyError) throw propertyError;
    const storedTimezone = (property as { timezone?: string | null } | null)?.timezone;
    if (typeof storedTimezone !== 'string' || !storedTimezone.trim()) {
      throw new Error('property timezone is unavailable');
    }
    const tz = storedTimezone.trim();
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    } catch {
      // Never move hotel accounting into UTC just because configuration is
      // invalid; that could shift deliveries across month boundaries while
      // still returning plausible totals.
      throw new Error('property timezone is invalid');
    }

    const nowParts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
    }).formatToParts(new Date());
    const nowYear = nowParts.find((part) => part.type === 'year')?.value;
    const nowMonth = nowParts.find((part) => part.type === 'month')?.value;
    const utcNow = new Date();
    const fallbackYear = String(utcNow.getUTCFullYear());
    const fallbackMonth = String(utcNow.getUTCMonth() + 1).padStart(2, '0');
    const month = monthParam ?? `${nowYear ?? fallbackYear}-${nowMonth ?? fallbackMonth}`;
    const [yearStr, mStr] = month.split('-');
    const window = localMonthWindowUTC(Number(yearStr), Number(mStr), tz);
    const summary = await getInventoryAccountingSummary(supabaseAdmin, gate.pid, window.start, {
      endExclusive: window.endExclusive,
      budgetMonthKey: window.budgetMonthKey,
      timeZone: tz,
    });
    // Keep the property's accounting month explicit. `summary.monthStart`
    // serializes as a UTC timestamp and can be on the prior UTC date for
    // positive-offset hotels, so clients must not infer the label by slicing.
    return ok({ ...summary, monthKey: month }, { requestId: gate.requestId });
  } catch (e) {
    // Log the detail server-side; don't leak PostgREST table/column/constraint
    // names to the client (matches scan-invoice's hardening). (Audit fix 2026-06-18.)
    log.error('[inventory/accounting-summary] aggregation failed', { err: errToString(e) });
    return err('Inventory accounting is unavailable. No totals were calculated.', {
      requestId: gate.requestId, status: 503, code: 'inventory_accounting_unavailable',
    });
  }
}
