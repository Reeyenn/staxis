// ─── From "true at this hotel" to "worth every hotel having" ─────────────────
//
// THE RISK THIS FILE EXISTS TO REMOVE
// The sweep discovers a candidate check by looking at ONE hotel's data. If that
// candidate reaches the shared library carrying anything the hotel's own
// records taught it — a room range, an item name, a dollar figure, a threshold
// measured on its invoices — then every hotel on that PMS family is now running
// a detector built out of a competitor's operation. That is a tenant leak
// wearing a feature's clothes, and it would be indistinguishable from a feature
// in every screenshot and every review.
//
// SO THE RULE IS FLAT AND MECHANICAL: a promoted detector's text contains no
// digits. None.
//
// Not "no room numbers", not "no amounts" — no digits, checked by a regular
// expression, with the structural constants of a derivation spelled in words in
// THRESHOLD_DERIVATIONS. Every softer rule ("no PII", "nothing hotel-specific")
// is a judgement call that a reviewer makes correctly forty times and wrongly
// once. This one cannot be argued with, and a threshold measured off the source
// hotel cannot survive it, because a number is how such a threshold is written
// down.
//
// The payload is also built to satisfy it BY CONSTRUCTION rather than by
// filtering: `buildPromotionDraft` assembles text out of a fixed per-check
// template plus the derivation enum, and there is no parameter through which
// the hotel's evidence could reach it. The guard is the belt to that braces —
// it exists so the property stays true if someone later adds a parameter.
//
// WHAT MAKES A CANDIDATE ELIGIBLE AT ALL
// Two hotels, not one. A pattern reproduced at exactly one hotel is that
// hotel's quirk, and 0353's bar says the same thing in SQL (an origin other
// than 'authored' needs two supporting hotels for family tier, three plus a
// holdout for global). This file proposes only at FAMILY tier: global tier
// requires validation at a hotel that contributed none of the evidence, and a
// sweep cannot manufacture a holdout hotel — that promotion is the founder's to
// make by hand, from the family item, with the evidence in front of him.

import 'server-only';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import { proposePromotion, type ProposeAction } from '@/lib/promotion-queue';

import {
  THRESHOLD_DERIVATIONS,
  candidateSignature,
  type CheckKind,
  type ThresholdDerivation,
} from './sweep-checks';

/** Hotels that must have reproduced a candidate before it may be proposed. */
export const MIN_SUPPORTING_HOTELS = 2;

// ─── The property-agnostic guard ─────────────────────────────────────────────

export interface AgnosticViolation {
  field: string;
  kind: 'digit' | 'currency' | 'forbidden_token';
  token: string;
}

const DIGIT_RE = /\d/g;
const CURRENCY_RE = /[$€£¥]/g;

/**
 * Everything a promotion payload may NOT contain.
 *
 * `forbidden` carries the source hotel's own identifying strings — its id, its
 * name, the names of its inventory items. Tokens shorter than four characters
 * are dropped: a two-letter item name would match half the English language and
 * a guard that refuses everything gets switched off.
 */
export function propertyAgnosticViolations(
  fields: Readonly<Record<string, string>>,
  forbidden: readonly string[] = [],
): AgnosticViolation[] {
  const violations: AgnosticViolation[] = [];
  const needles = [...new Set(forbidden.map((f) => f.trim().toLowerCase()))].filter(
    (f) => f.length >= 4,
  );

  for (const [field, value] of Object.entries(fields)) {
    const text = value ?? '';
    for (const match of text.matchAll(DIGIT_RE)) {
      violations.push({ field, kind: 'digit', token: match[0] });
      break; // one report per field is enough to refuse it
    }
    for (const match of text.matchAll(CURRENCY_RE)) {
      violations.push({ field, kind: 'currency', token: match[0] });
      break;
    }
    const folded = text.toLowerCase();
    for (const needle of needles) {
      if (folded.includes(needle)) {
        violations.push({ field, kind: 'forbidden_token', token: needle });
      }
    }
  }
  return violations;
}

// ─── The proposal ────────────────────────────────────────────────────────────

export interface PromotionDraft {
  topic: string;
  claim: string;
  proposedContent: string;
  evidenceSummary: string;
}

/**
 * What each check would become as a shared detector, in words a founder can
 * judge. One fixed sentence per kind — no interpolation of anything the source
 * hotel produced, which is what makes the no-digits guard pass by construction
 * rather than by luck.
 */
