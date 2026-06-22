/**
 * Semantic-entropy abstain for the structured-discovery identify() call
 * (feature/cua-bestclass-verify, Task 2).
 *
 * The mapper's ONE paid identify() call (mapper.ts attemptStructuredDiscovery)
 * proposes which captured JSON array + jsonPath + column mapping reconciles with
 * the DOM oracle. A single sample can be confidently WRONG on an ambiguous page
 * (two near-identical arrays, two plausible date fields). Best-in-class
 * verification samples the identify() N times and measures whether the samples
 * AGREE ON MEANING — the "semantic entropy" uncertainty signal (Kuhn et al.
 * 2023; Farquhar et al., Nature 2024): cluster the samples by what they MEAN
 * (here: the (candidateIndex, jsonPath, column-mapping) triple), then abstain
 * when the meaning is unstable across samples.
 *
 * PURE module: no anthropic / playwright / supabase imports. The caller owns the
 * N actual identify() calls (the only cost); this module just clusters the
 * already-returned proposals and decides consensus-vs-abstain. Fully
 * unit-testable offline.
 *
 * Abstain-by-default, exactly like the rest of the safety core: any doubt
 * (no dominant cluster / entropy above the cap) → the caller keeps the DOM
 * recipe. Rejecting a good candidate costs nothing; accepting a bad one corrupts
 * a hotel's data.
 *
 * Cost note: N samples = N identify() calls. This runs ONCE per feed at
 * ONBOARDING (never at the 30s poll), and the sample count defaults to 1 (single
 * call → trivial single-element cluster → today's behavior, zero added cost).
 * N>1 is opt-in via CUA_DISCOVERY_IDENTIFY_SAMPLES.
 */

/** The parsed shape of one identify() proposal that matters for MEANING. The
 *  caller extracts these three from the model's raw JSON BEFORE clustering;
 *  malformed / `{none:true}` samples are passed as `null` and counted as their
 *  own "abstain" meaning so they dilute consensus rather than being silently
 *  dropped. */
export interface DiscoveryProposalShape {
  candidateIndex: number;
  jsonPath: string;
  /** snake_case canonical column → dot-path mapping (post contract-filter). */
  columns: Record<string, string>;
}

export interface ProposalCluster {
  /** Canonical meaning key shared by every member. */
  key: string;
  /** How many samples landed in this cluster. */
  count: number;
  /** A representative member (the first sample with this meaning). `null` for
   *  the abstain/none cluster. */
  representative: DiscoveryProposalShape | null;
}

/**
 * Canonical MEANING key for a proposal. Two proposals mean the same thing iff
 * they pick the same captured array (candidateIndex), the same jsonPath, AND the
 * same column→path mapping. Column order is irrelevant to meaning, so the entries
 * are sorted; whitespace is trimmed so cosmetic differences don't split a
 * cluster. `null` (a malformed or {none:true} sample) is its own meaning so an
 * "I can't map it" answer counts AGAINST consensus.
 */
export function proposalMeaningKey(p: DiscoveryProposalShape | null): string {
  if (p === null) return 'none';
  const cols = Object.entries(p.columns)
    .map(([col, path]) => [col.trim(), String(path).trim()] as const)
    .filter(([col, path]) => col !== '' && path !== '')
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([col, path]) => `${col}=${path}`)
    .join('|');
  return `${p.candidateIndex}#${p.jsonPath.trim()}#${cols}`;
}

/**
 * Group proposals by meaning key. Result is sorted by descending count then key
 * (deterministic — no wall-clock / RNG), so `clusters[0]` is the plurality
 * meaning.
 */
