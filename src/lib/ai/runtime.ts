import type {
  AiFeatureKey,
  AiModelPricing,
  AiProvider,
  ResolvedAiFeatureConfig,
} from '@/lib/ai/types';
import { getAiFeatureDefinition } from '@/lib/ai/feature-registry';
import { resolveAiFeatureConfig } from '@/lib/ai/model-config-store';

type ResolvedModel = ResolvedAiFeatureConfig['primary'];

export class AiFeatureDisabledError extends Error {
  constructor(public readonly featureKey: AiFeatureKey) {
    super(`AI feature "${featureKey}" is disabled`);
    this.name = 'AiFeatureDisabledError';
  }
}

export class AiFeatureModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiFeatureModelError';
  }
}

export interface AiExecutionPlan {
  config: ResolvedAiFeatureConfig;
  primary: ResolvedModel;
  fallback: ResolvedModel | null;
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // Anthropic wraps BOTH AbortSignal.timeout() and caller cancellation in an
  // APIUserAbortError with the same "Request was aborted" message. The caller
  // signal supplied separately to shouldRetryAiFallback is the only reliable
  // discriminator for that wrapper. A raw AbortError remains terminal for
  // direct callers that do not pass a separate signal.
  if (error.name === 'TimeoutError' || error.name === 'APIUserAbortError') return false;
  return error.name === 'AbortError';
}

export function shouldRetryAiFallback(opts: {
  fallbackAvailable: boolean;
  aborted: boolean;
  emittedToUser: boolean;
  error: unknown;
}): boolean {
  return opts.fallbackAvailable && !opts.aborted && !opts.emittedToUser && !isAbortError(opts.error);
}

function assertTarget(
  featureKey: AiFeatureKey,
  target: ResolvedModel,
  provider: AiProvider,
  requirePricing: boolean,
): void {
  if (target.provider !== provider) {
    throw new AiFeatureModelError(
      `AI feature "${featureKey}" selected ${target.provider}/${target.modelId}, ` +
      `but this runtime supports ${provider} models only`,
    );
  }
  if (
    requirePricing &&
    (!target.pricing ||
      typeof target.pricing.inputUsdPerMillionTokens !== 'number' ||
      typeof target.pricing.outputUsdPerMillionTokens !== 'number')
  ) {
    throw new AiFeatureModelError(
      `AI feature "${featureKey}" selected ${target.provider}/${target.modelId} without usable token pricing metadata`,
    );
  }
}

/**
 * Resolve one feature once per request. The store returns the registry default
 * when there is no database override, so adding runtime routing does not alter
 * today's model choice.
 */
export async function resolveAiExecutionPlan(
  featureKey: AiFeatureKey,
  provider: AiProvider,
  opts: { requirePricing?: boolean } = {},
): Promise<AiExecutionPlan> {
  const definition = getAiFeatureDefinition(featureKey);
  if (definition.runtimeProvider !== provider) {
    throw new AiFeatureModelError(
      `AI feature "${featureKey}" is implemented by ${definition.runtimeProvider}, ` +
      `but was invoked through the ${provider} runtime`,
    );
  }
  const config = await resolveAiFeatureConfig(featureKey);
  if (!config.enabled) throw new AiFeatureDisabledError(featureKey);

  const requirePricing = opts.requirePricing === true;
  assertTarget(featureKey, config.primary, provider, requirePricing);

  const fallback = config.fallback &&
    !(config.fallback.provider === config.primary.provider && config.fallback.modelId === config.primary.modelId)
    ? config.fallback
    : null;
  if (fallback) assertTarget(featureKey, fallback, provider, requirePricing);

  return { config, primary: config.primary, fallback };
}

export interface AiExecutionResult<T> {
  value: T;
  model: ResolvedModel;
  usedFallback: boolean;
}

export interface AiAttemptContext {
  attempt: 'primary' | 'fallback';
  attemptIndex: 0 | 1;
  /** One signal combining the caller cancellation and this attempt's share
   * of the shared wall-clock deadline. */
  signal: AbortSignal | undefined;
  /** Absolute deadline shared by primary and fallback, or null when the
   * caller did not request deadline enforcement. */
  deadlineAt: number | null;
  /** Remaining whole-call time when this attempt began. */
  remainingMs: number | null;
}

