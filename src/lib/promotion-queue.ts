/**
 * The knowledge promotion queue — shared rules (migration 0353).
 *
 * Staxis AI holds knowledge in three tiers:
 *   GLOBAL           true of every hotel
 *   PMS/BRAND FAMILY true of every hotel on that PMS
 *   THIS HOTEL       walled off, never leaves
 * Hotel-specific always wins on conflict.
 *
 * Anything moving UP a tier — a lesson learned at one hotel becoming knowledge
 * shared with hotels that never generated it — crosses a privacy boundary and
 * is the founder's call alone. This module holds the rules that decide it, in
 * ONE place, so the DB CHECKs (0353), the API route, and the Mission Control
 * panel can never drift into disagreeing about what "good enough to promote"
 * means.
 *
 * Everything above `── DB helpers` is pure: no network, no clock beyond the
 * `now` you pass in. That is deliberate — the bar is the part that must be
 * testable without a database.
 *
 * NOT the hotel-facing approval queue. A GM approving "order towels" is
 * agent_pending_actions. Different audience, different consequences.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';

// ── Vocabulary ─────────────────────────────────────────────────────────────

/** The tier a claim wants to ENTER. Hotel tier never appears here: staying
 *  inside one hotel crosses no boundary and needs nobody's approval. */
export type PromotionTier = 'family' | 'global';
/** The tier a claim was lifted FROM. `null` = authored, nothing was lifted. */
export type PromotionSourceTier = 'hotel' | 'family';
export type PromotionStatus = 'pending' | 'approved' | 'rejected' | 'retracted';
export type PromotionOrigin = 'learned' | 'authored';
/** Closed vocabulary — mirrors knowledge_promotions_preconditions_ck. */
export type PromotionPrecondition = 'family_row_exists';

/** What staxis_propose_promotion answers. Never throws on a refusal. */
export type ProposeAction =
  | 'inserted'
  | 'already_pending'
  | 'already_promoted'
  | 'refused_rejected'
  | 'below_bar';

/** Promoted knowledge ages out unless re-confirmed. Same 75 days the nightly
 *  memory consolidation gives an auto-learned hotel fact (0259) — shared
 *  knowledge should not outlive a hotel fact by default. */
export const PROMOTION_TTL_DAYS = 75;

/** Aggregate / cross-hotel claims ("hotels like yours run 3 housekeepers")
 *  need this many SUPPORTING hotels, excluding whichever hotel asked, or the
 *  system refuses to propose the claim at all rather than answering weakly.
 *  With one hotel in the fleet, no aggregate claim can ever qualify — which is
 *  the intended outcome, not a gap. */
export const AGGREGATE_MIN_GROUP_SIZE = 5;

/** Higher tier, higher bar. `requiresHoldout` is "must still be true at a
 *  hotel that contributed none of the evidence" — the guard against promoting
 *  one operator's habit to a universal truth. */
export const TIER_BAR: Record<PromotionTier, { minSupportingHotels: number; requiresHoldout: boolean }> = {
  family: { minSupportingHotels: 2, requiresHoldout: false },
  global: { minSupportingHotels: 3, requiresHoldout: true },
};

// ── The row shape the API and the panel both speak ─────────────────────────

export interface PromotionRow {
  id: string;
  topic: string;
  claim: string;
  evidence_summary: string | null;
  proposed_content: string;
  final_content: string | null;
  source_tier: PromotionSourceTier | null;
  target_tier: PromotionTier;
  pms_family: string | null;
  origin: PromotionOrigin;
  source_kind: string;
  source_ref: string | null;
  source_property_ids: string[] | null;
  supporting_hotel_count: number;
  observation_count: number;
  evidence_window_start: string | null;
  evidence_window_end: string | null;
  holdout_validated: boolean;
  is_aggregate: boolean;
  preconditions: string[] | null;
  target_table: string | null;
  target_row_id: string | null;
  previous_target_row_id: string | null;
  status: PromotionStatus;
  decided_at: string | null;
  decided_by_account_id: string | null;
  decision_note: string | null;
  approved_at: string | null;
  expires_at: string | null;
  reconfirmed_at: string | null;
  reconfirm_count: number;
  retracted_at: string | null;
  applied_property_ids: string[] | null;
  created_at: string;
  updated_at: string;
}

