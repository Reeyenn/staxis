/**
 * Multi-signal weighted commit gate (feature/cua-bestclass-verify, Tasks 3-5).
 *
 * The existing promotion gate (mapping-driver.evaluatePromotionGate) is a
 * single-pass boolean: required feeds present + columns proven → auto_promote.
 * Best-in-class verification turns auto-promotion into a CALIBRATED decision
 * combining several independent witnesses, requiring a quotable confidence, and
 * demanding the recipe prove itself MORE THAN ONCE before it goes family-wide.
 *
 * This module is the PURE decision core (no playwright / supabase / anthropic):
 *   - computeCommitScore: fold the independent signals into a [0,1] confidence.
 *   - decideCommit: gate that score against a per-family calibrated THRESHOLD
 *     and a consistent-pass count (pass^N).
 *   - valueFingerprint / fingerprintsMatch: a coarse value-distribution
 *     fingerprint used to decide whether two onboarding passes are CONSISTENT
 *     (the same recipe really re-derived the same shape) — the pass^N anchor.
 *
 * It does NOT re-implement the safety core. The `reconcile` signal is FED from
 * reconcileRows / certifyColumns verdicts (computed elsewhere); the `crossFeed`
 * signal is FED from cross-feed-reconcile.ts; the `secondModel` signal is FED
 * from a cheap critic-style vote. This module only WEIGHS already-computed
 * verdicts.
 *
 * MONOTONICITY: the score is 1.0 when NO signal actively fails (abstaining
 * signals cost nothing). So a recipe the legacy gate would auto-promote, with no
 * new contradiction, still scores 1.0 ≥ threshold — it is never newly parked.
 * Only an ACTIVE contradiction (a cross-feed mismatch, a confident second-model
 * reject, an unproven required column, a degenerate fingerprint) pulls the score
 * below threshold, and even then only routes to founder review.
 */

/** Each independent witness reports one of: it agreed (pass), it actively
 *  contradicted (fail), or it had nothing to say (abstain — no penalty). */
export type SignalVerdict = 'pass' | 'fail' | 'abstain';

export interface CommitSignals {
  /** Required-column proof strength: reconcileRows (api) reconciled OR
   *  certifyColumns certified ⟹ pass; an unproven required column ⟹ fail;
   *  not applicable ⟹ abstain. (Read from the existing safety core, never
   *  recomputed here.) */
  reconcile: SignalVerdict;
  /** cross-feed-reconcile.ts overall signal mapped: pass/fail/no_signal→abstain. */
  crossFeed: SignalVerdict;
  /** Value-distribution fingerprint: a degenerate distribution (e.g. a constant
   *  key column) ⟹ fail; thin/no evidence ⟹ abstain; sane ⟹ pass. */
  fingerprint: SignalVerdict;
  /** Cheap second-model vote (critic-style): confident reject ⟹ fail; approve
   *  ⟹ pass; unclear / disabled / errored ⟹ abstain (fail-open). */
  secondModel: SignalVerdict;
}

export interface SignalWeights {
  reconcile: number;
  crossFeed: number;
  fingerprint: number;
  secondModel: number;
}

/** Each weight is ≥ (1 − DEFAULT_COMMIT_THRESHOLD) so that ANY single failing
 *  signal pulls the score below the default threshold — abstain-by-default: one
 *  real contradiction is enough to route a recipe to founder review. */
export const DEFAULT_SIGNAL_WEIGHTS: SignalWeights = {
  reconcile: 0.6,
  crossFeed: 0.5,
  fingerprint: 0.4,
  secondModel: 0.3,
};

/** Calibrated minimum confidence to AUTO-promote. 0.99 ⟹ "we are ≥99% confident
 *  every signal that could speak, agreed". Per-family override persisted in the
 *  signed knowledge envelope (knowledge-file.ts RecipeVerification.threshold). */
export const DEFAULT_COMMIT_THRESHOLD = 0.99;

/** How many CONSISTENT verification passes a family recipe needs before
 *  draft→active auto-promotion (pass^N). Default 1 ⟹ today's behaviour (one
 *  pass auto-promotes); raise via CUA_VERIFY_REQUIRED_PASSES for the
 *  "prove-it-twice-before-family-wide" posture. */
export const DEFAULT_REQUIRED_PASSES = 1;

export interface CommitScore {
  /** [0,1] — 1.0 when no signal failed. */
  score: number;
  failedSignals: string[];
  passedSignals: string[];
  abstainedSignals: string[];
}

/**
 * Fold the independent signal verdicts into a [0,1] confidence. Start at 1.0;
 * subtract each FAILING signal's weight; floor at 0. Passing/abstaining signals
 * never change the score — so the score answers exactly "did anything that could
 * speak, disagree?".
 */
export function computeCommitScore(
  signals: CommitSignals,
  weights: SignalWeights = DEFAULT_SIGNAL_WEIGHTS,
): CommitScore {
  const failedSignals: string[] = [];
  const passedSignals: string[] = [];
  const abstainedSignals: string[] = [];
  let score = 1;
  for (const key of Object.keys(weights) as Array<keyof SignalWeights>) {
    const verdict = signals[key];
    if (verdict === 'fail') {
      score -= weights[key];
      failedSignals.push(key);
    } else if (verdict === 'pass') {
      passedSignals.push(key);
    } else {
      abstainedSignals.push(key);
    }
  }
  return { score: Math.max(0, Number(score.toFixed(4))), failedSignals, passedSignals, abstainedSignals };
}

