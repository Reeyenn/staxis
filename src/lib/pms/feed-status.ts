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
 *
 * A2 (2026-07-24) extends the same module with the OTHER half of the same
 * question: not just "can I trust this feed?" but "how old is what it told
 * me?". See the "Data-age honesty" section below. Both halves are gated on
 * `mode === 'live'` by their callers — a manual (no_pms) hotel's numbers are
 * live by definition and must never be given a staleness warning.
 */

import { propertyLocalToday } from '@/lib/schedule/local-date';

/**
 * D4 (2026-07-24) adds a FOURTH state, 'stale', and the report era needs it.
 *
 * The three-word vocabulary above forces a false choice between lying and
 * blanking. When a hotel's 6:40 AM room-status report is the newest thing we
 * have at 11 AM, the number is REAL — it is just OLD. Calling it 'live' lies;
 * calling it 'learning' blanks a number a GM can genuinely use.
 *
 *  - 'stale' — the number is real but past its promised arrival window. SHOW
 *              it, with an "as of 6:40 AM" stamp. Never null it.
 *
 * The rule that produces it lives in SQL (pms_feed_health_v1, migration 0339)
 * — there is exactly one definition of freshness and this file is not it. The
 * split between "the number is real" and "the number is current" is
 * countsTrusted() vs countsFresh() below.
 */
export type FeedState = 'live' | 'stale' | 'learning' | 'unavailable';

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
  /**
   * A2 (data-age honesty) — WHEN the numbers behind this property's feeds were
   * captured. Optional because it is only resolved for `mode === 'live'`
   * hotels: a manual (no_pms) hotel's numbers ARE live (the app is the system
   * of record) and an onboarding hotel has no numbers yet, so claiming an age
   * for either would be a false staleness warning.
   */
  freshness?: FeedFreshness;
}

// ─── Data-age honesty (A2) ──────────────────────────────────────────────────
// The report-email intake replaces the 30s robot poll, so PMS numbers arrive
// in scheduled batches (typically every 30-60 min) instead of continuously.
// Every surface that states an occupancy / room / money number needs to know
// HOW OLD it is; this is the pure half of that answer (the queries live in
// src/lib/pms-feed-status-server.ts).

/**
 * How much to trust the capture time.
 *  - 'fresh'       — within one report cycle. State the numbers, quote the time.
 *  - 'stale'       — older than a cycle but under PMS_STALE_MAX_MINUTES.
 *  - 'very_stale'  — nothing has arrived in over PMS_STALE_MAX_MINUTES.
 *  - 'change_only' — the only signal we have moves when the DATA changes, not
 *                    when the feed was read. Absence of change is not evidence
 *                    of staleness, so age is reported without a caution.
 *  - 'unknown'     — no capture time at all. Say so; never imply "now".
 */
export type FreshnessTier = 'fresh' | 'stale' | 'very_stale' | 'change_only' | 'unknown';

/**
 * Where the capture time came from, in resolution order. Recorded so a wrong
 * answer can be traced to the signal that produced it rather than guessed at.
 *  - 'heartbeat'        — the ingestion layer's own per-run heartbeat (D4). The
 *                         only true "when did we last check" signal; the single
 *                         seam D4 plugs into.
 *  - 'snapshot_capture' — pms_in_house_snapshot.captured_at.
 *  - 'session_read'     — property_sessions.last_successful_read_at.
 *  - 'room_status_sync' — max(pms_room_status_log.last_synced_at).
 *  - 'feed_capture'     — a tool's own table stamps every row (captured_at);
 *                         more precise than the property-level signal.
 *  - 'row_change'       — a stamp that only moves when the data changes. Always
 *                         classifies 'change_only'.
 *  - 'none'             — nothing available.
 */
export type FreshnessSource =
  | 'heartbeat'
  | 'snapshot_capture'
  | 'session_read'
  | 'room_status_sync'
  | 'feed_capture'
  | 'row_change'
  | 'none';

export interface FeedFreshness {
  /** ISO timestamp. NEVER a pre-rendered age — the 30s status cache would
   *  otherwise serve a frozen "22 min ago" for half a minute. */
  capturedAt: string | null;
  source: FreshnessSource;
}

/**
 * Worst supported report cadence (60 min) + headroom for report generation,
 * email routing and parse (15 min). Below one cadence the copilot would append
 * a caution to every answer all day and staff would learn to ignore it, which
 * is worse than saying nothing. If real cadence grows a long tail this number
 * moves up — the wording does not change.
 */
export const PMS_FRESH_MAX_MINUTES = 75;

/** Past this, treat the connection as stuck rather than merely lagging. */
export const PMS_STALE_MAX_MINUTES = 360;

/** The "we have no idea" value. */
export const NO_FRESHNESS: FeedFreshness = Object.freeze({
  capturedAt: null,
  source: 'none',
});

/**
 * Whole minutes between `capturedAt` and `now`, or null when there is no
 * usable timestamp. A capture time in the FUTURE would make every age negative
 * and every tier read 'fresh' — the exact failure the honesty layer exists to
 * prevent — so it clamps to 0 and warns loudly. (Migration 0337 forbids it at
 * the DB level for the six feed tables; this is the belt.)
 */
