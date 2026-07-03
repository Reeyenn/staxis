/**
 * feat/cua-partial-promotion — per-property, per-feed trust derivation.
 *
 * THE app-side honesty layer. The CUA's promotion gate parks a recipe that
 * is missing some feeds as a gap-annotated draft (`park_partial`); when the
 * admin promotes it, it goes live with the gaps recorded in the knowledge
 * envelope's `feedGaps` (cua-service/src/knowledge-file.ts — keep
 * `FeedGaps`/`FeedGapEntry` in sync with that file, per the CLAUDE.md
 * type-sync pitfall). Every surface that renders feed data asks this module
 * "is this feed trustworthy for this property?" and shows a "still learning"
 * state instead of a confident zero / empty list / all-clean / all-dirty
 * board when it isn't. This module is PURE (no I/O) so it's unit-testable;
 * the supabaseAdmin wrapper lives in src/lib/pms-feed-status-server.ts.
 *
 * Three feed states, with precedence:
 *  - 'learning'    — the target is listed in feedGaps (missing, or present
 *                    but structurally dead). Gap-listing TAKES PRECEDENCE
 *                    over presence in `actions`: an incomplete_columns feed
 *                    is present AND dead — classifying it 'live' would
 *                    resurrect the exact fake-empty/all-dirty bug this
 *                    feature exists to prevent. Learning feeds are being
 *                    auto-retried daily (backfill cron; paused while a
 *                    newer draft awaits the admin's review).
 *  - 'live'        — the target is in `actions` and not gap-listed.
 *  - 'unavailable' — absent and not gap-listed: outside the mapper's
 *                    learnable catalogue (e.g. getDashboardCounts on every
 *                    newly-learned family) or simply never expected. Copy
 *                    must say "not provided by this PMS connection" — never
 *                    a false "retrying" claim.
 */

export type FeedState = 'live' | 'learning' | 'unavailable';

/** Mirror of cua-service/src/knowledge-file.ts FeedGapEntry — keep in sync. */
export interface FeedGapEntry {
  target: string;
  reason: 'not_found' | 'incomplete_columns';
  missingColumns?: string[];
}

/** Mirror of cua-service/src/knowledge-file.ts FeedGaps — keep in sync. */
export interface FeedGaps {
  computedAt: string;
  missingRequired: FeedGapEntry[];
  missingBusinessCritical: string[];
}

/**
 * Mirror of mapping-driver's REQUIRED_TARGETS (cua-service). Used ONLY for
 * the legacy fallback below (active knowledge files written before feedGaps
 * existed). Small + stable by design; if it ever changes cua-side, the
 * contract tests there will force a release note.
 */
const REQUIRED_TARGETS = ['getRoomStatus', 'getArrivals', 'getDepartures', 'getWorkOrders'] as const;

/** Semantic feed key → CUA target name. The five feeds user surfaces key off. */
export const FEED_TARGETS = {
  roomStatus: 'getRoomStatus',
  arrivals: 'getArrivals',
  departures: 'getDepartures',
  workOrders: 'getWorkOrders',
  dashboardCounts: 'getDashboardCounts',
} as const;

export type FeedKey = keyof typeof FEED_TARGETS;

