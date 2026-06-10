/**
 * Target column contract (fix/mapper-field-contract).
 *
 * THE field-name contract between what the vision mapper LEARNS and what the
 * generic-table-writer VALIDATES/WRITES. The mapper emits a learned column map
 * keyed by whatever names the prompt tells the model to use; the writer
 * (persistence/generic-table-writer.ts → validateRows) looks up each row by the
 * EXACT snake_case column name in the pms_table_schemas descriptor (migration
 * 0207). If those two name-spaces disagree, every row fails its required-field
 * check and the feed writes ZERO rows while still "succeeding" — exactly the
 * arrivals/departures/room-status bug on the first live mapping run (job
 * 55f8178d), where the model emitted camelCase (guestName, arrivalDate, …) but
 * pms_reservations requires guest_name, arrival_date, pms_reservation_id, ….
 *
 * This module is the single source of truth that keeps the two aligned:
 *   - mapper.ts uses `requiredLearned` as a core target's `requiredFields` (the
 *     keys the prompt tells the model to emit) AND for the success-branch
 *     completeness re-ask.
 *   - mapping-driver.ts uses it in evaluatePromotionGate to refuse to
 *     auto-promote a required feed whose learned columns are missing/blank.
 *
 * `requiredLearned` = descriptor columns that are `required:true` AND must be
 * SCRAPED — i.e. NOT writer-synthesized. generic-table-writer.ts stamps
 * `property_id` on every row and auto-fills any required `timestamptz` column
 * (changed_at / captured_at) with `now()`, so those are deliberately excluded:
 * demanding them from the model would re-ask forever for data the page never
 * shows. The rule is exactly: required && type !== 'timestamptz' && name !==
 * 'property_id'. Names mirror 0207; the drift guard in
 * __tests__/mapper-field-contract.test.ts fails if they diverge.
 *
 * OUT OF SCOPE (Wave-2): this fixes column NAMES only. Value normalization
 * (room-status `status` enum, work-order `out_of_order` boolean / `status`
 * enum) is a separate layer with no field.parser wired today — see the test's
 * documented-gap assertions.
 */

import type { Recipe, ActionRecipe } from './types.js';

export interface TargetColumnContract {
  /** v4 pms_* table this target writes to (matches recipe-adapter ACTION_ROUTES). */
  table: string;
  /** Descriptor columns the model MUST learn (required & scraped, snake_case). */
  requiredLearned: string[];
  /** Descriptor columns worth learning but not required (never gate/re-ask on
   *  these). This is a DESCRIPTOR RECORD, not a prompt list — numeric/boolean
   *  optionals (e.g. num_nights, rate_per_night_cents) must NOT be added to a
   *  target's goal-prose column list until value-normalization parsers exist,
   *  because the DOM/CSV extractors return raw strings and validateRows rejects
   *  the WHOLE row on a string-for-integer/boolean type mismatch (Wave-2). */
  optionalLearned: string[];
}

/**
 * The 4 core REQUIRED feeds (mapping-driver REQUIRED_TARGETS). ONLY these are
 * column-gated; every other target returns [] from missingRequiredColumns so
 * optional feeds are never re-asked-to-death or wrongly parked.
 *
 * Mirrors supabase/migrations/0207_pms_table_schemas_and_shadow.sql:
 *   pms_reservations      required: pms_reservation_id, guest_name,
 *                                   arrival_date, departure_date
 *   pms_room_status_log   required: room_number, status, changed_at(ts→stamped)
 *   pms_work_orders_v2    required: pms_work_order_id, description, status,
 *                                   out_of_order
 */
export const CORE_TARGET_CONTRACTS: Partial<
  Record<keyof Recipe['actions'], TargetColumnContract>
> = {
  getRoomStatus: {
    table: 'pms_room_status_log',
    // changed_at is required in the descriptor but timestamptz → auto-stamped
    // by the writer, so it is NOT something the model has to learn.
    requiredLearned: ['room_number', 'status'],
    optionalLearned: ['changed_by'],
  },
  getArrivals: {
    table: 'pms_reservations',
    requiredLearned: ['pms_reservation_id', 'guest_name', 'arrival_date', 'departure_date'],
    optionalLearned: ['room_number', 'num_nights', 'status', 'channel_name', 'rate_per_night_cents'],
  },
  getDepartures: {
    table: 'pms_reservations',
    requiredLearned: ['pms_reservation_id', 'guest_name', 'arrival_date', 'departure_date'],
    optionalLearned: ['room_number', 'num_nights', 'status', 'channel_name', 'rate_per_night_cents'],
  },
  getWorkOrders: {
    table: 'pms_work_orders_v2',
    requiredLearned: ['pms_work_order_id', 'description', 'status', 'out_of_order'],
    optionalLearned: ['room_number', 'priority', 'assigned_to'],
  },
};

/**
 * Max times mapAction re-asks the model to fill missing required columns before
 * accepting blanks (the promotion gate then parks the draft rather than
 * auto-promoting a zero-row feed). Bounds re-ask cost; the per-target step /
 * cost / wallclock / token caps already in mapAction are the outer backstops.
 */
export const MAX_COMPLETENESS_REASKS = 2;

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
 * Which of a CORE target's required-learned columns are missing/blank in a
 * learned column map. Non-core targets are not column-gated → always []. Used
 * by the promotion gate; the mapper re-ask uses missingFromList over the
 * target's own requiredFields (which for core targets === requiredLearned).
 */
export function missingRequiredColumns(
  actionKey: keyof Recipe['actions'],
  columns: Record<string, string>,
): string[] {
  const contract = CORE_TARGET_CONTRACTS[actionKey];
  if (!contract) return [];
  return missingFromList(contract.requiredLearned, columns);
}

/**
 * The required-learned column names for a target — the list the prompt injects
 * as "Required fields for this page". [] for non-core targets, whose
 * requiredFields are left as their existing prose-derived lists.
 */
export function requiredLearnedFor(actionKey: keyof Recipe['actions']): string[] {
  return CORE_TARGET_CONTRACTS[actionKey]?.requiredLearned ?? [];
}
