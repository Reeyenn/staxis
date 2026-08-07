/**
 * THE OFF SWITCH HAS TO REACH THE CODE THAT SPENDS THE MONEY.
 *
 * ─── WHAT WENT WRONG ────────────────────────────────────────────────────────
 *
 * Two rows on the AI Control Center — "Companion bubble" and "Messaging
 * assistant" — are FACES on the Ask Staxis conversation. They resolve their own
 * Control Center row so the founder can move either onto a cheaper model without
 * touching the chat bar managers type into all day, and they were written to
 * borrow the copilot's plan if their own row could not be resolved. The reason
 * given is a good one: a housekeeper's question in a channel must not go
 * unanswered because somebody unpriced a model on an admin screen.
 *
 * The catch was blanket. `resolveAiExecutionPlan` raises `AiFeatureDisabledError`
 * for a row somebody deliberately SWITCHED OFF — and for a row the config store
 * FAILED CLOSED, which is the store having already decided this row must stop
 * dispatching. Both landed in the same `catch` as "unpriced model", and both
 * came out the other side as "carry on, on the copilot's model".
 *
 * So the switch reported success and stopped nothing. Worse than a no-op: the
 * route picks the LEDGER FEATURE from the surface that asked, not from the plan
 * that ran, so every one of those turns was still booked to the switched-off row.
 * The spend screen showed a feature that is off, spending money.
 *
 * ─── WHAT IS ASSERTED ───────────────────────────────────────────────────────
 *
 * The real resolver, over the real config store, against a stubbed database
 * holding a real `ai_feature_config_versions` row. No source is read. The three
 * cases that have to come out differently:
 *
 *   1. SWITCHED OFF          → refuse. The decision reaches the runtime.
 *   2. FAILED CLOSED         → refuse. The store's decision reaches it too.
 *   3. BROKEN (no price)     → borrow the copilot's plan. The accident stays
 *                              invisible to the person in the thread, which is
 *                              the behaviour the fallback was written for and
 *                              which this fix must not take away.
 *
 * Case 3 is here on purpose: a fix that simply deleted the fallback would pass
 * cases 1 and 2 and quietly turn an admin typo into a dead bubble.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder-test-key-min-20-chars';

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { AiFeatureDisabledError } from '@/lib/ai/runtime';
import { invalidateAiFeatureConfigCache } from '@/lib/ai/model-config-store';
import { invalidateAiModelCatalogCache } from '@/lib/ai/model-catalog';
import {
  agentFeatureKeyForOrigin,
  resolveAgentOriginExecutionPlan,
  type AgentOrigin,
} from '@/lib/agent/llm';
import type { AiFeatureKey } from '@/lib/ai/types';

// ─── The seam ───────────────────────────────────────────────────────────────
// Exactly the two tables the config store reads. A thenable object stands in for
// the PostgREST builder, which is what supabase-js hands back from `.eq(...)`.

interface ThenableRows {
  then: (resolve: (value: { data: unknown[]; error: null }) => unknown) => unknown;
  [key: string]: unknown;
}

function rowsQuery(rows: unknown[]): ThenableRows {
  const query: ThenableRows = {
    then: (resolve) => resolve({ data: rows, error: null }),
  };
  for (const method of ['select', 'eq', 'is', 'order', 'limit', 'gte', 'in']) {
    query[method] = () => query;
  }
  return query;
}

/** One ACTIVE, validation-passed config row, in the store's own column shape. */
function activeConfigRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    version: 3,
    enabled: true,
    primary_provider: 'anthropic',
    primary_model_id: 'claude-sonnet-4-6',
    fallback_provider: null,
    fallback_model_id: null,
    parameters: {},
    validation_status: 'passed',
    validation_report: {},
    validated_at: new Date().toISOString(),
    validated_by: null,
    validated_by_email: null,
    is_active: true,
    parent_id: null,
    change_reason: null,
    created_at: new Date().toISOString(),
    created_by: null,
    created_by_email: null,
    activated_at: new Date().toISOString(),
    activated_by: null,
    activated_by_email: null,
    ...overrides,
  };
}

/** One `ai_model_catalog` row, in the catalog mapper's column shape. */
function catalogRow(overrides: Record<string, unknown>): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    provider: 'openai',
    model_id: 'gpt-5.6-luna',
    display_name: 'GPT-5.6 Luna',
    status: 'available',
    available: true,
    capabilities: ['text', 'tool_use'],
    max_input_tokens: null,
    max_output_tokens: null,
    released_at: null,
    pricing: null,
    source: 'provider',
    first_seen_at: now,
    last_seen_at: now,
    updated_at: now,
    ...overrides,
  };
}

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);