export interface PropertyFeedStatus {
  /**
   * - 'no_pms'     — no property_sessions row: a manual hotel; the app is the
   *                  system of record. Surfaces render exactly as today.
   * - 'onboarding' — CUA session exists but the family has no active
   *                  knowledge file yet (first learn in flight / quarantined).
   *                  The onboarding wizard owns this state; v1 deliberately
   *                  adds no new banners here.
   * - 'live'       — an active knowledge file exists; per-feed states apply.
   */
  mode: 'no_pms' | 'onboarding' | 'live';
  /**
   * Property-level connection health, independent of family-level feeds —
   * a brand-new hotel joining an existing family has 'live' feeds but empty
   * tables until its own session starts reading.
   * - 'pending' — session has never successfully read (no
   *   last_successful_read_at).
   * - 'paused'  — stopped / paused_mfa / paused_circuit_breaker /
   *   failed_restart. (paused_cost_cap is NOT here: deterministic reads
   *   continue under the cost cap, only Claude calls pause — 0201 comment.)
   * When connection !== 'healthy', surfaces show ONLY the "connecting…"
   * banner variant and suppress feed-level banners (no stacking).
   */
  connection: 'healthy' | 'pending' | 'paused';
  feeds: Record<FeedKey, FeedState>;
  /**
   * Server-derived tile values (pms_* tables are RLS deny-all-browser, so
   * tiles can't read them directly — and the legacy anon snapshot read was
   * silently dead). Populated only by the server helper, only for feeds in
   * states that make the number trustworthy.
   */
  derived?: {
    /** Count of today's active arrivals (booked/checked_in, property-local
     *  today) from pms_reservations. Present only when `arrivals` is live. */
    arrivalsToday?: number;
    /** pms_in_house_snapshot counts. Present only when dashboardCounts live. */
    snapshotArrivalsRemaining?: number | null;
    snapshotDeparturesRemaining?: number | null;
    snapshotInHouse?: number | null;
  };
  /** True iff a REQUIRED feed is learning. BC-only gaps do not amber the UI. */
  isPartial: boolean;
}

/** Minimal slice of property_sessions this derivation needs. */
export interface FeedStatusSessionRow {
  pms_family: string;
  status: string;
  last_successful_read_at: string | null;
}

/** Minimal slice of the active pms_knowledge_files row. */
export interface FeedStatusKnowledgeRow {
  actions?: Record<string, unknown> | null;
  feedGaps?: FeedGaps | null;
}

/**
 * The fail-safe value: renders every surface exactly as today (no banners,
 * no neutralization). Used for manual hotels AND as the containment value
 * whenever the server helper errors — this feature may only ever ADD
 * honesty, never block data.
 */
export const NO_PMS_FEED_STATUS: PropertyFeedStatus = Object.freeze({
  mode: 'no_pms',
  connection: 'healthy',
  feeds: Object.freeze({
    roomStatus: 'live',
    arrivals: 'live',
    departures: 'live',
    workOrders: 'live',
    dashboardCounts: 'live',
  }),
  isPartial: false,
}) as PropertyFeedStatus;

const PAUSED_STATUSES = new Set([
  'stopped', 'paused_mfa', 'paused_circuit_breaker', 'failed_restart',
  // The worker writes this when a hotel has no active knowledge file yet
  // (session-driver start()). It's a genuine not-reading pause — without it
  // a parked session derived connection 'healthy', hiding the problem.
  'paused_no_knowledge_file',
]);

function deriveConnection(session: FeedStatusSessionRow): PropertyFeedStatus['connection'] {
  if (PAUSED_STATUSES.has(session.status)) return 'paused';
  if (!session.last_successful_read_at) return 'pending';
  return 'healthy';
}

function deriveFeedState(target: string, actions: Set<string>, gapped: Set<string>, required: boolean): FeedState {
  // Gap-listing wins over presence — see module header.
  if (gapped.has(target)) return 'learning';
  if (actions.has(target)) return 'live';
  return required ? 'learning' : 'unavailable';
}

/**
 * Pure derivation. `session` null → no_pms. `knowledge` null → onboarding.
 * Otherwise per-feed states from actions + feedGaps, with the legacy
 * fallback: an active file written before feedGaps existed lists no gaps,
 * so a required target absent from `actions` still classifies 'learning'
 * (presence fallback — catches manually-promoted partial drafts).
 */
