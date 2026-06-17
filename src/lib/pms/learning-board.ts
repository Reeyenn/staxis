/**
 * CUA Learning Board — reader types + per-feed status derivation.
 *
 * The mapper (cua-service) persists per-feed learning state into
 * workflow_jobs.result under `targetCatalog` + `boardTargets` (alongside
 * the older `actionsSoFar`). This module turns that raw state plus the
 * LIVE pending help-request row into the rows the admin board renders.
 *
 * ⚠ Hand-synced writer types live in cua-service/src/types.ts
 * (BoardTargetDescriptor / BoardTargetState / BoardPreview). This is the
 * READER side of a display-only JSON contract: every field is optional and
 * unknown shapes degrade gracefully — never throw on weird data.
 *
 * INVARIANTS (unit-tested in src/lib/__tests__/learning-board-derive.test.ts):
 *  - A found feed can NEVER be flagged: 'found' beats every other signal,
 *    including a (stale) pending help request for the same target.
 *  - 'stuck' (the red ❌) derives ONLY from the live pending help-request
 *    row, and only while the job is still queued/running — it is never a
 *    persisted status, so it clears the instant the row resolves.
 *  - Terminal jobs coerce non-final statuses: a dead run shows no immortal
 *    spinners ('searching' → 'didnt_finish', unreached → 'not_reached').
 */

// ─── Wire types (tolerant duplicates of cua-service/src/types.ts) ─────────

export interface BoardTargetDescriptor {
  key?: string;
  label?: string;
  goal?: string;
  optional?: boolean;
}

export interface BoardPreview {
  rowCount?: number;
  sample?: Array<Record<string, string>>;
  sampleKind?: 'rows' | 'records';
}

export interface BoardTargetState {
  status?: string;
  /** Additive to `status` (feature/cua-admin-mapper-visibility): the finer
   *  live phase the robot is in. Optional — older jobs persist only `status`. */
  phase?: string;
  startedAt?: string;
  finishedAt?: string;
  carried?: boolean;
  reason?: string;
  preview?: BoardPreview;
  /** feature/cua-mapper-cost — per-feed Claude spend (micros). startCostMicros =
   *  total spend when the feed started (active-feed live cost = live total −
   *  this); costMicros = final spend once the feed finishes. Optional. */
  startCostMicros?: number;
  costMicros?: number;
}

// ─── Derived row ───────────────────────────────────────────────────────────

export type FeedGlyph =
  | 'found'        // ✅ learned, with optional captured preview
  | 'searching'    // ⏳ the robot is on it right now
  | 'stuck'        // ❌ pending help request — the ONLY red state
  | 'unavailable'  // ⊘ agent/admin says this PMS doesn't have the feed
  | 'failed'       // ✕ couldn't find it; the robot moved on
  | 'queued'       // ◻ waiting in line (job still live)
  | 'didnt_finish' // ◐ was searching when the run died (terminal coercion)
  | 'not_reached'; // — never reached before the run ended

/**
 * The finer live PHASE within (mostly) the 'searching' glyph — a separate,
 * additive contract from the glyph above. The robot writes it onto
 * boardTargets[key].phase and onto result.currentActivity.phase
 * (feature/cua-admin-mapper-visibility). Display-only; degrades to absent.
 */
export type FeedPhase =
  | 'queued'
  | 'navigating'
  | 'extracting'
  | 'certifying'
  | 'drilling'
  | 'rechecking'
  | 'found'
  | 'unavailable'
  | 'failed'
  | 'cost_capped';

const FEED_PHASES: ReadonlySet<string> = new Set<FeedPhase>([
  'queued', 'navigating', 'extracting', 'certifying', 'drilling',
  'rechecking', 'found', 'unavailable', 'failed', 'cost_capped',
]);

/** Phases that mean "actively working" — a spinner is appropriate. */
const IN_PROGRESS_PHASES: ReadonlySet<string> = new Set<FeedPhase>([
  'queued', 'navigating', 'extracting', 'certifying', 'drilling', 'rechecking',
]);

export function isInProgressPhase(phase: FeedPhase | null | undefined): boolean {
  return typeof phase === 'string' && IN_PROGRESS_PHASES.has(phase);
}

