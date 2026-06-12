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

/** A learned STRUCTURED-DATA endpoint — the JSON the page itself fetches under
 *  the hood. The mapper emits this (mode:'api') only after capturing the call
 *  AND verifying its rows reconcile with the DOM-scraped "oracle" for the same
 *  feed (silent-wrong-data guard). recipe-adapter translates it to a runtime
 *  fetch_api source (extractors/fetch-api.ts), replayed via
 *  page.evaluate(fetch,{credentials:'include'}) every poll (cookies ride along). */
export interface ApiHint {
  /** Endpoint URL the page calls (same-origin; replayed with the live session). */
  url: string;
  method: 'GET' | 'POST';
  /** POST body. MAY contain {today} / {date} placeholders the runtime re-templates
   *  to the current date each poll — the stale-date guard (a frozen date silently
   *  returns yesterday's data). GET date params live in the url the same way. */
  bodyTemplate?: string;
  headers?: Record<string, string>;
  /** Dot-path to the row array inside the JSON (e.g. 'data.reservations').
   *  Empty = response is already the array, or a {rows|results|data} envelope. */
  jsonPath?: string;
  /** our snake_case descriptor column name → the JSON key on each row. */
  columns: Record<string, string>;
}

export type ParseHint =
  | { mode: 'csv';   hint: CsvHint }
  | { mode: 'table'; hint: TableRowHint }
  | { mode: 'inline_text'; fields: Record<string, string> }
  | { mode: 'api';   hint: ApiHint };

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
    // feat/pms-universal-translate — 4 new universal money/booking feeds.
    // Money splits into two grains: per-folio balances + a daily collected
    // roll. All optional (never gate promotion / never regress the core feeds).
    getGuestBalances?:        ActionRecipe;  // who owes — outstanding folio balances + deposits
    getPaymentsDaily?:        ActionRecipe;  // collected today (cash + card + deposits)
    getFutureBookings?:       ActionRecipe;  // on-the-books reservations for UPCOMING dates (pace)
    getNoShows?:              ActionRecipe;  // last night's no-show reservations
    getCancellations?:        ActionRecipe;  // cancelled reservations
  };
  hints?: {
    dismissDialogs?: string[];
    scrollBeforeParse?: boolean;
  };
  /** feat/pms-universal-translate — self-learned VALUE translation, saved in
   *  the knowledge file alongside the WHERE-data-lives selectors. Optional so
   *  pre-existing recipes (e.g. the seeded Choice Advantage file) load fine and
   *  fall back to the ca_* parsers / heuristic date parse. */
  valueTranslations?: LearnedValueTranslations;
  dateFormat?: LearnedDateFormat;
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

// ─── Universal value translation (feat/pms-universal-translate) ─────────────
//
// The mapper LEARNS how a PMS formats its values (date order, status
// vocabulary) during the first mapping run and SAVES it in the knowledge
// file. At extraction time the generic parsers (parsers/generic.ts) read
// this learned config and translate ANY PMS's strings to the canonical types
// the descriptor expects — no per-PMS hand-written parser required.

export type DateOrder = 'MDY' | 'DMY' | 'YMD';

/** A date format learned during mapping. `order` disambiguates M/D vs D/M so
 *  runtime never has to guess "6/10" = June 10 or Oct 6. `confidence:'low'`
 *  means the samples were all ambiguous (every token ≤ 12) → the parser falls
 *  back to its heuristic rather than trusting a coin-flip order. */
export interface LearnedDateFormat {
  order: DateOrder;
  /** The literal separator observed ('/', '-', '.'). Optional — the parser
   *  tolerates any separator when absent. */
  separator?: string;
  confidence: 'high' | 'low';
  /** A few raw samples the inference was drawn from (audit / debugging). */
  samples?: string[];
}

/** Per-`${table}.${column}` raw→canonical value maps, self-learned by the
 *  mapper for enum columns whose vocabulary is PMS-specific (e.g. a PMS that
 *  writes "Belegt" for occupied). Saved in the knowledge file, reused by every
 *  hotel on that PMS family. */