const WATCHES: Readonly<Record<CheckKind, string>> = Object.freeze({
  stream_stopped:
    'something this hotel does over and over has stopped happening for longer than the hotel ' +
    'itself normally goes without it',
  weekly_spike:
    "a seven-day total far above what this hotel's own recent weeks do",
  item_usage_shift:
    'an inventory item moving at a daily rate far above the rate that item has moved at, at ' +
    'this hotel, in its own earlier counted intervals',
  weekday_concentration:
    'nearly all of one kind of activity landing on a single weekday, against a hotel whose ' +
    'other weekdays carry a much smaller share',
  variance_growth:
    'a hotel whose week-to-week swing has grown much larger than its own earlier swing, even ' +
    'though no single week is unusual on its own',
});

const SUBJECT_WORDS: Readonly<Record<string, string>> = Object.freeze({
  supply_spend: 'restocking spend',
  work_orders: 'work orders opened',
  inventory_counts: 'inventory counting',
  daily_log_closings: 'the daily numbers being recorded',
  work_order_flow: 'maintenance being logged',
  any_item: 'any inventory item',
});

/** Plain words for a count, so a payload never has to carry a digit. */
const COUNT_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
];
function inWords(n: number): string {
  const i = Math.max(0, Math.trunc(n));
  return i < COUNT_WORDS.length ? COUNT_WORDS[i] : 'many';
}

/**
 * Assemble a proposal. Property-agnostic by construction: the only inputs are a
 * check kind, a Staxis-defined subject slug, a derivation from the enum, and a
 * count of hotels rendered in words.
 */
export function buildPromotionDraft(
  check: CheckKind,
  subject: string,
  derivation: ThresholdDerivation,
  supportingHotels: number,
): PromotionDraft {
  const signature = candidateSignature(check, subject);
  const subjectSlug = signature.split(':')[1] ?? subject;
  const subjectWords = SUBJECT_WORDS[subjectSlug] ?? 'this activity';

  return {
    topic: `findings_detector:${signature}`,
    claim: `Watch ${subjectWords}: ${WATCHES[check]}.`,
    proposedContent: [
      `WHAT TO WATCH: ${subjectWords} — ${WATCHES[check]}.`,
      '',
      `WHEN TO SPEAK: ${THRESHOLD_DERIVATIONS[derivation]}.`,
      '',
      'HOW THE THRESHOLD IS SET: it is not. Every figure above is derived from the target ' +
      "hotel's own record at the moment the check runs. No value measured at any other hotel " +
      'appears in this check, and it says nothing at a hotel whose own record is too short or ' +
      'too sporadic for the derivation to mean anything.',
      '',
      'RECEIPT: the check must show the derived numbers it used, so a manager can re-check it ' +
      'against their own records without trusting it.',
    ].join('\n'),
    evidenceSummary:
      `Discovered by the weekly findings sweep and reproduced by a deterministic query at ` +
      `${inWords(supportingHotels)} separate hotels on this PMS family. The sweep proposes ` +
      'the check; it never proposes a number.',
  };
}

// ─── Who else has seen this ──────────────────────────────────────────────────

export interface SignatureSupport {
  /** Distinct hotels whose sweeps have reproduced this candidate. */
  propertyIds: string[];
  /** How many sweep runs in total. The observation count on the proposal. */
  runs: number;
}

/**
 * How many DISTINCT hotels have reproduced this candidate.
 *
 * A FLEET-WIDE READ, deliberately not scoped to one hotel — it is the only way
 * to answer "is this one hotel's quirk or a real pattern", which is the exact
 * question the promotion bar asks. It reads two things and nothing else: the
 * property id, and the property-agnostic signature. No hotel's numbers, labels,
 * rooms or items are in either column (see 0362's comment on `signatures`), so
 * the cross-tenant read carries no cross-tenant data.
 */
export async function loadSignatureSupport(signature: string): Promise<SignatureSupport> {
  const { data, error } = await supabaseAdmin
    .from('finding_sweep_runs')
    .select('property_id')
    .overlaps('signatures', [signature])
    .limit(2000);
  if (error) {
    log.warn('[findings] signature support read failed; treating as one hotel only', {
      signature,
      err: error.message,
    });
    return { propertyIds: [], runs: 0 };
  }
  const rows = (data ?? []) as unknown as Array<{ property_id: string }>;
  return { propertyIds: [...new Set(rows.map((r) => r.property_id))], runs: rows.length };
}

