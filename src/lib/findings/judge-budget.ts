// ─── The background spend cap INV-17 leaves out ──────────────────────────────
//
// WHY THIS FILE EXISTS
// `agent/cost-controls.ts` caps user-facing chat: per user, per hotel, per day,
// atomically, under an advisory lock. It counts ONLY `kind='request'` rows —
// background work (summaries, memory consolidation, and now the judge) is
// excluded ON PURPOSE (INV-17), so a cron can never eat the budget a manager
// needs to ask a question at 6am.
//
// The deliberate consequence is that background work has no ceiling AT ALL. It
// was a fair trade when background work meant a handful of Haiku calls. It stops
// being fair the moment a nightly per-hotel judge exists: a detector bug that
// opens 400 findings, or a retry loop, is now a bill with nothing standing in
// front of it.
//
// So: a small, dedicated cap for the findings layer, sized as a fraction of the
// hotel's existing daily envelope so the two move together. Same reserve →
// finalize/cancel discipline as `reserveCostBudget`, because check-then-write is
// racy and 0081/0082 exist precisely because we learned that the expensive way.
//
// This is the GATE. The BOOKS are still `agent_costs` (kind='background'), which
// the judge writes exactly like every other background caller — so the admin
// spend screens stay complete and nothing has to learn about a second ledger.

import 'server-only';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import { COST_LIMITS } from '@/lib/agent/cost-controls';
import { anthropicTierTokenRates, type AnthropicPricingTier } from '@/lib/ai/feature-registry';

/**
 * The findings layer's share of a hotel's daily AI envelope.
 *
 * DERIVED, not typed out: when the property cap moves, this moves with it. A
 * hard-coded dollar figure here would silently become the wrong fraction the
 * first time someone raised the envelope, and nobody would notice until the
 * judge started failing over to templates on a busy hotel.
 *
 * Ten percent is the shape of the bet: the findings layer is a nightly
 * one-shot, so it should cost roughly nothing next to a day of conversation. If
 * it ever needs more than a tenth, that is a signal about the design, not a
 * number to raise quietly.
 */
export const FINDINGS_BACKGROUND_SHARE = 0.1;

export function findingsPropertyDailyCapUsd(): number {
  return Math.round(COST_LIMITS.propertyDailyUsd * FINDINGS_BACKGROUND_SHARE * 100) / 100;
}

/**
 * Every background caller that draws on this budget, and how much of it each
 * one may exhaust.
 *
 * ═══ WHY ONE POOL NEEDED PRIORITIES ═══
 * The cap is per HOTEL PER DAY and the pool is shared, so the first feature to
 * ask can spend the whole thing. Three callers draw on it — the nightly judge,
 * the morning brief, the weekly sweep — and they are not equally important: the
 * judge is what turns tonight's findings into sentences a manager can read, and
 * the brief is a pleasant rewrite of lines that are already correct without it.
 * A brief that retried through a bad morning could take ten holds and leave the
 * judge on templates that night, which is precisely the wrong thing to lose.
 *
 * So each feature gets a SHARE of the cap as its own ceiling. This is not a
 * separate budget — the sum compared against is still the hotel's whole findings
 * spend for the day — it is a bar the lesser features stop at, leaving the rest
 * for the one that matters. The judge's share is 1: it may use the pool right up
 * to the cap, and nothing may starve it.
 */
export const FEATURE_CAP_SHARE: Readonly<Record<string, number>> = Object.freeze({
  'findings.judge': 1,
  'findings.sweep': 0.6,
  'findings.brief': 0.4,
  // ═══ THE EVENT SWEEP, AND WHY IT DRAWS ON THIS POOL AT ALL ═══
  // It is not a findings caller. It is the companion noticing something the
  // moment it happens (src/lib/companion/event-wake/*). It is here because the
  // hole this file exists to close is not "findings" — it is BACKGROUND WORK
  // WITH NO CEILING, and a second cap system for the second background spender
  // would be two things to reason about where one will do.
  //
  // A TENTH, and it is the smallest share on the table on purpose. This caller
  // fires up to 144 times a day per hotel, against the judge's once. Its whole
  // justification is that it costs approximately nothing, so the number that
  // holds it to that promise is small enough to notice when it is wrong.
  // 0.1 of the findings pool is $0.25 per hotel per day at today's envelope.
  //
  // The dollar cap is the BACKSTOP, not the primary control. The primary
  // control is MAX_WAKES_PER_DAY in event-wake/events.ts, which is free to
  // enforce and bites at roughly a seventh of this number. If this cap is ever
  // the thing stopping a hotel, something upstream is wrong.
  'companion.event_wake': 0.1,
});

