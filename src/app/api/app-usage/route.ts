/**
 * GET /api/app-usage?propertyId=<uuid>
 *
 * Returns { usage: { housekeeping: bool, communications: bool, maintenance:
 * bool, inventory: bool, staff: bool, financials: bool } } — which apps the
 * hotel is actually USING, so the top nav lights the active ones and greys +
 * sinks the rest. "In use" = at least one row in any of the app's activity
 * signal tables (see src/lib/app-usage/registry.ts).
 *
 * Mirrors /api/capabilities/overrides: signed-in + property-access gated, reads
 * via supabaseAdmin (the signal tables are RLS-restricted, so an anon browser
 * read would return [] and grey everything for a logged-in owner — the RLS
 * silent-empty trap). The map isn't sensitive: it only reflects the caller's
 * own hotel's activity. PropertyContext fetches it fail-soft — any error → {} →
 * nothing greyed.
 */

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import {
  APP_USAGE_SIGNALS,
  APP_KEYS,
  type AppKey,
  type AppUsageMap,
} from '@/lib/app-usage/registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Does this table have ≥1 row for the property? A single-row existence probe
 * (cheaper than an exact count). Tri-state on purpose:
 *   true  → has at least one row (app is in use)
 *   false → query succeeded and there are genuinely zero rows
 *   null  → the query ERRORED (missing table/column, transient timeout, pool
 *           exhaustion, PostgREST schema-cache miss) — "unknown", NOT "empty".
 * Conflating an error with "empty" would let a transient DB hiccup silently
 * grey an app the hotel actually uses (worst for the single-signal apps —
 * communications, staff), defeating the fail-soft invariant.
 */
async function tableHasRow(table: string, propertyId: string): Promise<boolean | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from(table)
      .select('property_id')
      .eq('property_id', propertyId)
      .limit(1);
    if (error) return null;
    return Array.isArray(data) && data.length > 0;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);

  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  const pid = new URL(req.url).searchParams.get('propertyId') ?? '';
  const idCheck = validateUuid(pid, 'propertyId');
  if (idCheck.error || !idCheck.value) {
    return err('propertyId is required', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }

  const hasAccess = await userHasPropertyAccess(session.userId, idCheck.value);
  if (!hasAccess) {
    return err('no access to this property', {
      requestId,
      status: 403,
      code: ApiErrorCode.Forbidden,
    });
  }

  const propertyId = idCheck.value;

  // One existence probe per signal table, all in parallel.
  const perApp = await Promise.all(
    APP_KEYS.map(async (app): Promise<[AppKey, boolean] | null> => {
      const tables = APP_USAGE_SIGNALS[app];
      const results = await Promise.all(tables.map((t) => tableHasRow(t, propertyId)));
      // In use if ANY signal concretely has a row.
      if (results.some((r) => r === true)) return [app, true];
      // Otherwise only declare it NOT in use (which greys + sinks it) when EVERY
      // probe answered a concrete `false`. If any probe errored (null), omit the
      // key entirely → the client treats "absent" as in use, so a transient DB
      // hiccup never greys an app the hotel actually relies on.
      if (results.some((r) => r === null)) return null;
      return [app, false];
    }),
  );

  const usage = Object.fromEntries(perApp.filter(Boolean) as [AppKey, boolean][]) as AppUsageMap;
  return ok({ usage }, { requestId });
}
