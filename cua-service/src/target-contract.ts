/**
 * Target column contract (fix/mapper-field-contract).
 *
 * THE field-name + value contract between what the vision mapper LEARNS and
 * what the generic-table-writer VALIDATES/WRITES. The mapper emits a learned
 * column map keyed by whatever names the prompt tells the model to use; the
 * writer (persistence/generic-table-writer.ts → validateRows) looks up each row
 * by the EXACT snake_case column name in the pms_table_schemas descriptor
 * (migration 0207) AND type-checks the value. If the names disagree, every row
 * fails the required-field check; if the VALUE has the wrong type (a raw DOM
 * string "2" for an `integer` column), validateRows rejects the WHOLE row. Both
 * silently wrote 0 rows on the first live mapping run (job 55f8178d).
 *
 * This module is the single source of truth that keeps them aligned:
 *   - NAMES: mapper.ts uses `requiredLearnedFor` as a core target's
 *     `requiredFields` (the keys the prompt tells the model to emit) and for
 *     the success-branch completeness re-ask; mapping-driver's gate uses
 *     `missingRequiredColumns` to refuse to auto-promote a blank required feed.
 *   - VALUES: recipe-adapter.ts uses `parserForLearnedColumn` to attach a
 *     value parser (parsers/registry.ts) to each learned column, DRIVEN BY THE
 *     DESCRIPTOR TYPE so new feeds inherit normalization automatically
 *     (date→ca_date, integer→ca_integer, bigint *_cents→ca_currency,
 *     boolean→ca_boolean_yn) plus PMS-specific enum overrides.
 *
 * `columns` lists every LEARNABLE column (required + optional) with its 0207
 * descriptor type. It deliberately EXCLUDES writer-synthesized columns:
 * generic-table-writer stamps `property_id` on every row and auto-fills any
 * required `timestamptz` column (changed_at / captured_at) with `now()`, so
 * those must never be learned or gated. The drift guard in
 * __tests__/mapper-field-contract.test.ts fails if these drift from 0207.
 */

import type {
  Recipe, ActionRecipe, ParserConfig, LearnedValueTranslations, LearnedDateFormat,
} from './types.js';

/** 0207 descriptor column types (mirrors ColumnDescriptor['type'] in
 *  generic-table-writer.ts; kept local so this module stays a dependency-free
 *  leaf — no runtime import of the supabase-constructing writer). */
export type DescriptorColType =
  | 'text' | 'integer' | 'bigint' | 'numeric' | 'boolean' | 'date' | 'timestamptz' | 'jsonb';

export interface CoreColumn {
  name: string;
  /** 0207 descriptor type — drives the value parser (parserForColumn). */
  type: DescriptorColType;
  /** required in the descriptor AND scraped (i.e. not writer-synthesized). */
  required: boolean;
}

export interface TargetColumnContract {
  /** v4 pms_* table this target writes to (matches recipe-adapter ACTION_ROUTES). */
  table: string;
  /** Every LEARNABLE column (required + optional), mirroring the 0207
   *  descriptor minus writer-synthesized columns (property_id, required
   *  timestamptz). `required` here = a snake_case key the model MUST emit. */
  columns: CoreColumn[];
}

/**
 * The 4 core REQUIRED feeds (mapping-driver REQUIRED_TARGETS). ONLY these are
 * column-gated; every other target returns [] from missingRequiredColumns so
 * optional feeds are never re-asked-to-death or wrongly parked.
 *
 * Mirrors supabase/migrations/0207_pms_table_schemas_and_shadow.sql.
 */
export const CORE_TARGET_CONTRACTS: Partial<
  Record<keyof Recipe['actions'], TargetColumnContract>
