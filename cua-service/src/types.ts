/**
 * Local types for the CUA worker. Subset of src/lib/pms/ in the main
 * Next.js app — kept in sync by hand for now (TODO: extract a shared
 * package once we have 2 consumers, this + scraper).
 */

export type PMSType =
  | 'choice_advantage'
  | 'opera_cloud'
  | 'cloudbeds'
  | 'roomkey'
  | 'skytouch'
  | 'webrezpro'
  | 'hotelogix'
  | 'other';

export interface PMSCredentials {
  loginUrl: string;
  username: string;
  password: string;
}

// ─── Auth-code inbox (Okta 2FA email reader; migration 0274) ───────────────
// Source-agnostic so an SMS factor can be added later without touching
// callers. Mirror in src/lib/pms/ when that shared package exists (see header).

export type AuthCodeSource = 'email' | 'sms';

/** A stored one-time login code (pms_auth_codes row, worker-facing subset). */
export interface PmsAuthCode {
  propertyId: string;
  code: string;
  source: AuthCodeSource;
  receivedAt: string;
  consumedAt?: string | null;
}

export interface RecordAuthCodeInput {
  propertyId: string;
  code: string;
  source?: AuthCodeSource;
  emailTo: string;
  sender?: string | null;
  subject?: string | null;
  rawRef?: string | null;
}

export interface FetchAuthCodeOptions {
  /** Only consider codes received within this many seconds (default 180). */
  maxAgeSeconds?: number;
  /** Give up after this long, returning null (default 90_000). */
  timeoutMs?: number;
  /** Delay between polls (default 3_000). */
  pollMs?: number;
  /**
   * Login watermark: only accept codes received at/after this instant (ISO).
   * The login recipe stamps when it triggered the Okta send so a flood of
   * earlier/forged codes can't be grabbed. Optional until that wiring lands.
   */
  notBefore?: string | null;
}

export type RoomCondition =
  | 'occupied' | 'vacant_clean' | 'vacant_dirty' | 'inspected' | 'out_of_order' | 'unknown';

export interface PMSArrival {
  guestName: string;
  roomNumber: string;
  arrivalDate: string;
  departureDate: string;
  numNights: number;
  numAdults?: number;
  numChildren?: number;
  rateCode?: string;
  confirmationNumber?: string;
  notes?: string;
}

export interface PMSDeparture {
  guestName: string;
  roomNumber: string;
  arrivalDate: string;
  departureDate: string;
  confirmationNumber?: string;
  checkedOut?: boolean;
}

export interface PMSRoomStatus {
  roomNumber: string;
  status: RoomCondition;
  guestName?: string;
  arrivalDate?: string;
  departureDate?: string;
  staySegment?: 'stayover' | 'checkout' | 'arrival' | null;
}

export interface PMSStaffMember {
  name: string;
  role?: string;
  phone?: string;
  email?: string;
  externalId?: string;
}

export interface PMSRoomDescriptor {
  roomNumber: string;
  floor?: string;
  type?: string;
  beds?: string;
}

// ─── Recipe shape (mirrors src/lib/pms/recipe.ts) ────────────────────────

/**
 * Plan v9 F2 — tiered element selector. Recipe replay tries each tier in
 * the order role+name → css → xpath and logs which tier resolved so we
 * can watch CSS selector durability over weeks of polling.
 *
 * Why each tier exists:
 *   - `roleName` is the most durable. ARIA role + accessible name survive
 *     PMS CSS class renames, dynamic className hashing, and most layout
 *     redesigns. Maps directly to Playwright's `page.getByRole(role, {name})`.
 *   - `css` is the historical default — fast, precise, but the first to
 *     break when the PMS team renames a class or restructures the DOM.
 *   - `xpath` is the last resort — most fragile against structural
 *     reorganization but works when class-based selectors fail and there's
 *     no semantic role yet (legacy PMS UIs with no ARIA).
 *
 * All fields are optional so a partial selector still resolves through
 * the tiers we DO have. An empty TieredSelector is a no-op.
 */
