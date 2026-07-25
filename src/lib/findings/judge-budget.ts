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
import { anthropicTierTokenRates } from '@/lib/ai/feature-registry';

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
 * Worst-case size of one judge call, used as the hold.
 *
 * The hold has to be bigger than any actual cost or the gate is decoration. Two
 * things could make it too small, and both are designed out:
 *
 *   • A bigger prompt. The judge's input is bounded by the caller
 *     (MAX_JUDGED_FINDINGS × per-finding payload + the knowledge block), and
 *     that bound is passed in here rather than assumed.
 *   • A more expensive model. The AI Control Center lets an admin point the
 *     judge at any configured model, so the hold is priced at the most
 *     expensive verified Anthropic tier, not at the cheap default. An admin who
 *     switches the judge to Opus does not get a free pass through the cap.
 */
export function deriveJudgeReservationUsd(opts: {
  maxInputTokens: number;
  maxOutputTokens: number;
}): number {
  const rates = anthropicTierTokenRates('opus');
  const usd =
    (opts.maxInputTokens / 1_000_000) * rates.inputUsdPerMillionTokens +
    (opts.maxOutputTokens / 1_000_000) * rates.outputUsdPerMillionTokens;
  // Round UP to the cent: a hold that rounds down is a hold that is too small.
  return Math.ceil(usd * 100) / 100;
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
  const capUsd = opts.capUsd ?? findingsPropertyDailyCapUsd();
  const { data, error } = await supabaseAdmin.rpc('staxis_reserve_findings_spend', {
    p_property_id: opts.propertyId,
    p_feature: opts.feature ?? 'findings.judge',
    p_estimated_usd: opts.estimatedUsd,
    p_cap_usd: capUsd,
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
