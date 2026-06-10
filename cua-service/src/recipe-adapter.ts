/**
 * Recipe → TableTemplate adapter (Plan v7).
 *
 * The CUA pipeline has two upstream sources of "where does data live in
 * this PMS" knowledge:
 *
 *   1. **Legacy `Recipe.actions`** — what the original mapper emits
 *      (getRoomStatus, getArrivals, etc.) AND what the hand-seeded
 *      migration 0203 produced for Choice Advantage (the v1 active
 *      knowledge file, before this rewrite). Per-action key + ParseHint.
 *
 *   2. **`pms_knowledge_files.knowledge.feeds`** — the v4 runtime jsonb
 *      shape with named feeds (dashboard_counts, arrivals_departures,
 *      etc.) — see migration 0203 for the seeded example.
 *
 * Going forward, both should resolve to ONE canonical runtime shape:
 * `TableTemplate` (defined in types.ts). The generic-table-writer + the
 * template-runner + multi-source-runner all consume TableTemplate. If
 * the two paths drift apart, fixes only land in one, runtime breaks.
 *
 * This module is the single boundary. Anywhere the runtime needs to know
 * "what selectors does CA use to extract arrivals", it asks the adapter
 * and gets back a TableTemplate — regardless of whether the source was
 * the v0 hand-seeded recipe, the v1 mapper Recipe, or the v2 mapper
 * output (Plan v7) which will eventually emit TableTemplates directly.
 *
 * Codex v2 P1-TWO-PATH closure.
 */

import type {
  Recipe,
  ActionRecipe,
  TableTemplate,
  TableTemplateSource,
  TableTemplateField,
  WriteStrategy,
  SnapshotScope,
  ExtractionMode,
} from './types.js';
import { log } from './log.js';
import { resolveColumnParser, type LearnedTranslations } from './target-contract.js';

// ─── Per-action → table mapping ───────────────────────────────────────────
//
// Each Recipe.actions key maps to one v4 pms_* table. The mapping is
// 1:1 today; if it ever becomes one-action-to-many or many-to-one we'd
// need to enrich this table.

interface ActionRoute {
  tableName: string;
  keys: string[];
  writeStrategy: WriteStrategy;
  snapshotScope: SnapshotScope;
  /** Extraction mode the ParseHint implies. */
  modeFromParseHint(parseHintMode: 'csv' | 'table' | 'inline_text' | 'api'): ExtractionMode;
}

const PARSE_HINT_TO_MODE: Record<'csv' | 'table' | 'inline_text' | 'api', ExtractionMode> = {
  csv:         'csv_download',
  table:       'dom_table',
  inline_text: 'dom_inline',
  api:         'fetch_api',
};

