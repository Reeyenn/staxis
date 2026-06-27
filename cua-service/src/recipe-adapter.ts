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
  RecipeStep,
  TableTemplate,
  TableTemplateSource,
  TableTemplateField,
  TieredSelector,
  WriteStrategy,
  SnapshotScope,
  ExtractionMode,
} from './types.js';
import { log } from './log.js';
import {
  resolveColumnParser, recoveredDetailColumns,
  requiredLearnedFor, contextualColumnsFor, optionalColumnsFor,
  type LearnedTranslations,
} from './target-contract.js';
import type { PreStep } from './extractors/pre-steps.js';

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

// ─── csv flow derivation ──────────────────────────────────────────────────
//
// A learned csv recipe's "where the export lives" knowledge is its recorded
// STEP SEQUENCE: navigate to the report page, click/select options, then the
// final click that fires the download. CsvHint itself only carries the column
// map. The adapter used to DROP all of that — a learned csv feed hard-failed
// at runtime with "feedSpec missing selectors.downloadButton". This derives
// the runtime wiring the extractor actually needs, 100% structurally (no
// PMS-specific strings):
//
//   - steps AFTER the last `goto` are the in-page flow (the goto itself is
//     replayed as source.url);
//   - the LAST click/click_at is the download trigger → selectors.downloadButton
//     (or extra.downloadClickAt for a coordinate-recorded click);
//   - every interaction step BEFORE the trigger → extra.preSteps, in order;
//   - steps after the trigger are dropped (mapping-time waiting for the file —
//     the extractor's waitForEvent('download') replaces them);
//   - fill/type_text referencing $username/$password are dropped + warned:
//     extraction must never replay credentials (recipe-runner stance).

interface DerivedCsvFlow {
  preSteps: PreStep[];
  downloadButton?: string;
  downloadClickAt?: { x: number; y: number };
}

/** Fields whose NAME smells like a credential. A learned report flow has no
 *  business filling one; if the mapper recorded it (e.g. a literal secret
 *  typed mid-flow), it must not be replayed every poll. Conservative on
 *  purpose — report filters are dates/rooms/formats, never "password".
 *  `token(?![a-z0-9])` matches '#csrf-token'/'#csrf_token'/'#token' but NOT
 *  benign compounds like '#tokenizedSearch' (Codex P2 false-positive). */
const CREDENTIAL_SELECTOR_RE = /passw|pwd|secret|api[-_]?key|token(?![a-z0-9])/i;

/**
 * Translate the recorded in-page RecipeSteps (those AFTER the last `goto`) into
 * replayable PreSteps, preserving order and dropping credential-bearing
 * fills/type_text. Shared by the csv download-flow derivation and the
 * dom_table pre-step derivation so both enforce identical credential hygiene
 * (extraction must never replay a recorded secret — recipe-runner stance).
 * `goto` is handled via source.url; screenshot/eval_text are non-interactive.
 */
function mapInPageStepsToPreSteps(inPage: RecipeStep[], context: 'csv' | 'dom_table'): PreStep[] {
  const mapped: PreStep[] = [];
  for (const s of inPage) {
    switch (s.kind) {
      case 'click':
        mapped.push({ kind: 'click', selector: s.selector });
        break;
      case 'click_at':
        mapped.push({ kind: 'click_at', x: s.x, y: s.y });
        break;
      case 'fill':
        if (s.value === '$username' || s.value === '$password') {
          log.warn(`recipe-adapter: dropping ${context} pre-step fill that references credentials`, {});
          break;
        }
        if (CREDENTIAL_SELECTOR_RE.test(s.selector)) {
          // A literal value into a credential-looking field — the value may
          // BE a recorded secret (Codex P1). Never carry it into the runtime
          // source (and never log the value).
          log.warn(`recipe-adapter: dropping ${context} pre-step fill into a credential-looking field`, {
            selector: s.selector,
          });
          break;
        }
        mapped.push({ kind: 'fill', selector: s.selector, value: s.value });
        break;
      case 'type_text':
        if (s.value === '$username' || s.value === '$password') {
          log.warn(`recipe-adapter: dropping ${context} pre-step type_text that references credentials`, {});
          break;
        }
        mapped.push({ kind: 'type_text', value: s.value });
        break;
      case 'select':
        mapped.push({ kind: 'select', selector: s.selector, value: s.value });
        break;
      case 'press_key':
        mapped.push({ kind: 'press_key', key: s.key });
        break;
      case 'wait_for':
        mapped.push({ kind: 'wait_for', selector: s.selector, ...(s.timeoutMs ? { timeoutMs: s.timeoutMs } : {}) });
        break;
      case 'wait_ms':
        mapped.push({ kind: 'wait_ms', ms: s.ms });
        break;
      // goto handled via source.url; screenshot/eval_text are non-interactive.
      case 'goto':
      case 'screenshot':
      case 'eval_text':
        break;
    }
  }
  return mapped;
}