/** The minimum an evidence check needs. Lets tests and the propose path check
 *  the bar without inventing a whole row. */
export type EvidenceClaim = Pick<
  PromotionRow,
  'target_tier' | 'origin' | 'supporting_hotel_count' | 'holdout_validated' | 'is_aggregate'
>;

// ── The bar ────────────────────────────────────────────────────────────────

/** WHICH bar a claim failed. Lets a second vocabulary (the card's one-line
 *  summary) be written for the same failure without re-deriving the thresholds
 *  and drifting from the rule. Never widen this into a decision — `ok` is the
 *  only field anything is allowed to gate on. */
export type BarFailure = 'aggregate_group' | 'not_enough_hotels' | 'no_holdout' | 'unknown_tier';

export interface BarResult {
  /** Does this claim clear the bar for the tier it wants to enter? */
  ok: boolean;
  /** Plain English, addressed to the founder. Empty when ok. */
  reason: string;
  /** Empty when ok. Wording only — see BarFailure. */
  code: BarFailure | '';
}

/**
 * The single source of truth for "is the evidence strong enough for this tier".
 * Mirrors knowledge_promotions_bar_ck + _aggregate_group_ck in migration 0353
 * and the guards inside staxis_propose_promotion — three enforcement points,
 * one rule, stated here.
 *
 * Authored items (a human deliberately wrote the text) are exempt from the
 * supporting-hotel count: there is no borrowed hotel data to justify. They are
 * NOT exempt from the aggregate minimum group size, because an aggregate claim
 * is about other hotels' data no matter who typed it.
 */
export function meetsEvidenceBar(claim: EvidenceClaim): BarResult {
  const hotels = Number.isFinite(claim.supporting_hotel_count) ? claim.supporting_hotel_count : 0;

  if (claim.is_aggregate && hotels < AGGREGATE_MIN_GROUP_SIZE) {
    return {
      ok: false,
      code: 'aggregate_group',
      reason:
        `Comparing hotels needs at least ${AGGREGATE_MIN_GROUP_SIZE} other hotels backing it — ` +
        `this has ${hotels}. Staxis says "not enough hotels to say" rather than guessing.`,
    };
  }

  if (claim.origin === 'authored') return { ok: true, reason: '', code: '' };

  const bar = TIER_BAR[claim.target_tier];
  if (!bar) return { ok: false, reason: `Unknown tier "${claim.target_tier}".`, code: 'unknown_tier' };

  if (hotels < bar.minSupportingHotels) {
    return {
      ok: false,
      code: 'not_enough_hotels',
      reason:
        `${tierLabel(claim.target_tier, null)} needs at least ${bar.minSupportingHotels} hotels ` +
        `backing it — this has ${hotels}.`,
    };
  }
  if (bar.requiresHoldout && !claim.holdout_validated) {
    return {
      ok: false,
      code: 'no_holdout',
      reason: 'Not yet confirmed at a hotel that contributed none of the evidence.',
    };
  }
  return { ok: true, reason: '', code: '' };
}

/** Plain-English name for the audience a promotion would reach. */
export function tierLabel(tier: PromotionTier, pmsFamily: string | null): string {
  if (tier === 'global') return 'Every hotel';
  const family = (pmsFamily ?? '').replace(/_/g, ' ').trim();
  return family ? `Every hotel on ${family}` : 'Every hotel on this system';
}

/** One line describing where the claim came from and how strong it is. */
export function describeEvidence(row: PromotionRow): string {
  const parts: string[] = [];
  if (row.origin === 'authored') {
    parts.push('Written by hand');
  } else {
    const h = row.supporting_hotel_count;
    parts.push(`${h} hotel${h === 1 ? '' : 's'} back it`);
  }
  if (row.observation_count > 0) {
    parts.push(`${row.observation_count} observation${row.observation_count === 1 ? '' : 's'}`);
  }
  const window = describeWindow(row.evidence_window_start, row.evidence_window_end);
  if (window) parts.push(window);
  if (row.holdout_validated) parts.push('confirmed at a hotel that gave no evidence');
  return parts.join(' · ');
}