export interface TieredSelector {
  roleName?: { role: string; name: string };
  css?: string;
  xpath?: string;
}

export type RecipeStep =
  | { kind: 'goto';        url: string }
  | { kind: 'fill';        selector: string; value: '$username' | '$password' | string }
  // Plan v9 F2: optional tiered fallback. When `tieredSelector` is set the
  // runner tries role+name → css → xpath in order; the legacy single-string
  // `selector` field is still authoritative when `tieredSelector` is absent.
  | { kind: 'click';       selector: string; tieredSelector?: TieredSelector }
  // Coordinate-based variants — emitted by the vision-mode mapper.
  // Plan v9 F2: when SoM resolves a #N badge OR an elementsFromPoint
  // lookup at the click coord finds a labeled element, we also record
  // role+name. Replay tries `getByRole(role, {name})` first and falls back
  // to the recorded coordinate. Old recipes (no roleName) replay
  // exactly as before via `page.mouse.click(x, y)`.
  | { kind: 'click_at';    x: number; y: number; roleName?: { role: string; name: string } }
  | { kind: 'type_text';   value: '$username' | '$password' | string }
  | { kind: 'wait_for';    selector: string; timeoutMs?: number }
  | { kind: 'wait_ms';     ms: number }
  | { kind: 'select';      selector: string; value: string }
  | { kind: 'press_key';   key: string }
  | { kind: 'eval_text';   selector: string; binding: string }
  | { kind: 'screenshot';  reason: string };

export interface LoginSteps {
  startUrl: string;
  steps: RecipeStep[];
  successSelectors: string[];
  timeoutMs?: number;
}

export interface CsvHint {
  columns: Record<string, string>;
  requiredColumn?: string;
}

export interface TableRowHint {
  rowSelector: string;
  columns: Record<string, string>;
  skipSelector?: string;
}

export type ParseHint =
  | { mode: 'csv';   hint: CsvHint }
  | { mode: 'table'; hint: TableRowHint }
  | { mode: 'inline_text'; fields: Record<string, string> };

export interface ActionRecipe {
  steps: RecipeStep[];
  parse: ParseHint;
  downloadsCsv?: boolean;
  acceptsDate?: boolean;
  acceptsDays?: boolean;
  /** Plan v7 — drill-down targets (guests, lost-and-found, activity log)
   *  learn BOTH the list page AND the per-record detail page. Runtime
   *  decides whether to enumerate from the list (cheap) or drill per
   *  record (expensive, on-demand only). recipe-adapter translates this
   *  to a multi-source TableTemplate with list_row + detail_page sources. */
  drillDown?: {
    /** List page selectors (high-throughput core fields). */
    listUrl: string;
    listRowSelector: string;
    listColumns: Record<string, string>;
    /** Detail page URL template inferred from N samples + verified with
     *  one extra drill (Plan v7 — Codex v2 P0 URL templating fix). */
    detailUrlTemplate: string;
    /** Map: template placeholder → list column whose value substitutes in.
     *  e.g. {pms_reservation_id: 'reservation_id'} means substitute the
     *  list row's `reservation_id` column into `{pms_reservation_id}` in
     *  the URL template. */
    detailUrlParams: Record<string, string>;
    /** Selectors for fields on the detail page (nice-to-haves like email,
     *  phone, loyalty_tier that don't appear on the list). */
    detailColumns: Record<string, string>;
    /** Per-field observed coverage across the sampled records. Stored as
     *  "M/N" strings (e.g. "2/3" = present in 2 of 3 samples). Admin UI
     *  surfaces fields below a coverage threshold as warnings. */
    fieldCoverage: Record<string, string>;
    /** Number of sample records the mapper actually drilled into. Should
     *  be ≥ 3 + 1 verification (= 4) for a clean drill-down recipe. */
    samplesDrilled: number;
    /** Whether the verification drill (with substituted URL template)
     *  succeeded — i.e., the template substitution loaded a real detail
     *  page with the expected selectors. False = template-inference
     *  failed; target should quarantine. */
    templateVerified: boolean;
  };
}