export function freshnessAgeMinutes(
  capturedAt: string | null | undefined,
  now: Date,
): number | null {
  if (!capturedAt) return null;
  const at = new Date(capturedAt).getTime();
  if (Number.isNaN(at)) return null;
  const minutes = (now.getTime() - at) / 60_000;
  if (minutes < 0) {
    console.warn('[pms/feed-status] captured_at is in the future — clamping age to 0', {
      capturedAt,
      now: now.toISOString(),
    });
    return 0;
  }
  return Math.floor(minutes);
}

/** Classify a capture time. Pure; `now` is injected so callers are testable. */
export function freshnessTier(
  capturedAt: string | null | undefined,
  source: FreshnessSource,
  now: Date,
): FreshnessTier {
  const age = freshnessAgeMinutes(capturedAt, now);
  if (age === null) return 'unknown';
  // A change-stamp cannot distinguish "nothing happened" from "nothing
  // arrived", so it never escalates to a staleness caution.
  if (source === 'row_change') return 'change_only';
  if (age <= PMS_FRESH_MAX_MINUTES) return 'fresh';
  if (age <= PMS_STALE_MAX_MINUTES) return 'stale';
  return 'very_stale';
}

/** Rendered pieces of an as-of statement. Kept separate so callers can compose
 *  their own sentence without re-deriving the clock. */
export interface AsOfClock {
  /** '2:40 PM', or 'Jul 23, 11:05 PM' when the capture is not on the
   *  property's local today. */
  time: string;
  /** The IANA zone `time` is expressed in ('UTC' when the property has none). */
  zone: string;
  /** 'just now' | '22 min ago' | '3 hr 35 min ago' | '2 days ago' */
  age: string;
}

function resolveZone(timezone: string | null | undefined): string {
  if (!timezone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    return 'UTC';
  }
}

/** Human age wording. Deliberately coarse — hotel staff read "about an hour",
 *  not "63.4 minutes". */
export function formatAge(minutes: number): string {
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) {
    const hr = Math.floor(minutes / 60);
    const min = minutes % 60;
    return min === 0 ? `${hr} hr ago` : `${hr} hr ${min} min ago`;
  }
  const days = Math.floor(minutes / 1440);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * Format a capture time for a human (12-hour clock with AM/PM — US
 * limited-service hotel staff). The date prefix appears ONLY when the capture
 * is not on the property's local today, so the common case stays short.
 * Returns null for an unusable timestamp.
 */
export function formatAsOfClock(
  capturedAt: string,
  timezone: string | null,
  now: Date,
): AsOfClock | null {
  const at = new Date(capturedAt);
  if (Number.isNaN(at.getTime())) return null;
  const zone = resolveZone(timezone);
  try {
    const clock = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(at);
    const sameLocalDay = propertyLocalToday(at, zone) === propertyLocalToday(now, zone);
    const time = sameLocalDay
      ? clock
      : `${new Intl.DateTimeFormat('en-US', { timeZone: zone, month: 'short', day: 'numeric' }).format(at)}, ${clock}`;
    return { time, zone, age: formatAge(freshnessAgeMinutes(capturedAt, now) ?? 0) };
  } catch {
    return null;
  }
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
  // Defined (not left undefined) so a consumer that reads `.freshness` without
  // checking `mode` gets the honest "no capture time" value rather than a
  // TypeError. Nothing should emit a staleness claim for a manual hotel — the
  // mode gate, not this value, is what prevents that.
  freshness: NO_FRESHNESS,
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
 *
 * D4 (2026-07-24): the MEANING is unchanged, the SOURCE moves. In the report
 * era `connection === 'pending'` is set when every enabled report expectation
 * for this hotel has never received a single delivery (feedStatusFromHealth in
 * src/lib/pms/feed-health.ts) — the same fact, asked of reports instead of a
 * robot session. Callers do not change.
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
  // 'stale' counts as trusted: the number came from a real report, it is just
  // older than promised. Blanking it would throw away a usable figure — see
  // the FeedState comment at the top of this file.
  const state = status.feeds.dashboardCounts;
  return (state === 'live' || state === 'stale') && status.connection !== 'pending';
}

/**
 * The stricter half of the countsTrusted split: the number is not merely real,
 * it is CURRENT.
 *
 * Use this — not countsTrusted — anywhere the app SPEAKS FIRST rather than
 * answering: a proactive nudge, a daily seal, an alert. A nudge fired off
 * nine-hour-old occupancy is worse than no nudge, because nobody asked and
 * nobody sees the as-of stamp. Answering a direct question is different: there
 * countsTrusted plus the stamp is the honest response.
 */
export function countsFresh(status: PropertyFeedStatus): boolean {
  if (status.mode !== 'live') return true; // manual/onboarding: render as today
  return status.feeds.dashboardCounts === 'live' && status.connection !== 'pending';
}

/** The feeds whose numbers are real but past their promised arrival — the
 *  ones that render an "as of 6:40 AM" chip rather than a learning banner. */
export function staleFeeds(status: PropertyFeedStatus): FeedKey[] {
  if (status.mode !== 'live') return [];
  return (Object.keys(status.feeds) as FeedKey[]).filter((k) => status.feeds[k] === 'stale');
}

/** True when any feed is showing real-but-old numbers. */
export function isStale(status: PropertyFeedStatus): boolean {
  return staleFeeds(status).length > 0;
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
