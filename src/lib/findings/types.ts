// ─── The Finding model ───────────────────────────────────────────────────────
//
// ONE shape for "Staxis noticed something wrong at this hotel", shared by every
// detector. Before this file the app had three unrelated detection systems —
// the cleaning rules engine, the nudge checks, and the operational-signal
// aggregators — each with its own record type, its own idea of "have I already
// said this?", and no way to answer "what is currently wrong here?".
//
// THE ONE RULE THAT SHAPES EVERYTHING ELSE
// A detector is a PURE function of a preloaded context. It does not query, it
// does not write, it does not know what a hotel id is beyond a string. Every
// database touch happens in the runner, which is scoped to one hotel and which
// enforces dedupe, caps and staleness FROM THE DECLARATION — so a detector
// cannot forget to comply with a rule it never had the chance to break.
//
// Modelled on src/lib/rules-engine/types.ts (`Rule` = id + description +
// pure evaluate). The additions are the parts that make a finding survivable
// outside one cron tick: an identity separate from its measurement, a receipt,
// an as-of, a declared minimum data requirement, and an escalation policy.

import type { OperationalSignal } from '@/lib/agent/operational-signals';
import type { checkOperationalAlerts } from '@/lib/agent/nudges';
import type { PropertyRunResult } from '@/lib/rules-engine';
import type {
  InventoryUsageHistory,
  OperatingRhythmHistory,
  SupplySpendHistory,
  WorkOrderHistory,
} from './history';

// ─── Scalars ─────────────────────────────────────────────────────────────────

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Mirrors findings.severity. */
export type FindingSeverity = 'critical' | 'attention' | 'info';

/** Mirrors findings.disposition — what the system proposes doing about it. */
export type FindingDisposition = 'propose' | 'recommend' | 'fyi' | 'ask' | 'drop';

/** Mirrors findings.status. See 0360 for what each one means. */
export type FindingStatus =
  | 'open'
  | 'updated'
  | 'resolved'
  | 'known_problem'
  | 'muted'
  | 'expired';

/**
 * Statuses that OCCUPY the one-row-per-problem slot. Kept identical to the
 * predicate of `findings_one_active_per_problem_uq` (migration 0360) — if these
 * two ever disagree, the database wins and the app starts seeing unique
 * violations it does not expect.
 */
export const ACTIVE_STATUSES: readonly FindingStatus[] = Object.freeze([
  'open',
  'updated',
  'known_problem',
  'muted',
]);

/** Statuses that are silenced: present, but deliberately not surfaced. */
export const SILENCED_STATUSES: readonly FindingStatus[] = Object.freeze([
  'known_problem',
  'muted',
]);

// ─── Money ───────────────────────────────────────────────────────────────────

/**
 * A price tag is a RANGE or it is absent (founder call, 2026-07-26: "$200-400",
 * never "$340"). `high` must be strictly greater than `low`; the database
 * refuses anything else, so a point estimate cannot be smuggled in as a
 * zero-width range. Cents, because money is an integer count of cents.
 */
export interface PriceRange {
  lowCents: number;
  highCents: number;
  currency: string;
  /** Where the range came from: "based on your last 3 plumber invoices". */
  basis: string;
}

/** True when the range is one the schema will accept. */
export function isUsablePriceRange(price: PriceRange | null | undefined): price is PriceRange {
  if (!price) return false;
  return (
    Number.isInteger(price.lowCents) &&
    Number.isInteger(price.highCents) &&
    price.lowCents >= 0 &&
    price.highCents > price.lowCents &&
    price.currency.length === 3
  );
}

// ─── Evidence: the receipt ───────────────────────────────────────────────────

/**
 * What a human (or a later verification pass) needs to check the claim without
 * trusting it. A finding whose evidence cannot reproduce it is a rumour.
 */
export interface FindingEvidence {
  /** Identifier of the query that produced the numbers. */
  queryId: string;
  /** The arguments it ran with. */
  params: Readonly<Record<string, JsonValue>>;
  /** The numbers themselves. */
  values: Readonly<Record<string, JsonValue>>;
  /** Plain-English basis line: "4 hvac work orders in the last 30 days". */
  basis: string;
}

