// ─── Cost controls + rate limiting (atomic reservation pattern) ──────────
// Codex review (2026-05-13) flagged the previous check-then-write pattern
// as racy — 20 concurrent requests could each read the same pre-write
// ledger and all pass. Fix: reserve estimated spend INSIDE a Postgres
// advisory lock (RPC `staxis_reserve_agent_spend`), then reconcile to
// actual spend when the stream completes (`staxis_finalize_agent_spend`)
// or release the hold on abort (`staxis_cancel_agent_spend`).
//
// Caller pattern at /api/agent/command:
//
//   const r = await reserveCostBudget({ userId, propertyId });
//   if (!r.ok) return 429;
//   try {
//     // ... run the stream ...
//     await finalizeCostReservation({ id: r.reservationId, actualUsd, ... });
//   } catch {
//     await cancelCostReservation(r.reservationId);
//     throw;
//   }
//
// The rate-limit check stays in JS (a separate query) but is paired with
// the reservation so a misbehaving client can't burn budget without also
// being rate-limited.

import { supabaseAdmin } from '@/lib/supabase-admin';
import { MAX_OUTPUT_TOKENS, MAX_TOOL_ITERATIONS, PRICING } from './llm';

// ─── Reservation sizing (Codex review fix H1 + round-5 R3) ────────────────
// The cost gate is only safe if the reservation is bigger than the
// worst-case actual cost.
//
// Output bound: every iteration can emit MAX_OUTPUT_TOKENS at Sonnet's
// output price; 8 × 8192 × $15/M = $0.983.
//
// Input bound (Codex round-5 R3): tool_result content is now truncated
// to MAX_TOOL_RESULT_CHARS (6000) in llm.ts, which caps the per-iteration
// history growth. Per-iter fresh input ≈ initial-context + growing
// truncated-tool-results. Across 8 iters this sums to ~200K-250K
// tokens × $3/M ≈ $0.60-$0.75 worst-case input.
//
// We pick $1.00 headroom for a comfortable buffer above that ceiling.
// If MAX_TOOL_RESULT_CHARS or MAX_TOOL_ITERATIONS bump materially,
// re-derive the bound here.
const WORST_CASE_OUTPUT_USD =
  (MAX_OUTPUT_TOKENS / 1_000_000) * PRICING.sonnet.output * MAX_TOOL_ITERATIONS;
const INPUT_HEADROOM_USD = 1.00;
const ESTIMATED_REQUEST_USD =
  Math.ceil((WORST_CASE_OUTPUT_USD + INPUT_HEADROOM_USD) * 100) / 100;

// ─── Configurable limits ──────────────────────────────────────────────────

export const COST_LIMITS = {
  userDailyUsd:     10,
  propertyDailyUsd: 50,
  globalDailyUsd:   500,
  userRateLimitPerMin: 10,
  // Worst-case per-request reservation, derived from MAX_OUTPUT_TOKENS and
  // MAX_TOOL_ITERATIONS. Reconciled to actual on finalize. Codex fix H1.
  estimatedRequestUsd: ESTIMATED_REQUEST_USD,
} as const;

// ─── Public types ─────────────────────────────────────────────────────────

export type ReserveResult =
  | { ok: true; reservationId: string }
  | { ok: false; reason: 'user_cap' | 'property_cap' | 'global_cap' | 'rate_limit'; message: string };

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Atomically check all caps and reserve estimated budget. Call this at
 * the top of /api/agent/command. The reservation row is part of the
 * `agent_costs` ledger so subsequent cap-check sums see it.
 *
 * Two-step gate:
 *   1. Rate limit (JS-side count over agent_messages) — fast reject for
 *      bad-faith clients before we touch the lock.
 *   2. Dollar caps via the RPC under advisory lock.
 */
export async function reserveCostBudget(opts: {
  userId: string;
  propertyId: string;
}): Promise<ReserveResult> {
  // Rate-limit check first. The query joins agent_messages → agent_conversations
  // by user_id — index `agent_conversations_user_updated_idx` (0079) covers
  // the user_id side and the FK on agent_messages.conversation_id covers
  // the join. At 10 msgs/min/user this is well under the per-user query
  // cost ceiling.
  const recentCount = await countRecentUserMessages(opts.userId);
  if (recentCount >= COST_LIMITS.userRateLimitPerMin) {
    return {
      ok: false,
      reason: 'rate_limit',
      message: `Slow down — you've sent ${recentCount} messages in the last minute. Try again in a few seconds.`,
    };
  }

  // Now the atomic dollar-cap reservation. The RPC takes an advisory
  // lock keyed on user_id so concurrent requests for the same user
  // serialize on this check.
  const { data, error } = await supabaseAdmin.rpc('staxis_reserve_agent_spend', {
    p_user_id: opts.userId,
    p_property_id: opts.propertyId,
    p_estimated_usd: COST_LIMITS.estimatedRequestUsd,
    p_user_cap_usd: COST_LIMITS.userDailyUsd,
    p_property_cap_usd: COST_LIMITS.propertyDailyUsd,
    p_global_cap_usd: COST_LIMITS.globalDailyUsd,
  });

  if (error) {
    console.error('[cost-controls] reserve RPC failed', error);
    // Fail closed — when the cap system is broken we'd rather block users
    // than risk uncapped spend.
    return {
      ok: false,
      reason: 'global_cap',
      message: 'The cost-control system is temporarily unavailable. Try again in a moment.',
    };
  }

  // RPC returns table(ok, reservation_id, reason, user_spend, property_spend, global_spend)
  // — supabase-js gives us an array.
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || !row.ok) {
    const reason = (row?.reason as 'user_cap' | 'property_cap' | 'global_cap') ?? 'global_cap';
    return { ok: false, reason, message: capMessage(reason) };
  }

  return { ok: true, reservationId: row.reservation_id as string };
}

