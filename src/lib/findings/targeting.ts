// ─── Which THING a finding is about ──────────────────────────────────────────
//
// The founder's decision for this feature, in one sentence: the pattern shows up
// where the evidence lives. Not a strip at the top of a tab, not a second inbox
// — a one-line signpost on room 214's own record, on that inventory item's own
// record, pointing at the one card in the Staxis queue.
//
// That needs an answer to exactly one question: "does this hotel have an open
// finding about THIS thing?" This file is that answer, and it is deliberately
// pure — no database handle, no server-only import — so the matching rule can be
// asserted directly instead of inferred from a route's output.
//
// HOW A FINDING'S TARGET IS READ, AND WHY IT IS NOT PARSED OUT OF THE KEY
// Two sources, tried in order:
//
//   1. evidence.target — the structured field detectors write from now on
//      (see FindingTarget in ./types.ts). This is the only source new code
//      should rely on.
//
//   2. A CLOSED, NAMED allowlist of legacy evidence params, for rows written
//      before that field existed — including the `[QA seed]` rows on Test
//      Hotel. These are named JSON keys a detector deliberately put there
//      ("room_number", "item_id"), not substrings recovered from a key.
//
// What this file will NOT do is split `dedupe_key`. The key's interior is the
// detector's private business — `room_needs_attention:overdue_room:2026-07-25:214`
// today, something else after any refactor — and a screen that unpicked it would
// be coupled to every detector's format forever, and would fail SILENTLY (a chip
// that stops appearing, never an error) the first time one changed. The
// allowlist below is small, explicit, and will not grow: new detectors set
// `evidence.target`.

import type { FindingTarget, FindingTargetKind } from './types';

/** Findings statuses this feature will surface. */
export type TargetableStatus = 'open' | 'updated';

/**
 * Legacy evidence params that named a target before `evidence.target` existed.
 *
 * Frozen and short on purpose. Every entry is a key some shipped detector (or
 * the QA seed) actually wrote; nothing here is speculative, and nothing new
 * belongs here — a detector added after this file sets `evidence.target`.
 */
const LEGACY_PARAM_KEYS: Readonly<Record<FindingTargetKind, readonly string[]>> = Object.freeze({
  // `room_number` — room_needs_attention. `room` — the QA seed rows.
  room: Object.freeze(['room_number', 'room']),
  // `item_id` — inventory_usage_baseline.
  inventory_item: Object.freeze(['item_id']),
});

const KINDS: readonly FindingTargetKind[] = Object.freeze(['room', 'inventory_item']);

/**
 * Stand-ins a detector wrote where a real identity was missing. Normalized form.
 *
 * `room_needs_attention` fills `room_number` with "unknown" when the nudge named
 * no room, and rows carrying that predate the structured field — so without this
 * every roomless alert at every hotel would resolve to one shared phantom room.
 */
const PLACEHOLDER_VALUES: ReadonlySet<string> = new Set(['unknown', 'null', 'undefined', 'n/a', '-']);

export function isFindingTargetKind(value: unknown): value is FindingTargetKind {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value);
}

/**
 * The comparison form of an identity. Trimmed and lowercased, so " 214 " from a
 * work order's location field and "214" from a detector are the same room, and
 * a uuid's casing never decides whether a chip appears.
 */
export function normalizeTargetValue(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  // 120 is well past any room number or uuid; it exists so a pathological
  // evidence blob cannot turn into a pathological comparison.
  if (trimmed.length === 0 || trimmed.length > 120) return null;
  return trimmed;
}

/** The evidence shape this file needs. Structurally compatible with FindingEvidence. */
export interface TargetableEvidence {
  params?: Readonly<Record<string, unknown>> | null;
  target?: { kind?: unknown; value?: unknown } | null;
}

/**
 * What this finding is about, or null when it is about the hotel rather than one
 * thing. Never throws: evidence is stored jsonb and a malformed blob must
 * produce "no target", not a broken screen.
 */
export function resolveFindingTarget(evidence: TargetableEvidence | null | undefined): FindingTarget | null {
  if (!evidence || typeof evidence !== 'object') return null;

  // 1. The structured field, when the detector wrote one.
  //
  // PRESENCE, not truthiness. `target: null` is a detector SAYING "this is not
  // about one thing" — room_needs_attention writes exactly that when the nudge
  // named no room — and falling through from there to the params would recover
  // an answer the detector had just declined to give. (It did, once: the params
  // still carry `room_number: "unknown"`, this function read it, and every
  // roomless alert became a finding about a room called "unknown".)
  if ('target' in evidence) {
    const declared = evidence.target;
    if (!declared || typeof declared !== 'object') return null;
    const kind = declared.kind;
    const value = normalizeTargetValue(declared.value);
    if (isFindingTargetKind(kind) && value) return { kind, value };
    // Declared but unusable: still the detector's statement. The honest outcome
    // is no chip, not a different answer recovered from somewhere else.
    return null;
  }

  // 2. Rows written before the field existed: named params only.
  const params = evidence.params;
  if (!params || typeof params !== 'object') return null;
  for (const kind of KINDS) {
    for (const key of LEGACY_PARAM_KEYS[kind]) {
      const raw = (params as Record<string, unknown>)[key];
      const value = normalizeTargetValue(raw);
      if (value && !PLACEHOLDER_VALUES.has(value)) return { kind, value };
    }
  }
  return null;
}

// ─── Matching ────────────────────────────────────────────────────────────────

/** The slice of a stored finding this file reads. */
export interface TargetableFinding {
  id: string;
  dedupeKey: string;
  severity: 'critical' | 'attention' | 'info';
  status: string;
  disposition: string;
  judgedDisposition?: string | null;
  evidence?: TargetableEvidence | null;
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, attention: 1, info: 2 };

/**
 * The findings this hotel currently has open about ONE thing, worst first.
 *
 * Three filters, each one load-bearing:
 *
 *   status      only `open` and `updated`. `known_problem` and `muted` are
 *               silences a manager armed, and a chip on the thing itself would
 *               be the same nag wearing a different hat — the exact "second
 *               inbox" the founder ruled out. `resolved` and `expired` are over.
 *
 *   renderable  `ask` findings are questions and belong to the drip card;
 *               `drop` is the judge's "not worth surfacing". Neither has a card
 *               in the queue, and a signpost pointing at a card that is not
 *               there is worse than no signpost. The JUDGE's verdict governs
 *               where it has one, exactly as the queue route does.
 *
 *   target      kind and value must both match.
 *
 * Order is severity then dedupe key — stable across identical loads, and
 * comparable across detectors in a way raw magnitude is not (one detector counts
 * minutes, another counts bottles of shampoo).
 */
export function findingsForTarget<T extends TargetableFinding>(
  findings: readonly T[],
  kind: FindingTargetKind,
  value: string,
): T[] {
  const wanted = normalizeTargetValue(value);
  if (!wanted) return [];

  const matched = findings.filter((f) => {
    if (f.status !== 'open' && f.status !== 'updated') return false;
    const disposition = f.judgedDisposition ?? f.disposition;
    if (disposition === 'ask' || disposition === 'drop') return false;
    const target = resolveFindingTarget(f.evidence);
    return target !== null && target.kind === kind && target.value === wanted;
  });

  return matched.sort((a, b) => {
    const sev = (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
    if (sev !== 0) return sev;
    return a.dedupeKey < b.dedupeKey ? -1 : a.dedupeKey > b.dedupeKey ? 1 : 0;
  });
}
