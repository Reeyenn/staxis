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

import type { Recipe, ActionRecipe } from './types.js';

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
 */
export const MAX_COMPLETENESS_REASKS = 2;

// ─── Value parsers ───────────────────────────────────────────────────────────

/**
 * Enum/text columns that need a PMS-specific code→canonical map the type alone
 * can't express. Keyed `${table}.${column}`. pms_room_status_log.status maps
 * raw CA codes (OCC/VAC/VD/OOO/INSP) → the room-status enum. Deliberately NOT
 * here: pms_reservations.status (free text, no enum constraint) and
 * pms_work_orders_v2.status (different enum, served as canonical JSON, not a
 * DOM scrape) — adding ca_status there would mistranslate their values.
 */
const ENUM_PARSER_OVERRIDES: Record<string, string> = {
  'pms_room_status_log.status': 'ca_status',
};

/**
 * Pick the value parser (parsers/registry.ts name) for a descriptor column,
 * driven by its TYPE so new feeds inherit normalization automatically. Returns
 * undefined for plain text/jsonb (the raw string already satisfies the type
 * check). Enum columns are handled by ENUM_PARSER_OVERRIDES first.
 */
export function parserForColumn(table: string, col: { name: string; type: DescriptorColType }): string | undefined {
  const override = ENUM_PARSER_OVERRIDES[`${table}.${col.name}`];
  if (override) return override;
  switch (col.type) {
    case 'date':    return 'ca_date';
    case 'integer': return 'ca_integer';
    case 'bigint':  return col.name.endsWith('_cents') ? 'ca_currency' : 'ca_integer';
    case 'boolean': return 'ca_boolean_yn';
    // text/numeric/jsonb/timestamptz → no parser (raw string passes the type
    // check, or the column is writer-synthesized and never learned).
    default:        return undefined;
  }
}

/**
 * The parser name to attach to a LEARNED column of a core target, or undefined.
 * recipe-adapter calls this per learned column when building TableTemplate
 * fields. Returns undefined for non-core targets and for learned columns not in
 * the descriptor (extra fields pass through unparsed and are dropped by the
 * writer's extra-field check).
 */
export function parserForLearnedColumn(
  actionKey: keyof Recipe['actions'],
  columnName: string,
): string | undefined {
  const contract = CORE_TARGET_CONTRACTS[actionKey];
  if (!contract) return undefined;
  const col = contract.columns.find((c) => c.name === columnName);
  if (!col) return undefined;
  return parserForColumn(contract.table, col);
}

// ─── Column-name helpers (names contract) ────────────────────────────────────

/**
 * Pull the learned column map out of any ActionRecipe shape. table/csv parse
 * hints carry `.columns`; inline_text carries `.fields`; a drill-down recipe's
 * list page carries `.drillDown.listColumns` (recipe-adapter collapses the
 * recipe to the list page, so that's the map the runtime actually uses).
 */
export function columnsFromAction(action: ActionRecipe): Record<string, string> {
  if (action.drillDown?.listColumns) return action.drillDown.listColumns;
  const parse = action.parse;
  if (!parse) return {};
  if (parse.mode === 'table' || parse.mode === 'csv') return parse.hint?.columns ?? {};
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
