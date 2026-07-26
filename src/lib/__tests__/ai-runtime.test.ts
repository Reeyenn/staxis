import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ResolvedAiFeatureConfig } from '@/lib/ai/types';
import {
  AiFeatureModelError,
  executeAiPlan,
  estimateAiCostUsd,
  scaleAiReservationUsd,
  shouldRetryAiFallback,
  type AiExecutionPlan,
} from '@/lib/ai/runtime';
import { captureTokenUsage, type AiUsageReport } from '@/lib/ai/usage';

const pricing = {
  inputUsdPerMillionTokens: 3,
  outputUsdPerMillionTokens: 15,
  cachedInputUsdPerMillionTokens: 0.3,
  source: 'test',
  asOf: 'test',
};

function plan(): AiExecutionPlan {
  const config: ResolvedAiFeatureConfig = {
    featureKey: 'inventory.photo_count',
    enabled: true,
    primary: { provider: 'anthropic', modelId: 'primary', pricing },
    fallback: { provider: 'anthropic', modelId: 'fallback', pricing },
    parameters: {},
    source: 'database',
    versionId: 'v1',
    version: 1,
  };
  return { config, primary: config.primary, fallback: config.fallback };
}

test('executeAiPlan retries the configured fallback after a pre-result failure', async () => {
  const calls: string[] = [];
  const result = await executeAiPlan(plan(), async (model) => {
    calls.push(model.modelId);
    if (model.modelId === 'primary') throw new Error('provider unavailable');
    return 'ok';
  });
  assert.deepEqual(calls, ['primary', 'fallback']);
  assert.equal(result.value, 'ok');
  assert.equal(result.model.modelId, 'fallback');
  assert.equal(result.usedFallback, true);
});

test('schema failures and attempt timeouts retry within one shared deadline', async () => {
  const attempts: Array<{ name: string; deadlineAt: number | null; remainingMs: number | null; hasSignal: boolean }> = [];
  const result = await executeAiPlan(
    plan(),
    async (model, context) => {
      attempts.push({
        name: context.attempt,
        deadlineAt: context.deadlineAt,
        remainingMs: context.remainingMs,
        hasSignal: Boolean(context.signal),
      });
      if (model.modelId === 'primary') {
        const timeout = new Error('The operation was aborted due to timeout');
        timeout.name = 'TimeoutError';
        throw timeout;
      }
      return { parsed: true };
    },
    { deadlineMs: 1_000, fallbackReserveMs: 400 },
  );
  assert.deepEqual(result.value, { parsed: true });
  assert.deepEqual(attempts.map((attempt) => attempt.name), ['primary', 'fallback']);
  assert.equal(attempts[0].deadlineAt, attempts[1].deadlineAt);
  assert.ok(attempts.every((attempt) => attempt.hasSignal));
  assert.ok((attempts[0].remainingMs ?? 0) <= 1_000);
});

test('executeAiPlan never retries an abort', async () => {
  const calls: string[] = [];
  const aborted = new Error('aborted by client');
  aborted.name = 'AbortError';
  await assert.rejects(
    executeAiPlan(plan(), async (model) => {
      calls.push(model.modelId);
      throw aborted;
    }),
    /aborted by client/,
  );
  assert.deepEqual(calls, ['primary']);
});

test('Anthropic APIUserAbortError from an internal timeout can fall back', async () => {
  const calls: string[] = [];
  const result = await executeAiPlan(plan(), async (model) => {
    calls.push(model.modelId);
    if (model.modelId === 'primary') {
      const wrappedTimeout = new Error('Request was aborted.');
      wrappedTimeout.name = 'APIUserAbortError';
      throw wrappedTimeout;
    }
    return 'fallback-ok';
  });
  assert.equal(result.value, 'fallback-ok');
  assert.deepEqual(calls, ['primary', 'fallback']);
});

test('Anthropic APIUserAbortError does not fall back when the caller signal aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  const calls: string[] = [];
  const wrappedAbort = new Error('Request was aborted.');
  wrappedAbort.name = 'APIUserAbortError';
  await assert.rejects(
    executeAiPlan(plan(), async (model) => {
      calls.push(model.modelId);
      throw wrappedAbort;
    }, { abortSignal: controller.signal }),
    /Request was aborted/,
  );
  assert.deepEqual(calls, ['primary']);
});

test('estimateAiCostUsd prices disjoint fresh, cache-read, cache-write, and output tokens', () => {
  assert.equal(estimateAiCostUsd(pricing, {
    uncachedInputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadInputTokens: 500_000,
    cacheCreationInputTokens: 300_000,
    cacheCreation5mInputTokens: 200_000,
    cacheCreation1hInputTokens: 100_000,
  }), 19.5);
  // Unknown cache-write TTL is conservatively charged at the 1h (2x) rate.
  assert.equal(estimateAiCostUsd(pricing, {
    uncachedInputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadInputTokens: 500_000,
    cacheCreationInputTokens: 300_000,
  }), 19.95);
  assert.throws(
    () => estimateAiCostUsd(
      { usdPerAudioMinute: 0.006, source: 'test', asOf: 'test' },
      { uncachedInputTokens: 1, outputTokens: 1 },
    ),
    /requires verified input and output token pricing/,
  );
});

test('stream fallback is allowed only before user-visible output', () => {
  const error = new Error('connection reset');
  assert.equal(shouldRetryAiFallback({ fallbackAvailable: true, aborted: false, emittedToUser: false, error }), true);
  assert.equal(shouldRetryAiFallback({ fallbackAvailable: true, aborted: false, emittedToUser: true, error }), false);
  assert.equal(shouldRetryAiFallback({ fallbackAvailable: true, aborted: true, emittedToUser: false, error }), false);
});