> = {
  getRoomStatus: {
    table: 'pms_room_status_log',
    // changed_at (required timestamptz) is writer-stamped → not listed/learned.
    columns: [
      { name: 'room_number', type: 'text', required: true },
      { name: 'status', type: 'text', required: true }, // enum — normalized by ca_status (see ENUM_PARSER_OVERRIDES)
      { name: 'changed_by', type: 'text', required: false },
    ],
  },
  getArrivals: {
    table: 'pms_reservations',
    columns: [
      { name: 'pms_reservation_id', type: 'text', required: true },
      { name: 'guest_name', type: 'text', required: true },
      { name: 'arrival_date', type: 'date', required: true },
      { name: 'departure_date', type: 'date', required: true },
      { name: 'room_number', type: 'text', required: false },
      { name: 'num_nights', type: 'integer', required: false },
      { name: 'status', type: 'text', required: false },
      { name: 'channel_name', type: 'text', required: false },
      { name: 'rate_per_night_cents', type: 'bigint', required: false },
    ],
  },
  getDepartures: {
    table: 'pms_reservations',
    columns: [
      { name: 'pms_reservation_id', type: 'text', required: true },
      { name: 'guest_name', type: 'text', required: true },
      { name: 'arrival_date', type: 'date', required: true },
      { name: 'departure_date', type: 'date', required: true },
      { name: 'room_number', type: 'text', required: false },
      { name: 'num_nights', type: 'integer', required: false },
      { name: 'status', type: 'text', required: false },
      { name: 'channel_name', type: 'text', required: false },
      { name: 'rate_per_night_cents', type: 'bigint', required: false },
    ],
  },
  getWorkOrders: {
    table: 'pms_work_orders_v2',
    columns: [
      { name: 'pms_work_order_id', type: 'text', required: true },
      { name: 'description', type: 'text', required: true },
      { name: 'status', type: 'text', required: true }, // enum {open,in_progress,resolved,cancelled} — CA serves these as JSON (already canonical)
      { name: 'out_of_order', type: 'boolean', required: true },
      { name: 'room_number', type: 'text', required: false },
      { name: 'priority', type: 'text', required: false },
      { name: 'assigned_to', type: 'text', required: false },
    ],
  },
};

/**
 * Max times mapAction re-asks the model to fill missing required columns before
 * accepting blanks (the promotion gate then parks the draft rather than
 * auto-promoting a zero-row feed). Bounds re-ask cost; the per-target step /
 * cost / wallclock / token caps already in mapAction are the outer backstops.
 * Raised 2 → 3 for feature/cua-column-recovery: each re-ask is now FOCUSED
 * (live-DOM verification names exactly which columns are dead and where to
 * look), so the attempts buy real recovery instead of the same blank re-read.
 */
export const MAX_COMPLETENESS_REASKS = 3;

// ─── Value parsers (feat/pms-universal-translate) ────────────────────────────
//
// Value translation is now UNIVERSAL: a descriptor column's TYPE picks a
// GENERIC, PMS-agnostic parser (parsers/generic.ts) that works on any PMS with
// no hand-written code. The two PMS-specific things — the date ORDER and the
// enum VOCABULARY — are LEARNED during mapping and saved in the knowledge file;
// resolveColumnParser() folds those learned translations into the parser config
// at wiring time. The Choice-Advantage parsers (ca.ts) survive ONLY as a
// back-compat / safety fallback for the already-seeded CA knowledge file, which
// has no learned vocabulary yet (see ENUM_PARSER_OVERRIDES below).

/**
 * Enum columns whose canonical value set can't be expressed by type alone, and
 * for which we keep a PMS-specific `ca_*` parser as a FALLBACK — used ONLY when
 * the knowledge file carries no self-learned mapping for that column (i.e. the
 * legacy seeded Choice Advantage file, or a safety net if learning abstained).
 * A brand-new PMS never reaches these: its mapper emits a learned mapping and
 * resolveColumnParser routes to generic_enum instead. Keyed `${table}.${col}`.
 */
const ENUM_PARSER_OVERRIDES: Record<string, string> = {
  'pms_room_status_log.status': 'ca_status',
  'pms_work_orders_v2.status': 'ca_work_order_status',
  'pms_work_orders_v2.priority': 'ca_priority',
};

/** Type → generic format parser name (PMS-agnostic). Returns undefined for
 *  text/jsonb/timestamptz (raw string already satisfies the type check, or the
 *  column is writer-synthesized). Enum handling lives in resolveColumnParser. */
function genericParserForType(type: DescriptorColType, name: string): string | undefined {
  switch (type) {
    case 'date':    return 'generic_date';
    case 'integer': return 'generic_integer';
    case 'bigint':  return name.endsWith('_cents') ? 'generic_currency' : 'generic_integer';
    case 'numeric': return 'generic_number';
    case 'boolean': return 'generic_boolean';
    default:        return undefined;
  }
}