const ACTION_ROUTES: Record<keyof Recipe['actions'], ActionRoute> = {
  // Tier-1 already-extracted (matches current writers in new-schema-writer.ts).
  getArrivals: {
    tableName: 'pms_reservations',
    keys: ['property_id', 'pms_reservation_id'],
    writeStrategy: 'upsert',
    snapshotScope: 'full',
    modeFromParseHint: (m) => PARSE_HINT_TO_MODE[m],
  },
  getDepartures: {
    tableName: 'pms_reservations',
    keys: ['property_id', 'pms_reservation_id'],
    writeStrategy: 'upsert',
    snapshotScope: 'delta',  // departures = subset; can't auto-resolve full table
    modeFromParseHint: (m) => PARSE_HINT_TO_MODE[m],
  },
  getRoomStatus: {
    tableName: 'pms_room_status_log',
    keys: ['property_id', 'room_number', 'changed_at'],
    writeStrategy: 'append',  // log table — never updates
    snapshotScope: 'full',
    modeFromParseHint: (m) => PARSE_HINT_TO_MODE[m],
  },
  // getStaffRoster route removed in v8 Phase D.1 — no pms_staff_roster
  // table in v4; mapper no longer emits this key.
  getRoomLayout: {
    tableName: 'pms_rooms_inventory',
    keys: ['property_id', 'room_number'],
    writeStrategy: 'upsert',
    snapshotScope: 'full',
    modeFromParseHint: (m) => PARSE_HINT_TO_MODE[m],
  },
  getDashboardCounts: {
    tableName: 'pms_in_house_snapshot',
    keys: ['property_id'],
    writeStrategy: 'upsert',  // one row per property — always overwritten
    snapshotScope: 'full',
    modeFromParseHint: (m) => PARSE_HINT_TO_MODE[m],
  },
  getHistoricalOccupancy: {
    tableName: 'pms_revenue_daily',
    keys: ['property_id', 'date'],
    writeStrategy: 'upsert',
    snapshotScope: 'delta',
    modeFromParseHint: (m) => PARSE_HINT_TO_MODE[m],
  },
  // Plan v7 new targets — one per net-new v4 table.
  getGuests: {
    tableName: 'pms_guests',
    keys: ['property_id', 'pms_guest_id'],
    writeStrategy: 'upsert',
    snapshotScope: 'delta',  // can't enumerate every guest; partial view
    modeFromParseHint: (m) => PARSE_HINT_TO_MODE[m],
  },
  getRevenueDaily: {
    tableName: 'pms_revenue_daily',
    keys: ['property_id', 'date'],
    writeStrategy: 'upsert',
    snapshotScope: 'full',
    modeFromParseHint: (m) => PARSE_HINT_TO_MODE[m],
  },
  getForecastDaily: {
    tableName: 'pms_forecast_daily',
    keys: ['property_id', 'forecast_date', 'snapshot_date'],
    writeStrategy: 'upsert',
    snapshotScope: 'full',
    modeFromParseHint: (m) => PARSE_HINT_TO_MODE[m],
  },
  getChannelPerformance: {
    tableName: 'pms_channel_performance',
    keys: ['property_id', 'date', 'channel'],
    writeStrategy: 'upsert',
    snapshotScope: 'full',
    modeFromParseHint: (m) => PARSE_HINT_TO_MODE[m],
  },
  getActivityLog: {
    tableName: 'pms_activity_log',
    keys: ['property_id', 'captured_at', 'pms_user', 'action'],
    writeStrategy: 'append',
    snapshotScope: 'delta',
    modeFromParseHint: (m) => PARSE_HINT_TO_MODE[m],
  },
  getLostAndFound: {
    tableName: 'pms_lost_and_found',
    keys: ['property_id', 'pms_item_id'],
    writeStrategy: 'reconcile',  // claim/dispose status changes upstream
    snapshotScope: 'full',
    modeFromParseHint: (m) => PARSE_HINT_TO_MODE[m],
  },
  getGroupsAndBlocks: {
    tableName: 'pms_groups_and_blocks',
    keys: ['property_id', 'pms_group_id'],
    writeStrategy: 'upsert',
    snapshotScope: 'full',
    modeFromParseHint: (m) => PARSE_HINT_TO_MODE[m],
  },
  getRatesAndInventory: {
    tableName: 'pms_rates_and_inventory',
    keys: ['property_id', 'date', 'room_type', 'rate_plan'],
    writeStrategy: 'upsert',
    snapshotScope: 'full',
    modeFromParseHint: (m) => PARSE_HINT_TO_MODE[m],
  },
  getWorkOrders: {
    tableName: 'pms_work_orders_v2',
    keys: ['property_id', 'pms_work_order_id'],
    writeStrategy: 'reconcile',  // disappeared rows auto-resolve
    snapshotScope: 'full',       // CA fetch returns ALL open + recent
    modeFromParseHint: (m) => PARSE_HINT_TO_MODE[m],
  },
  // feat/pms-universal-translate — 5 net-new feeds (migration 0276). All
  // `upsert` + `delta`: each is a partial view (only folios with balances /
  // today's collected / future or recently-cancelled reservations), so we
  // never want reconcile's destructive auto-resolve.
  getGuestBalances: {
    tableName: 'pms_guest_balances',
    keys: ['property_id', 'pms_folio_id'],
    writeStrategy: 'upsert',
    snapshotScope: 'delta',
    modeFromParseHint: (m) => PARSE_HINT_TO_MODE[m],
  },
  getPaymentsDaily: {
    tableName: 'pms_payments_daily',
    keys: ['property_id', 'business_date'],
    writeStrategy: 'upsert',
    snapshotScope: 'delta',
    modeFromParseHint: (m) => PARSE_HINT_TO_MODE[m],
  },
  getFutureBookings: {
    tableName: 'pms_future_bookings',
    keys: ['property_id', 'pms_reservation_id'],
    writeStrategy: 'upsert',
    snapshotScope: 'delta',
    modeFromParseHint: (m) => PARSE_HINT_TO_MODE[m],
  },
  getNoShows: {
    tableName: 'pms_no_shows',
    keys: ['property_id', 'pms_reservation_id'],
    writeStrategy: 'upsert',
    snapshotScope: 'delta',
    modeFromParseHint: (m) => PARSE_HINT_TO_MODE[m],
  },
  getCancellations: {
    tableName: 'pms_cancellations',
    keys: ['property_id', 'pms_reservation_id'],
    writeStrategy: 'upsert',
    snapshotScope: 'delta',
    modeFromParseHint: (m) => PARSE_HINT_TO_MODE[m],
  },
};

