// ─── Agent reasoner — the ONE LLM chokepoint ────────────────────────────────
// The agent engine reaches the model ONLY through here, and this call ALWAYS
// passes `tools: []`. That is the structural guarantee behind the security
// property "a prompt-injected model can never trigger an agent action": with
// no tools, llm.runAgent's tool loop has nothing to execute, and the mutating
// AgentActionDef.execute() functions are a completely separate registry the
// model never sees. (Guarded by the agents-security-no-tools test.)
//
// Cost: booked via recordNonRequestCost({kind:'background'}) — excluded from
// the per-user request caps, so an automated agent never eats a GM's personal
// AI budget. Bounded by a hard per-run call cap AND a per-property/day ceiling.

import 'server-only';
import { runAgent as runLlmAgent } from '@/lib/agent/llm';
import { recordNonRequestCost } from '@/lib/agent/cost-controls';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import type { AppRole } from '@/lib/roles';

/** Best-effort per-property/day ceiling on agent reasoning spend. Background-
 *  kind cost is excluded from cost-controls' request caps, so the engine
 *  enforces its own. NOTE: this is a non-locking read-then-act check over a
 *  rolling 24h window — under heavy concurrency it can be modestly exceeded.
 *  That's acceptable: summaries are cheap Haiku and fail safe to deterministic
 *  text. It is a guardrail, not a hard transactional cap. */
export const AGENT_LLM_DAILY_USD_PER_PROPERTY = 2;

const AGENT_SYSTEM_STABLE =
  'You are Staxis, writing a short, plain-English receipt of what a hotel ' +
  'operations agent just did. Be concise (1-3 sentences), factual, and never ' +
  'invent actions that are not in the provided step log.';

/** A metered reasoner. Returns null (caller falls back to a deterministic
 *  summary) when there is no cost account, the per-run cap is hit, the
 *  per-property ceiling is reached, or the call fails. */
export type Reasoner = (prompt: string) => Promise<string | null>;

async function propertyAgentSpendTodayUsd(propertyId: string): Promise<number> {
  // Rolling 24h window — a conservative stand-in for "today".
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabaseAdmin
    .from('agent_costs')
    .select('cost_usd')
    .eq('property_id', propertyId)
    .eq('kind', 'background')
    .gte('created_at', since);
  if (error) {
    log.warn('agents/reasoner: spend lookup failed (treating as 0)', { propertyId, msg: error.message });
    return 0;
  }
  return (data ?? []).reduce((s, r) => s + Number((r as { cost_usd?: number }).cost_usd ?? 0), 0);
}

export function makeReasoner(opts: {
  propertyId: string;
  costAccountId: string | null;
  requestId: string;
  maxCalls?: number;
}): Reasoner {
  const maxCalls = opts.maxCalls ?? 1;
  let calls = 0;

  return async (prompt: string): Promise<string | null> => {
    if (!opts.costAccountId) return null;                 // no ledger account → no LLM
    if (calls >= maxCalls) return null;                   // hard per-run cap
    if ((await propertyAgentSpendTodayUsd(opts.propertyId)) >= AGENT_LLM_DAILY_USD_PER_PROPERTY) return null;
    calls += 1;
    try {
      const res = await runLlmAgent({
        systemPrompt: { stable: AGENT_SYSTEM_STABLE, dynamic: '' },
        history: [],
        newUserMessage: prompt,
        tools: [], // SECURITY INVARIANT: the agent reasoner NEVER passes tools.
        toolContext: {
          user: {
            uid: opts.costAccountId,
            accountId: opts.costAccountId,
            username: 'staxis-agent',
            displayName: 'Staxis Agent',
            role: 'admin' as AppRole,
            propertyAccess: [opts.propertyId],
          },
          propertyId: opts.propertyId,
          staffId: null,
          requestId: opts.requestId,
          surface: 'chat',
          dryRun: false,
        },
        model: 'haiku',
      });
      const u = res.usage;
      await recordNonRequestCost({
        userId: opts.costAccountId,
        propertyId: opts.propertyId,
        conversationId: null,
        model: u.model,
        modelId: u.modelId,
        tokensIn: u.inputTokens,
        tokensOut: u.outputTokens,
        cachedInputTokens: u.cachedInputTokens,
        costUsd: u.costUsd,
        kind: 'background',
      }).catch((e) => log.warn('agents/reasoner: cost record failed', { msg: e instanceof Error ? e.message : String(e) }));
      return res.text;
    } catch (e) {
      log.warn('agents/reasoner: LLM call failed (falling back to deterministic summary)', {
        propertyId: opts.propertyId,
        msg: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  };
}
