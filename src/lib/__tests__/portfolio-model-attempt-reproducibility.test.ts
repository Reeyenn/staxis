import assert from 'node:assert/strict';
import { test } from 'node:test';

import type Anthropic from '@anthropic-ai/sdk';

import {
  runAgent,
  type MessagesClient,
  type ProviderRequestAttempt,
} from '@/lib/agent/llm';
import type { ToolContext } from '@/lib/agent/tools';
import type { AiExecutionPlan } from '@/lib/ai/runtime';

const PROPERTY_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';

const pricing = {
  inputUsdPerMillionTokens: 3,
  outputUsdPerMillionTokens: 15,
  cachedInputUsdPerMillionTokens: 0.3,
  cacheCreation5mInputUsdPerMillionTokens: 3.75,
  cacheCreation1hInputUsdPerMillionTokens: 6,
  source: 'test',
  asOf: 'test',
};

function executionPlan(): AiExecutionPlan {
  const primary = {
    provider: 'anthropic' as const,
    modelId: 'claude-primary-alias',
    pricing,
  };
  const fallback = {
    provider: 'anthropic' as const,
    modelId: 'claude-fallback-alias',
    pricing,
  };
  return {
    config: {
      featureKey: 'agent.portfolio_chat',
      enabled: true,
      primary,
      fallback,
      parameters: { temperature: 0 },
      source: 'database',
      versionId: 'config-version-17',
      version: 17,
    },
    primary,
    fallback,
  };
}

function response(input: {
  id: string;
  model: string;
  text: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}): Anthropic.Messages.Message {
  return {
    id: input.id,
    type: 'message',
    role: 'assistant',
    model: input.model,
    content: [{ type: 'text', text: input.text, citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: input.inputTokens,
      output_tokens: input.outputTokens,
      cache_read_input_tokens: input.cacheReadTokens ?? 0,
      cache_creation_input_tokens: input.cacheCreationTokens ?? 0,
      cache_creation: input.cacheCreationTokens
        ? {
            ephemeral_5m_input_tokens: 2,
            ephemeral_1h_input_tokens: input.cacheCreationTokens - 2,
          }
        : null,
      server_tool_use: null,
      service_tier: null,
    },
  } as unknown as Anthropic.Messages.Message;
}

function jsonSnapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test('runAgent preserves a rejected alias response and its spend before a distinct fallback snapshot', async () => {
  const validCandidate = JSON.stringify({
    version: 'portfolio-presentation-plan.v1',
    lead: 'scope_first',
    orderedClaimIds: ['coverage'],
  });
  const primaryResponse = response({
    id: 'msg_primary_200',
    model: 'claude-primary-snapshot-20260727',
    text: 'this is a billable but schema-invalid 200',
    inputTokens: 11,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheCreationTokens: 5,
  });
  const fallbackResponse = response({
    id: 'msg_fallback_200',
    model: 'claude-fallback-snapshot-20260720',
    text: validCandidate,
    inputTokens: 17,
    outputTokens: 4,
  });
  const receivedBodies: Anthropic.Messages.MessageCreateParamsNonStreaming[] = [];
  const client: MessagesClient = {
    messages: {
      async create(body) {
        receivedBodies.push(jsonSnapshot(body));
        if (body.model === 'claude-primary-alias') return primaryResponse;
        if (body.model === 'claude-fallback-alias') return fallbackResponse;
        throw new Error(`unexpected model ${body.model}`);
      },
      stream() {
        throw new Error('stream is not used by this reproducibility test');
      },
    },
  };
  const toolContext: ToolContext = {
    user: {
      uid: ACCOUNT_ID,
      accountId: ACCOUNT_ID,
      username: 'portfolio-auditor',
      displayName: 'Portfolio Auditor',
      role: 'general_manager',
      propertyAccess: [PROPERTY_ID],
    },
    propertyId: PROPERTY_ID,
    staffId: null,
    requestId: 'portfolio-model-attempt-reproducibility',
    surface: 'portfolio',
  };
  const usageReports: Array<{ inputTokens: number; outputTokens: number }> = [];

  const result = await runAgent({
    systemPrompt: {
      stable: 'Return only the requested portfolio presentation plan.',
      dynamic: 'REQUIRED_CLAIM_IDS: coverage',
      factual: 'No numeric facts are sent in this test.',
    },
    history: [{ role: 'user', content: 'Earlier portfolio context.' }],
    newUserMessage: 'How are all my hotels doing?',
    tools: [],
    toolContext,
    executionPlan: executionPlan(),
    modelClient: client,
    validateAssistantResponse(candidate) {
      const parsed = JSON.parse(candidate.text) as { version?: unknown };
      if (parsed.version !== 'portfolio-presentation-plan.v1') {
        throw new TypeError('wrong presentation plan version');
      }
    },
    onUsage(usage) {
      usageReports.push({
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      });
    },
  });

  assert.equal(result.text, validCandidate);
  assert.equal(receivedBodies.length, 2);
  const attempts = result.providerRequestAttempts as ProviderRequestAttempt[];
  assert.equal(attempts.length, 2);

  assert.deepEqual(attempts[0].request, receivedBodies[0], 'primary wire request must be verbatim');
  assert.equal(attempts[0].requestedModelId, 'claude-primary-alias');
  assert.equal(attempts[0].request.model, 'claude-primary-alias');
  assert.equal(attempts[0].outcome, 'rejected');
  assert.equal(attempts[0].failureName, 'SyntaxError');
  assert.equal(attempts[0].responseModelId, 'claude-primary-snapshot-20260727');
  assert.deepEqual(attempts[0].response, jsonSnapshot(primaryResponse));
  assert.deepEqual(attempts[0].billableUsage, {
    inputTokens: 19,
    uncachedInputTokens: 11,
    outputTokens: 2,
    cachedInputTokens: 3,
    cacheCreationInputTokens: 5,
    cacheCreation5mInputTokens: 2,
    cacheCreation1hInputTokens: 3,
  });

  assert.deepEqual(attempts[1].request, receivedBodies[1], 'fallback wire request must be verbatim');
  assert.equal(attempts[1].requestedModelId, 'claude-fallback-alias');
  assert.equal(attempts[1].request.model, 'claude-fallback-alias');
  assert.equal(attempts[1].outcome, 'succeeded');
  assert.equal(attempts[1].failureName, null);
  assert.equal(attempts[1].responseModelId, 'claude-fallback-snapshot-20260720');
  assert.deepEqual(attempts[1].response, jsonSnapshot(fallbackResponse));
  assert.deepEqual(attempts[1].billableUsage, {
    inputTokens: 17,
    uncachedInputTokens: 17,
    outputTokens: 4,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheCreation5mInputTokens: 0,
    cacheCreation1hInputTokens: 0,
  });

  assert.equal(result.usage.inputTokens, 36, 'rejected-primary spend must remain in aggregate usage');
  assert.equal(result.usage.outputTokens, 6);
  assert.equal(result.usage.modelId, 'claude-fallback-snapshot-20260720');
  assert.equal(result.usage.costUsd, 0.0002004);
  assert.equal(usageReports.length, 1);
  assert.deepEqual(usageReports[0], { inputTokens: 36, outputTokens: 6 });

  // The audit object is a snapshot, not the provider client's live response.
  (primaryResponse as unknown as { model: string }).model = 'mutated-after-return';
  assert.equal(attempts[0].response?.model, 'claude-primary-snapshot-20260727');
});