// ─── Translate a single ActionRecipe → TableTemplate ─────────────────────

export function actionRecipeToTableTemplate(
  actionKey: keyof Recipe['actions'],
  action: ActionRecipe,
  learned?: LearnedTranslations,
): TableTemplate | null {
  const route = ACTION_ROUTES[actionKey];
  if (!route) return null;

  // Build a TableTemplate field, attaching the UNIVERSAL value parser + its
  // learned config (date order / enum mapping from the knowledge file). The
  // generic parsers normalize ANY PMS's scraped string to the type validateRows
  // expects — otherwise a raw string for an integer/boolean/date/enum column
  // rejects the WHOLE row. undefined parser for plain-text + unmapped columns.
  const buildField = (col: string, selectorOrColumn: string): TableTemplateField => {
    const resolved = resolveColumnParser(actionKey, col, learned);
    return {
      origin: 'list_row',
      source: 'primary',
      selectorOrColumn,
      ...(resolved
        ? { parser: resolved.parser, ...(resolved.config ? { parserConfig: resolved.config } : {}) }
        : {}),
    };
  };

  // Source URL: walk steps for the LAST `goto` step (the URL the agent
  // ultimately landed on). Falls back to the first step's URL.
  const gotoSteps = action.steps.filter((s) => s.kind === 'goto');
  const sourceUrl = gotoSteps.length > 0 ? (gotoSteps[gotoSteps.length - 1]!).url : '';

  // ParseHint → mode + selectors + columns.
  const mode = route.modeFromParseHint(action.parse.mode);
  let selectors: Record<string, string> = {};
  let columns: Record<string, string> = {};
  let apiUrl: string | undefined;
  let extra: Record<string, unknown> | undefined;
  if (action.parse.mode === 'csv') {
    columns = action.parse.hint.columns;
    if (action.parse.hint.requiredColumn) {
      selectors.requiredColumn = action.parse.hint.requiredColumn;
    }
  } else if (action.parse.mode === 'table') {
    selectors = { rowSelector: action.parse.hint.rowSelector };
    columns = action.parse.hint.columns;
    if (action.parse.hint.skipSelector) {
      selectors.skipSelector = action.parse.hint.skipSelector;
    }
  } else if (action.parse.mode === 'inline_text') {
    columns = action.parse.fields;
  } else if (action.parse.mode === 'api') {
    // Structured endpoint (mode:'api') → runtime fetch_api source. FOUNDATION
    // SKELETON — Chat 1 (Plumbing) hardens: jsonPath wiring into the extractor,
    // per-poll date/param re-templating, header/CSRF freshness, and tests.
    const h = action.parse.hint;
    apiUrl = h.url;
    columns = h.columns;
    extra = {
      method: h.method,
      ...(h.bodyTemplate ? { body: h.bodyTemplate } : {}),
      ...(h.headers ? { headers: h.headers } : {}),
      ...(h.jsonPath ? { jsonPath: h.jsonPath } : {}),
      expectJson: true,
    };
  }

  // Single source for non-drill-down targets.
  const sources: TableTemplateSource[] = [{
    name: 'primary',
    url: apiUrl ?? sourceUrl,
    mode,
    selectors,
    columns,
    ...(extra ? { extra } : {}),
  }];
  const fields: Record<string, TableTemplateField> = {};
  for (const [col, selectorOrColumn] of Object.entries(columns)) {
    fields[col] = buildField(col, selectorOrColumn);
  }

  // Drill-down — collapse to a SINGLE list-page source.
  //
  // The mapper learns BOTH a list page and a per-record detail page, but
  // emitting both as a 2-source template (list_row + detail_page) with no
  // `aggregate` spec makes runMultiSourceTemplate hard-fail ("multi-source
  // template missing aggregate spec") so guests / lost-and-found /
  // activity-log extract NOTHING. The list-row data is correct and
  // sufficient for the first run, so we use ONLY the list page here and
  // DISCARD the detail_page source. Per-row detail enrichment is deferred.
  if (action.drillDown) {
    sources[0]!.url = action.drillDown.listUrl;
    sources[0]!.selectors = { rowSelector: action.drillDown.listRowSelector };
    sources[0]!.columns = action.drillDown.listColumns;
    // Single-source template: keep ONLY the list-row fields. Reset the
    // field map so any columns inferred from the non-drill-down parse hint
    // above don't linger as orphans pointing at a discarded source.
    for (const col of Object.keys(fields)) delete fields[col];
    for (const [col, selectorOrColumn] of Object.entries(action.drillDown.listColumns)) {
      fields[col] = buildField(col, selectorOrColumn);
    }
  }

  const template: TableTemplate = {
    tableName: route.tableName,
    keys: route.keys,
    writeStrategy: route.writeStrategy,
    snapshotScope: route.snapshotScope,
    sources,
    fields,
    // Plan v8 self-repair — bridge template → recipe action_key so
    // session-driver's zero-row failure detector can enqueue a
    // single-target re-learn instead of the full 13-target re-mapping.
    sourceActionKey: actionKey,
  };

  // The adapter only replays the LAST `goto` as the source URL — every
  // click / select / type_text / wait_for / press_key the mapper recorded
  // to reach the table is DISCARDED. For feeds that need interaction
  // before the table renders, the extractor would then time out and churn
  // paid re-mapping every 30s. Full pre-step replay is deferred; for now,
  // flag the template `incomplete` (surfaces in admin review) and warn,
  // rather than silently timing out. Allowed no-interaction kinds: goto,
  // screenshot, wait_ms.
  const NON_INTERACTION_KINDS = new Set(['goto', 'screenshot', 'wait_ms']);
  const interactionKinds = [
    ...new Set(
      action.steps
        .map((s) => s.kind)
        .filter((k) => !NON_INTERACTION_KINDS.has(k)),
    ),
  ];
  if (interactionKinds.length > 0) {
    template.incomplete = true;
    log.warn(
      'recipe-adapter: action requires pre-table interaction the adapter does not replay — flagged incomplete for operator review',
      {
        actionKey,
        tableName: route.tableName,
        interactionKinds,
      },
    );
  }

  return template;
}

