/**
 * PMS recipes — the data structure Claude (computer-use agent) emits when
 * it learns a new PMS, and what the cheap Playwright fleet replays on
 * every pull thereafter.
 *
 * Mental model:
 *   1. CUA mapping run, once per pms_type:
 *      → Claude logs in, clicks around, finds the arrivals/departures/
 *        room-status/staff pages, records selectors and parsing hints.
 *      → Output: a Recipe (this file's main type), saved to pms_recipes.
 *
 *   2. Steady-state pulls, every 15 min per property:
 *      → Playwright loads the recipe, replays the LoginSteps, replays
 *        each ActionSteps[name] block, and uses the ParseHints to extract
 *        canonical PMSArrival[]/PMSDeparture[]/etc.
 *      → Zero Claude tokens spent in this path.
 *
 *   3. When Playwright fails (selector missing, page shape changed) the
 *      pull fails with code='page_changed' and the property is flagged
 *      for re-mapping — a fresh CUA run produces version 2 of the recipe.
 *
 * All recipes are stored as JSONB in pms_recipes.recipe. The shape MUST
 * be backward-compatible: rolling a new field requires a default, since
 * old recipes won't have it.
 */

// ─── Step primitives — the things a recipe can ask Playwright to do ────

/**
 * Discriminated union of low-level browser actions. Keep this small —
 * if Claude needs something fancier than this, that's a sign the recipe
 * is too brittle and we should re-think the layer.
 */
export type RecipeStep =
  | { kind: 'goto';        url: string }
  | { kind: 'fill';        selector: string; value: '$username' | '$password' | string }
  | { kind: 'click';       selector: string }
  | { kind: 'wait_for';    selector: string; timeoutMs?: number }
  | { kind: 'wait_ms';     ms: number }
  | { kind: 'select';      selector: string; value: string }
  | { kind: 'press_key';   key: string }                                // e.g. "Enter"
  | { kind: 'eval_text';   selector: string; binding: string }          // grab innerText into vars
  | { kind: 'screenshot';  reason: string };                            // for debugging only

// $username / $password are placeholders — the runner substitutes the
// property's real credentials at execution time. Never store real creds
// in a recipe.

// ─── Login subsystem ─────────────────────────────────────────────────────

export interface LoginSteps {
  /** The starting URL — usually the value of scraper_credentials.ca_login_url. */
  startUrl: string;
  /** Steps to perform from start to logged-in. */
  steps: RecipeStep[];
  /**
   * After running steps, the runner verifies success by checking that
   * one of these selectors is present (whichever resolves first).
   * If none resolve in `timeoutMs`, the login is considered failed.
   */
  successSelectors: string[];
  /** Default 15s. */
  timeoutMs?: number;
}

// ─── Action subsystem ────────────────────────────────────────────────────

/**
 * Each "action" is a recipe for one method on the PMSAdapter. The keys
 * MUST match the methods on PMSAdapter — see src/lib/pms/adapter.ts.
 *
 * Not every PMS surfaces all of these. Missing entries mean the
 * CUAGenericAdapter will return AdapterError 'unsupported' for that
 * method — the caller decides how to handle it (e.g. fall back to manual
 * entry, or skip).
 */
export interface ActionSteps {
  getArrivals?:        ActionRecipe<ArrivalsParseHint>;
  getDepartures?:      ActionRecipe<DeparturesParseHint>;
  getRoomStatus?:      ActionRecipe<RoomStatusParseHint>;
  getStaffRoster?:     ActionRecipe<StaffParseHint>;
  getRoomLayout?:      ActionRecipe<RoomLayoutParseHint>;
  getDashboardCounts?: ActionRecipe<DashboardParseHint>;
  /** History pulls take a number-of-days param — included in StepContext. */
  getHistoricalOccupancy?: ActionRecipe<HistoryParseHint>;
}

/**
 * One action's full plan: the steps to navigate to the page, plus the
 * hint for parsing the resulting DOM/CSV/whatever into our canonical
 * types.
 */
