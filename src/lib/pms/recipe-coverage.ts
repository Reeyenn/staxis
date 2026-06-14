/**
 * recipe-coverage — APP-SIDE mirror of the parts of
 * cua-service/src/recipe-adapter.ts (ACTION_ROUTES) + target-contract.ts
 * (columnsFromAction) the web app needs to render a per-feed coverage view of
 * a saved PMS map.
 *
 * WHY a copy and not an import: `cua-service/` is a SEPARATE TypeScript project
 * (its own package.json + tsconfig; the root tsconfig EXCLUDES it). The Next app
 * cannot import worker runtime code. This module re-implements the small,
 * stable pieces needed to: (a) list which feeds a knowledge envelope captures,
 * (b) read each feed's learned columns, (c) map a feed to its pms_* table for a
 * live row-count badge, (d) know which feeds are required / drill-down.
 *
 * ⚠️ TYPE-SYNC (CLAUDE.md "CUA service has its own types.ts" pitfall): the table
 * mapping mirrors cua-service/src/recipe-adapter.ts ACTION_ROUTES, the required
 * set mirrors mapping-driver.ts REQUIRED_TARGETS, and the drill-down set mirrors
 * the classification:'drilldown_sample' targets in cua-service/src/mapper.ts
 * TARGETS. If a feed/table/classification changes there, update it here too.
 *
 * TWO recipe shapes are both valid in pms_knowledge_files.knowledge:
 *   - CURRENT  — mapper-produced maps store feeds under `knowledge.actions`
 *     (camelCase verbs: getRoomStatus, getArrivals, …) — these are EDITABLE.
 *   - LEGACY   — hand-seeded maps (migration 0203, e.g. Choice Advantage v1)
 *     store feeds under `knowledge.feeds` (snake_case: room_status,
 *     arrivals_departures, …) with NO `actions`. These are READ-ONLY here:
 *     the coverage editor edits `knowledge.actions`, so a legacy map must be
 *     re-learned once before its individual feeds can be edited.
 */

/** The 4 feeds the app's honesty layer treats as REQUIRED (mirror of
 *  cua-service mapping-driver REQUIRED_TARGETS + src/lib/pms/feed-status.ts).
 *  Deleting one of these would cripple every hotel on the family — the
 *  delete-feed route refuses it. */
export const REQUIRED_ACTION_KEYS = new Set<string>([
  'getRoomStatus', 'getArrivals', 'getDepartures', 'getWorkOrders',
]);

/** Drill-down feeds run through mapDrillDownAction, which has NO founder-takeover
 *  gate in v1 (cua-service/src/mapper.ts). The coverage editor therefore cannot
 *  drive them by hand — edit/add-via-takeover is hidden for these. */
export const DRILLDOWN_ACTION_KEYS = new Set<string>([
  'getGuests', 'getLostAndFound', 'getActivityLog',
]);

/**
 * The feeds the vision mapper can actually LEARN — the `key`s of the TARGETS
 * catalogue in cua-service/src/mapper.ts. Re-pointing (edit) and adding a feed
 * both drive a mapper run, so they are only offered for these keys. Notably
 * EXCLUDES getDashboardCounts / getRoomLayout / getHistoricalOccupancy, which
 * have ACTION_ROUTES tables but are never learned via the TARGETS loop. ⚠️ keep
 * in sync with the TARGETS array in cua-service/src/mapper.ts.
 */
export const LEARNABLE_ACTION_KEYS = new Set<string>([
  'getRoomStatus', 'getArrivals', 'getDepartures', 'getWorkOrders',
  'getRevenueDaily', 'getRatesAndInventory', 'getChannelPerformance',
  'getGuests', 'getForecastDaily', 'getGroupsAndBlocks', 'getLostAndFound',
  'getActivityLog', 'getGuestBalances', 'getPaymentsDaily', 'getFutureBookings',
  'getNoShows', 'getCancellations',
]);

export interface ActionFeedContract {
  /** Human label for the coverage view. */
  label: string;
  /** The pms_* table this feed writes to (for the live row-count badge). */
  table: string;
}

/**
 * actionKey → { label, table }. Mirrors ACTION_ROUTES in
 * cua-service/src/recipe-adapter.ts (the authoritative key→table registry).
 * This is also the catalogue of ADDABLE feeds (its keys).
 */