export interface AiExecutionOptions {
  /** Relative whole-call deadline. Ignored when deadlineAt is provided. */
  deadlineMs?: number;
  /** Absolute whole-call deadline, useful when route work starts before the
   * provider call. */
  deadlineAt?: number;
  /** Time protected for the fallback when the primary is configured. */
  fallbackReserveMs?: number;
  /** User/request cancellation. It is composed with, never replaced by, the
   * internal attempt deadline. */
  abortSignal?: AbortSignal;
}

export class AiExecutionDeadlineError extends Error {
  constructor() {
    super('AI execution deadline exhausted');
    this.name = 'AiExecutionDeadlineError';
  }
}

function executionDeadlineAt(opts: AiExecutionOptions): number | null {
  if (typeof opts.deadlineAt === 'number' && Number.isFinite(opts.deadlineAt)) {
    return opts.deadlineAt;
  }
  if (typeof opts.deadlineMs === 'number' && Number.isFinite(opts.deadlineMs)) {
    return Date.now() + Math.max(1, Math.floor(opts.deadlineMs));
  }
  return null;
}

export function createAiAttemptContext(
  attempt: 'primary' | 'fallback',
  deadlineAt: number | null,
  hasFallback: boolean,
  opts: AiExecutionOptions,
): AiAttemptContext {
  const remainingMs = deadlineAt === null ? null : Math.floor(deadlineAt - Date.now());
  if (remainingMs !== null && remainingMs <= 0) throw new AiExecutionDeadlineError();

  let attemptMs = remainingMs;
  if (attempt === 'primary' && hasFallback && remainingMs !== null) {
    const requestedReserve = Math.max(
      1,
      Math.floor(opts.fallbackReserveMs ?? Math.min(10_000, remainingMs / 3)),
    );
    // Never starve the primary completely when very little route time remains.
    const reserve = Math.min(requestedReserve, Math.max(1, Math.floor(remainingMs / 2)));
    attemptMs = Math.max(1, remainingMs - reserve);
  }

  const deadlineSignal = attemptMs === null ? undefined : AbortSignal.timeout(attemptMs);
  const signal = opts.abortSignal && deadlineSignal
    ? AbortSignal.any([opts.abortSignal, deadlineSignal])
    : opts.abortSignal ?? deadlineSignal;
  return {
    attempt,
    attemptIndex: attempt === 'primary' ? 0 : 1,
    signal,
    deadlineAt,
    remainingMs,
  };
}

/**
 * Execute against the configured primary and, if it fails before returning a
 * value, retry once with the configured compatible fallback. Abort errors are
 * never retried: a user cancellation must stop provider spend immediately.
 */
export async function executeAiFeature<T>(
  featureKey: AiFeatureKey,
  provider: AiProvider,
  invoke: (model: ResolvedModel, context: AiAttemptContext) => Promise<T>,
  opts: { requirePricing?: boolean } & AiExecutionOptions = {},
): Promise<AiExecutionResult<T>> {
  // Materialize relative deadlines before config I/O so catalog/database
  // latency cannot silently extend the provider + fallback wall-clock budget.
  const deadlineAt = executionDeadlineAt(opts);
  const executionOpts: AiExecutionOptions = deadlineAt === null
    ? opts
    : { ...opts, deadlineAt, deadlineMs: undefined };
  const plan = await resolveAiExecutionPlan(featureKey, provider, opts);
  return executeAiPlan(plan, invoke, executionOpts);
}

/** Pure execution half, exported for focused fallback tests and for callers
 * that must resolve once before a multi-iteration provider loop. */
export async function executeAiPlan<T>(
  plan: AiExecutionPlan,
  invoke: (model: ResolvedModel, context: AiAttemptContext) => Promise<T>,
  opts: AiExecutionOptions = {},
): Promise<AiExecutionResult<T>> {
  const deadlineAt = executionDeadlineAt(opts);
  try {
    const context = createAiAttemptContext('primary', deadlineAt, plan.fallback !== null, opts);
    return { value: await invoke(plan.primary, context), model: plan.primary, usedFallback: false };
  } catch (error) {
    const fallback = plan.fallback;
    if (!shouldRetryAiFallback({
      fallbackAvailable: fallback !== null,
      aborted: opts.abortSignal?.aborted ?? false,
      emittedToUser: false,
      error,
    }) || !fallback) throw error;
    const context = createAiAttemptContext('fallback', deadlineAt, false, opts);
    return { value: await invoke(fallback, context), model: fallback, usedFallback: true };
  }
}

