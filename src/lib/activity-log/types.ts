/**
 * Cross-department activity log — shared types.
 *
 * One row per meaningful event from any source table (housekeeping,
 * maintenance, staff, system). Populated by AFTER INSERT/UPDATE triggers
 * defined in supabase/migrations/0225_activity_log.sql.
 *
 * The browser never reads activity_log directly. Reads go through
 * /api/settings/activity-log/* with supabaseAdmin (service-role only).
 */

export const ACTIVITY_CATEGORIES = [
  'housekeeping',
  'maintenance',
  'staff',
  'system',
  'messages',
  'inventory',
  'front_desk',
] as const;

export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

export const ACTIVITY_SOURCES = [
  'housekeeper_app',
  'manager_dashboard',
  'admin_dashboard',
  'cron',
  'cua_worker',
  'rules_engine',
  'pms_sync',
  'system',
  'sms',
  'voice',
] as const;

export type ActivitySource = (typeof ACTIVITY_SOURCES)[number];

export interface ActivityLogRow {
  id: string;
  property_id: string;
  occurred_at: string;            // ISO timestamp
  event_category: ActivityCategory;
  event_type: string;
  actor_account_id: string | null;
  actor_name: string | null;
  actor_role: string | null;
  target_type: string | null;
  target_id: string | null;
  target_label: string | null;
  description: string;
  source: ActivitySource;
  source_event_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface ActivityQueryFilters {
  propertyId: string;
  /** ISO date or timestamp. Inclusive lower bound on occurred_at. */
  from?: string;
  /** ISO date or timestamp. Exclusive upper bound on occurred_at. */
  to?: string;
  /** Restrict to one or more categories. */
  categories?: ActivityCategory[];
  /** Restrict to one or more sources. */
  sources?: ActivitySource[];
  /** Free-text — matched against description, actor_name, target_label (ILIKE). */
  search?: string;
  /** Filter by actor account id (an accounts.id, not auth uid). */
  actorAccountId?: string;
  /** Filter by target (e.g., target_type='room', target_id='305'). */
  targetType?: string;
  targetId?: string;
  /** Pagination — 1-based page index. */
  page?: number;
  /** Page size (default 50, capped at 200). */
  pageSize?: number;
}

export interface ActivityQueryResult {
  rows: ActivityLogRow[];
  total: number;
  page: number;
  pageSize: number;
}
