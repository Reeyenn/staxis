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
  startedAt?: string;
  finishedAt?: string;
  carried?: boolean;
  reason?: string;
  preview?: BoardPreview;
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

export interface FeedRow {
  key: string;
  label: string;
  goal: string;
  optional: boolean;
  glyph: FeedGlyph;
  rowCount?: number;
  sample?: Array<Record<string, string>>;
  sampleKind?: 'rows' | 'records';
  reason?: string;
  carried?: boolean;
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
      ...(typeof preview?.rowCount === 'number' ? { rowCount: preview.rowCount } : {}),
      ...(Array.isArray(preview?.sample) && preview.sample.length > 0 ? { sample: preview.sample } : {}),
      ...(preview?.sampleKind === 'rows' || preview?.sampleKind === 'records'
        ? { sampleKind: preview.sampleKind }
        : {}),
      ...(typeof state.reason === 'string' && state.reason.length > 0 ? { reason: state.reason } : {}),
      ...(state.carried === true ? { carried: true } : {}),
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