/** Index of the LAST `goto` step, or -1. The steps after it are the in-page
 *  interaction flow (the goto itself is replayed as source.url). */
function lastGotoIndex(steps: RecipeStep[]): number {
  return steps.reduce((acc, s, i) => (s.kind === 'goto' ? i : acc), -1);
}

/**
 * feature/cua-feed-extract — the in-page interaction flow for a DOM feed: the
 * steps the mapper recorded AFTER the last `goto` with NO url change (an SPA
 * route swap, or an in-page "Generate"/filter click on a report page). The
 * extractor navigates to the source url (the last goto) then replays these
 * before scraping. URL-change navigations are already captured as the source
 * url (the mapper records the landing page as a trailing goto), so their
 * clicks fall BEFORE that goto and are correctly excluded here — direct
 * navigation is preferred over replaying fragile coordinate clicks.
 */
export function deriveDomPreStepsFromSteps(steps: RecipeStep[]): PreStep[] {
  const inPage = steps.slice(lastGotoIndex(steps) + 1);
  return mapInPageStepsToPreSteps(inPage, 'dom_table');
}

export function deriveCsvFlowFromSteps(steps: RecipeStep[]): DerivedCsvFlow {
  const inPage = steps.slice(lastGotoIndex(steps) + 1);

  // Translate the in-page recipe steps to replayable PreSteps, keeping order.
  const mapped: PreStep[] = mapInPageStepsToPreSteps(inPage, 'csv');

  // The download trigger is the LAST click-like step.
  let triggerIdx = -1;
  for (let i = mapped.length - 1; i >= 0; i--) {
    if (mapped[i]!.kind === 'click' || mapped[i]!.kind === 'click_at') {
      triggerIdx = i;
      break;
    }
  }
  if (triggerIdx === -1) {
    // No click at all — leave the flow trigger-less; the extractor fails
    // loudly ("missing selectors.downloadButton"), which is correct: a csv
    // feed with no recorded trigger click can't download anything.
    return { preSteps: mapped };
  }

  const trigger = mapped[triggerIdx]!;
  const preSteps = mapped.slice(0, triggerIdx);
  return trigger.kind === 'click'
    ? { preSteps, downloadButton: trigger.selector }
    : { preSteps, downloadClickAt: { x: (trigger as { x: number; y: number }).x, y: (trigger as { x: number; y: number }).y } };
}

// ─── Translate a single ActionRecipe → TableTemplate ─────────────────────

