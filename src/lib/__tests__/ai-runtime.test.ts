import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ResolvedAiFeatureConfig } from '@/lib/ai/types';
import {
  executeAiPlan,
  estimateAiCostUsd,
  scaleAiReservationUsd,
  shouldRetryAiFallback,
  type AiExecutionPlan,
} from '@/lib/ai/runtime';

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