/**
 * Pick the value parser NAME for a descriptor column by TYPE. Generic parser
 * for formattable types; the `ca_*` enum FALLBACK when an override exists (no
 * learned-mapping context here — resolveColumnParser is the learned-aware
 * path). Kept for the contract drift guard + back-compat callers.
 */
export function parserForColumn(table: string, col: { name: string; type: DescriptorColType }): string | undefined {
  const override = ENUM_PARSER_OVERRIDES[`${table}.${col.name}`];
  if (override) return override;
  return genericParserForType(col.type, col.name);
}

// ─── Superset VALUE contract — drives parser selection for EVERY mapped ───────
//     target (the 4 core feeds + the 5 net-new money/booking feeds).
//
// Decoupled from CORE_TARGET_CONTRACTS (which gates required-field NAMES so the
// promotion gate + mapAction re-ask are unchanged). This map is purely about
// VALUE translation: each column's descriptor type, plus `enumValues` for the
// few enum columns (their canonical allowed_values, used for generic_enum's
// safe default + the learn step's target set). Mirrors the live 0207 + 0276
// descriptors; the contract drift guard enforces parity. Writer-stamped
// `captured_at`/`changed_at` (timestamptz) are intentionally excluded.
//
// DEFERRED (no contract yet → resolveColumnParser returns undefined → their
// date/_cents columns stay unparsed, exactly as before this change — NOT a
// regression): the optional report feeds getRevenueDaily / getRatesAndInventory
// / getChannelPerformance / getForecastDaily / getGroupsAndBlocks /
// getLostAndFound / getActivityLog / getGuests / getRoomLayout /
// getDashboardCounts / getHistoricalOccupancy. They have never run end-to-end;
// wiring them is a follow-up that must mirror each one's CURRENT live descriptor
// (several drifted from 0207 — see the room-status / work-order note above).

export interface ValueColumn {
  name: string;
  type: DescriptorColType;
  /** Canonical allowed_values — present iff this is an enum column. */
  enumValues?: string[];
}

export interface TargetValueContract {
  table: string;
  columns: ValueColumn[];
}

const RESERVATION_VALUE_COLUMNS: ValueColumn[] = [
  { name: 'pms_reservation_id', type: 'text' },
  { name: 'guest_name', type: 'text' },
  { name: 'arrival_date', type: 'date' },
  { name: 'departure_date', type: 'date' },
  { name: 'room_number', type: 'text' },
  { name: 'num_nights', type: 'integer' },
  // pms_reservations.status carries a LIVE DB CHECK (booked/checked_in/
  // checked_out/cancelled/no_show or null) but its 0207 descriptor has empty
  // allowed_values, so an un-normalized raw status (e.g. "Due In") batch-loses
  // the WHOLE arrivals/departures reservation row. Give it the canonical set so
  // resolveColumnParser routes it through generic_enum: a learned recipe maps
  // the PMS's words → canonical; anything unknown → null (status is optional, so
  // the reservation still writes). 'unknown' is NOT a CHECK value → onUnknown=null.
  { name: 'status', type: 'text', enumValues: ['booked', 'checked_in', 'checked_out', 'cancelled', 'no_show'] },
  { name: 'channel_name', type: 'text' },
  { name: 'rate_per_night_cents', type: 'bigint' },
];

export const TARGET_VALUE_CONTRACTS: Partial<
  Record<keyof Recipe['actions'], TargetValueContract>