export const ACTION_FEED_CONTRACTS: Record<string, ActionFeedContract> = {
  getRoomStatus:          { label: 'Room status',           table: 'pms_room_status_log' },
  getArrivals:            { label: 'Arrivals',              table: 'pms_reservations' },
  getDepartures:          { label: 'Departures',            table: 'pms_reservations' },
  getWorkOrders:          { label: 'Work orders',           table: 'pms_work_orders_v2' },
  getDashboardCounts:     { label: 'Dashboard counts',      table: 'pms_in_house_snapshot' },
  getRoomLayout:          { label: 'Room layout',           table: 'pms_rooms_inventory' },
  getHistoricalOccupancy: { label: 'Historical occupancy',  table: 'pms_revenue_daily' },
  getRevenueDaily:        { label: 'Daily revenue',         table: 'pms_revenue_daily' },
  getForecastDaily:       { label: 'Daily forecast',        table: 'pms_forecast_daily' },
  getChannelPerformance:  { label: 'Channel performance',   table: 'pms_channel_performance' },
  getActivityLog:         { label: 'Activity log',          table: 'pms_activity_log' },
  getLostAndFound:        { label: 'Lost & found',          table: 'pms_lost_and_found' },
  getGroupsAndBlocks:     { label: 'Groups & blocks',       table: 'pms_groups_and_blocks' },
  getRatesAndInventory:   { label: 'Rates & inventory',     table: 'pms_rates_and_inventory' },
  getGuests:              { label: 'Guests',                table: 'pms_guests' },
  getGuestBalances:       { label: 'Guest balances',        table: 'pms_guest_balances' },
  getPaymentsDaily:       { label: 'Daily payments',        table: 'pms_payments_daily' },
  getFutureBookings:      { label: 'Future bookings',       table: 'pms_future_bookings' },
  getNoShows:             { label: 'No-shows',              table: 'pms_no_shows' },
  getCancellations:       { label: 'Cancellations',         table: 'pms_cancellations' },
};

/**
 * Legacy `knowledge.feeds` snake_case key → the canonical actionKey(s) it maps
 * to. Mirror of FEED_SOURCE_KEYS in src/app/api/admin/live-mapper/maps/route.ts.
 * Used only to render a legacy map's coverage read-only; `housekeeping` has no
 * mapper action (it's derived from room_status) so it maps to nothing editable.
 */
export const LEGACY_FEED_TO_ACTIONS: Record<string, readonly string[]> = {
  dashboard_counts: ['getDashboardCounts'],
  arrivals_departures: ['getArrivals', 'getDepartures'],
  room_status: ['getRoomStatus'],
  housekeeping: [],
  work_orders: ['getWorkOrders'],
};

/** Human label for a legacy snake_case feed key. */
const LEGACY_FEED_LABEL: Record<string, string> = {
  dashboard_counts: 'Dashboard counts',
  arrivals_departures: 'Arrivals / Departures',
  room_status: 'Room status',
  housekeeping: 'Housekeeping',
  work_orders: 'Work orders',
};

/**
 * Extract the learned column map (columnName → selector/header) from one
 * `knowledge.actions[key]` value. App-side mirror of `columnsFromAction` in
 * cua-service/src/target-contract.ts — tolerant of arbitrary jsonb so a hand-
 * edited or corrupt row never throws.
 */
export function columnsFromAction(action: unknown): Record<string, string> {
  if (!action || typeof action !== 'object') return {};
  const a = action as Record<string, unknown>;

  // drillDown list-page columns win (recipe-adapter collapses to the list page).
  const dd = a.drillDown as Record<string, unknown> | undefined;
  if (dd && typeof dd === 'object') {
    const listColumns = dd.listColumns;
    if (listColumns && typeof listColumns === 'object' && !Array.isArray(listColumns)) {
      return asStringMap(listColumns);
    }
  }

  const parse = a.parse as Record<string, unknown> | undefined;
  if (!parse || typeof parse !== 'object') return {};
  const mode = parse.mode;
  if (mode === 'table' || mode === 'csv' || mode === 'api') {
    const hint = parse.hint as Record<string, unknown> | undefined;
    const cols = hint?.columns;
    if (cols && typeof cols === 'object' && !Array.isArray(cols)) return asStringMap(cols);
    return {};
  }
  if (mode === 'inline_text') {
    const fields = parse.fields;
    if (fields && typeof fields === 'object' && !Array.isArray(fields)) return asStringMap(fields);
    return {};
  }
  return {};
}

function asStringMap(obj: object): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
    else if (v != null) out[k] = String(v);
  }
  return out;
}