// ─── Feeds: everything a detector is allowed to see ──────────────────────────

/**
 * The data sources the runner knows how to load. A detector declares which it
 * reads; the runner loads the union once per hotel and hands the same context
 * to every detector, so twelve detectors reading room status cost one read.
 */
export type FeedId =
  | 'operational_signals'
  | 'nudge_drafts'
  | 'cleaning_plan'
  // Phase 2A: the hotel's own trailing record, the raw material for the
  // "unusual for THIS hotel" and "this stopped" detectors. Shapes in history.ts.
  | 'supply_spend_history'
  | 'work_order_history'
  | 'inventory_usage_history'
  | 'operating_rhythm';

/** Nudge drafts, taken from the live return type so nudges.ts stays untouched. */
export type NudgeDraftFeed = Awaited<ReturnType<typeof checkOperationalAlerts>>;

/** What each feed carries. */
export interface FeedShapes {
  operational_signals: OperationalSignal[];
  nudge_drafts: NudgeDraftFeed;
  /** The cleaning rules engine's DRY-RUN result. Evaluates, never writes. */
  cleaning_plan: PropertyRunResult;
  supply_spend_history: SupplySpendHistory;
  work_order_history: WorkOrderHistory;
  inventory_usage_history: InventoryUsageHistory;
  operating_rhythm: OperatingRhythmHistory;
}

/** A loaded feed plus the honesty metadata every claim on it inherits. */
export interface FeedResult<K extends FeedId = FeedId> {
  value: FeedShapes[K];
  /** How many records it carries. Drives the declared minimum-data check. */
  recordCount: number;
  /** When the underlying data was true — not when we looked at it. */
  asOf: Date | null;
  /** Age in days of the weakest input inside this feed. */
  weakestInputAgeDays: number | null;
}

/** A feed that failed to load. The runner skips detectors that needed it. */
export interface FeedFailure {
  error: string;
}

export type FeedOutcome<K extends FeedId = FeedId> = FeedResult<K> | FeedFailure;

export function isFeedFailure(outcome: FeedOutcome): outcome is FeedFailure {
  return (outcome as FeedFailure).error !== undefined;
}

// ─── Detector context ────────────────────────────────────────────────────────

/**
 * Everything a detector may read. Deliberately has no database handle: a pure
 * function cannot leak another hotel's rows because it cannot reach them.
 */
export interface DetectorContext {
  readonly propertyId: string;
  /** Wall clock at the start of the run. Injected so detectors are testable. */
  readonly now: Date;
  readonly timezone: string | null;
  /** The hotel's local business date, YYYY-MM-DD. */
  readonly businessDate: string;
  readonly feeds: Readonly<Partial<Record<FeedId, FeedOutcome>>>;
}

/**
 * Read a loaded feed. Throws when the feed is absent — that is a DECLARATION
 * bug (the detector read something it did not declare), and the runner will
 * only ever call a detector whose declared feeds all loaded.
 */
export function readFeed<K extends FeedId>(ctx: DetectorContext, feed: K): FeedShapes[K] {
  const outcome = ctx.feeds[feed];
  if (!outcome) {
    throw new Error(
      `Detector read feed "${feed}" without declaring it in inputs — ` +
      'add it to the declaration so the runner loads it and enforces its minimum data.',
    );
  }
  if (isFeedFailure(outcome)) {
    throw new Error(`Detector read feed "${feed}", which failed to load: ${outcome.error}`);
  }
  return outcome.value as FeedShapes[K];
}

// ─── What a detector emits ───────────────────────────────────────────────────

/**
 * One problem, as the detector sees it. No id, no status, no timestamps — the
 * runner owns the whole lifecycle, which is why a detector cannot accidentally
 * reopen something a manager silenced.
 */