function describeWindow(start: string | null, end: string | null): string {
  if (!start || !end) return '';
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return '';
  const days = Math.max(1, Math.round((b - a) / 86_400_000));
  return `over ${days} day${days === 1 ? '' : 's'}`;
}

// ── Expiry ─────────────────────────────────────────────────────────────────

/** ISO timestamp a promotion approved at `now` should expire at. */
export function expiryFrom(now: Date): string {
  return new Date(now.getTime() + PROMOTION_TTL_DAYS * 86_400_000).toISOString();
}

/** A live promotion past its re-confirm date. Expired knowledge is still
 *  applied until someone acts — which is exactly why the queue shouts about
 *  it rather than quietly filing it away. */
export function isExpired(row: Pick<PromotionRow, 'status' | 'expires_at'>, now: Date): boolean {
  if (row.status !== 'approved' || !row.expires_at) return false;
  const t = Date.parse(row.expires_at);
  return Number.isFinite(t) && t <= now.getTime();
}

/** Whole days until re-confirm is due. Negative once overdue; null if not live. */
export function daysUntilExpiry(row: Pick<PromotionRow, 'status' | 'expires_at'>, now: Date): number | null {
  if (row.status !== 'approved' || !row.expires_at) return null;
  const t = Date.parse(row.expires_at);
  if (!Number.isFinite(t)) return null;
  return Math.ceil((t - now.getTime()) / 86_400_000);
}

/**
 * The number the founder sees without opening the panel. Counts everything
 * that genuinely needs him: items waiting for a decision, and live items whose
 * 75 days ran out. A queue you have to remember to open is a queue nobody
 * works, so this number is what gets surfaced on the admin header strip.
 */
export function countNeedingAttention(rows: Array<Pick<PromotionRow, 'status' | 'expires_at'>>, now: Date): number {
  let n = 0;
  for (const r of rows) {
    if (r.status === 'pending' || isExpired(r, now)) n += 1;
  }
  return n;
}

// ── Preconditions ──────────────────────────────────────────────────────────

/** Facts about the world that machine-checkable preconditions are evaluated
 *  against. Gathered once per request by the route. */
export interface PreconditionFacts {
  /** ACTIVE rows in agent_prompts with role='family'. */
  activeFamilyRowCount: number;
}

/**
 * Plain-English reasons this item cannot be approved yet. Empty array = the
 * Approve button is live.
 *
 * Deliberately a CLOSED vocabulary (see knowledge_promotions_preconditions_ck):
 * an unrecognised key blocks approval rather than being ignored. A gate nobody
 * evaluates that silently passes is worse than no gate at all.
 */
export function unmetPreconditions(
  row: Pick<PromotionRow, 'preconditions'>,
  facts: PreconditionFacts,
): string[] {
  return unmetPreconditionKeys(row, facts).map((key) =>
    key === 'family_row_exists'
      ? 'No PMS-family instructions are switched on yet, so this would describe a section that never appears.'
      : `Unrecognised requirement "${key}" — nothing checks it, so this stays blocked.`,
  );
}

/**
 * The unmet requirements as KEYS, in stored order — the single evaluation that
 * both `unmetPreconditions` (the full reasons) and `plainLockReason` (the one
 * line on the card) read. Two vocabularies for one verdict; they cannot drift
 * into disagreeing about whether something is blocked.
 *
 * An unrecognised key comes back as unmet, for the reason above: a gate nobody
 * evaluates must never read as satisfied.
 */
export function unmetPreconditionKeys(
  row: Pick<PromotionRow, 'preconditions'>,
  facts: PreconditionFacts,
): string[] {
  const out: string[] = [];
  for (const key of row.preconditions ?? []) {
    if (key === 'family_row_exists') {
      if (facts.activeFamilyRowCount <= 0) out.push(key);
      continue;
    }
    out.push(key);
  }
  return out;
}

// ── How a card reads at a glance ───────────────────────────────────────────
//
// The founder is the only reader of this queue, he is not an engineer, and a
// card he needs three minutes to decode is a card he does not work. Everything
// below is WORDING — it decides nothing. `meetsEvidenceBar` and
// `unmetPreconditions` remain the only things that gate Approve, and the short
// sentences here are derived from those same two calls rather than
// re-implementing them.