> = {
  // ── 4 core feeds (mirror CORE_TARGET_CONTRACTS + enum canonical sets) ──
  // enumValues mirror the LIVE pms_table_schemas descriptor (which validateRows
  // enforces) — NOT the stale 0207 seed. The room-status + work-order enum sets
  // were widened by later migrations; learning against the live set means a new
  // PMS maps to values the DB CHECK actually accepts (Codex review #7).
  getRoomStatus: {
    table: 'pms_room_status_log',
    columns: [
      { name: 'room_number', type: 'text' },
      { name: 'status', type: 'text', enumValues: ['vacant_clean', 'vacant_dirty', 'occupied', 'occupied_clean', 'occupied_dirty', 'out_of_order', 'out_of_inventory', 'inspected', 'unknown'] },
      { name: 'changed_by', type: 'text' },
    ],
  },
  getArrivals: { table: 'pms_reservations', columns: RESERVATION_VALUE_COLUMNS },
  getDepartures: { table: 'pms_reservations', columns: RESERVATION_VALUE_COLUMNS },
  getWorkOrders: {
    table: 'pms_work_orders_v2',
    columns: [
      { name: 'pms_work_order_id', type: 'text' },
      { name: 'description', type: 'text' },
      { name: 'status', type: 'text', enumValues: ['open', 'in_progress', 'closed', 'deferred', 'resolved'] },
      { name: 'out_of_order', type: 'boolean' },
      { name: 'room_number', type: 'text' },
      { name: 'priority', type: 'text', enumValues: ['urgent', 'high', 'medium', 'low'] },
      { name: 'assigned_to', type: 'text' },
    ],
  },
  // ── 5 net-new feeds (mirror migration 0276; all-text status = free text,
  //    so they need ONLY generic format parsers — a clean universality proof) ──
  getGuestBalances: {
    table: 'pms_guest_balances',
    columns: [
      { name: 'pms_folio_id', type: 'text' },
      { name: 'pms_reservation_id', type: 'text' },
      { name: 'guest_name', type: 'text' },
      { name: 'room_number', type: 'text' },
      { name: 'balance_cents', type: 'bigint' },
      { name: 'deposit_cents', type: 'bigint' },
      { name: 'folio_status', type: 'text' },
      { name: 'last_payment_cents', type: 'bigint' },
      { name: 'last_payment_method', type: 'text' },
    ],
  },
  getPaymentsDaily: {
    table: 'pms_payments_daily',
    columns: [
      { name: 'business_date', type: 'date' },
      { name: 'cash_collected_cents', type: 'bigint' },
      { name: 'card_collected_cents', type: 'bigint' },
      { name: 'deposits_collected_cents', type: 'bigint' },
      { name: 'total_collected_cents', type: 'bigint' },
    ],
  },
  getFutureBookings: {
    table: 'pms_future_bookings',
    columns: [
      { name: 'pms_reservation_id', type: 'text' },
      { name: 'guest_name', type: 'text' },
      { name: 'room_number', type: 'text' },
      { name: 'room_type', type: 'text' },
      { name: 'arrival_date', type: 'date' },
      { name: 'departure_date', type: 'date' },
      { name: 'num_nights', type: 'integer' },
      { name: 'rate_per_night_cents', type: 'bigint' },
      { name: 'total_amount_cents', type: 'bigint' },
      { name: 'status', type: 'text' },
      { name: 'channel_name', type: 'text' },
    ],
  },
  getNoShows: {
    table: 'pms_no_shows',
    columns: [
      { name: 'pms_reservation_id', type: 'text' },
      { name: 'guest_name', type: 'text' },
      { name: 'room_number', type: 'text' },
      { name: 'arrival_date', type: 'date' },
      { name: 'departure_date', type: 'date' },
      { name: 'rate_per_night_cents', type: 'bigint' },
      { name: 'total_amount_cents', type: 'bigint' },
      { name: 'channel_name', type: 'text' },
      { name: 'no_show_date', type: 'date' },
    ],
  },
  getCancellations: {
    table: 'pms_cancellations',
    columns: [
      { name: 'pms_reservation_id', type: 'text' },
      { name: 'guest_name', type: 'text' },
      { name: 'room_number', type: 'text' },
      { name: 'arrival_date', type: 'date' },
      { name: 'departure_date', type: 'date' },
      { name: 'cancelled_date', type: 'date' },
      { name: 'cancellation_fee_cents', type: 'bigint' },
      { name: 'total_amount_cents', type: 'bigint' },
      { name: 'channel_name', type: 'text' },
      { name: 'reason', type: 'text' },
    ],
  },
};

/** The learned translations a recipe carries (subset of Recipe / KnowledgeFile). */
export interface LearnedTranslations {
  valueTranslations?: LearnedValueTranslations;
  dateFormat?: LearnedDateFormat;
}

