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

export async function logClaudeUsage(usage: AnthropicUsage, context: LogContext): Promise<void> {
  try {
    const cost = computeCostMicros(usage, context.model);
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
