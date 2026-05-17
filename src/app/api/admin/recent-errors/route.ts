/**
 * GET /api/admin/recent-errors
 *
 * Recent failures grouped by (source, message) so 100 copies of the
 * same error show as a single row with a count + a list of affected
 * properties. Returned newest-first.
 *
 * Reads three sources and merges them:
 *   1. error_logs   — generic app errors (Sentry mirror, API failures)
 *   2. pull_metrics — CUA / scraper pull failures (ok=false)
 *   3. dashboard_by_date — per-property dashboard pull errors
 *      (error_code IS NOT NULL on a row)
 *
 * Powers the "Recent errors" panel on the Live hotels tab.
 *
 * Optional query params:
 *   ?since=<iso>   default: now - 24h
 *   ?limit=<n>     default: 50, max 200
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log, getOrMintRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

interface ErrorGroup {
  source: string | null;
  message: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  affectedPropertyIds: string[];
  // The most recent stack snippet so the UI can show it on click. We
  // intentionally only return ONE — clicking through to a deeper view
  // can list more if needed later.
  sampleStack: string | null;
}

interface NormalizedError {
  source: string | null;
  message: string;
  stack: string | null;
  property_id: string | null;
  ts: string;
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const sinceParam = url.searchParams.get('since');
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 200);

  const since = sinceParam ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // Run all three queries in parallel — they're independent reads.
  const [logsRes, pullsRes, dashRes] = await Promise.all([
    supabaseAdmin
      .from('error_logs')
      .select('source, message, stack, property_id, ts')
      .gte('ts', since)
      .order('ts', { ascending: false })
      .limit(2000),
    supabaseAdmin
      .from('pull_metrics')
      .select('property_id, pull_type, error_code, pulled_at')
      .eq('ok', false)
      .gte('pulled_at', since)
      .order('pulled_at', { ascending: false })
      .limit(500),
    supabaseAdmin
      .from('dashboard_by_date')
      .select('property_id, date, error_code, error_message, error_page, errored_at')
      .not('error_code', 'is', null)
      .gte('errored_at', since)
      .order('errored_at', { ascending: false })
      .limit(500),
  ]);

  if (logsRes.error) {
    log.error('recent-errors query failed', { err: logsRes.error, requestId });
    return err('recent-errors query failed', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  // pull_metrics + dashboard_by_date errors are best-effort: if either
  // query fails we still want to return what we have. Log + continue.
  if (pullsRes.error) {
    log.error('[recent-errors] pull_metrics query failed', { err: pullsRes.error, requestId });
  }
  if (dashRes.error) {
    log.error('[recent-errors] dashboard_by_date query failed', { err: dashRes.error, requestId });
  }

  // Normalize every source into a common shape so the grouping pass
  // doesn't need to know where each row came from.
  const all: NormalizedError[] = [];

  for (const row of (logsRes.data ?? [])) {
    const r = row as { source: string | null; message: string | null; stack: string | null; property_id: string | null; ts: string };
    all.push({
      source: r.source,
      message: (r.message ?? '').trim(),
      stack: r.stack,
      property_id: r.property_id,
      ts: r.ts,
    });
  }

  for (const row of (pullsRes.data ?? [])) {
    const r = row as { property_id: string | null; pull_type: string | null; error_code: string | null; pulled_at: string };
    // Surface as "scraper:<pull_type>: <error_code>" so different
    // pull-types and error-codes group separately in the UI but a
    // single "csv_morning: login_failed" run-of-failures collapses
    // into one row with a count.
    all.push({
      source: 'scraper',
      message: `${r.pull_type ?? 'pull'}: ${r.error_code ?? 'unknown'}`,
      stack: null,
      property_id: r.property_id,
      ts: r.pulled_at,
    });
  }

  for (const row of (dashRes.data ?? [])) {
    const r = row as { property_id: string | null; date: string | null; error_code: string | null; error_message: string | null; error_page: string | null; errored_at: string | null };
    if (!r.errored_at) continue;
    // Friendly error_message is more useful than the bare code when
    // both are present (e.g. "session expired — please re-login")
    // — but fall back to the code for grouping consistency.
    const msg = r.error_message
      ? `dashboard: ${r.error_code ?? 'error'} — ${r.error_message}`
      : `dashboard: ${r.error_code ?? 'pull failed'}`;
    all.push({
      source: 'dashboard',
      message: msg,
      stack: r.error_page ?? null,
      property_id: r.property_id,
      ts: r.errored_at,
    });
  }

  // Group by (source, message). Trim the message so subtle whitespace
  // differences don't fragment a real group, but keep the raw form too
  // in case the original is meaningful.
  const groups = new Map<string, ErrorGroup>();
  for (const r of all) {
    const key = `${r.source ?? 'unknown'}::${r.message}`;

    let g = groups.get(key);
    if (!g) {
      g = {
        source: r.source,
        message: r.message,
        count: 0,
        firstSeen: r.ts,
        lastSeen: r.ts,
        affectedPropertyIds: [],
        sampleStack: r.stack,
      };
      groups.set(key, g);
    }
    g.count += 1;
    if (r.ts < g.firstSeen) g.firstSeen = r.ts;
    if (r.ts > g.lastSeen) g.lastSeen = r.ts;
    if (r.property_id && !g.affectedPropertyIds.includes(r.property_id)) {
      g.affectedPropertyIds.push(r.property_id);
    }
  }

  const grouped = Array.from(groups.values())
    .sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen))
    .slice(0, limit);

  return ok({
    since,
    totalCount: all.length,
    groupCount: grouped.length,
    groups: grouped,
  }, { requestId });
}