export interface FeedRow {
  key: string;
  label: string;
  goal: string;
  optional: boolean;
  glyph: FeedGlyph;
  /** Finer live phase (mostly while glyph==='searching'). Additive; absent on
   *  older jobs. Drives the per-feed phase detail without touching the glyph. */
  phase?: FeedPhase;
  rowCount?: number;
  sample?: Array<Record<string, string>>;
  sampleKind?: 'rows' | 'records';
  reason?: string;
  carried?: boolean;
  /** feature/cua-mapper-cost — per-feed Claude spend (micros). costMicros once
   *  finished; startCostMicros to compute the active feed's live running cost. */
  costMicros?: number;
  startCostMicros?: number;
}

/**
 * The single live line: what the robot is doing RIGHT NOW, from
 * result.currentActivity. Display-only mirror of the worker's writer.
 */
export interface CurrentActivity {
  feedKey: string | null;
  phase: FeedPhase | null;
  pct: number | null;
  at: string | null;
  /** feature/cua-mapper-cost — live total spend (micros) at this tick; null on
   *  older jobs. Drives the board's live total + the active feed's running cost. */
  totalCostMicros?: number | null;
}

export interface FeedSummary {
  total: number;
  found: number;
  searching: number;
  stuck: number;
  unavailable: number;
  failed: number;
  waiting: number;
}

const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export function isTerminalJobStatus(jobStatus: string | null | undefined): boolean {
  return typeof jobStatus === 'string' && TERMINAL_JOB_STATUSES.has(jobStatus);
}

/** getRoomStatus → "Room status"; getLostAndFound → "Lost and found". */
export function prettifyTargetKey(key: string): string {
  const stripped = key.replace(/^get/, '');
  const spaced = stripped.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  const lower = spaced.toLowerCase();
  return lower.length > 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : key;
}