export function clusterProposals(
  proposals: Array<DiscoveryProposalShape | null>,
): ProposalCluster[] {
  const byKey = new Map<string, ProposalCluster>();
  for (const p of proposals) {
    const key = proposalMeaningKey(p);
    const existing = byKey.get(key);
    if (existing) {
      existing.count++;
    } else {
      byKey.set(key, { key, count: 1, representative: p });
    }
  }
  return [...byKey.values()].sort((a, b) =>
    b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Shannon entropy (base-e, natural log) over the cluster distribution,
 * NORMALIZED to [0,1] by dividing by ln(#distinct-meanings) — so the cap is
 * comparable regardless of how many samples were drawn. 0 = perfect agreement
 * (one cluster); 1 = maximal disagreement (every sample a distinct meaning).
 * A single sample (or all-identical samples) → exactly 0.
 */
export function semanticEntropy(clusters: ProposalCluster[]): number {
  const total = clusters.reduce((s, c) => s + c.count, 0);
  if (total <= 1 || clusters.length <= 1) return 0;
  let h = 0;
  for (const c of clusters) {
    const p = c.count / total;
    if (p > 0) h -= p * Math.log(p);
  }
  // Normalize by the maximum possible entropy for this many distinct meanings.
  const hMax = Math.log(clusters.length);
  return hMax > 0 ? h / hMax : 0;
}

export interface ConsensusConfig {
  /** Reject if fewer than this many usable samples were drawn. Default 1. */
  minSamples?: number;
  /** Abstain when normalized semantic entropy exceeds this. Default 0.5. */
  maxEntropy?: number;
  /** Abstain when the plurality cluster's share is below this. Default 0.5
   *  (a strict majority of samples must agree on the meaning). */
  minDominance?: number;
}

export type ConsensusResult =
  | {
      ok: true;
      proposal: DiscoveryProposalShape;
      /** Plurality cluster share [0,1]. */
      agreement: number;
      /** Normalized semantic entropy [0,1]. */
      entropy: number;
      samples: number;
    }
  | { ok: false; reason: string; entropy: number; agreement: number; samples: number };

/**
 * Decide whether N identify() samples agree enough to TRUST a proposal.
 *
 * Returns the plurality proposal ONLY when:
 *   - at least `minSamples` were drawn, AND
 *   - the plurality cluster is a real proposal (not the `none`/malformed
 *     cluster), AND
 *   - normalized semantic entropy ≤ `maxEntropy`, AND
 *   - the plurality cluster's share ≥ `minDominance`.
 *
 * Otherwise abstains. The returned proposal is STILL mechanically reconciled by
 * the caller afterward — consensus is a CHEAP pre-gate that kills ambiguous
 * hypotheses before the (more expensive) replay/probe machinery runs, never a
 * substitute for it.
 *
 * Single-sample callers (the default, N=1) get the trivial happy path: one
 * cluster, entropy 0, agreement 1 → returns that proposal, behaviourally
 * identical to today's single identify() call.
 */
export function chooseConsensusProposal(
  proposals: Array<DiscoveryProposalShape | null>,
  config: ConsensusConfig = {},
): ConsensusResult {
  const minSamples = config.minSamples ?? 1;
  const maxEntropy = config.maxEntropy ?? 0.5;
  const minDominance = config.minDominance ?? 0.5;

  const samples = proposals.length;
  const clusters = clusterProposals(proposals);
  const entropy = semanticEntropy(clusters);
  const total = clusters.reduce((s, c) => s + c.count, 0);
  const top = clusters[0];
  const agreement = top && total > 0 ? top.count / total : 0;

  if (samples < minSamples) {
    return { ok: false, reason: `too_few_samples:${samples}/${minSamples}`, entropy, agreement, samples };
  }
  if (!top || top.representative === null) {
    // Plurality meaning is "no mappable candidate" (or no samples at all).
    return { ok: false, reason: 'plurality_is_none', entropy, agreement, samples };
  }
  // A genuine TIE (the runner-up cluster has the same count as the top) has no
  // dominant meaning, regardless of how lax maxEntropy/minDominance are set —
  // `top` would otherwise be the lexicographic tie-winner, which is arbitrary.
  if (clusters.length >= 2 && clusters[1]!.count === top.count) {
    return { ok: false, reason: 'tie_no_plurality', entropy, agreement, samples };
  }
  if (entropy > maxEntropy) {
    return { ok: false, reason: `entropy_too_high:${entropy.toFixed(3)}>${maxEntropy}`, entropy, agreement, samples };
  }
  if (agreement < minDominance) {
    return { ok: false, reason: `no_dominant_cluster:${agreement.toFixed(3)}<${minDominance}`, entropy, agreement, samples };
  }
  return { ok: true, proposal: top.representative, agreement, entropy, samples };
}