export type LearnedValueTranslations = Record<string, Record<string, string>>;

/** Runtime config handed to a parser via TableTemplateField.parserConfig.
 *  Each generic parser reads only the keys it needs; ca_* parsers ignore it. */
export interface ParserConfig {
  /** generic_date — the learned format. Absent → heuristic parse. */
  dateFormat?: LearnedDateFormat;
  /** generic_enum — normalized-raw → canonical mapping. */
  mapping?: Record<string, string>;
  /** generic_enum — value emitted when raw isn't in `mapping` (default null). */
  onUnknown?: string | null;
}

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
  /** Learned config the parser reads at runtime (date format / enum mapping).
   *  Built by recipe-adapter from the knowledge file's valueTranslations +
   *  dateFormat. Ephemeral (rebuilt each poll) — never persisted. */
  parserConfig?: ParserConfig;
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
  /** feature/cua-column-recovery — per-row detail enrichment for REQUIRED
   *  columns recovered onto a record's detail page (ActionRecipe.drillDown
   *  with a verified, key-anchored URL template). After the list rows are
   *  extracted, the runner substitutes each row's values into `urlTemplate`,
   *  navigates (host-pinned), reads `columns` with the shared dom-rows reader
   *  and merges the values into the row before parsing. Set ONLY by
   *  recipe-adapter when target-contract's drillDownDetailEligible passes —
   *  the same predicate the promotion gate counts columns with. This
   *  supersedes the never-wired TableTemplateSource.urlTemplate/urlParams
   *  fields from the original drill-down design. Runtime-only (rebuilt each
   *  poll), never persisted. */
  rowDetail?: {
    /** Absolute templated URL, e.g. 'https://pms/Res/view?id={pms_reservation_id}'. */
    urlTemplate: string;
    /** Template placeholder → list column whose row value substitutes in
     *  (identity-named by the mapper today). */
    urlParams: Record<string, string>;
    /** field → detail-page selector ('@attr' convention supported). */
    columns: Record<string, string>;
  };
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

// ─── CUA Learning Board (feature/cua-assist-board) ────────────────────────
// Per-feed learning state the mapper persists into workflow_jobs.result
// (keys `targetCatalog` + `boardTargets`, alongside the existing
// `actionsSoFar`) so the admin Learning Board can show, per feed: what was
// found (with a small captured-row preview), what's being searched, and
// what failed/was unavailable. "Stuck" is intentionally NOT a persisted
// status — the board derives it live from the pending mapping_help_requests
// row, so a found feed can never be flagged.
//
// ⚠ Hand-synced duplicate reader lives in src/lib/pms/learning-board.ts
// (Next.js app). Display-only contract: every field optional on the reader
// side; additive changes only.

/** One catalogue entry per mapper target, written once at run start. */
export interface BoardTargetDescriptor {
  key: string;
  /** Human label shown on the board (the target's progressLabel). */
  label: string;
  /** Business-domain goal text (what the robot is looking for). */
  goal: string;
  optional: boolean;
}

/** Small captured-data preview attached when a feed is found. */
export interface BoardPreview {
  /** Rows matched on the feed page at success time (table-mode targets). */
  rowCount?: number;
  /** Up to 3 real captured rows/records, cells truncated. */
  sample?: Array<Record<string, string>>;
  /** 'rows' = feed table rows; 'records' = drill-down sample records. */
  sampleKind?: 'rows' | 'records';
}

export type BoardTargetStatus = 'searching' | 'found' | 'unavailable' | 'failed';

export interface BoardTargetState {
  status: BoardTargetStatus;
  startedAt?: string;
  finishedAt?: string;
  /** True when carried from a prior attempt (reclaim) or repair seed. */
  carried?: boolean;
  /** Failure/unavailable explanation (truncated). */
  reason?: string;
  preview?: BoardPreview;
}