// ─── Multi-source aggregate templates (legacy seed shape) ────────────────
//
// The hand-seeded migration-0203 feed `dashboard_counts` doesn't map to
// a single `Recipe.actions` key — it's a feed that fetches 3 URLs in
// parallel (inHouse / arrivals / departures) and aggregates them into
// one row of pms_in_house_snapshot. The runtime today special-cases
// this in `session-driver.runCaDashboardCounts`. In Plan v7, multi-source
// is first-class on TableTemplate; this helper builds the TableTemplate
// directly from the legacy feed shape.
//
// `knowledge.feeds[feedName]` is the FeedSpec from the jsonb knowledge
// file. We only need the typed pattern for dashboard_counts today; other
// multi-source feeds (if any future PMS has them) follow the same
// pattern.

export interface LegacyFeedSpec {
  description?: string;
  mode: 'csv_download' | 'dom_table' | 'fetch_api' | 'dom_inline';
  url?: string;
  selectors?: Record<string, string>;
  columns?: Record<string, string>;
  extra?: Record<string, unknown>;
}

export function dashboardCountsTemplateFromLegacy(
  feed: LegacyFeedSpec,
): TableTemplate | null {
  // Migration 0203 puts the 3 URLs under extra.pages.
  const pages = (feed.extra?.pages as Record<string, string> | undefined) ?? {};
  if (!pages.inHouse || !pages.arrivals || !pages.departures) return null;

  const sources: TableTemplateSource[] = [
    {
      name: 'in_house',
      url: pages.inHouse,
      mode: 'dom_inline',
      columns: feed.columns ?? {},
    },
    {
      name: 'arrivals',
      url: pages.arrivals,
      mode: 'dom_inline',
      columns: feed.columns ?? {},
    },
    {
      name: 'departures',
      url: pages.departures,
      mode: 'dom_inline',
      columns: feed.columns ?? {},
    },
  ];

  // Aggregate: merge_named — each source contributes one named field to
  // the output row. (`roomCount` from in_house source → `total_occupied_rooms`,
  // etc.). The actual normalizer (choice-advantage.normalizeCaDashboardCounts)
  // does the merge today; in the new pipeline, the multi-source-runner
  // applies these rules.
  return {
    tableName: 'pms_in_house_snapshot',
    keys: ['property_id'],
    writeStrategy: 'upsert',
    snapshotScope: 'full',
    sources,
    aggregate: {
      strategy: 'merge_named',
      rules: {
        total_occupied_rooms: 'from source in_house field roomCount',
        arrivals_remaining_today: 'from source arrivals field roomCount',
        departures_remaining_today: 'from source departures field roomCount',
      },
    },
    fields: {
      total_occupied_rooms: { origin: 'list_row', source: 'in_house', selectorOrColumn: 'roomCount' },
      arrivals_remaining_today: { origin: 'list_row', source: 'arrivals', selectorOrColumn: 'roomCount' },
      departures_remaining_today: { origin: 'list_row', source: 'departures', selectorOrColumn: 'roomCount' },
    },
    // Plan v8 self-repair — dashboard_counts comes from the legacy
    // getDashboardCounts action. Repair re-learns that one (which will
    // re-fetch all 3 sub-pages on the new mapper run).
    sourceActionKey: 'getDashboardCounts',
  };
}