/**
 * THE universal resolver. Given a target + learned column, return the parser to
 * apply AND its runtime config, folding in the knowledge file's self-learned
 * translations:
 *   - enum column → learned mapping present → generic_enum + that mapping;
 *                   else ca_* fallback (seeded CA / safety net); else
 *                   generic_enum with empty mapping (→ safe default + log).
 *   - date column → generic_date (+ learned dateFormat config when present).
 *   - other formattable types → the matching generic_* parser.
 *   - plain text / unknown column → undefined (no parser; raw string is fine).
 * recipe-adapter calls this per learned column when building TableTemplate
 * fields. Returns undefined for targets/columns not in TARGET_VALUE_CONTRACTS
 * (extra fields pass through unparsed and are dropped by the writer's
 * extra-field check).
 */
export function resolveColumnParser(
  actionKey: keyof Recipe['actions'],
  columnName: string,
  learned?: LearnedTranslations,
): { parser: string; config?: ParserConfig } | undefined {
  const contract = TARGET_VALUE_CONTRACTS[actionKey];
  if (!contract) return undefined;
  const col = contract.columns.find((c) => c.name === columnName);
  if (!col) return undefined;
  const tableCol = `${contract.table}.${columnName}`;

  if (col.enumValues && col.enumValues.length > 0) {
    // An unknown value writes as 'unknown' when that's a valid canonical value
    // (so the row still lands), else null (a required enum then rejects only
    // its own row). Either way it's logged, never a silent guess.
    const onUnknown = col.enumValues.includes('unknown') ? 'unknown' : null;
    const learnedMap = learned?.valueTranslations?.[tableCol];
    if (learnedMap && Object.keys(learnedMap).length > 0) {
      return { parser: 'generic_enum', config: { mapping: learnedMap, onUnknown } };
    }
    // The ca_* parser is a Choice-Advantage-SPECIFIC fallback. Use it ONLY for a
    // LEGACY recipe — one with no learned-translation capability at all (the
    // seeded CA knowledge file, whose `valueTranslations` is undefined). A
    // new-style recipe ALWAYS carries a valueTranslations object (even when
    // empty), so an enum column it didn't learn safely uses generic_enum
    // (→ onUnknown + log) — a brand-new PMS NEVER falls back to a CA-specific
    // parser, which would mis-translate its vocabulary (Codex review #2).
    const isLegacyRecipe = learned?.valueTranslations === undefined;
    if (isLegacyRecipe) {
      const fallback = ENUM_PARSER_OVERRIDES[tableCol];
      if (fallback) return { parser: fallback };
    }
    return { parser: 'generic_enum', config: { onUnknown } };
  }

  const p = genericParserForType(col.type, col.name);
  if (!p) return undefined;
  if (p === 'generic_date' && learned?.dateFormat) {
    return { parser: p, config: { dateFormat: learned.dateFormat } };
  }
  return { parser: p };
}

/**
 * Back-compat NAME-only resolver (no learned context). Used by the contract
 * drift guard / tests. recipe-adapter uses resolveColumnParser (config-aware).
 */
export function parserForLearnedColumn(
  actionKey: keyof Recipe['actions'],
  columnName: string,
): string | undefined {
  return resolveColumnParser(actionKey, columnName)?.parser;
}

// ─── Column-name helpers (names contract) ────────────────────────────────────

/**
 * Pull the learned column map out of any ActionRecipe shape. table/csv/api parse
 * hints carry `.columns`; inline_text carries `.fields`; a drill-down recipe's
 * list page carries `.drillDown.listColumns` (recipe-adapter collapses the
 * recipe to the list page, so that's the map the runtime actually uses).
 *
 * `api` (structured discovery) MUST be here: the promotion gate's
 * missingRequiredColumns() reads this map to decide if a feed has its required
 * columns. Without the `api` case a verified mode:'api' recipe returns {} →
 * every required column reads "missing" → the gate quarantines/parks every
 * structured discovery. (Cross-chat gap closed at integration.)
 */
export function columnsFromAction(action: ActionRecipe): Record<string, string> {
  if (action.drillDown?.listColumns) return action.drillDown.listColumns;
  const parse = action.parse;
  if (!parse) return {};
  if (parse.mode === 'table' || parse.mode === 'csv' || parse.mode === 'api') return parse.hint?.columns ?? {};
  if (parse.mode === 'inline_text') return parse.fields ?? {};
  return {};
}

