import type { AiModelRef } from './types';
import { estimateAiCostUsd } from './runtime';

/** Billable usage from one provider attempt. A failed primary is retained so
 * fallback success cannot hide spend that the provider already charged. */
export interface AiUsageAttempt {
  /** Total provider input = uncached + cache creation + cache read. */
  inputTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  /** Cache hits/reads (persisted in agent_costs.cached_input_tokens). */
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  cacheCreation5mInputTokens: number;
  cacheCreation1hInputTokens: number;
  costUsd: number;
  model: string;
  modelId: string | null;
}

export interface AiUsageReport extends AiUsageAttempt {
  attempts: AiUsageAttempt[];
}

/** Ledger attribution for runtime-owned cost recording. When passed through
 * to executeAiFeature/executeAiPlan, the runtime records every billable
 * attempt to agent_costs itself — call-sites cannot forget to meter. */
export interface AiLedgerContext {
  userId: string;
  propertyId: string;
  kind?: 'background' | 'audio' | 'vision';
  requestId?: string;
  /** Defaults to the executed plan's feature key. */
  feature?: string;
}

export interface AiCallOptions {
  deadlineAt?: number;
  abortSignal?: AbortSignal;
  /** Called once per runtime execution with that execution's aggregated
   * usage. Helpers that run several executions per public call re-aggregate
   * with mergeAiUsage before reporting upward. */
  onUsage?: (usage: AiUsageReport) => void;
  ledger?: AiLedgerContext;
}

function finiteNonnegative(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export interface AnthropicUsageLike {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_creation?: {
    ephemeral_5m_input_tokens?: unknown;
    ephemeral_1h_input_tokens?: unknown;
  } | null;
}

export interface NormalizedAnthropicUsage {
  /** Sum of every input class; this is the value written to tokens_in. */
  inputTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  cacheCreation5mInputTokens: number;
  cacheCreation1hInputTokens: number;
}

/** Anthropic reports base input, cache writes, and cache reads as disjoint
 * counters. Normalize them once so callers cannot accidentally subtract cache
 * hits from input_tokens or omit billable cache creation. */
export function normalizeAnthropicUsage(
  usage: AnthropicUsageLike | null | undefined,
): NormalizedAnthropicUsage {
  const uncachedInputTokens = finiteNonnegative(usage?.input_tokens);
  const outputTokens = finiteNonnegative(usage?.output_tokens);
  const cachedInputTokens = finiteNonnegative(usage?.cache_read_input_tokens);
  const reportedCreation = finiteNonnegative(usage?.cache_creation_input_tokens);
  const cacheCreation5mInputTokens = finiteNonnegative(
    usage?.cache_creation?.ephemeral_5m_input_tokens,
  );
  const cacheCreation1hInputTokens = finiteNonnegative(
    usage?.cache_creation?.ephemeral_1h_input_tokens,
  );
  const cacheCreationInputTokens = Math.max(
    reportedCreation,
    cacheCreation5mInputTokens + cacheCreation1hInputTokens,
  );
  return {
    inputTokens: uncachedInputTokens + cacheCreationInputTokens + cachedInputTokens,
    uncachedInputTokens,
    outputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    cacheCreation5mInputTokens,
    cacheCreation1hInputTokens,
  };
}

export function captureTokenUsage(
  attempts: AiUsageAttempt[],
  selected: AiModelRef,
  responseModel: string | null | undefined,
  usage: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
    cache_creation?: {
      ephemeral_5m_input_tokens?: unknown;
      ephemeral_1h_input_tokens?: unknown;
    } | null;
  } | null | undefined,
): void {
  if (!selected.pricing) throw new Error(`Missing pricing for ${selected.provider}/${selected.modelId}`);
  const normalized = normalizeAnthropicUsage(usage);
  attempts.push({
    ...normalized,
    costUsd: estimateAiCostUsd(selected.pricing, {
      uncachedInputTokens: normalized.uncachedInputTokens,
      outputTokens: normalized.outputTokens,
      cacheReadInputTokens: normalized.cachedInputTokens,
      cacheCreationInputTokens: normalized.cacheCreationInputTokens,
      cacheCreation5mInputTokens: normalized.cacheCreation5mInputTokens,
      cacheCreation1hInputTokens: normalized.cacheCreation1hInputTokens,
    }),
    model: selected.modelId,
    modelId: responseModel ?? null,
  });
}

export function capturePricedUsage(
  attempts: AiUsageAttempt[],
  usage: Pick<AiUsageAttempt, 'inputTokens' | 'outputTokens' | 'costUsd' | 'model' | 'modelId'>
    & Partial<Pick<AiUsageAttempt,
      | 'uncachedInputTokens'
      | 'cachedInputTokens'
      | 'cacheCreationInputTokens'
      | 'cacheCreation5mInputTokens'
      | 'cacheCreation1hInputTokens'>>,
): void {
  const inputTokens = finiteNonnegative(usage.inputTokens);
  const cachedInputTokens = finiteNonnegative(usage.cachedInputTokens);
  const cacheCreationInputTokens = finiteNonnegative(usage.cacheCreationInputTokens);
  attempts.push({
    ...usage,
    inputTokens,
    uncachedInputTokens: usage.uncachedInputTokens === undefined
      ? Math.max(0, inputTokens - cachedInputTokens - cacheCreationInputTokens)
      : finiteNonnegative(usage.uncachedInputTokens),
    outputTokens: finiteNonnegative(usage.outputTokens),
    cachedInputTokens,
    cacheCreationInputTokens,
    cacheCreation5mInputTokens: finiteNonnegative(usage.cacheCreation5mInputTokens),
    cacheCreation1hInputTokens: finiteNonnegative(usage.cacheCreation1hInputTokens),
    costUsd: finiteNonnegative(usage.costUsd),
  });
}

export function aggregateAiUsage(attempts: AiUsageAttempt[]): AiUsageReport | null {
  if (attempts.length === 0) return null;
  const last = attempts[attempts.length - 1];
  return {
    inputTokens: attempts.reduce((sum, usage) => sum + usage.inputTokens, 0),
    uncachedInputTokens: attempts.reduce((sum, usage) => sum + usage.uncachedInputTokens, 0),
    outputTokens: attempts.reduce((sum, usage) => sum + usage.outputTokens, 0),
    cachedInputTokens: attempts.reduce((sum, usage) => sum + usage.cachedInputTokens, 0),
    cacheCreationInputTokens: attempts.reduce((sum, usage) => sum + usage.cacheCreationInputTokens, 0),
    cacheCreation5mInputTokens: attempts.reduce((sum, usage) => sum + usage.cacheCreation5mInputTokens, 0),
    cacheCreation1hInputTokens: attempts.reduce((sum, usage) => sum + usage.cacheCreation1hInputTokens, 0),
    costUsd: attempts.reduce((sum, usage) => sum + usage.costUsd, 0),
    model: last.model,
    modelId: last.modelId,
    attempts: attempts.map((attempt) => ({ ...attempt })),
  };
}

export function mergeAiUsage(
  current: AiUsageReport | null,
  next: AiUsageReport,
): AiUsageReport {
  return aggregateAiUsage([...(current?.attempts ?? []), ...next.attempts])!;
}

export function emitAiUsage(
  attempts: AiUsageAttempt[],
  onUsage?: (usage: AiUsageReport) => void,
): void {
  if (!onUsage) return;
  const usage = aggregateAiUsage(attempts);
  if (usage) onUsage(usage);
}
