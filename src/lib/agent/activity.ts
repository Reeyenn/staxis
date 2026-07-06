// ─── AI activity feed — server read (service-role) ──────────────────────────
//
// The AI-assistant approval gate (migration 0300, agent_pending_actions) durably
// records every action Claude proposed on a property — approved & executed,
// denied, expired before anyone acted, or failed at execution. This module is
// the server READ side: it powers "AI activity", a manager-only pop-up.
//
// It imports supabaseAdmin (the table is deny-all RLS), so it is SERVER-ONLY —
// never import it from a client component. The pure, client-safe view model
// (types, mappers, outcome + day grouping) lives in ./activity-view, which both
// this file and the browser pop-up import without pulling the service-role
// client into the bundle. The route (/api/agent/activity) is a thin auth wrapper
// around fetchActivity().

import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  mapActivityRows,
  ACTIVITY_PAGE_SIZE,
  ACTIVITY_PAGE_MAX,
  type ActivityPage,
  type ActivityRawRow,
} from '@/lib/agent/activity-view';

// Re-export the view model so route + tests have a single import surface.
export {
  outcomeForStatus,
  mapActivityRows,
  groupByDay,
  ACTIVITY_PAGE_SIZE,
  ACTIVITY_PAGE_MAX,
} from '@/lib/agent/activity-view';
export type {
  ActivityOutcome,
  ActivityItem,
  ActivityPage,
  ActivityDayGroup,
  ActivityRawRow,
} from '@/lib/agent/activity-view';

/**
 * Page of AI activity for one property, newest first. Reads via supabaseAdmin
 * (the table is deny-all RLS); the caller has already proven property access +
 * manager role. Fetches `limit + 1` rows to compute hasMore without a count
 * round-trip, then resolves account display names in one follow-up query.
 *
 * `offset` is a simple row offset (the client passes items.length). Good enough
 * for a review pop-up — the feed only grows at the head, and the manager reads
 * top-down.
 */
export async function fetchActivity(opts: {
  propertyId: string;
  limit?: number;
  offset?: number;
}): Promise<ActivityPage> {
  const limit = Math.min(Math.max(1, opts.limit ?? ACTIVITY_PAGE_SIZE), ACTIVITY_PAGE_MAX);
  const offset = Math.max(0, opts.offset ?? 0);

  const { data, error } = await supabaseAdmin
    .from('agent_pending_actions')
    .select('id, account_id, tool_name, tool_args, status, error, created_at')
    .eq('property_id', opts.propertyId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit); // limit+1 rows → detect a further page
  if (error) throw new Error(`fetchActivity failed: ${error.message}`);

  const fetched = (data ?? []) as ActivityRawRow[];
  const hasMore = fetched.length > limit;
  const pageRows = hasMore ? fetched.slice(0, limit) : fetched;

  // Resolve display names for exactly the accounts on this page, in one query.
  const accountIds = [...new Set(pageRows.map((r) => r.account_id).filter(Boolean))];
  const nameById = new Map<string, string>();
  if (accountIds.length > 0) {
    const { data: accts, error: acctErr } = await supabaseAdmin
      .from('accounts')
      .select('id, display_name, username')
      .in('id', accountIds);
    if (acctErr) throw new Error(`fetchActivity name lookup failed: ${acctErr.message}`);
    for (const a of accts ?? []) {
      const rec = a as { id: string; display_name: string | null; username: string | null };
      const name = (rec.display_name ?? rec.username ?? '').trim();
      if (name) nameById.set(rec.id, name);
    }
  }
  const nameFor = (accountId: string): string => nameById.get(accountId) ?? 'Staxis';

  return { items: mapActivityRows(pageRows, nameFor), hasMore };
}
