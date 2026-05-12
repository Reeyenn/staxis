/**
 * Claude API usage logger.
 *
 * After every Anthropic API call in this worker we record token counts
 * + estimated cost into `claude_usage_log` so the admin Money tab can
 * roll up "what did Claude cost us this month, per hotel?"
 *
 * Cost is in micro-dollars (1e-6 USD) so a single $0.0003 call doesn't
 * round to zero. The Money tab divides by 10,000 to get cents.
 *
 * Failures are logged but never thrown — usage logging must NEVER break
 * a CUA mapping run.
 */

import { supabase } from './supabase.js';
import { log } from './log.js';

// Sonnet 4 / 4.5 / 4.6 pricing (per Anthropic public price list, USD per
// million tokens). Update if/when we change CLAUDE_MODEL.
const PRICE_PER_1M_TOKENS = {
  'claude-sonnet-4-6': {
    input: 3,
    output: 15,
    cacheWrite5m: 3.75,
    cacheRead: 0.30,
  },
  'claude-sonnet-4-5': {
    input: 3,
    output: 15,
    cacheWrite5m: 3.75,
    cacheRead: 0.30,
  },
  'claude-opus-4-7': {
    input: 15,
    output: 75,
    cacheWrite5m: 18.75,
    cacheRead: 1.50,
  },
} as const;

type ModelId = keyof typeof PRICE_PER_1M_TOKENS;

interface AnthropicUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

interface LogContext {
  workload: 'cua_mapping_login' | 'cua_mapping_action' | 'cua_extraction' | 'other';
  model: string;
  propertyId?: string | null;
  jobId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * In-process running total of Claude spend per job_id.
 *
 * Why: getJobCostMicros() queries claude_usage_log to compute cumulative
 * spend, but logClaudeUsage is fire-and-forget (`void logClaudeUsage(...)`).
 * The row may not be committed by the time the NEXT phase queries. Two
 * concurrent phases starting at the same instant could both see 0 spend
 * and pass the cap check, then both burn $2.40 — net $4.80 before the
 * next phase catches it.
 *
 * This map gives us a tight, lag-free running total inside a single
 * Node process (each Fly.io CUA worker is one process). getJobCostMicros
 * checks this map FIRST and falls back to the DB only if a process
 * restart wiped the in-memory state.
 *
 * Capped at 1000 entries with LRU eviction to bound memory; an
 * onboarding job lives a few minutes so eviction would only happen
 * after a very long-running worker that's seen 1000+ jobs.
 */
const IN_PROC_COST_BY_JOB = new Map<string, number>();
const IN_PROC_COST_CAP = 1000;

/**
 * Compute cost in micro-dollars from a usage object.
 * 1 micro-dollar = $0.000001 = 0.0001 cents.
 */
function computeCostMicros(usage: AnthropicUsage, model: string): number {
  const prices = PRICE_PER_1M_TOKENS[model as ModelId];
  if (!prices) return 0;

  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;

  // micro-dollars = (tokens / 1_000_000) * price_per_1M * 1_000_000
  //               = tokens * price_per_1M
  const total =
    input * prices.input +
    output * prices.output +
    cacheWrite * prices.cacheWrite5m +
    cacheRead * prices.cacheRead;

  return Math.round(total);
}

/**
 * Sum cost_micros for a given job. Checks the in-process map FIRST
 * (zero-lag, no DB round-trip) and falls back to the DB only when the
 * in-memory state is unknown (worker restart since the job started).
 *
 * May 2026 audit pass-4: the previous version queried only the DB,
 * which had two race windows: (1) logClaudeUsage is fire-and-forget,
 * so the row may not be committed before the next check; (2) two
 * concurrent phases could both query and see stale-zero. The
 * in-process map closes both windows.
 *
 * Returns 0 on any error (fail-open — never block a job because the
 * cost-lookup itself failed).
 */
export async function getJobCostMicros(jobId: string): Promise<number> {
  // Fast path: in-process state is authoritative when present.
  const inProc = IN_PROC_COST_BY_JOB.get(jobId);
  if (inProc !== undefined) return inProc;

  // Fallback: DB read. Used only when the worker restarted between
  // logClaudeUsage and the next checkBudget — rare but possible on
  // Fly.io worker rescheduling.
  try {
    const { data, error } = await supabase
      .from('claude_usage_log')
      .select('cost_micros')
      .eq('job_id', jobId);
    if (error || !data) return 0;
    let total = 0;
    for (const row of data) {
      total += Number((row as { cost_micros?: number }).cost_micros ?? 0);
    }
    // Seed the in-process map so subsequent calls hit the fast path.
    IN_PROC_COST_BY_JOB.set(jobId, total);
    return total;
  } catch {
    return 0;
  }
}

export async function logClaudeUsage(usage: AnthropicUsage, context: LogContext): Promise<void> {
  try {
    const cost = computeCostMicros(usage, context.model);

    // Update the in-process running total IMMEDIATELY (before the DB
    // round-trip). The cost-cap check downstream sees this without lag.
    if (context.jobId) {
      const current = IN_PROC_COST_BY_JOB.get(context.jobId) ?? 0;
      IN_PROC_COST_BY_JOB.set(context.jobId, current + cost);
      // Bounded-size eviction: drop the oldest entry when over cap.
      // Maps preserve insertion order, so the first key is the oldest.
      if (IN_PROC_COST_BY_JOB.size > IN_PROC_COST_CAP) {
        const oldest = IN_PROC_COST_BY_JOB.keys().next().value;
        if (oldest !== undefined) IN_PROC_COST_BY_JOB.delete(oldest);
      }
    }

    const { error } = await supabase.from('claude_usage_log').insert({
      property_id: context.propertyId ?? null,
      workload: context.workload,
      model: context.model,
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_read_tokens: usage.cache_read_input_tokens ?? 0,
      cache_write_tokens: usage.cache_creation_input_tokens ?? 0,
      cost_micros: cost,
      job_id: context.jobId ?? null,
      metadata: context.metadata ?? {},
    });
    if (error) {
      log.warn('claude_usage_log insert failed', { msg: error.message });
    }
  } catch (err) {
    log.warn('claude_usage_log threw', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