export interface ActionRecipe<H> {
  steps: RecipeStep[];
  parse: H;
  /** Whether this action issues a CSV download instead of just reading the DOM. */
  downloadsCsv?: boolean;
  /** If true, the action accepts a `date` parameter and the runner injects it
   *  into any `value: '$date'` fields in the steps. */
  acceptsDate?: boolean;
  /** Same as acceptsDate but for a number-of-days param (history calls). */
  acceptsDays?: boolean;
}

// ─── Parse hints — DOM / CSV → canonical types ───────────────────────────

/**
 * The simplest case: a page with a tabular HTML element where each row
 * is one record. The hint says "find rows matching X, extract field Y
 * from each row using selector Z."
 */
export interface TableRowHint {
  /** Selector matching one row (typically a <tr> or a card div). */
  rowSelector: string;
  /** Map of field name (in our canonical type) to selector relative to the row. */
  columns: Record<string, string>;
  /** If the table has a header row that shouldn't be parsed, exclude with this selector. */
  skipSelector?: string;
}

/**
 * For CSVs (Choice Advantage's primary mechanism). The runner downloads
 * the CSV from the previous step, then maps source columns to our fields.
 */
export interface CsvHint {
  /**
   * Map of our field name → CSV column header. Header matching is
   * case-insensitive and trims whitespace.
   */
  columns: Record<string, string>;
  /** Skip rows where this field is empty (used to drop summary/total rows). */
  requiredColumn?: string;
}

export type ArrivalsParseHint =
  | { mode: 'csv';   hint: CsvHint }
  | { mode: 'table'; hint: TableRowHint };

export type DeparturesParseHint =
  | { mode: 'csv';   hint: CsvHint }
  | { mode: 'table'; hint: TableRowHint };

export type RoomStatusParseHint =
  | { mode: 'csv';   hint: CsvHint }
  | { mode: 'table'; hint: TableRowHint };

export type StaffParseHint =
  | { mode: 'csv';   hint: CsvHint }
  | { mode: 'table'; hint: TableRowHint };

export type RoomLayoutParseHint =
  | { mode: 'csv';   hint: CsvHint }
  | { mode: 'table'; hint: TableRowHint };

export type DashboardParseHint = {
  mode: 'inline_text';
  /** Map of our field name → selector that resolves to a number. */
  fields: Record<string, string>;
};

export type HistoryParseHint =
  | { mode: 'csv';   hint: CsvHint }
  | { mode: 'table'; hint: TableRowHint };

// ─── Top-level Recipe shape ──────────────────────────────────────────────

export interface Recipe {
  /** Recipe schema version. Bump on breaking shape changes. */
  schema: 1;
  /** Free-form description — useful for ops debugging. */
  description?: string;
  /** Login flow. */
  login: LoginSteps;
  /** Per-action recipes. */
  actions: ActionSteps;
  /** Optional: hints for the runner about expected timing / quirks. */
  hints?: {
    /** PMS sometimes injects a 2FA / dialog — selectors that mean "try to
     *  dismiss this." Runner clicks each in turn before retrying. */
    dismissDialogs?: string[];
    /** Scroll to bottom before parsing tables (lazy-loading PMSes). */
    scrollBeforeParse?: boolean;
  };
}

// ─── Validation ──────────────────────────────────────────────────────────

/**
 * Cheap structural check used by /api/pms/test before saving a recipe to
 * pms_recipes. Doesn't validate every field exhaustively — just enough to
 * catch malformed JSONB blobs early.
 */
export function isRecipeShape(v: unknown): v is Recipe {
  if (!v || typeof v !== 'object') return false;
  const r = v as Partial<Recipe>;
  if (r.schema !== 1) return false;
  if (!r.login || typeof r.login !== 'object') return false;
  if (typeof r.login.startUrl !== 'string') return false;
  if (!Array.isArray(r.login.steps)) return false;
  if (!Array.isArray(r.login.successSelectors)) return false;
  if (!r.actions || typeof r.actions !== 'object') return false;
  return true;
}