export interface Recipe {
  schema: 1;
  description?: string;
  login: LoginSteps;
  actions: {
    // Original Phase 1 keys (getStaffRoster dropped in v8 Phase D.1 — no
    // pms_staff_roster table; never migrated to v4 schema; mapper hasn't
    // emitted it since the 13-target TARGETS array landed in 2026-05).
    getArrivals?:        ActionRecipe;
    getDepartures?:      ActionRecipe;
    getRoomStatus?:      ActionRecipe;
    // Already-extensible Phase 1 keys
    getRoomLayout?:      ActionRecipe;
    getDashboardCounts?: ActionRecipe;
    getHistoricalOccupancy?: ActionRecipe;
    // Phase 2 (Plan v7) — 9 net-new targets for the full 15-table schema.
    // Each maps to one pms_* table in v4. `getReportsCache` is the one
    // intentionally-deferred target (too polymorphic — see plan v7 OOS).
    getGuests?:               ActionRecipe;
    getRevenueDaily?:         ActionRecipe;
    getForecastDaily?:        ActionRecipe;
    getChannelPerformance?:   ActionRecipe;
    getActivityLog?:          ActionRecipe;
    getLostAndFound?:         ActionRecipe;
    getGroupsAndBlocks?:      ActionRecipe;
    getRatesAndInventory?:    ActionRecipe;
    getWorkOrders?:           ActionRecipe;  // currently fetched via fetch_api on CA but the mapper's never been pointed at it; adding so a fresh PMS can have it learned
  };
  hints?: {
    dismissDialogs?: string[];
    scrollBeforeParse?: boolean;
  };
}

// ─── Phase 3: PMS write-back recipe shapes ────────────────────────────────
//
// Writes are intentionally a SEPARATE type family from the read RecipeStep
// union above. A malformed/poisoned write recipe must never be able to
// change how reads or login replay. Two deliberate safety properties baked
// into the TYPE here (Codex adversarial review P0-3):
//   1. WriteStep OMITS coordinate clicks (`click_at`). A write must target an
//      element by an exact, asserted match — never a pixel guess that could
//      land on the wrong room.
//   2. Write values use a `$payload.<field>` family ONLY. Credentials
//      ($username/$password) are never part of a write step — enforced at
//      runtime in write-steps.ts (defense-in-depth) AND absent from the
//      value typing intent here.

/** Scope a write step to the whole page or to the single located room row. */
export type WriteScope = 'page' | 'row';

/** Locate exactly ONE row by an exact-text match on a payload field.
 *  Exact equality (trimmed, not substring) so room "10" can never match
 *  "110" (Codex P0-3 wrong-room vector). */
export interface WriteRowLocator {
  /** Selector for candidate rows, e.g. '#hkTable tbody tr'. */
  rowSelector: string;
  /** Sub-selector within a row holding the key text; omit to match the row's own text. */
  matchCell?: string;
  /** Which payload field to exact-match (e.g. 'room_number'). */
  matchParam: string;
}

export type WriteStep =
  | { kind: 'click';           selector: string; scope?: WriteScope; tieredSelector?: TieredSelector }
  | { kind: 'fill';            selector: string; value: string; scope?: WriteScope }
  | { kind: 'select';          selector: string; value: string; scope?: WriteScope }
  | { kind: 'type_text';       value: string }
  | { kind: 'press_key';       key: string }
  | { kind: 'wait_for';        selector: string; scope?: WriteScope; timeoutMs?: number }
  | { kind: 'wait_ms';         ms: number }
  | { kind: 'assert_text';     selector: string; scope?: WriteScope; equals?: string; contains?: string; timeoutMs?: number }
  | { kind: 'wait_for_change'; selector: string; scope?: WriteScope; fromText?: string; timeoutMs?: number }
  // The commit step — tagged distinctly so dry-run skips EXACTLY the commit
  // and nothing else.
  | { kind: 'save';            selector?: string; scope?: WriteScope; tieredSelector?: TieredSelector };