export function actionRecipeToTableTemplate(
  actionKey: keyof Recipe['actions'],
  action: ActionRecipe,
  learned?: LearnedTranslations,
): TableTemplate | null {
  const route = ACTION_ROUTES[actionKey];
  if (!route) return null;

  // Set in the csv branch below; drives the incomplete-flag logic at the end.
  let csvTriggerless = false;

  // feature/cua-semantic-columns — durable per-column header anchors, carried
  // verbatim from the persisted table parse hint (built by the mapper at
  // finalize). Undefined for every non-table recipe and every legacy table
  // recipe with no header (→ source.columnsTiered stays undefined; the runtime
  // reader takes its byte-identical positional path).
  let tieredColumns: Record<string, TieredSelector> | undefined;
  let tieredRowSelector: TieredSelector | undefined;

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

  // feature/cua-report-handling — NEW-WINDOW REPLAY is a follow-up, not part
  // of this deliverable (learn-time READ). A learn-time-discovered DOWNLOAD
  // feed already round-trips UNCHANGED here: the mapper emits parse.mode:'csv'
  // + downloadsCsv:true, and the csv branch below derives downloadClickAt /
  // downloadButton + preSteps via deriveCsvFlowFromSteps from the recorded
  // trigger click — no change needed for downloads.
  //
  // TODO(new-window replay): when action.opensNewWindow is true, the click
  // that reaches the feed opens a popup whose page holds the table. The
  // current dom_table replay (extractors/dom-table.ts) reads only the primary
  // page, so popup feeds are NOT yet replayable. Implementing this is
  // non-trivial — it needs the template-runner to (a) listen for the popup
  // via page.context().waitForEvent('page') around the trigger click, and (b)
  // scrape the popup page instead of the primary — so it is deferred. Until
  // then, opensNewWindow is carried on the recipe (additive, harmless) for the
  // admin UI / future runtime; the table branch below replays against the
  // primary page (degrades to "feed not located" rather than mis-scraping).

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
    // Carry the learned click-flow into the runtime source — the wiring
    // extractors/csv-download.ts hard-requires. Previously dropped: a learned
    // csv feed always died with "feedSpec missing selectors.downloadButton".
    const flow = deriveCsvFlowFromSteps(action.steps);
    csvTriggerless = !flow.downloadButton && !flow.downloadClickAt;
    if (flow.downloadButton) {
      selectors.downloadButton = flow.downloadButton;
    }
    // The learned column map's VALUES are the CSV header names we depend on —
    // hand them to the extractor's schema-drift check (case-insensitive) so a
    // renamed PMS column fails the feed with a precise reason at download
    // time instead of surfacing as all-blank columns downstream.
    const expectedHeaderColumns = Object.values(action.parse.hint.columns);
    const csvExtra: Record<string, unknown> = {
      ...(flow.preSteps.length > 0 ? { preSteps: flow.preSteps } : {}),
      ...(flow.downloadClickAt ? { downloadClickAt: flow.downloadClickAt } : {}),
      ...(expectedHeaderColumns.length > 0 ? { expectedHeaderColumns } : {}),
    };
    if (Object.keys(csvExtra).length > 0) extra = csvExtra;
  } else if (action.parse.mode === 'table') {
    selectors = { rowSelector: action.parse.hint.rowSelector };
    columns = action.parse.hint.columns;
    if (action.parse.hint.skipSelector) {
      selectors.skipSelector = action.parse.hint.skipSelector;
    }
    // feature/cua-semantic-columns — carry the durable header anchors through.
    if (action.parse.hint.columnsTiered && Object.keys(action.parse.hint.columnsTiered).length > 0) {
      tieredColumns = action.parse.hint.columnsTiered;
      tieredRowSelector = action.parse.hint.rowSelectorTiered;
    }
    // feature/cua-feed-extract — carry the in-page interaction flow (steps the
    // mapper recorded AFTER the last goto with NO url change: an SPA route
    // swap, an in-page Generate/filter click on a report page) so
    // extractors/dom-table replays them before scraping. Empty for
    // directly-navigable feeds — the mapper captured their landing page as the
    // source url (the last goto), so their click steps were dropped above.
    const domPreSteps = deriveDomPreStepsFromSteps(action.steps);
    if (domPreSteps.length > 0) {
      extra = { ...(extra ?? {}), preSteps: domPreSteps };
    }
  } else if (action.parse.mode === 'inline_text') {
    columns = action.parse.fields;
  } else if (action.parse.mode === 'api') {
    // Structured endpoint (mode:'api') → runtime fetch_api source. The url +
    // bodyTemplate keep their {today}/{date} placeholders UNSUBSTITUTED here:
    // extractors/fetch-api.ts renders them at fetch time, every poll, so a
    // frozen date can never ship (the stale-date guard). `dateRender` hands
    // the extractor the PMS's learned date format so the rendered date looks
    // like what the endpoint was captured with (ISO fallback otherwise).
    const h = action.parse.hint;
    apiUrl = h.url;
    columns = h.columns;
    extra = {
      method: h.method,
      ...(h.bodyTemplate ? { body: h.bodyTemplate } : {}),
      ...(h.headers ? { headers: h.headers } : {}),
      ...(h.jsonPath ? { jsonPath: h.jsonPath } : {}),
      ...(learned?.dateFormat ? { dateRender: learned.dateFormat } : {}),
      expectJson: true,
    };
  }

  // Single source for non-drill-down targets. The learned PMS date format
  // rides EVERY mode's extra (Codex P1): a csv/dom report URL can carry a
  // {today} placeholder too, and rendering it in ISO when the PMS expects
  // MDY would silently pull wrong-date (or empty) reports each poll.
  const mergedExtra: Record<string, unknown> = {
    ...(learned?.dateFormat ? { dateRender: learned.dateFormat } : {}),
    ...(extra ?? {}),
  };
  const sources: TableTemplateSource[] = [{
    name: 'primary',
    url: apiUrl ?? sourceUrl,
    mode,
    selectors,
    columns,
    ...(Object.keys(mergedExtra).length > 0 ? { extra: mergedExtra } : {}),
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
  // DISCARD the detail_page source — EXCEPT contract-REQUIRED columns the
  // column-recovery mapper verified onto the detail page (rowDetail below);
  // generic nice-to-have detail enrichment remains deferred.
  let rowDetail: TableTemplate['rowDetail'];
  if (action.drillDown) {
    sources[0]!.url = action.drillDown.listUrl;
    sources[0]!.selectors = { rowSelector: action.drillDown.listRowSelector };
    sources[0]!.columns = action.drillDown.listColumns;
    // The drill-down list page is always DOM (listRowSelector + CSS column
    // map). Without this, a csv/api parse hint above would leave mode =
    // csv_download / fetch_api pointing at an HTML list URL — fetch_api
    // would then demand JSON from a webpage and the feed would perma-fail.
    sources[0]!.mode = 'dom_table';
    // Single-source template: keep ONLY the list-row fields. Reset the
    // field map so any columns inferred from the non-drill-down parse hint
    // above don't linger as orphans pointing at a discarded source.
    for (const col of Object.keys(fields)) delete fields[col];
    for (const [col, selectorOrColumn] of Object.entries(action.drillDown.listColumns)) {
      fields[col] = buildField(col, selectorOrColumn);
    }
    // feature/cua-column-recovery — wire REQUIRED detail columns for per-row
    // enrichment. recoveredDetailColumns applies the SAME eligibility
    // predicate the promotion gate counts columns with (verified template,
    // every placeholder resolvable from a non-blank list column, required-
    // contract columns only) — so the gate can never pass a column this
    // adapter won't wire. Assigned AFTER the listColumns loop above so a
    // blank-selector list field can never shadow the recovered detail field.
    const detailCols = recoveredDetailColumns(actionKey, action);
    if (Object.keys(detailCols).length > 0) {
      rowDetail = {
        urlTemplate: action.drillDown.detailUrlTemplate,
        urlParams: action.drillDown.detailUrlParams,
        columns: detailCols,
      };
      for (const [col, selectorOrColumn] of Object.entries(detailCols)) {
        fields[col] = { ...buildField(col, selectorOrColumn), origin: 'detail_page' };
      }
    }
  }

  // feature/cua-semantic-columns — attach the durable header anchors to the
  // (single) primary source. We populate BOTH the typed fields (the contract
  // shape Chat 7/8 + any typed consumer read) AND an `extra` mirror, because the
  // runtime dom_table reader pulls them from feedSpec.extra: template-runner's
  // sourceToFeedSpec forwards only mode/url/selectors/columns/EXTRA, so the typed
  // columnsTiered/selectorsTiered would otherwise never reach the reader. Both
  // branches (single-source + drill-down) keep the SAME field-keyed list columns,
  // so the same anchors apply. Absent ⟹ no-op (legacy back-compat: the
  // selector-fallback test pins source.{columnsTiered,selectorsTiered}===undefined).
  if (tieredColumns && Object.keys(tieredColumns).length > 0) {
    const primary = sources[0]!;
    // Keep rowSelectorTiered.css in sync with the EFFECTIVE row selector — the
    // drill-down branch above swaps source.selectors.rowSelector to the list-row
    // selector, which can differ from the authored hint.rowSelector. (The reader
    // only consults .xpath today, but a stale .css would be a latent landmine.)
    const effectiveRowTiered: TieredSelector | undefined = tieredRowSelector
      ? { ...tieredRowSelector, ...(primary.selectors?.rowSelector ? { css: primary.selectors.rowSelector } : {}) }
      : undefined;
    primary.columnsTiered = tieredColumns;
    if (effectiveRowTiered) primary.selectorsTiered = { rowSelector: effectiveRowTiered };
    primary.extra = {
      ...(primary.extra ?? {}),
      columnsTiered: tieredColumns,
      ...(effectiveRowTiered ? { rowSelectorTiered: effectiveRowTiered } : {}),
    };
  }

  // feature/cua-column-editor — wire FOUNDER-ADDED custom columns. They're
  // captured from the page like any DOM column (merged into the primary
  // source's read set) but tagged `rawColumns` so template-runner gathers them
  // into each row's `raw` jsonb bucket instead of a typed warehouse field — so
  // they never enter the field contract / validator. Table mode only (DOM page
  // cells) and never on a drill-down feed (those collapse to a list page and
  // aren't editable here). Absent ⟹ no-op (byte-identical, rawColumns omitted).
  const rawColumns: string[] = [];
  const pageColumns: Array<{ key: string; selector: string }> = [];
  if (action.parse.mode === 'table' && !action.drillDown) {
    const custom = action.parse.hint.customColumns;
    if (custom && typeof custom === 'object') {
      const primary = sources[0]!;
      const mergedColumns = { ...primary.columns };
      // A typed contract column always wins — a custom column can never shadow
      // or overwrite contract data, even if the contract column wasn't LEARNED
      // (so isn't in `fields`). Guard against the full contract set, not just
      // the learned columns (the route + worker refuse this at write time; this
      // is the runtime safety net for any pre-guard/hand-edited recipe).
      const contractCols = new Set<string>([
        ...requiredLearnedFor(actionKey), ...contextualColumnsFor(actionKey), ...optionalColumnsFor(actionKey),
      ]);
      for (const [key, entry] of Object.entries(custom)) {
        // fix/cua-freeform-capture — coerce: a flat string is a PER-ROW selector
        // (original shape, byte-identical); an object { selector, scope:'page' }
        // is a ONE-OFF feed-level value read once and stored ONCE per feed
        // (pms_feed_values / the sample's pageValues block) — NOT stamped per row.
        const selector = typeof entry === 'string' ? entry : (entry && typeof entry === 'object' ? String((entry as { selector?: unknown }).selector ?? '') : '');
        const scope = typeof entry === 'string' ? 'row' : ((entry as { scope?: unknown })?.scope === 'page' ? 'page' : 'row');
        if (selector.trim() === '' || key in fields || contractCols.has(key)) continue;
        if (scope === 'page') {
          pageColumns.push({ key, selector });
        } else if (!(key in mergedColumns)) {
          mergedColumns[key] = selector;
          rawColumns.push(key);
        }
      }
      if (rawColumns.length > 0) primary.columns = mergedColumns;
    }
  }

  const template: TableTemplate = {
    tableName: route.tableName,
    keys: route.keys,
    writeStrategy: route.writeStrategy,
    snapshotScope: route.snapshotScope,
    sources,
    fields,
    ...(rawColumns.length > 0 ? { rawColumns } : {}),
    ...(pageColumns.length > 0 ? { pageColumns } : {}),
    ...(rowDetail ? { rowDetail } : {}),
    // Plan v8 self-repair — bridge template → recipe action_key so
    // session-driver's zero-row failure detector can enqueue a
    // single-target re-learn instead of the full 13-target re-mapping.
    sourceActionKey: actionKey,
  };

  // feature/cua-feed-extract — `incomplete` means "the runtime genuinely can't
  // LOCATE this feed's data", which the replay-time gate (sibling chat) surfaces
  // for operator review. After this change every recorded interaction IS
  // reproducible, so the flag reflects only un-locatable feeds:
  //
  //   - 'csv': the click-flow is carried on the source (preSteps +
  //     downloadButton) and replayed — EXCEPT a csv flow with NO recorded
  //     trigger click can never download anything (Codex P1), so it's
  //     incomplete.
  //   - 'api': the runtime calls the learned endpoint directly with the page's
  //     cookies — always locatable from apiUrl; never incomplete here.
  //   - 'table' (dom_table): the mapper records the landing page as the source
  //     url (a trailing goto) AND this adapter carries any residual in-page
  //     interactions as preSteps replayed before scraping. So a table feed is
  //     locatable whenever it has a source url. Incomplete ONLY when that url
  //     is blank — i.e. no goto was ever recorded (a malformed/hand-written
  //     recipe; never from a live mapper run, which always seeds a goto).
  //   - 'inline_text': dom-inline does not (yet) replay pre-steps, so an
  //     inline feed needing interaction, or lacking a url, stays incomplete.
  if (action.parse.mode === 'csv' && csvTriggerless) {
    template.incomplete = true;
    log.warn(
      'recipe-adapter: csv flow has no download trigger click — flagged incomplete for operator review',
      { actionKey, tableName: route.tableName },
    );
  } else if (action.parse.mode === 'table') {
    if (sourceUrl.trim() === '') {
      template.incomplete = true;
      log.warn(
        'recipe-adapter: dom_table feed has no source URL (no goto recorded) — cannot locate; flagged incomplete for operator review',
        { actionKey, tableName: route.tableName },
      );
    }
  } else if (action.parse.mode === 'inline_text') {
    const NON_INTERACTION_KINDS = new Set(['goto', 'screenshot', 'wait_ms']);
    const interactionKinds = [
      ...new Set(
        action.steps
          .map((s) => s.kind)
          .filter((k) => !NON_INTERACTION_KINDS.has(k)),
      ),
    ];
    if (sourceUrl.trim() === '' || interactionKinds.length > 0) {
      template.incomplete = true;
      log.warn(
        'recipe-adapter: inline_text feed needs interaction the inline extractor cannot replay (or has no url) — flagged incomplete for operator review',
        { actionKey, tableName: route.tableName, interactionKinds },
      );
    }
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