function installSeam(opts: {
  configs: Record<string, unknown>[];
  catalog?: Record<string, unknown>[];
}): void {
  // @ts-expect-error the test replaces the singleton dependency seam
  supabaseAdmin.from = (table: string) => {
    if (table === 'ai_feature_config_versions') return rowsQuery(opts.configs);
    if (table === 'ai_model_catalog') return rowsQuery(opts.catalog ?? []);
    throw new Error(`unexpected table read: ${table}`);
  };
  invalidateAiFeatureConfigCache();
  invalidateAiModelCatalogCache();
}

afterEach(() => {
  supabaseAdmin.from = originalFrom;
  invalidateAiFeatureConfigCache();
  invalidateAiModelCatalogCache();
});

/** The two surfaces that resolve their own row and can borrow the copilot's. */
const FACES: Array<{ origin: AgentOrigin; featureKey: AiFeatureKey; label: string }> = [
  { origin: 'companion', featureKey: 'companion.conversation', label: 'the companion bubble' },
  { origin: 'messages', featureKey: 'communications.staxis_assistant', label: 'the @Staxis thread assistant' },
];

describe('a Control Center row switched off stops the surface it governs', () => {
  for (const face of FACES) {
    test(`${face.label} refuses the turn when its own row is switched off`, async () => {
      installSeam({
        configs: [activeConfigRow({ feature_key: face.featureKey, enabled: false })],
      });

      await assert.rejects(
        () => resolveAgentOriginExecutionPlan(face.origin),
        (error: unknown) => {
          assert.ok(
            error instanceof AiFeatureDisabledError,
            'a switched-off row must reach the runtime as a refusal, not as the copilot\'s plan',
          );
          assert.equal(error.featureKey, face.featureKey);
          return true;
        },
      );
    });

    test(`${face.label} refuses the turn when the store failed its row closed`, async () => {
      // A row whose selected model is not in the catalog and carries no static
      // overlay: the store cannot hydrate it, so it fails the feature closed.
      // That is a decision by the safety layer, and it must land the same way a
      // hand-flipped switch does.
      installSeam({
        configs: [activeConfigRow({
          feature_key: face.featureKey,
          primary_provider: 'openai',
          primary_model_id: 'gpt-model-the-provider-no-longer-lists',
        })],
      });

      await assert.rejects(
        () => resolveAgentOriginExecutionPlan(face.origin),
        (error: unknown) => error instanceof AiFeatureDisabledError,
        'a fail-closed row must stop dispatching, not silently run on the copilot\'s model',
      );
    });

    test(`${face.label} still borrows the copilot's plan when its model is merely unpriced`, async () => {
      // The accident the fallback exists for: a real, available, capable model
      // that the provider publishes no price for. Nobody chose this, and nobody
      // in the thread should notice it.
      installSeam({
        configs: [activeConfigRow({
          feature_key: face.featureKey,
          primary_provider: 'openai',
          primary_model_id: 'gpt-unpriced-preview',
        })],
        catalog: [catalogRow({ model_id: 'gpt-unpriced-preview', pricing: null })],
      });

      const plan = await resolveAgentOriginExecutionPlan(face.origin);
      assert.equal(
        plan.config.featureKey, 'agent.ask_staxis',
        'an unpriced pick must fall through to the copilot rather than kill the surface',
      );
      assert.ok(plan.primary.pricing, 'the borrowed plan must still carry a price');
    });
  }

  test('the copilot itself is not given a second plan to hide behind', async () => {
    installSeam({
      configs: [activeConfigRow({ feature_key: 'agent.ask_staxis', enabled: false })],
    });

    await assert.rejects(
      () => resolveAgentOriginExecutionPlan('ask'),
      (error: unknown) => error instanceof AiFeatureDisabledError,
    );
  });

  test('the turn is billed to the row that governed it, so a stopped row cannot spend', () => {
    // The other half of the bug: the ledger feature comes from the surface, not
    // from the plan. That is only honest once a switched-off surface can no
    // longer run at all — which is what the rejections above establish.
    for (const face of FACES) {
      assert.equal(agentFeatureKeyForOrigin(face.origin), face.featureKey);
    }
    assert.equal(agentFeatureKeyForOrigin('ask'), 'agent.ask_staxis');
  });
});