/** Where knowledge lives, in the founder's words. The stored values are
 *  `hotel` / `family` / `global`; nobody outside this file should have to
 *  learn them. */
export const PLAIN_TIER: Record<PromotionSourceTier | PromotionTier, string> = {
  hotel: 'This hotel only',
  family: 'Hotels on the same system',
  global: 'Every hotel',
};

/** An authored item was lifted from nowhere — it has no home tier yet. */
export const PLAIN_TIER_UNUSED = 'Not in use yet';

export function plainTier(tier: PromotionSourceTier | PromotionTier | null): string {
  return tier ? PLAIN_TIER[tier] : PLAIN_TIER_UNUSED;
}

/** Where a piece of knowledge lives now, and where it is asking to go. The
 *  card draws this as two chips and an arrow — the one thing that has to be
 *  readable without reading. */
export interface PromotionJourney {
  from: string;
  to: string;
}

export function promotionJourney(row: Pick<PromotionRow, 'source_tier' | 'target_tier'>): PromotionJourney {
  return { from: plainTier(row.source_tier), to: plainTier(row.target_tier) };
}

/** Eyebrow above the headline: did a person write this, or did Staxis learn it
 *  from hotels? Echoes the vocabulary `describeEvidence` already uses. */
export function promotionOriginLabel(row: Pick<PromotionRow, 'origin'>): string {
  return row.origin === 'authored' ? 'Written by hand' : 'Learned from hotels';
}

/** Longest headline that still fits two lines in the Mission Control column.
 *  The card also clamps to two lines in CSS, so a stored claim with no spaces
 *  at all cannot overflow either. */
export const CLAIM_HEADLINE_MAX = 120;

/**
 * The claim cut down to something readable in a glance.
 *
 * Prefers the LAST clause boundary that fits, so the most meaning survives,
 * and falls back to a word boundary. Nothing is lost: the card keeps the full
 * claim under Details, which is the whole reason truncating here is safe.
 */
export function shortClaim(claim: string, max = CLAIM_HEADLINE_MAX): { text: string; truncated: boolean } {
  const whole = (claim ?? '').replace(/\s+/g, ' ').trim();
  if (whole.length <= max) return { text: whole, truncated: false };

  const window = whole.slice(0, max);
  // A boundary in the first half would throw away most of the sentence, so
  // only cuts past the midpoint count as an improvement on a plain word break.
  const floor = Math.floor(max / 2);
  let cut = -1;
  for (const m of window.matchAll(/[.;:,](?=\s)|\s[—–](?=\s)/g)) {
    const at = m.index ?? 0;
    if (at >= floor) cut = at;
  }
  if (cut < floor) cut = window.lastIndexOf(' ');
  if (cut < floor) cut = max;
  return { text: `${whole.slice(0, cut).replace(/[\s.;:,—–]+$/, '')}…`, truncated: true };
}

/**
 * The single plain sentence the card shows when Approve is switched off —
 * empty exactly when the item is approvable.
 *
 * Reads the same `meetsEvidenceBar` + `unmetPreconditionKeys` the route blocks
 * on, and reports the first problem in the same order the route lists them
 * (the evidence bar first). The full engineer-grade reasons are still carried
 * on the card under Details; this is the version that fits on one line.
 */
export function plainLockReason(
  row: Pick<
    PromotionRow,
    'preconditions' | 'target_tier' | 'origin' | 'supporting_hotel_count' | 'holdout_validated' | 'is_aggregate'
  >,
  facts: PreconditionFacts,
): string {
  const hotels = Number.isFinite(row.supporting_hotel_count) ? Math.max(0, row.supporting_hotel_count) : 0;
  const bar = meetsEvidenceBar(row);

  if (!bar.ok) {
    switch (bar.code) {
      // No em dashes in here: the card already prefixes "Locked — ", and a
      // second dash in the same line turns one sentence into a muddle.
      case 'aggregate_group':
        return `Comparing hotels needs ${AGGREGATE_MIN_GROUP_SIZE} behind it, and only ${hotels} back this.`;
      case 'not_enough_hotels':
        return `Only ${hotels} hotel${hotels === 1 ? ' backs' : 's back'} this so far, and it needs ${TIER_BAR[row.target_tier].minSupportingHotels}.`;
      case 'no_holdout':
        return 'Not proven yet at a hotel that gave none of the evidence.';
      default:
        return 'Something about this item no longer adds up, so it stays locked.';
    }
  }

  const [key] = unmetPreconditionKeys(row, facts);
  if (key === undefined) return '';
  if (key === 'family_row_exists') {
    return 'No shared notes are switched on yet, so this rule would describe nothing.';
  }
  return 'It is waiting on a check that no longer exists.';
}

