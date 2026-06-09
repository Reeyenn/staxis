/**
 * Pure pricing math for Claude API usage — split out of usage-log.ts so
 * unit tests can import it without dragging in the Supabase singleton
 * (whose RealtimeClient throws at module load on Node < 22 without a
 * `ws` transport — same constraint documented in auth-code-helpers.ts).
 *
 * Pricing per Anthropic public price list, USD per million tokens.
 * Verified against platform.claude.com 2026-06-09. Update when we change
 * CLAUDE_MODEL — and note computeCostMicros falls back to the MOST
 * EXPENSIVE row for unknown models, so a missing entry over-counts
 * (caps trip early) instead of counting $0 (caps go blind — the bug
 * this table shipped with: opus-4-7 was priced 3x high at $15/$75, and
 * any unlisted model cost "$0").
 */

import { log } from './log.js';

export const PRICE_PER_1M_TOKENS = {
  'claude-fable-5': {
    input: 10,
    output: 50,
    cacheWrite5m: 12.50,
    cacheRead: 1.00,
  },
  'claude-opus-4-8': {
    input: 5,
    output: 25,
    cacheWrite5m: 6.25,
    cacheRead: 0.50,
  },
  'claude-opus-4-7': {
    input: 5,
    output: 25,
    cacheWrite5m: 6.25,
    cacheRead: 0.50,
  },
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
} as const;

type ModelId = keyof typeof PRICE_PER_1M_TOKENS;

// Fail-safe rates for models not in the table: assume the most expensive
// known model so the cost caps stay fail-closed. A $0 fallback would let
// a model rename/upgrade spend without ANY cap ever tripping.
const FALLBACK_PRICES = PRICE_PER_1M_TOKENS['claude-fable-5'];

// Warn once per unknown model id, not once per API call.
const warnedUnknownModels = new Set<string>();

export interface AnthropicUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/**
 * Compute cost in micro-dollars from a usage object.
 * 1 micro-dollar = $0.000001 = 0.0001 cents.
 */
export function computeCostMicros(usage: AnthropicUsage, model: string): number {
  let prices = PRICE_PER_1M_TOKENS[model as ModelId];
  if (!prices) {
    if (!warnedUnknownModels.has(model)) {
      warnedUnknownModels.add(model);
      log.warn('usage-pricing: model missing from PRICE_PER_1M_TOKENS — billing at fail-safe (most expensive) rates', {
        model,
      });
    }
    prices = FALLBACK_PRICES;
  }

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
