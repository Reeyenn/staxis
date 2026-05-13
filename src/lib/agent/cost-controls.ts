// ─── Cost controls + rate limiting ────────────────────────────────────────
// Called before every LLM invocation. Reads the agent_costs ledger to
// enforce three concentric caps:
//
//   PER USER:     $10/day   — block + tell user they hit their limit
//   PER PROPERTY: $50/day   — block + tell user property cap hit
//   GLOBAL:       $500/day  — block + alert Reeyen (oncall-style)
//
// Plus a simple rate limit: 10 messages/min/user. Catches runaway loops
// that race past the dollar caps in seconds.
//
// All limits are configurable below — bump them as we get real usage data.

import { supabaseAdmin } from '@/lib/supabase-admin';

// ─── Configurable limits ──────────────────────────────────────────────────

export const COST_LIMITS = {
  userDailyUsd:     10,
  propertyDailyUsd: 50,
  globalDailyUsd:   500,
  userRateLimitPerMin: 10,
} as const;

// ─── Result types ─────────────────────────────────────────────────────────

export type CostCheckResult =
  | { ok: true; remaining: { userUsd: number; propertyUsd: number; globalUsd: number } }
  | { ok: false; reason: 'user_cap' | 'property_cap' | 'global_cap' | 'rate_limit'; message: string };

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Check ALL caps before running the LLM. Call this at the top of
 * /api/agent/command. Returns ok=false with a message to surface to the
 * user when any cap is hit.
 */
export async function checkCostCaps(opts: {
  userId: string;
  propertyId: string;
}): Promise<CostCheckResult> {
  // Run all three sums in parallel — they're independent queries.
  const [userSpend, propertySpend, globalSpend, recentMessages] = await Promise.all([
    sumSpendSince(opts.userId, 'user', dayStart()),
    sumSpendSince(opts.propertyId, 'property', dayStart()),
    sumSpendSince(null, 'global', dayStart()),
    countMessagesSince(opts.userId, oneMinuteAgo()),
  ]);

  if (recentMessages >= COST_LIMITS.userRateLimitPerMin) {
    return {
      ok: false,
      reason: 'rate_limit',
      message: `Slow down — you've sent ${recentMessages} messages in the last minute. Try again in a few seconds.`,
    };
  }
  if (userSpend >= COST_LIMITS.userDailyUsd) {
    return {
      ok: false,
      reason: 'user_cap',
      message: `You've hit your daily AI usage cap ($${COST_LIMITS.userDailyUsd}). Try again tomorrow, or ask an admin to raise the limit.`,
    };
  }
  if (propertySpend >= COST_LIMITS.propertyDailyUsd) {
    return {
      ok: false,
      reason: 'property_cap',
      message: `This property has hit its daily AI usage cap ($${COST_LIMITS.propertyDailyUsd}). Ask the owner to raise the limit or wait until tomorrow.`,
    };
  }
  if (globalSpend >= COST_LIMITS.globalDailyUsd) {
    return {
      ok: false,
      reason: 'global_cap',
      message: 'The system-wide AI usage cap was hit for today. Staxis support has been notified.',
    };
  }

  return {
    ok: true,
    remaining: {
      userUsd:     COST_LIMITS.userDailyUsd     - userSpend,
      propertyUsd: COST_LIMITS.propertyDailyUsd - propertySpend,
      globalUsd:   COST_LIMITS.globalDailyUsd   - globalSpend,
    },
  };
}

/**
 * Record a request's full cost to the agent_costs ledger. Call this after
 * the stream completes (or fails) so the next check sees this request.
 */
export async function recordCost(opts: {
  userId: string;
  propertyId: string;
  conversationId: string | null;
  model: string;
  tokensIn: number;
  tokensOut: number;
  cachedInputTokens?: number;
  costUsd: number;
  kind?: 'request' | 'eval' | 'background';
}): Promise<void> {
  if (opts.costUsd <= 0) return; // nothing to record
  const { error } = await supabaseAdmin.from('agent_costs').insert({
    user_id: opts.userId,
    property_id: opts.propertyId,
    conversation_id: opts.conversationId,
    model: opts.model,
    tokens_in: opts.tokensIn,
    tokens_out: opts.tokensOut,
    cached_input_tokens: opts.cachedInputTokens ?? 0,
    cost_usd: opts.costUsd,
    kind: opts.kind ?? 'request',
  });
  if (error) {
    console.error('[cost-controls] failed to record cost', error);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function dayStart(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function oneMinuteAgo(): string {
  return new Date(Date.now() - 60 * 1000).toISOString();
}

async function sumSpendSince(
  id: string | null,
  scope: 'user' | 'property' | 'global',
  since: string,
): Promise<number> {
  let q = supabaseAdmin
    .from('agent_costs')
    .select('cost_usd')
    .eq('kind', 'request')
    .gte('created_at', since);
  if (scope === 'user' && id) q = q.eq('user_id', id);
  else if (scope === 'property' && id) q = q.eq('property_id', id);
  // 'global' has no extra filter.
  const { data, error } = await q;
  if (error) {
    console.error('[cost-controls] sumSpendSince failed', error);
    return 0;
  }
  return (data ?? []).reduce((acc, r) => acc + Number(r.cost_usd ?? 0), 0);
}

async function countMessagesSince(userId: string, since: string): Promise<number> {
  // Count user-role messages from this account in the window.
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
    console.error('[cost-controls] countMessagesSince failed', error);
    return 0;
  }
  return count ?? 0;
}