export function deriveFeedStatus(
  session: FeedStatusSessionRow | null,
  knowledge: FeedStatusKnowledgeRow | null,
): PropertyFeedStatus {
  if (!session) return NO_PMS_FEED_STATUS;

  if (!knowledge) {
    return {
      mode: 'onboarding',
      connection: deriveConnection(session),
      // Fail-safe 'live' (= render as today): the wizard owns onboarding
      // messaging; a consumer that forgets to check `mode` must not splash
      // banners over every still-onboarding hotel.
      feeds: { ...NO_PMS_FEED_STATUS.feeds },
      isPartial: false,
    };
  }

  const actions = new Set(Object.keys(knowledge.actions ?? {}));
  const gaps = knowledge.feedGaps ?? null;
  const gappedRequired = new Set((gaps?.missingRequired ?? []).map((g) => g.target));
  const gappedBc = new Set(gaps?.missingBusinessCritical ?? []);
  const gapped = new Set([...gappedRequired, ...gappedBc]);
  const requiredSet = new Set<string>(REQUIRED_TARGETS);

  const feeds: Record<FeedKey, FeedState> = {
    roomStatus: deriveFeedState(FEED_TARGETS.roomStatus, actions, gapped, requiredSet.has(FEED_TARGETS.roomStatus)),
    arrivals: deriveFeedState(FEED_TARGETS.arrivals, actions, gapped, requiredSet.has(FEED_TARGETS.arrivals)),
    departures: deriveFeedState(FEED_TARGETS.departures, actions, gapped, requiredSet.has(FEED_TARGETS.departures)),
    workOrders: deriveFeedState(FEED_TARGETS.workOrders, actions, gapped, requiredSet.has(FEED_TARGETS.workOrders)),
    dashboardCounts: deriveFeedState(FEED_TARGETS.dashboardCounts, actions, gapped, false),
  };

  const isPartial = (Object.keys(FEED_TARGETS) as FeedKey[]).some(
    (k) => requiredSet.has(FEED_TARGETS[k]) && feeds[k] === 'learning',
  );

  return {
    mode: 'live',
    connection: deriveConnection(session),
    feeds,
    isPartial,
  };
}

/** The targets currently marked learning — for banner copy ("still learning
 *  departures, work orders"). Returns semantic keys, render-side maps to
 *  translated labels. */
export function learningFeeds(status: PropertyFeedStatus): FeedKey[] {
  if (status.mode !== 'live') return [];
  return (Object.keys(status.feeds) as FeedKey[]).filter((k) => status.feeds[k] === 'learning');
}

/**
 * Review-pass helpers (fake-empty hunter + Codex findings): the two
 * conditions every machine consumer of snapshot-derived numbers must test.
 *
 * `connection === 'pending'` means this property has NEVER successfully
 * read — every pms_* table is empty, so any zero derived from them is fake.
 * ('paused' is deliberately NOT included: a paused session has real-but-
 * stale data; staleness is the doctor/freshness domain, and masking
 * everything on every overnight MFA pause would train users to ignore the
 * honest states.)
 */
export function isDataPending(status: PropertyFeedStatus): boolean {
  return status.mode === 'live' && status.connection === 'pending';
}

/**
 * True when the in-house snapshot numbers (occupancy / vacant_clean /
 * vacant_dirty / ooo / in_house — ALL sourced exclusively from
 * pms_in_house_snapshot by today_property_counts_v1 with COALESCE→0) have a
 * real source. `'unavailable'` matters as much as `'learning'` here: the
 * counts feed is outside the mapper's learnable catalogue, so for every
 * newly-learned PMS family those columns are confident zeros FOREVER unless
 * consumers check this.
 */
export function countsTrusted(status: PropertyFeedStatus): boolean {
  if (status.mode !== 'live') return true; // manual/onboarding: render as today
  return status.feeds.dashboardCounts === 'live' && status.connection !== 'pending';
}

/**
 * Presence-only gap derivation for ACTIVE knowledge files that pre-date
 * feedGaps (legacy envelopes / manually-promoted old drafts). Used by the
 * backfill cron so a legacy partial recipe still gets its daily retry.
 * Returns null when no required target is missing (clean legacy file).
 */
export function presenceFeedGaps(
  actions: Record<string, unknown> | null | undefined,
): FeedGaps | null {
  const have = new Set(Object.keys(actions ?? {}));
  const missing = REQUIRED_TARGETS.filter((t) => !have.has(t));
  if (missing.length === 0) return null;
  return {
    computedAt: new Date(0).toISOString(), // sentinel — derived, not gate-computed
    missingRequired: missing.map((t) => ({ target: t, reason: 'not_found' as const })),
    missingBusinessCritical: [],
  };
}
