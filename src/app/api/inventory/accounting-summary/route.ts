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
 * Auth: requireSession + userHasPropertyAccess.
 * Aggregation runs through supabaseAdmin so the multi-table joins don't
 * collide with RLS — but the auth check above guarantees scope.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getInventoryAccountingSummary } from '@/lib/db/inventory-accounting';
import { log, getOrMintRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const isUuid = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

const isMonthString = (s: unknown): s is string =>
  typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return session.response;

  const url = new URL(req.url);
  const propertyId = url.searchParams.get('propertyId');
  const monthParam = url.searchParams.get('month');

  if (!isUuid(propertyId)) {
    return NextResponse.json({ ok: false, error: 'invalid_property_id' }, { status: 400 });
  }
  if (monthParam != null && !isMonthString(monthParam)) {
    return NextResponse.json({ ok: false, error: 'invalid_month' }, { status: 400 });
  }
  if (!(await userHasPropertyAccess(session.userId, propertyId))) {
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }

  // Resolve monthStart in UTC. The page sends YYYY-MM; we anchor to day 1.
  const now = new Date();
  const fallbackMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const month = monthParam ?? fallbackMonth;
  const [yearStr, mStr] = month.split('-');
  const monthStart = new Date(Date.UTC(Number(yearStr), Number(mStr) - 1, 1));

  try {
    const summary = await getInventoryAccountingSummary(supabaseAdmin, propertyId, monthStart);
    return NextResponse.json({
      ok: true,
      data: summary,
    });
  } catch (e) {
    // Don't echo errToString(e) to the client — it can include schema
    // names, query fragments, or upstream error text. Log full detail,
    // return a stable string.
    log.error('inventory-accounting-summary aggregation failed', {
      err: e instanceof Error ? e : new Error(String(e)),
      requestId, propertyId,
    });
    return NextResponse.json(
      { ok: false, error: 'aggregation_failed', requestId },
      { status: 500 },
    );
  }
}