// ─── Top-level: Recipe → TableTemplate[] ─────────────────────────────────
//
// Given a full Recipe (mapper output OR legacy seed), translate every
// action to its corresponding TableTemplate. Returns one template per
// known action key. Unknown / unsupported keys log a warning and are
// skipped (no template means runtime won't try to write that table).

export interface RecipeAdapterResult {
  templates: TableTemplate[];
  /** Action keys that couldn't be translated (typically because no
   *  ActionRoute exists or the parse-hint shape was malformed). */
  skipped: Array<{ key: string; reason: string }>;
}

export function recipeToTableTemplates(
  recipe: Recipe,
  learned?: LearnedTranslations,
): RecipeAdapterResult {
  const templates: TableTemplate[] = [];
  const skipped: Array<{ key: string; reason: string }> = [];

  // Default the learned translations to the recipe's own (mapper output carries
  // them inline); session-driver may also pass them explicitly from the loaded
  // knowledge file. Either way, undefined → ca_* / heuristic fallback.
  const learnedTranslations: LearnedTranslations = learned ?? {
    valueTranslations: recipe.valueTranslations,
    dateFormat: recipe.dateFormat,
  };

  for (const [key, action] of Object.entries(recipe.actions)) {
    if (!action) continue;
    const template = actionRecipeToTableTemplate(key as keyof Recipe['actions'], action, learnedTranslations);
    if (template) {
      templates.push(template);
    } else {
      skipped.push({ key, reason: 'no ActionRoute defined for this key' });
    }
  }

  return { templates, skipped };
}