interface DeriveInputs {
  /** result.targetCatalog — may be absent for jobs from before this shipped. */
  catalog: unknown;
  /** result.boardTargets. */
  boardTargets: unknown;
  /** result.actionsSoFar — legacy fallback "found" signal. */
  actionsSoFar: unknown;
  /** The LIVE pending help-request row (or null). */
  pendingHelpTargetKey: string | null;
  jobStatus: string | null | undefined;
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/**
 * Derive one render-ready row per feed. Pure — no IO, no Date.
 */
export function deriveFeedRows(inputs: DeriveInputs): FeedRow[] {
  const boardTargets = asRecord(inputs.boardTargets) as Record<string, BoardTargetState>;
  const actionsSoFar = asRecord(inputs.actionsSoFar);
  const terminal = isTerminalJobStatus(inputs.jobStatus);
  const pendingKey = !terminal ? inputs.pendingHelpTargetKey : null;

  // Catalogue rows; fall back to the union of every key we've seen state
  // for (pre-ship jobs persisted no catalogue).
  let descriptors: Array<{ key: string; label: string; goal: string; optional: boolean }> = [];
  if (Array.isArray(inputs.catalog) && inputs.catalog.length > 0) {
    descriptors = (inputs.catalog as BoardTargetDescriptor[])
      .filter((d) => typeof d?.key === 'string' && d.key.length > 0)
      .map((d) => ({
        key: d.key as string,
        label: typeof d.label === 'string' && d.label.length > 0 ? d.label : prettifyTargetKey(d.key as string),
        goal: typeof d.goal === 'string' ? d.goal : '',
        optional: d.optional === true,
      }));
  }
  if (descriptors.length === 0) {
    const keys = new Set<string>([
      ...Object.keys(actionsSoFar),
      ...Object.keys(boardTargets),
      ...(inputs.pendingHelpTargetKey ? [inputs.pendingHelpTargetKey] : []),
    ]);
    descriptors = [...keys].sort().map((key) => ({
      key,
      label: prettifyTargetKey(key),
      goal: '',
      optional: false,
    }));
  }

  return descriptors.map((d) => {
    const state: BoardTargetState = asRecord(boardTargets[d.key]) as BoardTargetState;
    const preview = state.preview && typeof state.preview === 'object' ? state.preview : undefined;
    const foundViaBoard = state.status === 'found';
    const foundViaActions = d.key in actionsSoFar;
    // Additive finer phase — never affects the glyph below.
    const phase = typeof state.phase === 'string' && FEED_PHASES.has(state.phase)
      ? (state.phase as FeedPhase)
      : undefined;

    let glyph: FeedGlyph;
    if (foundViaBoard || foundViaActions) {
      // INVARIANT: found wins over everything — a stale pending help row
      // for an already-found feed must not flag it.
      glyph = 'found';
    } else if (pendingKey === d.key) {
      glyph = 'stuck';
    } else if (state.status === 'unavailable') {
      glyph = 'unavailable';
    } else if (state.status === 'failed') {
      glyph = 'failed';
    } else if (state.status === 'searching') {
      glyph = terminal ? 'didnt_finish' : 'searching';
    } else {
      glyph = terminal ? 'not_reached' : 'queued';
    }

    return {
      key: d.key,
      label: d.label,
      goal: d.goal,
      optional: d.optional,
      glyph,
      ...(phase ? { phase } : {}),
      ...(typeof preview?.rowCount === 'number' ? { rowCount: preview.rowCount } : {}),
      ...(Array.isArray(preview?.sample) && preview.sample.length > 0 ? { sample: preview.sample } : {}),
      ...(preview?.sampleKind === 'rows' || preview?.sampleKind === 'records'
        ? { sampleKind: preview.sampleKind }
        : {}),
      ...(typeof state.reason === 'string' && state.reason.length > 0 ? { reason: state.reason } : {}),
      ...(state.carried === true ? { carried: true } : {}),
      ...(typeof state.costMicros === 'number' ? { costMicros: state.costMicros } : {}),
      ...(typeof state.startCostMicros === 'number' ? { startCostMicros: state.startCostMicros } : {}),
    };
  });
}

export function summarizeFeedRows(rows: FeedRow[]): FeedSummary {
  const summary: FeedSummary = {
    total: rows.length, found: 0, searching: 0, stuck: 0,
    unavailable: 0, failed: 0, waiting: 0,
  };
  for (const r of rows) {
    if (r.glyph === 'found') summary.found++;
    else if (r.glyph === 'searching') summary.searching++;
    else if (r.glyph === 'stuck') summary.stuck++;
    else if (r.glyph === 'unavailable') summary.unavailable++;
    else if (r.glyph === 'failed' || r.glyph === 'didnt_finish') summary.failed++;
    else summary.waiting++;
  }
  return summary;
}

/**
 * Parse result.currentActivity into the single live-line shape. Pure +
 * defensive: any non-conforming shape (or a pre-ship job that never wrote it)
 * yields null so the board degrades to no phase line. Returns null unless at
 * least a recognized phase OR a feed key is present.
 */
export function parseCurrentActivity(result: unknown): CurrentActivity | null {
  const raw = asRecord(result).currentActivity;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const ca = raw as Record<string, unknown>;
  const phase = typeof ca.phase === 'string' && FEED_PHASES.has(ca.phase)
    ? (ca.phase as FeedPhase)
    : null;
  const feedKey = typeof ca.feedKey === 'string' && ca.feedKey.length > 0 ? ca.feedKey : null;
  const pct = typeof ca.pct === 'number' && Number.isFinite(ca.pct)
    ? Math.max(0, Math.min(100, Math.round(ca.pct)))
    : null;
  const at = typeof ca.at === 'string' && ca.at.length > 0 ? ca.at : null;
  const totalCostMicros = typeof ca.totalCostMicros === 'number' && Number.isFinite(ca.totalCostMicros)
    ? ca.totalCostMicros
    : null;
  if (!phase && !feedKey) return null;
  return { feedKey, phase, pct, at, totalCostMicros };
}

/**
 * Human, founder-facing phase label. `feedNoun` is a prettified feed name
 * (e.g. "Room status") that interpolates into the navigating/extracting
 * phrasings; an empty string falls back to feed-less wording. English — the
 * admin studio (this board + the coverage editor) is English-only by
 * convention, like every other screen under /admin.
 */
export function phaseLabel(phase: FeedPhase, feedNoun = ''): string {
  // Lower-case the feed for natural mid-sentence flow ("the room status screen").
  const feed = feedNoun ? feedNoun.charAt(0).toLowerCase() + feedNoun.slice(1) : '';
  switch (phase) {
    case 'navigating':  return feed ? `Finding the ${feed} screen…` : 'Finding the screen…';
    case 'extracting':  return feed ? `Reading the ${feed} data…` : 'Reading the data…';
    case 'certifying':  return 'Double-checking the columns…';
    case 'drilling':    return 'Digging into the details…';
    case 'rechecking':  return 'Re-checking…';
    case 'queued':      return 'Waiting in line…';
    case 'found':       return 'Found ✓';
    case 'unavailable': return 'Not in this PMS';
    case 'failed':      return "Couldn't find it";
    case 'cost_capped': return 'Stopped (budget)';
    default:            return '';
  }
}