export interface FeedView {
  /** The recipe key — actionKey for editable maps; the legacy feed name otherwise. */
  key: string;
  /** Canonical actionKey when known (for edit/delete targeting). null for a
   *  legacy feed with no editable action equivalent (e.g. housekeeping). */
  actionKey: string | null;
  label: string;
  /** pms_* table for the row-count badge, or null when unknown. */
  table: string | null;
  /** Learned columns (name → selector). Empty for legacy feeds we don't parse. */
  columns: Record<string, string>;
  required: boolean;
  /** True when this feed can be re-pointed/deleted via takeover (not drill-down,
   *  and the map is actions-shaped). */
  canTakeover: boolean;
  /** 'actions' = editable mapper recipe; 'legacy' = read-only knowledge.feeds. */
  source: 'actions' | 'legacy';
}

export type MapShape = 'actions' | 'legacy' | 'empty';

export interface ParsedKnowledgeCoverage {
  shape: MapShape;
  /** True iff feeds are stored under `knowledge.actions` (per-feed editable). */
  editable: boolean;
  feeds: FeedView[];
}

interface KnowledgeEnvelope {
  actions?: Record<string, unknown> | null;
  feeds?: Record<string, unknown> | null;
}

/**
 * Parse a `knowledge` jsonb envelope into a render-ready coverage list,
 * handling BOTH the current `actions` shape and the legacy `feeds` shape.
 * Editable (per-feed) operations are only offered for the `actions` shape.
 */
export function parseKnowledgeCoverage(knowledge: unknown): ParsedKnowledgeCoverage {
  const env = (knowledge && typeof knowledge === 'object' ? knowledge : {}) as KnowledgeEnvelope;
  const actions = env.actions && typeof env.actions === 'object' && !Array.isArray(env.actions)
    ? env.actions
    : null;
  const legacyFeeds = env.feeds && typeof env.feeds === 'object' && !Array.isArray(env.feeds)
    ? env.feeds
    : null;

  // Actions shape wins — it's the editable, canonical form.
  if (actions && Object.keys(actions).length > 0) {
    const feeds: FeedView[] = Object.keys(actions).map((actionKey) => {
      const contract = ACTION_FEED_CONTRACTS[actionKey];
      return {
        key: actionKey,
        actionKey,
        label: contract?.label ?? prettifyKey(actionKey),
        table: contract?.table ?? null,
        columns: columnsFromAction(actions[actionKey]),
        required: REQUIRED_ACTION_KEYS.has(actionKey),
        // Re-pointable by takeover only if the mapper can learn it AND it isn't
        // a drill-down feed (those have no takeover gate in v1).
        canTakeover: LEARNABLE_ACTION_KEYS.has(actionKey) && !DRILLDOWN_ACTION_KEYS.has(actionKey),
        source: 'actions',
      };
    });
    return { shape: 'actions', editable: true, feeds };
  }

  // Legacy feeds shape — read-only.
  if (legacyFeeds && Object.keys(legacyFeeds).length > 0) {
    const feeds: FeedView[] = Object.keys(legacyFeeds).map((feedKey) => {
      const mapped = LEGACY_FEED_TO_ACTIONS[feedKey] ?? [];
      const actionKey = mapped[0] ?? null;
      const contract = actionKey ? ACTION_FEED_CONTRACTS[actionKey] : undefined;
      return {
        key: feedKey,
        actionKey,
        label: LEGACY_FEED_LABEL[feedKey] ?? prettifyKey(feedKey),
        table: contract?.table ?? null,
        columns: {},
        required: !!actionKey && REQUIRED_ACTION_KEYS.has(actionKey),
        canTakeover: false,
        source: 'legacy',
      };
    });
    return { shape: 'legacy', editable: false, feeds };
  }

  return { shape: 'empty', editable: false, feeds: [] };
}

/**
 * The feeds the founder could ADD to an actions-shaped map: learnable catalogue
 * keys not already present, EXCLUDING drill-down feeds (no takeover gate to
 * drive them by hand).
 */
export function addableFeeds(presentActionKeys: ReadonlySet<string>): Array<{ actionKey: string; label: string }> {
  return [...LEARNABLE_ACTION_KEYS]
    .filter((k) => !presentActionKeys.has(k) && !DRILLDOWN_ACTION_KEYS.has(k))
    .map((k) => ({ actionKey: k, label: ACTION_FEED_CONTRACTS[k]?.label ?? prettifyKey(k) }));
}

/** "getRoomStatus" → "Room status" fallback for unknown keys. */
export function prettifyKey(key: string): string {
  const noGet = key.replace(/^get/, '');
  const spaced = noGet.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}
