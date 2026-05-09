/**
 * GET /api/admin/recent-errors
 *
 * Recent error_logs grouped by (source, message) so 100 copies of the
 * same error show as a single row with a count + a list of affected
 * properties. Returned newest-first.
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
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';

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

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const sinceParam = url.searchParams.get('since');
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 200);

  const since = sinceParam ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabaseAdmin
    .from('error_logs')
    .select('source, message, stack, property_id, ts')
    .gte('ts', since)
    .order('ts', { ascending: false })
    .limit(2000); // Pull up to 2k raw rows then group in memory.

  if (error) {
    return err(`recent-errors query failed: ${error.message}`, { requestId, status: 500 });
  }

  // Group by (source, message). Trim the message so subtle whitespace
  // differences don't fragment a real group, but keep the raw form too
  // in case the original is meaningful.
  const groups = new Map<string, ErrorGroup>();
  for (const row of (data ?? [])) {
    const r = row as { source: string | null; message: string | null; stack: string | null; property_id: string | null; ts: string };
    const msg = (r.message ?? '').trim();
    const key = `${r.source ?? 'unknown'}::${msg}`;

    let g = groups.get(key);
    if (!g) {
      g = {
        source: r.source,
        message: msg,
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
    totalCount: (data ?? []).length,
    groupCount: grouped.length,
    groups: grouped,
  }, { requestId });
}