export interface AiTokenCostUsage {
  /** Provider-reported base/uncached input_tokens. Cache reads and writes are
   * separate Anthropic usage fields and MUST NOT be subtracted from this. */
  uncachedInputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheCreation5mInputTokens?: number;
  cacheCreation1hInputTokens?: number;
}

export function estimateAiCostUsd(
  pricing: AiModelPricing,
  usage: AiTokenCostUsage,
): number {
  const inputRate = pricing.inputUsdPerMillionTokens;
  const outputRate = pricing.outputUsdPerMillionTokens;
  if (typeof inputRate !== 'number' || typeof outputRate !== 'number') {
    throw new AiFeatureModelError('Token cost estimation requires verified input and output token pricing');
  }
  const finite = (value: number | undefined): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
  const fresh = finite(usage.uncachedInputTokens);
  const output = finite(usage.outputTokens);
  const cacheRead = finite(usage.cacheReadInputTokens);
  const reportedCreation = finite(usage.cacheCreationInputTokens);
  const creation5m = finite(usage.cacheCreation5mInputTokens);
  const creation1h = finite(usage.cacheCreation1hInputTokens);
  // Some SDK/provider versions expose only aggregate cache creation. Price any
  // unclassified remainder at the most expensive known write rate so missing
  // TTL metadata never understates spend.
  const creationTotal = Math.max(reportedCreation, creation5m + creation1h);
  const creationUnknown = Math.max(0, creationTotal - creation5m - creation1h);
  const cacheReadRate = pricing.cachedInputUsdPerMillionTokens ?? inputRate;
  const creation5mRate = pricing.cacheCreation5mInputUsdPerMillionTokens ?? inputRate * 1.25;
  const creation1hRate = pricing.cacheCreation1hInputUsdPerMillionTokens ?? inputRate * 2;
  const unknownCreationRate = Math.max(inputRate, creation5mRate, creation1hRate);
  return (
    (fresh / 1_000_000) * inputRate +
    (cacheRead / 1_000_000) * cacheReadRate +
    (creation5m / 1_000_000) * creation5mRate +
    (creation1h / 1_000_000) * creation1hRate +
    (creationUnknown / 1_000_000) * unknownCreationRate +
    (output / 1_000_000) * outputRate
  );
}

/**
 * Scale an existing conservative token reservation when an admin selects a
 * pricier primary or fallback. Cheaper models never reduce the established
 * safety hold, preserving today's cap behavior.
 */
export async function estimateAiReservationUsd(
  featureKey: AiFeatureKey,
  provider: AiProvider,
  baseline: { usd: number; inputUsdPerMillionTokens: number; outputUsdPerMillionTokens: number },
): Promise<number> {
  const plan = await resolveAiExecutionPlan(featureKey, provider, { requirePricing: true });
  const refs = [plan.primary, plan.fallback].filter((ref): ref is ResolvedModel => ref !== null);
  return scaleAiReservationUsd(refs, baseline);
}

export function scaleAiReservationUsd(
  refs: ResolvedModel[],
  baseline: { usd: number; inputUsdPerMillionTokens: number; outputUsdPerMillionTokens: number },
): number {
  let multiplier = 0;
  for (const ref of refs) {
    const pricing = ref.pricing!;
    // A failed primary may still consume billable input/partial output before
    // the fallback runs. Reserve for both attempts rather than only the more
    // expensive model so fallback resilience cannot overrun the spend hold.
    multiplier += Math.max(
      pricing.inputUsdPerMillionTokens! / baseline.inputUsdPerMillionTokens,
      pricing.outputUsdPerMillionTokens! / baseline.outputUsdPerMillionTokens,
    );
  }
  return Math.ceil(baseline.usd * Math.max(1, multiplier) * 100) / 100;
}
