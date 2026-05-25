/**
 * Activity log query — paginated read with filters.
 *
 * Used by /api/settings/activity-log (list) and /api/settings/activity-log/export.
 * Reads service-role-only — always called with supabaseAdmin.
 *
 * Search semantics: free-text ILIKE'd against `description`, `actor_name`,
 * and `target_label`. Cheap on 90 days of data — switch to tsvector + GIN
 * if the timeline outgrows it.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import type {
  ActivityLogRow,
  ActivityQueryFilters,
  ActivityQueryResult,
} from './types';
import { clampPage, clampPageSize, escapeIlike } from './pure';

// Re-exported here so callers + tests can import either from this
// module or from ./pure. Keeping the pure helpers in their own file
// means tests don't have to load supabase-admin to use them.
export { clampPage, clampPageSize, escapeIlike };

export interface QueryOptions {
  /**
   * Bypass the MAX_PAGE_SIZE clamp (200). Used by the export route to
   * stream up to EXPORT_MAX_ROWS in one shot. Without this override the
   * export would silently return only the first 200 rows. Caller must
   * cap the value themselves; queryActivityLog trusts it.
   *
   * (Codex adversarial review #2.)
   */
  maxRows?: number;
}

/**
 * Paginated read against activity_log. Returns rows + total count for the
 * footer "showing X–Y of N" and the page selector.
 */
export async function queryActivityLog(
  filters: ActivityQueryFilters,
  opts: QueryOptions = {},
): Promise<ActivityQueryResult> {
  const page = clampPage(filters.page);
  const pageSize = opts.maxRows && opts.maxRows > 0
    ? Math.max(1, Math.floor(opts.maxRows))
    : clampPageSize(filters.pageSize);

  let query = supabaseAdmin
    .from('activity_log')
    .select('*', { count: 'exact' })
    .eq('property_id', filters.propertyId);

  if (filters.from) query = query.gte('occurred_at', filters.from);
  if (filters.to)   query = query.lt('occurred_at', filters.to);

  if (filters.categories && filters.categories.length > 0) {
    query = query.in('event_category', filters.categories);
  }
  if (filters.sources && filters.sources.length > 0) {
    query = query.in('source', filters.sources);
  }
  if (filters.actorAccountId) {
    query = query.eq('actor_account_id', filters.actorAccountId);
  }
  if (filters.targetType) {
    query = query.eq('target_type', filters.targetType);
  }
  if (filters.targetId) {
    query = query.eq('target_id', filters.targetId);
  }
  if (filters.search && filters.search.trim().length > 0) {
    // Two layers of escaping:
    //   1. Strip characters that would break PostgREST's .or() / .ilike()
    //      grammar (comma + parens + asterisk). Mirrors the pattern in
    //      /api/admin/list-properties.
    //   2. Escape PostgreSQL LIKE metacharacters (% and _).
    const safe = filters.search.trim().replace(/[,()*%_\\]/g, ' ').trim();
    if (safe.length > 0) {
      const pattern = `%${escapeIlike(safe)}%`;
      query = query.or(
        [
          `description.ilike.${pattern}`,
          `actor_name.ilike.${pattern}`,
          `target_label.ilike.${pattern}`,
        ].join(','),
      );
    }
  }

  query = query.order('occurred_at', { ascending: false }).order('id', { ascending: false });

  const fromIdx = (page - 1) * pageSize;
  const toIdx = fromIdx + pageSize - 1;
  query = query.range(fromIdx, toIdx);

  const { data, error, count } = await query;
  if (error) {
    throw new Error(`activity_log query failed: ${error.message}`);
  }

  return {
    rows: (data ?? []) as ActivityLogRow[],
    total: count ?? 0,
    page,
    pageSize,
  };
}

/** Fetch one event by id (for the side-panel detail view). */
export async function getActivityEvent(
  propertyId: string,
  eventId: string,
): Promise<ActivityLogRow | null> {
  const { data, error } = await supabaseAdmin
    .from('activity_log')
    .select('*')
    .eq('property_id', propertyId)
    .eq('id', eventId)
    .maybeSingle();
  if (error) throw new Error(`activity_log event lookup failed: ${error.message}`);
  return (data as ActivityLogRow | null) ?? null;
}