/** The PMS family shared by these hotels, or null when they do not share one. */
export async function sharedPmsFamily(propertyIds: readonly string[]): Promise<string | null> {
  if (propertyIds.length === 0) return null;
  const { data, error } = await supabaseAdmin
    .from('properties')
    .select('id, pms_type')
    .in('id', [...propertyIds]);
  if (error) return null;
  const families = new Set(
    ((data ?? []) as Array<{ pms_type: string | null }>).map((r) => r.pms_type ?? ''),
  );
  if (families.size !== 1) return null;
  const only = [...families][0];
  return only.length > 0 ? only : null;
}

// ─── Routing ─────────────────────────────────────────────────────────────────

export type PromotionOutcome =
  /** Fewer than MIN_SUPPORTING_HOTELS hotels, or no shared PMS family. */
  | { decision: 'kept_local'; because: string }
  /** The guard caught hotel-specific content. Nothing was sent. */
  | { decision: 'refused_leak'; violations: AgnosticViolation[] }
  /** The RPC was called. `action` is its own verdict, recorded verbatim. */
  | { decision: 'proposed'; action: ProposeAction; promotionId: string | null; topic: string };

export interface PromotionAttempt {
  check: CheckKind;
  subject: string;
  derivation: ThresholdDerivation;
  signature: string;
  /** The source hotel's identifying strings. Used only by the guard. */
  forbidden: readonly string[];
  /** Injected so tests can drive the routing without a database. */
  support?: SignatureSupport;
  family?: string | null;
}

/**
 * Decide what happens to one reproduced candidate.
 *
 * Order matters: eligibility first (cheap, and most candidates stop here), then
 * the guard, then the RPC. The guard runs on the assembled payload rather than
 * on its inputs, because the thing that must be clean is the thing that gets
 * stored.
 */
export async function routeCandidateToPromotion(
  attempt: PromotionAttempt,
): Promise<PromotionOutcome> {
  const support = attempt.support ?? (await loadSignatureSupport(attempt.signature));
  if (support.propertyIds.length < MIN_SUPPORTING_HOTELS) {
    return {
      decision: 'kept_local',
      because:
        `reproduced at ${support.propertyIds.length} hotel(s); shared knowledge needs ` +
        `${MIN_SUPPORTING_HOTELS}`,
    };
  }

  const family =
    attempt.family !== undefined ? attempt.family : await sharedPmsFamily(support.propertyIds);
  if (!family) {
    return {
      decision: 'kept_local',
      because: 'the hotels that reproduced it do not share a PMS family to promote it into',
    };
  }

  const draft = buildPromotionDraft(
    attempt.check,
    attempt.subject,
    attempt.derivation,
    support.propertyIds.length,
  );

  const violations = propertyAgnosticViolations(
    {
      topic: draft.topic,
      claim: draft.claim,
      proposedContent: draft.proposedContent,
      evidenceSummary: draft.evidenceSummary,
    },
    attempt.forbidden,
  );
  if (violations.length > 0) {
    // Loud. A candidate that got this far and still carries hotel-specific
    // content means the assembly path grew a hole, and that is worth waking up
    // for even though nothing leaked.
    log.error('[findings] promotion refused — candidate carried hotel-specific content', {
      signature: attempt.signature,
      violations: violations.map((v) => `${v.field}:${v.kind}:${v.token}`).join(', '),
    });
    return { decision: 'refused_leak', violations };
  }

  const result = await proposePromotion({
    topic: draft.topic,
    claim: draft.claim,
    proposedContent: draft.proposedContent,
    targetTier: 'family',
    pmsFamily: family,
    // 'learned' is the machine-authored origin — 'authored' means a human wrote
    // it, and claiming that here would let a sweep skip the supporting-hotel bar
    // 0353 enforces for exactly this case.
    origin: 'learned',
    sourceKind: 'findings_sweep',
    sourceTier: 'hotel',
    evidenceSummary: draft.evidenceSummary,
    sourceRef: attempt.signature,
    // Recorded so the founder can audit the privacy cost before approving. It
    // never leaves knowledge_promotions (0353).
    sourcePropertyIds: support.propertyIds,
    supportingHotelCount: support.propertyIds.length,
    observationCount: support.runs,
  });

  return {
    decision: 'proposed',
    action: result.action,
    promotionId: result.id,
    topic: draft.topic,
  };
}