export interface FindingDraft {
  /**
   * Identity of the PROBLEM, WITHOUT the measurement. The runner prefixes the
   * detector id, so two detectors can never collide.
   *
   * "room_214:hvac" — right. "room_214:hvac:4_orders" — wrong: tomorrow's fifth
   * work order would become a second card, which is the exact failure the whole
   * ledger exists to prevent.
   */
  key: string;
  /** Deterministic, template-generated. No model is involved in Phase 1. */
  summary: string;
  severity: FindingSeverity;
  /** Omit to take the declaration's default. */
  disposition?: FindingDisposition;
  /** How bad it is, on a scale where bigger is always worse. */
  magnitude: number;
  evidence: FindingEvidence;
  /** A RANGE or nothing. An unusable range is dropped rather than stored. */
  price?: PriceRange | null;
  /** When the data behind this was true. Defaults to the feed's as-of. */
  asOf?: Date | null;
  /** Age of the weakest input. Defaults to the feed's. */
  weakestInputAgeDays?: number | null;
}

// ─── The declaration ─────────────────────────────────────────────────────────

/**
 * How a silenced problem earns its way back onto the screen.
 *
 * A manager who taps "known problem" at 4 work orders consented to 4. Nine is a
 * different problem wearing the same name. Both conditions must hold, so a
 * problem that creeps from 4 to 5 stays quiet.
 */
export interface EscalationPolicy {
  /** magnitude >= silencedAtMagnitude * factor */
  readonly factor: number;
  /** AND magnitude - silencedAtMagnitude >= minDelta */
  readonly minDelta: number;
}

/** What a detector needs before it is allowed to say anything at all. */
export interface DataRequirement {
  readonly feed: FeedId;
  /** Minimum records the feed must carry. 0 = "the feed merely has to load". */
  readonly minRecords: number;
  /** Why, in plain English. Surfaced when the detector skips. */
  readonly because: string;
}

export type DetectorParams = Readonly<Record<string, JsonValue>>;

/** A frozen case: this context must produce exactly these problem keys. */
export interface DetectorEvalCase<P extends DetectorParams = DetectorParams> {
  readonly name: string;
  /** Feeds this case supplies. Anything not listed is absent. */
  readonly feeds: Readonly<Partial<Record<FeedId, FeedShapes[FeedId]>>>;
  /** The hotel-local date the case runs on. Defaults to EVAL_BUSINESS_DATE. */
  readonly businessDate?: string;
  readonly params?: P;
  /** Exactly these draft keys, in any order. */
  readonly expectKeys: readonly string[];
  /** Optional per-key magnitude expectations. */
  readonly expectMagnitude?: Readonly<Record<string, number>>;
}

/**
 * Everything the runner needs to know about a detector WITHOUT running it.
 * Declaration-driven on purpose: dedupe, caps, staleness and escalation are
 * enforced structurally, from this object, so a new detector inherits every
 * guarantee by existing rather than by remembering.
 */
export interface DetectorDeclaration<P extends DetectorParams = DetectorParams> {
  /** Stable slug. Prefixes every dedupe key this detector produces. */
  readonly id: string;
  /** One line, product terms. Shown in the run summary and in logs. */
  readonly description: string;
  /** Feeds this detector reads. The runner loads exactly this union. */
  readonly inputs: readonly FeedId[];
  /** What must be present before it may speak. Unmet ⇒ skipped, not silent. */
  readonly requires: readonly DataRequirement[];
  /** The query a human can re-run to check any finding this produces. */
  readonly receiptQueryId: string;
  readonly defaultDisposition: FindingDisposition;
  readonly defaultSeverity: FindingSeverity;
  /** null = a silenced problem from this detector never comes back. */
  readonly escalation: EscalationPolicy | null;
  /** Hard cap on findings per hotel per run. The runner truncates. */
  readonly maxPerRun: number;
  /**
   * Days an open finding may go un-refound before the runner expires it. The
   * problem stopped being true; the card should not outlive it.
   */
  readonly staleAfterDays: number;
  readonly params?: P;
  readonly evalCases: readonly DetectorEvalCase<P>[];
}

/** A detector: a declaration plus a pure function. That is the whole contract. */
export interface Detector<P extends DetectorParams = DetectorParams> {
  readonly declaration: DetectorDeclaration<P>;
  detect(ctx: DetectorContext, params: P): FindingDraft[];
}

export type AnyDetector = Detector<DetectorParams>;

// ─── The stored row ──────────────────────────────────────────────────────────