/**
 * Required column names from `required` whose selector is ABSENT or blank /
 * whitespace in the learned `columns` map. The single shared predicate behind
 * both the mapper's success-branch re-ask and the promotion gate.
 */
export function missingFromList(
  required: string[],
  columns: Record<string, string>,
): string[] {
  return required.filter((name) => {
    const sel = columns[name];
    return typeof sel !== 'string' || sel.trim() === '';
  });
}

/**
 * The required-learned column names for a target — the list the prompt injects
 * as "Required fields for this page". [] for non-core targets, whose
 * requiredFields are left as their existing prose-derived lists.
 */
export function requiredLearnedFor(actionKey: keyof Recipe['actions']): string[] {
  return (CORE_TARGET_CONTRACTS[actionKey]?.columns ?? [])
    .filter((c) => c.required)
    .map((c) => c.name);
}

/**
 * Which of a CORE target's required-learned columns are missing/blank in a
 * learned column map. Non-core targets are not column-gated → always []. Used
 * by the promotion gate; the mapper re-ask uses this too (keyed off actionName)
 * so it only fires for the core feeds' descriptor contract.
 */
export function missingRequiredColumns(
  actionKey: keyof Recipe['actions'],
  columns: Record<string, string>,
): string[] {
  if (!CORE_TARGET_CONTRACTS[actionKey]) return [];
  return missingFromList(requiredLearnedFor(actionKey), columns);
}

// ─── Recovered detail columns (feature/cua-column-recovery) ──────────────────
//
// Stage-2 recovery maps required columns that aren't in the list view onto a
// single record's DETAIL page (ActionRecipe.drillDown.detailColumns) with a
// verified, key-anchored URL template. These helpers are THE shared predicate
// between the promotion gate and the runtime adapter: the gate may only count
// a detail column as "present" when the runtime will actually extract it, and
// the adapter wires exactly the columns the gate counted. One predicate, two
// callers — by construction no gate-passes-but-runtime-blank split-brain.

/**
 * True iff a drillDown's detail mapping is replayable at poll time: the
 * template was mechanically verified during mapping AND every {placeholder}
 * resolves from a non-blank list column (otherwise the runtime cannot build
 * per-row URLs).
 */
export function drillDownDetailEligible(action: ActionRecipe): boolean {
  const dd = action.drillDown;
  if (!dd || dd.templateVerified !== true) return false;
  if (!dd.detailUrlTemplate) return false;
  const placeholders = [...new Set([...dd.detailUrlTemplate.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!))];
  if (placeholders.length === 0) return false;
  return placeholders.every((p) => {
    const sel = dd.listColumns?.[p];
    return typeof sel === 'string' && sel.trim() !== '';
  });
}

/**
 * The CONTRACT-REQUIRED detail columns the runtime will actually enrich for a
 * core target: blank-filtered, required-only, and only when the drillDown is
 * runtime-eligible. Non-core targets (guests / lost-and-found / activity-log
 * style drilldowns) have no required contract → always {} → their adapter
 * behavior is byte-identical to before this feature.
 */
export function recoveredDetailColumns(
  actionKey: keyof Recipe['actions'],
  action: ActionRecipe,
): Record<string, string> {
  if (!CORE_TARGET_CONTRACTS[actionKey]) return {};
  const dd = action.drillDown;
  if (!dd?.detailColumns || !drillDownDetailEligible(action)) return {};
  const required = new Set(requiredLearnedFor(actionKey));
  const out: Record<string, string> = {};
  for (const [col, sel] of Object.entries(dd.detailColumns)) {
    if (!required.has(col)) continue;
    if (typeof sel !== 'string' || sel.trim() === '') continue;
    out[col] = sel;
  }
  return out;
}

/**
 * The column map the promotion gate should judge: the list-view columns plus
 * any RECOVERED detail columns the runtime is guaranteed to extract. This does
 * NOT loosen the gate — the completeness definition is unchanged ("will this
 * feed extract its required columns at poll time"); it widens the evidence to
 * include the verified per-record detail path the recovery built.
 */
export function effectiveColumnsFromAction(
  actionKey: keyof Recipe['actions'],
  action: ActionRecipe,
): Record<string, string> {
  return { ...columnsFromAction(action), ...recoveredDetailColumns(actionKey, action) };
}