export interface WriteActionRecipe {
  /** Stable action key, e.g. 'set_room_status'. */
  key: string;
  description?: string;
  /** Payload fields required before ANY browser action (fail-closed if missing). */
  requiredParams: string[];
  /** Allowed values per param — reject junk before touching the PMS. */
  paramEnums?: Record<string, string[]>;
  /** Navigate here first (the page hosting the editable rows). Pinned to allowedHost. */
  pageUrl: string;
  /** How to find the single target row (exact-text match). */
  rowLocator: WriteRowLocator;
  /** Optional: assert the row's current value before editing (idempotency / sanity). */
  precondition?: { selector: string; scope?: WriteScope; equals?: string; contains?: string };
  /** The edit steps (open control -> choose value -> save). $payload + scope aware. */
  steps: WriteStep[];
  /** In-page success check run immediately after steps (Layer-1 verify). */
  verifyInPage?: { selector: string; scope?: WriteScope; equals?: string; contains?: string; timeoutMs?: number };
  /** Authoritative Layer-2 verify: reload the page and re-assert verifyInPage
   *  against a freshly-located row. Default true. Set false to trust the
   *  in-page assert alone (rare). */
  rereadAfterReload?: boolean;
  /** A selector present ONLY when logged in. The handler fails closed
   *  ('session_expired') if it's absent after navigating — never blind-clicks
   *  into a login wall (Codex P1-6). */
  loggedInSelector?: string;
  /** Map our internal value -> the PMS's on-screen string for select/verify. */
  valueMap?: Record<string, string>;
  /** Provenance for the safety gate (how the recipe was learned/validated). */
  verifiedAgainst: 'mock' | 'practice_room' | 'path_only';
  learnedAt?: string;
  learnedBy?: string;
}

// ─── Plan v7: TableTemplate — the canonical runtime template ──────────────
//
// `recipe-adapter.ts` translates BOTH legacy Recipe.actions AND new mapper
// output into this shape. Runtime (template-runner.ts, generic-table-writer.ts)
// only ever sees TableTemplate — eliminates split-brain risk between the
// legacy normalizer path and the new template path.
//
// `sources[]` is multi-source by default: most feeds have one source, but
// dashboard_counts has three (parallel fetch + aggregate). URL templates
// support drill-down: mapper learns N concrete URLs from samples, infers
// the template (e.g. `/Reservation/view?id={pms_reservation_id}`), verifies
// with an extra sample.

export type WriteStrategy = 'upsert' | 'append' | 'reconcile';
export type SnapshotScope = 'full' | 'delta';
export type ExtractionMode = 'csv_download' | 'dom_table' | 'fetch_api' | 'dom_inline';

export interface TableTemplateSource {
  /** Stable name within the template (matches keys in `aggregate.rules` if used). */
  name: string;
  /** Concrete URL (single-source feeds), or one-of-N sample URLs (drill-down). */
  url: string;
  /** Templated URL, e.g. '/Reservation/view?id={pms_reservation_id}'. Optional —
   *  if set, runtime substitutes params per-row before fetching (drill-down). */
  urlTemplate?: string;
  /** Mapping from template placeholder → source column (e.g. {pms_reservation_id: 'pms_reservations.pms_reservation_id'}). */
  urlParams?: Record<string, string>;
  mode: ExtractionMode;
  /** Mode-specific selectors (e.g. {rowSelector: '...'} for dom_table; {csvCheckbox, downloadButton} for csv_download). */
  selectors?: Record<string, string>;
  /** Field → selector/column map for the rows this source returns. */
  columns?: Record<string, string>;
  /** Opaque per-mode extras (HTTP method/body for fetch_api, preStepClick for csv_download, etc.). */
  extra?: Record<string, unknown>;
  /** Plan v9 F2 — tiered alternatives to `selectors.rowSelector`. When set,
   *  runtime tries role+name → css → xpath in order. Falls back to
   *  `selectors.rowSelector` if all tiers fail or this field is absent.
   *  Backward-compat: legacy templates without this field replay using
   *  the existing single-string rowSelector exactly as before. */
  selectorsTiered?: Record<string, TieredSelector>;
  /** Plan v9 F2 — tiered per-column alternatives. Keyed by the same
   *  column name as `columns`. Runtime checks columnsTiered first; if
   *  the column has tiered selectors AND any tier resolves on the row,
   *  uses that. Else falls through to `columns[col]` (CSS). Optional. */
  columnsTiered?: Record<string, TieredSelector>;
}