/** An unlisted feature gets the brief's share rather than the judge's: a caller
 *  nobody has thought about is by definition not the one to prioritise. */
const DEFAULT_CAP_SHARE = 0.4;

export function featureCapUsd(feature: string): number {
  const share = FEATURE_CAP_SHARE[feature] ?? DEFAULT_CAP_SHARE;
  return Math.round(findingsPropertyDailyCapUsd() * share * 100) / 100;
}

/**
 * How long a hold from each feature may sit unreconciled before it stops
 * counting against the cap.
 *
 * ═══ WHY NOT THE RPC'S 360-MINUTE DEFAULT ═══
 * Nothing was passing the parameter, so every caller inherited six hours. That
 * is a sensible worst case for a job that could genuinely take hours and a bad
 * one for these three, all of which finish in seconds: a judge run that dies
 * mid-call held $0.54 of a $2.50 daily budget until lunchtime, for a call that
 * had already stopped existing. Each window below is generously longer than its
 * caller's own deadline and nothing more.
 *
 * The window is a SAFETY NET, not a cleanup: a hold that is finalized or
 * cancelled stops counting immediately, and this only decides how long a crashed
 * run's hold lingers. `/api/admin/doctor` counts holds that outlive it, so a
 * caller that has started leaking them is visible rather than merely absorbed.
 */
export const FEATURE_ABANDON_MINUTES: Readonly<Record<string, number>> = Object.freeze({
  // A nightly one-shot with a deadline in the tens of seconds.
  'findings.judge': 30,
  // Weekly, samples a few hotels, still one call each.
  'findings.sweep': 60,
  // A manager is waiting on a screen; its own deadline is nine seconds.
  'findings.brief': 10,
  // The sweep runs every ten minutes. A hold from a run that died mid-call must
  // not still be standing two sweeps later, so this is deliberately the
  // shortest window on the table: longer than the call's own deadline and
  // shorter than the gap to the run after next.
  'companion.event_wake': 15,
});

const DEFAULT_ABANDON_MINUTES = 60;

export function featureAbandonMinutes(feature: string): number {
  return FEATURE_ABANDON_MINUTES[feature] ?? DEFAULT_ABANDON_MINUTES;
}

/**
 * How many PROVIDER CALLS one reserved unit of work can turn into.
 *
 * `runAgent` retries a failed or malformed primary against the configured
 * fallback model exactly once, and books the spend of BOTH — a fallback is
 * resilience, not an eraser (llm.ts). One hold covering one call therefore
 * under-reserved by up to half whenever a fallback fired, and the AI Control
 * Center makes that reachable in the worst configuration: an admin who points
 * the judge at Opus with an Opus fallback gets two of the most expensive calls
 * in the product against a hold priced for one.
 *
 * Two, and not "however many the loop might make": these background callers pass
 * no tools, so there are no tool iterations — one primary, at most one fallback,
 * and that is the whole tree.
 */
export const MAX_PROVIDER_ATTEMPTS = 2;

/**
 * Worst-case size of one judge call, used as the hold.
 *
 * The hold has to be bigger than any actual cost or the gate is decoration.
 * Three things could make it too small, and all three are designed out:
 *
 *   • A bigger prompt. The judge's input is bounded by the caller
 *     (MAX_JUDGED_FINDINGS × per-finding payload + the knowledge block), and
 *     that bound is passed in here rather than assumed.
 *   • A more expensive model. The AI Control Center lets an admin point the
 *     judge at any configured model, so the hold is priced at the most
 *     expensive verified Anthropic tier, not at the cheap default. An admin who
 *     switches the judge to Opus does not get a free pass through the cap.
 *   • A fallback. One reservation covers every attempt the runtime may make on
 *     its own — see MAX_PROVIDER_ATTEMPTS.
 */
export function deriveJudgeReservationUsd(opts: {
  maxInputTokens: number;
  maxOutputTokens: number;
}): number {
  return deriveBackgroundReservationUsd({ tier: 'opus', ...opts });
}

/**
 * The same sizing, for any background caller, at whichever tier it can actually
 * reach.
 *
 * `deriveJudgeReservationUsd` above is this function pinned to Opus, and it is
 * pinned to Opus because the AI Control Center lets an admin point the judge at
 * any configured model. A caller whose model is LOCKED does not have that
 * exposure, and pricing its hold at a tier it cannot run on is not caution, it
 * is a hold four times the size of the ceiling it has to fit inside. The tier
 * is therefore a parameter, and the rule is one sentence:
 *
 *   price the hold at the most expensive model this feature can be moved to.
 *
 * A caller that passes a tier cheaper than one its feature can be switched to
 * has broken that rule and under-reserved. `modelSwitchable: false` on the
 * feature is what makes a cheap tier the correct answer rather than a wish.
 */