export interface CommitDecisionInput {
  score: number;
  threshold?: number;
  /** Consistent passes INCLUDING this one. */
  consistentPasses: number;
  requiredPasses?: number;
}

export interface CommitDecision {
  /** True ⟹ safe to auto-promote family-wide (threshold AND pass^N met). */
  commit: boolean;
  meetsThreshold: boolean;
  meetsPasses: boolean;
  threshold: number;
  requiredPasses: number;
  reason: string;
}

/**
 * Gate a commit score against the calibrated threshold and the pass^N counter.
 * Auto-promotion requires BOTH the confidence floor and N consistent passes.
 */
export function decideCommit(input: CommitDecisionInput): CommitDecision {
  const threshold = input.threshold ?? DEFAULT_COMMIT_THRESHOLD;
  const requiredPasses = Math.max(1, input.requiredPasses ?? DEFAULT_REQUIRED_PASSES);
  const meetsThreshold = input.score >= threshold;
  const meetsPasses = input.consistentPasses >= requiredPasses;
  const commit = meetsThreshold && meetsPasses;
  const reason = commit
    ? `commit: score ${input.score.toFixed(3)} ≥ ${threshold} over ${input.consistentPasses}/${requiredPasses} consistent passes`
    : !meetsThreshold
      ? `hold: score ${input.score.toFixed(3)} < threshold ${threshold}`
      : `hold: ${input.consistentPasses}/${requiredPasses} consistent verification passes (need ${requiredPasses})`;
  return { commit, meetsThreshold, meetsPasses, threshold, requiredPasses, reason };
}

// ─── Value-distribution fingerprint (pass^N consistency anchor) ───────────────

export interface FingerprintInput {
  feed: string;
  /** Sampled canonical rows for the feed. */
  rows: Array<Record<string, unknown>>;
  /** The feed's key column (DISCOVERY_KEY_COLUMNS) — drives key-distinctness. */
  keyField?: string;
  /** The feed's enum/status column — drives the value-vocabulary profile. */
  statusField?: string;
  /** Total rows the feed matched (may exceed rows.length when rows is a sample). */
  rowCount?: number;
}

export interface FeedFingerprint {
  feed: string;
  rowCount: number;
  /** 'all' (every key distinct) | 'high' (≥90% distinct) | 'low' | 'na'. */
  keyDistinctBucket: 'all' | 'high' | 'low' | 'na';
  /** Sorted distinct normalized status values seen (the enum vocabulary), or ''. */
  enumProfile: string;
  /** A degenerate distribution that no correct feed should show — e.g. a key
   *  column that is constant across ≥3 rows. */
  sane: boolean;
}

const normLower = (v: unknown): string =>
  v == null ? '' : String(v).trim().toLowerCase().replace(/\s+/g, ' ');

/** Compute a coarse, drift-tolerant value fingerprint for one feed. Coarse on
 *  purpose: it must be STABLE across two onboarding passes minutes apart (a
 *  guest checking in must not change it), while still distinguishing a genuinely
 *  different recipe shape. Distinct from certifyColumns: this is an aggregate
 *  DISTRIBUTION summary, not a per-column identity proof — it does not certify a
 *  column, it characterises the feed for cross-pass consistency. */
export function valueFingerprint(input: FingerprintInput): FeedFingerprint {
  const rows = input.rows ?? [];
  const rowCount = input.rowCount ?? rows.length;

  let keyDistinctBucket: FeedFingerprint['keyDistinctBucket'] = 'na';
  let sane = true;
  if (input.keyField) {
    const keys = rows.map((r) => normLower(r[input.keyField!])).filter((k) => k !== '');
    if (keys.length > 0) {
      const distinct = new Set(keys).size;
      const ratio = distinct / keys.length;
      keyDistinctBucket = ratio >= 1 ? 'all' : ratio >= 0.9 ? 'high' : 'low';
      // A key constant across ≥3 rows is a wrong-key smell no correct feed shows.
      if (keys.length >= 3 && distinct < 2) sane = false;
    }
  }

  let enumProfile = '';
  if (input.statusField) {
    const vals = [...new Set(rows.map((r) => normLower(r[input.statusField!])).filter((v) => v !== ''))].sort();
    enumProfile = vals.join(',');
  }

  return { feed: input.feed, rowCount, keyDistinctBucket, enumProfile, sane };
}

/** Stable serialization of a set of feed fingerprints → one string suitable for
 *  persisting in the signed envelope and comparing across passes. Order-stable
 *  (sorted by feed). rowCount is bucketed coarsely so ±small drift between
 *  passes doesn't change the string. */
export function recipeFingerprintString(fps: FeedFingerprint[]): string {
  return [...fps]
    .sort((a, b) => (a.feed < b.feed ? -1 : a.feed > b.feed ? 1 : 0))
    .map((f) => `${f.feed}:${rowCountBucket(f.rowCount)}:${f.keyDistinctBucket}:${f.enumProfile}`)
    .join(';');
}

/** Coarse exponential-ish bucket so a one-or-two row drift keeps the same label. */
function rowCountBucket(n: number): string {
  if (n <= 0) return '0';
  if (n <= 5) return '1-5';
  if (n <= 20) return '6-20';
  if (n <= 50) return '21-50';
  if (n <= 100) return '51-100';
  if (n <= 300) return '101-300';
  return '300+';
}

/** Two recipe fingerprints are CONSISTENT iff their bucketed serializations are
 *  identical. Used to decide whether a fresh onboarding pass corroborated the
 *  prior one (→ increment the pass^N counter) or diverged (→ reset to 1). */
export function fingerprintsMatch(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a === b;
}
