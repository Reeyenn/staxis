/**
 * App-usage signals — which "apps" (top-nav sections) a hotel is actually
 * USING, so the nav can auto-light the active ones and grey out + sink the
 * rest. Replaces the old onboarding "Which services?" pick: nothing to choose
 * up front, the menu just mirrors real activity.
 *
 * Each app maps to one or more tables whose row-existence (scoped to the
 * property) proves REAL activity — deliberately NOT the tables that get
 * auto-seeded at property creation, or the menu would light up for everyone:
 *   - inventory items (16 defaults) are seeded on create → we key off
 *     inventory_counts / inventory_orders (things the hotel actually does).
 *   - comms channel conversations are auto-created → we key off comms_messages
 *     (a message someone actually sent).
 *
 * Verified against the live DB (2026-06-24): every table below exists and has a
 * property_id column.
 */

export type AppKey =
  | 'housekeeping'
  | 'communications'
  | 'maintenance'
  | 'inventory'
  | 'staff'
  | 'financials';

/**
 * Map of app → whether it's in use at the active property. A key that is ABSENT
 * (or true) means "treat as in use": the nav only ever greys an app when it has
 * a definitive `false`, so a still-loading or failed fetch never hides anything.
 */
export type AppUsageMap = Partial<Record<AppKey, boolean>>;

/**
 * Activity-signal tables per app. An app is "in use" if ANY of its tables has
 * at least one row for the property.
 */
export const APP_USAGE_SIGNALS: Record<AppKey, readonly string[]> = {
  // (`rooms` is intentionally omitted — it's a dead Plan-v4 table with no
  // remaining read/write path. Housekeeping activity now lands in cleaning_tasks
  // + the PMS housekeeping feed.)
  housekeeping: ['cleaning_tasks', 'pms_housekeeping_assignments'],
  communications: ['comms_messages'],
  maintenance: ['work_orders', 'pms_work_orders_v2'],
  inventory: ['inventory_counts', 'inventory_orders'],
  staff: ['staff'],
  financials: ['financial_expenses', 'capex_projects'],
};

export const APP_KEYS = Object.keys(APP_USAGE_SIGNALS) as AppKey[];

/** Route path → AppKey, so the nav can look up usage for each link. */
export const APP_KEY_BY_HREF: Record<string, AppKey> = {
  '/housekeeping': 'housekeeping',
  '/communications': 'communications',
  '/maintenance': 'maintenance',
  '/inventory': 'inventory',
  '/staff': 'staff',
  '/financials': 'financials',
};
