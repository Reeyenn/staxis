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
import { recordSpend } from './cost-cap.js';
// Pricing math lives in usage-pricing.ts (pure, no Supabase import) so
// unit tests can exercise it without the Node<22 RealtimeClient throw.
import { computeCostMicros, type AnthropicUsage } from './usage-pricing.js';

export { computeCostMicros } from './usage-pricing.js';

interface LogContext {
  workload:
    | 'cua_mapping_login'
    | 'cua_mapping_action'
    | 'cua_mapping_drilldown'
    // feature/cua-column-recovery — the stage-2 detail drill. Keeps the
    // 'cua_mapping_' prefix so checkDailyMappingSpend's `workload like
    // 'cua_mapping%'` filter counts it as mapping spend (and the per-hotel
    // polling cap, which never sees mapper-side calls, stays unaffected).
    | 'cua_mapping_colrecovery'
    | 'cua_critic'
    | 'cua_extraction'
    | 'other';
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
  if (inProc !== undefined) {
    // Refresh recency (delete+re-set moves the key to the tail) so a job that
    // is still being cost-checked can never become the eviction victim — the
    // bounded map evicts the least-recently-touched entry, not the oldest.
    IN_PROC_COST_BY_JOB.delete(jobId);
    IN_PROC_COST_BY_JOB.set(jobId, inProc);
    return inProc;
  }

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
  } catch (err) {
    // Fail-open to 0 so the cost-lookup itself never blocks a job, but
    // make the failure VISIBLE: a throwing DB read here silently disables
    // the per-job cost cap (e.g. after a worker restart wiped the in-proc
    // total), so this must reach Sentry rather than vanish.
    log.error('getJobCostMicros cost read failed — cost cap may be disabled for this job', {
      jobId,
      err: err instanceof Error ? err.message : String(err),
    });
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
      // delete+set (not a bare set on an existing key, which leaves insertion
      // order untouched) so this just-written job moves to the tail — an active
      // job that keeps spending stays the most-recently-touched and is never
      // the eviction victim, so its running total can't be silently truncated.
      IN_PROC_COST_BY_JOB.delete(context.jobId);
      IN_PROC_COST_BY_JOB.set(context.jobId, current + cost);
      // Bounded-size eviction: drop the LEAST-recently-touched entry when over
      // cap. Both get (getJobCostMicros) and set refresh recency via delete+set,
      // so Map insertion order is now LRU order — the first key is the coldest.
      if (IN_PROC_COST_BY_JOB.size > IN_PROC_COST_CAP) {
        const coldest = IN_PROC_COST_BY_JOB.keys().next().value;
        if (coldest !== undefined) IN_PROC_COST_BY_JOB.delete(coldest);
      }
    }

    // Feed the per-hotel $5/day cap. This is the ONE seam every Claude call
    // site already flows through — recordSpend previously had zero live
    // callers, so the cap's tally never incremented and the advertised
    // auto-pause could never trip. Mapping workloads are excluded (the
    // org-wide daily mapping cap covers them); cua_critic rides mapping
    // runs and is bounded by the per-job + org mapping caps instead.
    if (
      context.propertyId &&
      !context.workload.startsWith('cua_mapping') &&
      context.workload !== 'cua_critic'
    ) {
      await recordSpend(context.propertyId, cost, { kind: 'other', note: context.workload });
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