/**
 * Reconcile the reservation to actual cost + telemetry. Call after the
 * stream emits its `done` event.
 */
export async function finalizeCostReservation(opts: {
  reservationId: string;
  conversationId: string;
  actualUsd: number;
  model: string;
  /** Exact Anthropic snapshot ID from response.model. Captured for
   *  audit + before-after comparison when Anthropic ships model
   *  snapshot updates. Codex review fix S5. */
  modelId: string | null;
  tokensIn: number;
  tokensOut: number;
  cachedInputTokens?: number;
}): Promise<void> {
  const { error } = await supabaseAdmin.rpc('staxis_finalize_agent_spend', {
    p_reservation_id: opts.reservationId,
    p_conversation_id: opts.conversationId,
    p_actual_usd: opts.actualUsd,
    p_model: opts.model,
    p_model_id: opts.modelId,
    p_tokens_in: opts.tokensIn,
    p_tokens_out: opts.tokensOut,
    p_cached_input_tokens: opts.cachedInputTokens ?? 0,
  });
  if (error) {
    // Codex review fix M1, 2026-05-13: previously this just logged and
    // returned, which left the reservation row stuck in 'reserved' state.
    // Metrics filters by state='finalized', so the failed finalize was
    // invisible. AND the reservation kept inflating cap checks.
    //
    // Now: throw so the route's finally block catches it. The route logs
    // critically + attempts a cancel (release the budget hold). The user
    // has already received their response (done event was emitted before
    // the finally ran), so we're only losing the actual cost record — a
    // known trade-off versus permanently stranded reservations.
    console.error('[cost-controls] finalize RPC failed; throwing so route can cancel reservation', error);
    throw new Error(`finalize RPC failed: ${error.message}`);
  }
}

/**
 * Release the budget hold without recording any spend. Call when the
 * stream aborts before any tokens are consumed (early validation error,
 * client disconnect before LLM call, etc.).
 *
 * If actual tokens WERE consumed, prefer finalizeCostReservation instead
 * so the spend gets recorded honestly.
 */
export async function cancelCostReservation(reservationId: string): Promise<void> {
  const { error } = await supabaseAdmin.rpc('staxis_cancel_agent_spend', {
    p_reservation_id: reservationId,
  });
  if (error) {
    console.error('[cost-controls] cancel RPC failed', error);
  }
}

/**
 * Record a non-request cost (eg eval runs, background tasks). These don't
 * go through the reservation flow because they're not user-driven and
 * shouldn't count against per-user caps. Still writes to agent_costs so
 * the monitoring page sees them.
 */
export async function recordNonRequestCost(opts: {
  userId: string;
  propertyId: string;
  conversationId: string | null;
  model: string;
  tokensIn: number;
  tokensOut: number;
  cachedInputTokens?: number;
  costUsd: number;
  kind: 'eval' | 'background';
}): Promise<void> {
  if (opts.costUsd <= 0) return;
  const { error } = await supabaseAdmin.from('agent_costs').insert({
    user_id: opts.userId,
    property_id: opts.propertyId,
    conversation_id: opts.conversationId,
    model: opts.model,
    tokens_in: opts.tokensIn,
    tokens_out: opts.tokensOut,
    cached_input_tokens: opts.cachedInputTokens ?? 0,
    cost_usd: opts.costUsd,
    kind: opts.kind,
    state: 'finalized',
  });
  if (error) {
    console.error('[cost-controls] non-request cost insert failed', error);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function capMessage(reason: 'user_cap' | 'property_cap' | 'global_cap'): string {
  switch (reason) {
    case 'user_cap':
      return `You've hit your daily AI usage cap ($${COST_LIMITS.userDailyUsd}). Try again tomorrow, or ask an admin to raise the limit.`;
    case 'property_cap':
      return `This property has hit its daily AI usage cap ($${COST_LIMITS.propertyDailyUsd}). Ask the owner to raise the limit or wait until tomorrow.`;
    case 'global_cap':
      return 'The system-wide AI usage cap was hit for today. Staxis support has been notified.';
  }
}

async function countRecentUserMessages(userId: string): Promise<number> {
  const since = new Date(Date.now() - 60 * 1000).toISOString();
  const { count, error } = await supabaseAdmin
    .from('agent_messages')
    .select('id, conversation_id, agent_conversations!inner(user_id)', {
      count: 'exact',
      head: true,
    })
    .eq('role', 'user')
    .eq('agent_conversations.user_id', userId)
    .gte('created_at', since);
  if (error) {
    console.error('[cost-controls] countRecentUserMessages failed', error);
    return 0;
  }
  return count ?? 0;
}
