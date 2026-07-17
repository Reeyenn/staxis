import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  agentStopReason,
  agentToolStopReason,
  estimateAnthropicRequestInputTokens,
  hasInflightBillingEvidence,
  modelTierForModelId,
} from '@/lib/agent/llm';
import { normalizeAnthropicUsage } from '@/lib/ai/usage';
import {
  EFFECTIVE_LEGACY_MODELS,
  LEGACY_MODEL_OVERRIDE_FEATURE_TIERS,
  applyLegacyModelOverrideToPlan,
  applyLegacyModelOverridesToSummaries,
  parseLegacyModelOverrides,
} from '@/lib/ai/legacy-model-overrides';
import type { AiExecutionPlan } from '@/lib/ai/runtime';

test('model telemetry tier follows the model actually selected', () => {
  assert.equal(modelTierForModelId('claude-opus-5-20260701', 'sonnet'), 'opus');
  assert.equal(modelTierForModelId('claude-haiku-4-5', 'sonnet'), 'haiku');
  assert.equal(modelTierForModelId('claude-sonnet-5-1', 'haiku'), 'sonnet');
  assert.equal(modelTierForModelId('future-unclassified-model', 'sonnet'), 'sonnet');
});

test('partial-stream estimate includes system prompt and tool schemas', () => {
  const messages = [{ role: 'user', content: 'count towels' }];
  const messagesOnly = Math.ceil(JSON.stringify({ system: [], messages }).length / 4);
  const full = estimateAnthropicRequestInputTokens({
    system: [{ type: 'text', text: 'x'.repeat(4000) }],
    tools: [{ name: 'count_inventory', input_schema: { type: 'object', description: 'y'.repeat(2000) } }],
    messages,
  });
  assert.ok(full > messagesOnly + 1000);
});

test('message_start input usage is billing evidence before content arrives', () => {
  assert.equal(hasInflightBillingEvidence(false, 812), true);
  assert.equal(hasInflightBillingEvidence(true, null), true);
  assert.equal(hasInflightBillingEvidence(false, null), false);
});

test('Anthropic usage keeps uncached, cache-write, and cache-read counters disjoint', () => {
  assert.deepEqual(normalizeAnthropicUsage({
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 300,
    cache_creation_input_tokens: 200,
    cache_creation: {
      ephemeral_5m_input_tokens: 150,
      ephemeral_1h_input_tokens: 50,
    },
  }), {
    inputTokens: 600,
    uncachedInputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 300,
    cacheCreationInputTokens: 200,
    cacheCreation5mInputTokens: 150,
    cacheCreation1hInputTokens: 50,
  });
});

test('agent deadline checks stop at tool boundaries and caller abort wins', () => {
  const controller = new AbortController();
  assert.equal(agentStopReason(999, controller.signal, 1_000), 'deadline');
  controller.abort();
  assert.equal(agentStopReason(999, controller.signal, 1_000), 'caller_abort');
  assert.equal(agentStopReason(1_001, undefined, 1_000), null);
  assert.equal(agentToolStopReason('get_room_status', 3_001, undefined, 1_000), null);
  assert.equal(agentToolStopReason('get_room_status', 3_000, undefined, 1_000), 'deadline');
  assert.equal(agentToolStopReason('search_knowledge', 32_000, undefined, 1_000), 'deadline');
});

test('legacy override parsing and feature coverage include Ask Staxis and walkthroughs', () => {
  assert.deepEqual(
    parseLegacyModelOverrides('sonnet=claude-sonnet-pinned, haiku=claude-haiku-pinned, bad=x'),
    { sonnet: 'claude-sonnet-pinned', haiku: 'claude-haiku-pinned' },
  );
  assert.equal(LEGACY_MODEL_OVERRIDE_FEATURE_TIERS['agent.ask_staxis'], 'sonnet');
  assert.equal(LEGACY_MODEL_OVERRIDE_FEATURE_TIERS['walkthrough.step_generation'], 'sonnet');
});

test('legacy override changes only default plans and preserves database selections', () => {
  const pricing = {
    inputUsdPerMillionTokens: 3,
    outputUsdPerMillionTokens: 15,
    source: 'test',
    asOf: 'test',
  };
  const base: AiExecutionPlan = {
    config: {
      featureKey: 'agent.ask_staxis',
      enabled: true,
      primary: { provider: 'anthropic', modelId: 'claude-sonnet-4-6', pricing },
      fallback: null,
      parameters: {},
      source: 'default',
      versionId: null,
      version: null,
    },
    primary: { provider: 'anthropic', modelId: 'claude-sonnet-4-6', pricing },
    fallback: null,
  };
  const effective = applyLegacyModelOverrideToPlan(base, 'sonnet');
  assert.equal(effective.primary.modelId, EFFECTIVE_LEGACY_MODELS.sonnet);
  assert.equal(effective.config.primary.modelId, effective.primary.modelId);

  const database = {
    ...base,
    config: { ...base.config, source: 'database' as const, versionId: 'v1', version: 1 },
    primary: { ...base.primary, modelId: 'admin-selected-model' },
  };
  assert.equal(applyLegacyModelOverrideToPlan(database, 'sonnet'), database);
});

test('Control Center summary reports the effective legacy default model', () => {
  const summary = {
    key: 'walkthrough.step_generation',
    activeConfig: {
      featureKey: 'walkthrough.step_generation',
      enabled: true,
      primary: {
        provider: 'anthropic',
        modelId: 'claude-sonnet-4-6',
        pricing: {
          inputUsdPerMillionTokens: 3,
          outputUsdPerMillionTokens: 15,
          source: 'test',
          asOf: 'test',
        },
      },
      fallback: null,
      parameters: {},
      source: 'default',
      versionId: null,
      version: null,
    },
  } as Parameters<typeof applyLegacyModelOverridesToSummaries>[0][number];
  const [effective] = applyLegacyModelOverridesToSummaries([summary]);
  assert.equal(effective.activeConfig.primary.modelId, EFFECTIVE_LEGACY_MODELS.sonnet);
});