export function deriveBackgroundReservationUsd(opts: {
  tier: AnthropicPricingTier;
  maxInputTokens: number;
  maxOutputTokens: number;
}): number {
  const rates = anthropicTierTokenRates(opts.tier);
  const perCall =
    (opts.maxInputTokens / 1_000_000) * rates.inputUsdPerMillionTokens +
    (opts.maxOutputTokens / 1_000_000) * rates.outputUsdPerMillionTokens;
  // Round UP to the cent: a hold that rounds down is a hold that is too small.
  return Math.ceil(perCall * MAX_PROVIDER_ATTEMPTS * 100) / 100;
}

export type FindingsSpendReservation =
  | { ok: true; reservationId: string; capUsd: number; spentTodayUsd: number }
  | { ok: false; reason: 'property_daily_cap' | 'unavailable'; capUsd: number; spentTodayUsd: number };

/**
 * Hold `estimatedUsd` against this hotel's findings-AI budget for today.
 *
 * FAILS CLOSED. When the cap system itself is broken we decline the call and
 * fall back to deterministic phrasing — a night of template sentences is a
 * visible, harmless degradation; an uncapped background spender is not.
 */
export async function reserveFindingsSpend(opts: {
  propertyId: string;
  feature?: string;
  estimatedUsd: number;
  capUsd?: number;
}): Promise<FindingsSpendReservation> {
  const feature = opts.feature ?? 'findings.judge';
  // The feature's own ceiling, not the whole pool — so the lesser callers stop
  // short and leave the judge its room. See FEATURE_CAP_SHARE.
  const capUsd = opts.capUsd ?? featureCapUsd(feature);
  const { data, error } = await supabaseAdmin.rpc('staxis_reserve_findings_spend', {
    p_property_id: opts.propertyId,
    p_feature: feature,
    p_estimated_usd: opts.estimatedUsd,
    p_cap_usd: capUsd,
    // Passed EXPLICITLY. The RPC's own default is six hours, which nothing was
    // overriding, so one crashed nightly run held a fifth of a hotel's daily
    // findings budget until the following afternoon.
    p_abandon_after_minutes: featureAbandonMinutes(feature),
  });

  if (error) {
    log.error('[findings] spend reservation failed; declining the call', {
      propertyId: opts.propertyId,
      error: error.message,
    });
    return { ok: false, reason: 'unavailable', capUsd, spentTodayUsd: 0 };
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | { ok?: boolean; reservation_id?: string; property_spend_usd?: number | string }
    | null
    | undefined;
  const spentTodayUsd = Number(row?.property_spend_usd ?? 0) || 0;

  if (!row?.ok || !row.reservation_id) {
    return { ok: false, reason: 'property_daily_cap', capUsd, spentTodayUsd };
  }
  return { ok: true, reservationId: row.reservation_id, capUsd, spentTodayUsd };
}

/** Reconcile a hold to what the provider actually charged. Best-effort: a lost
 *  finalize leaves the worst-case hold standing for the rest of the day, which
 *  errs toward under-spending rather than over-spending. */
export async function finalizeFindingsSpend(opts: {
  reservationId: string;
  actualUsd: number;
  model: string;
  modelId: string | null;
  tokensIn: number;
  tokensOut: number;
}): Promise<void> {
  const { error } = await supabaseAdmin.rpc('staxis_finalize_findings_spend', {
    p_reservation_id: opts.reservationId,
    p_actual_usd: opts.actualUsd,
    p_model: opts.model,
    p_model_id: opts.modelId,
    p_tokens_in: opts.tokensIn,
    p_tokens_out: opts.tokensOut,
  });
  if (error) {
    log.error('[findings] spend finalize failed; the hold stands for today', {
      reservationId: opts.reservationId,
      error: error.message,
    });
  }
}

/** Release a hold without recording spend — the call never reached the provider. */
export async function cancelFindingsSpend(reservationId: string): Promise<void> {
  const { error } = await supabaseAdmin.rpc('staxis_cancel_findings_spend', {
    p_reservation_id: reservationId,
  });
  if (error) {
    log.error('[findings] spend cancel failed; the hold stands for today', {
      reservationId,
      error: error.message,
    });
  }
}