// ── DB helpers ─────────────────────────────────────────────────────────────

/**
 * PostgREST's "the table isn't there" signals. The 0353 migration is applied by
 * hand, so every reader must survive the window between deploy and apply — the
 * admin header degrades to "—" instead of 500ing the whole stat strip.
 */
export function isMissingRelationError(error: { code?: string | null; message?: string | null } | null): boolean {
  if (!error) return false;
  const code = error.code ?? '';
  if (code === '42P01' || code === 'PGRST205' || code === 'PGRST202') return true;
  const msg = (error.message ?? '').toLowerCase();
  return msg.includes('does not exist') && (msg.includes('knowledge_promotions') || msg.includes('relation'));
}

export interface ProposePromotionInput {
  topic: string;
  claim: string;
  proposedContent: string;
  targetTier: PromotionTier;
  origin: PromotionOrigin;
  // Mirrors knowledge_promotions_source_kind_ck. 'findings_sweep' (0362) is the
  // weekly findings discovery pass: machine-authored, and worth being able to
  // tell apart from a fact lifted out of a conversation when a human is
  // deciding whether to make it everyone's.
  sourceKind:
    | 'agent_memory'
    | 'consolidation'
    | 'eval'
    | 'extraction'
    | 'migration'
    | 'human'
    | 'findings_sweep';
  pmsFamily?: string | null;
  sourceTier?: PromotionSourceTier | null;
  evidenceSummary?: string | null;
  sourceRef?: string | null;
  sourcePropertyIds?: string[];
  supportingHotelCount?: number;
  observationCount?: number;
  evidenceWindowStart?: string | null;
  evidenceWindowEnd?: string | null;
  holdoutValidated?: boolean;
  isAggregate?: boolean;
  preconditions?: PromotionPrecondition[];
  targetTable?: 'agent_prompts' | null;
  targetRowId?: string | null;
}

/**
 * THE automatic way in. Anything that learns something worth sharing calls
 * this; nothing waits on the founder flipping a switch to get INTO the queue —
 * he only decides what gets out of it.
 *
 * Never throws on a business refusal (a permanently rejected topic, a
 * duplicate, weak evidence): those come back as an `action` code so a
 * background job can log and carry on. Only a genuine DB failure throws.
 */
export async function proposePromotion(
  input: ProposePromotionInput,
): Promise<{ id: string | null; action: ProposeAction }> {
  const { data, error } = await supabaseAdmin.rpc('staxis_propose_promotion', {
    p_topic: input.topic,
    p_claim: input.claim,
    p_proposed_content: input.proposedContent,
    p_target_tier: input.targetTier,
    p_origin: input.origin,
    p_source_kind: input.sourceKind,
    p_pms_family: input.pmsFamily ?? null,
    p_source_tier: input.sourceTier ?? null,
    p_evidence_summary: input.evidenceSummary ?? null,
    p_source_ref: input.sourceRef ?? null,
    p_source_property_ids: input.sourcePropertyIds ?? [],
    p_supporting_hotel_count: input.supportingHotelCount ?? 0,
    p_observation_count: input.observationCount ?? 0,
    p_evidence_window_start: input.evidenceWindowStart ?? null,
    p_evidence_window_end: input.evidenceWindowEnd ?? null,
    p_holdout_validated: input.holdoutValidated ?? false,
    p_is_aggregate: input.isAggregate ?? false,
    p_preconditions: input.preconditions ?? [],
    p_target_table: input.targetTable ?? null,
    p_target_row_id: input.targetRowId ?? null,
  });

  if (error) throw new Error(`staxis_propose_promotion failed: ${error.message}`);

  const row = Array.isArray(data) ? data[0] : data;
  const action = (row?.action ?? 'below_bar') as ProposeAction;
  return { id: (row?.promotion_id as string | null) ?? null, action };
}