test('reservation scaling sums primary and fallback attempt exposure and never shrinks', () => {
  const p = plan();
  p.primary.pricing = { ...pricing, inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 5 };
  p.fallback!.pricing = { ...pricing, inputUsdPerMillionTokens: 15, outputUsdPerMillionTokens: 75 };
  assert.equal(scaleAiReservationUsd([p.primary, p.fallback!], {
    usd: 2,
    inputUsdPerMillionTokens: 3,
    outputUsdPerMillionTokens: 15,
  }), 10.67);
  assert.equal(scaleAiReservationUsd([p.primary], {
    usd: 2,
    inputUsdPerMillionTokens: 3,
    outputUsdPerMillionTokens: 15,
  }), 2);
});

// ─── Cross-provider execution ───────────────────────────────────────────────
//
// Once a feature can be moved between Claude and GPT, a plan's primary and
// fallback may live with DIFFERENT providers. Everything below is about the
// money staying right when that happens.

test('a caller that speaks both providers may execute an OpenAI selection', async () => {
  const config: ResolvedAiFeatureConfig = {
    featureKey: 'agent.ask_staxis',
    enabled: true,
    primary: {
      provider: 'openai',
      modelId: 'gpt-5.4-mini',
      pricing: {
        inputUsdPerMillionTokens: 0.75,
        outputUsdPerMillionTokens: 4.5,
        cachedInputUsdPerMillionTokens: 0.075,
        source: 'https://developers.openai.com/api/docs/pricing',
        asOf: '2026-07-26',
      },
    },
    fallback: null,
    parameters: {},
    source: 'database',
    versionId: 'v2',
    version: 2,
  };
  let seenUsage: AiUsageReport | null = null;
  const result = await executeAiPlan(
    { config, primary: config.primary, fallback: null },
    async (model, context) => {
      captureTokenUsage(context.attempts, model, 'gpt-5.4-mini-2026-03-17', {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      });
      return model.modelId;
    },
    { onUsage: (usage) => { seenUsage = usage; } },
  );

  assert.equal(result.value, 'gpt-5.4-mini');
  const usage = seenUsage as unknown as AiUsageReport;
  assert.equal(usage.costUsd, 0.75 + 4.5);
  // The exact snapshot that answered, which is what agent_costs.model_id keeps
  // so an operator can see which build served a turn.
  assert.equal(usage.modelId, 'gpt-5.4-mini-2026-03-17');
});

test('a cross-provider fallback bills each attempt at its own provider price', async () => {
  // The important failure this prevents: pricing the whole turn against the
  // model that finally answered would erase what the failed provider already
  // charged, or bill its tokens at the wrong rate.
  const config: ResolvedAiFeatureConfig = {
    featureKey: 'agent.ask_staxis',
    enabled: true,
    primary: {
      provider: 'openai',
      modelId: 'gpt-5.5',
      pricing: {
        inputUsdPerMillionTokens: 5,
        outputUsdPerMillionTokens: 30,
        source: 'https://developers.openai.com/api/docs/pricing',
        asOf: '2026-07-26',
      },
    },
    fallback: {
      provider: 'anthropic',
      modelId: 'claude-haiku-4-5',
      pricing: {
        inputUsdPerMillionTokens: 1,
        outputUsdPerMillionTokens: 5,
        source: 'official-list-price',
        asOf: '2026-07-25',
      },
    },
    parameters: {},
    source: 'database',
    versionId: 'v3',
    version: 3,
  };

  let seenUsage: AiUsageReport | null = null;
  const providersTried: string[] = [];
  const result = await executeAiPlan(
    { config, primary: config.primary, fallback: config.fallback },
    async (model, context) => {
      providersTried.push(model.provider);
      // Both attempts consume 1M input; only the second produces output.
      captureTokenUsage(context.attempts, model, model.modelId, {
        input_tokens: 1_000_000,
        output_tokens: model.provider === 'openai' ? 0 : 1_000_000,
      });
      if (model.provider === 'openai') throw new Error('provider unavailable');
      return 'answered by claude';
    },
    { onUsage: (usage) => { seenUsage = usage; } },
  );

  assert.deepEqual(providersTried, ['openai', 'anthropic']);
  assert.equal(result.usedFallback, true);
  const usage = seenUsage as unknown as AiUsageReport;
  // OpenAI's failed 1M input @ $5/M is still owed, plus Claude's 1M in @ $1/M
  // and 1M out @ $5/M. A single-price model would have reported $6.
  assert.equal(usage.costUsd, 5 + 1 + 5);
  assert.equal(usage.attempts.length, 2);
  assert.equal(usage.attempts[0].model, 'gpt-5.5');
  assert.equal(usage.attempts[1].model, 'claude-haiku-4-5');
});

test('a runtime that speaks one provider refuses a selection from another', async () => {
  // The embeddings/transcription callers still legitimately support exactly one
  // provider. They must not be handed a chat model just because the feature
  // registry widened elsewhere.
  await assert.rejects(
    () => executeAiPlan(
      {
        config: {
          featureKey: 'agent.ask_staxis',
          enabled: true,
          primary: { provider: 'openai', modelId: 'gpt-5.4', pricing },
          fallback: null,
          parameters: {},
          source: 'database',
          versionId: 'v4',
          version: 4,
        },
        primary: { provider: 'openai', modelId: 'gpt-5.4', pricing },
        fallback: null,
      },
      async () => { throw new AiFeatureModelError('anthropic runtime cannot serve openai/gpt-5.4'); },
    ),
    /cannot serve openai/,
  );
});