export interface TableTemplateAggregate {
  /** How to combine rows from multiple sources into a single result set. */
  strategy: 'merge_named' | 'concat_rows' | 'first_non_null';
  /** For merge_named: target_col → "from source <name> field <col>". */
  rules?: Record<string, string>;
}

export type FieldOrigin = 'list_row' | 'detail_page';

export interface TableTemplateField {
  /** Where this field's value comes from. For drill-down targets, fields can
   *  come from the list row (cheap, high-throughput) or from per-record
   *  detail-page extraction (expensive, only on demand). */
  origin: FieldOrigin;
  /** Which source[] name this field reads from. */
  source: string;
  /** Selector or CSV column name in the source. */
  selectorOrColumn: string;
  /** Parser plugin to apply (looked up from parsers/registry.ts). */
  parser?: string;
}

export interface TableTemplate {
  /** Target table in the pms_* schema (e.g. 'pms_reservations'). */
  tableName: string;
  /** Natural-key columns used for upserts / reconcile lookups. */
  keys: string[];
  writeStrategy: WriteStrategy;
  /** Required for `reconcile`. `'full'` permits auto-resolve of disappeared
   *  rows; `'delta'` does NOT (the extractor isn't seeing every row). */
  snapshotScope: SnapshotScope;
  /** One or more sources. Single-source = no aggregation needed. */
  sources: TableTemplateSource[];
  /** Required iff sources.length > 1. */
  aggregate?: TableTemplateAggregate;
  /** Per-column extraction spec. */
  fields: Record<string, TableTemplateField>;
  /** Set by the mapper when budget tripped mid-target — runtime uses partial
   *  data but flags in admin UI as "needs operator review." */
  incomplete?: boolean;
  /** Plan v8 self-repair — the Recipe.actions key this template was built
   *  from. Lets session-driver's zero-row-failure detection map a broken
   *  TEMPLATE back to the RECIPE TARGET KEY for a single-target re-learn
   *  (vs the full $25 re-mapping). For multi-source templates (e.g.
   *  dashboard_counts merges arrivals+departures+in_house), this is the
   *  PRIMARY source's action key — repair re-learns that one and accepts
   *  that the other sources' selectors are still good. */
  sourceActionKey?: keyof Recipe['actions'];
}

// ─── Job + recipe storage shapes ──────────────────────────────────────────

export interface OnboardingJob {
  id: string;
  property_id: string;
  pms_type: PMSType;
  status: 'queued' | 'running' | 'mapping' | 'extracting' | 'complete' | 'failed';
  step: string | null;
  progress_pct: number;
  result: Record<string, unknown> | null;
  error: string | null;
  error_detail: Record<string, unknown> | null;
  recipe_id: string | null;
  worker_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  /** Set true by /api/admin/regenerate-recipe so the worker runs the
   *  CUA mapper even when an active recipe exists for this pms_type. */
  force_remap: boolean;
}

export interface ScraperCredentialsRow {
  property_id: string;
  pms_type: PMSType;
  ca_login_url: string;
  ca_username: string;
  ca_password: string;
  is_active: boolean;
}