/** A findings row as the app reads it back. Mirrors migration 0360. */
export interface Finding {
  id: string;
  propertyId: string;
  detectorId: string;
  dedupeKey: string;
  summary: string;
  severity: FindingSeverity;
  disposition: FindingDisposition;
  status: FindingStatus;
  receiptQueryId: string;
  evidence: FindingEvidence;
  asOf: string | null;
  weakestInputAgeDays: number | null;
  magnitude: number;
  price: PriceRange | null;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrenceCount: number;
  statusChangedAt: string;
  resolvedAt: string | null;
  silencedAtMagnitude: number | null;
  escalatedAt: string | null;
  shownCount: number;
  actedCount: number;
  ignoredCount: number;

  // ── the judge's half (migration 0361) ──
  // Written ALONGSIDE the fields above, never over them. All null until the
  // nightly judge has seen this row; all still null if the model was
  // unavailable and nothing was persisted. `summary` and `disposition` above
  // remain what the detector decided, forever.
  /** The judge's verdict. Falls back to `disposition` when absent. */
  judgedDisposition: FindingDisposition | null;
  /** Guard-checked phrasing. Both languages or neither — the schema refuses
   *  half-translated phrasing, so a Spanish speaker never sees English
   *  silently standing in for Spanish. */
  judgedSummaryEn: string | null;
  judgedSummaryEs: string | null;
  judgedRationale: string | null;
  /** The judge's reading order within its run. Advisory. */
  judgedRank: number | null;
  /** 'model' when the generated text passed the prose guard, 'template' when
   *  code wrote it instead. */
  judgedSource: 'model' | 'template' | null;
  judgedAt: string | null;
  judgedModel: string | null;
  /** True when the prose guard threw model phrasing away for this row. */
  judgedGuardRejected: boolean;
}

/** What the judge did to one hotel on one night. Mirrors finding_runs (0361). */
export interface FindingJudgeSummary {
  /**
   * 'no_findings'        nothing new or changed — zero model calls, by design
   * 'model'              a call was made and its output was used
   * 'fallback_cap'       the hotel's daily findings-AI budget was exhausted
   * 'fallback_error'     the provider failed, timed out, or was unreachable
   * 'fallback_malformed' the reply broke the output contract and was refused
   * 'skipped'            the judge was switched off for this run
   */
  mode:
    | 'no_findings'
    | 'model'
    | 'fallback_cap'
    | 'fallback_error'
    | 'fallback_malformed'
    | 'skipped';
  findings: number;
  costUsd: number;
  /** How many findings had model phrasing discarded by the prose guard. */
  guardRejections: number;
}

/** What one runner execution did to one hotel. Mirrors finding_runs. */
export interface FindingRunSummary {
  propertyId: string;
  runDate: string;
  detectorsRegistered: number;
  detectorsChecked: number;
  detectorsSkipped: number;
  detectorsFailed: number;
  /**
   * Checks this hotel has ignored all the way to rest (see demotion.ts).
   * Counted apart from `detectorsSkipped` on purpose: skipped means the data
   * was not there, resting means this hotel's own behaviour switched it off.
   * A run summary that conflated them would report a healthy hotel as a starved
   * one every night.
   */
  detectorsDormant: number;
  findingsOpened: number;
  findingsUpdated: number;
  findingsSuppressed: number;
  findingsEscalated: number;
  findingsExpired: number;
  durationMs: number;
  errors: Array<{ detectorId: string; error: string }>;
  /** Per-detector detail. Not persisted — returned for the cron response. */
  skipped: Array<{ detectorId: string; because: string }>;
  /** "N checks resting" — which ones, and since when. Not persisted; the state
   *  itself lives in finding_detector_state and outlives any one run. */
  dormant: Array<{ detectorId: string; since: string | null }>;
  /** Rungs stepped down tonight. The transition log is in the state row; this
   *  is what the cron response says happened. */
  demotions: Array<{ detectorId: string; from: string; to: string; reason: string }>;
  /**
   * What the judge did. Part of the null result for the same reason the
   * detector counts are: a night with nothing new to judge and a night where
   * the budget ran out both leave the findings table looking untouched, and
   * only one of those is fine.
   */
  judge: FindingJudgeSummary;
}
