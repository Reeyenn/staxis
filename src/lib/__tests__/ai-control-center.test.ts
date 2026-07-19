import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  AI_FEATURE_KEYS,
  AI_FEATURE_REGISTRY,
  getAiFeatureDefinition,
} from '@/lib/ai/feature-registry';
import { discoverProviderModels } from '@/lib/ai/provider-discovery';
import { probeAiModel } from '@/lib/ai/provider-probe';
import { listRegistryModelFallbacks, mergeAiModelCatalogRows } from '@/lib/ai/model-catalog';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('AI Control Center feature registry', () => {
  // 2026-07-17: the front-desk surface retirement removed lost-found photo
  // description, lost-found match rerank, and package label scan (28→25);
  // the Recommendations tab added admin.model_recommendations (25→26).
  // 2026-07-19: reports.weekly_insight removed with the automatic report
  // emails (26→25 controllable, 34→33 keys).
  test('covers 25 controllable hosted features and 8 display-only features', () => {
    assert.equal(AI_FEATURE_KEYS.length, 33);
    assert.equal(new Set(AI_FEATURE_KEYS).size, AI_FEATURE_KEYS.length);
    assert.deepEqual(Object.keys(AI_FEATURE_REGISTRY).sort(), [...AI_FEATURE_KEYS].sort());

    const informational = AI_FEATURE_KEYS
      .map((key) => AI_FEATURE_REGISTRY[key])
      .filter((feature) => !feature.editable);
    assert.equal(informational.length, 8);
    for (const feature of informational) {
      assert.equal(feature.switchable, false);
      assert.equal(feature.modelSwitchable, false);
      assert.equal(feature.fallbackAllowed, false);
      assert.ok(
        feature.key === 'knowledge.embeddings'
        || feature.defaultConfig.primary.provider === 'browser'
        || feature.defaultConfig.primary.provider === 'in_house',
      );
    }
    for (const key of AI_FEATURE_KEYS) {
      const feature = AI_FEATURE_REGISTRY[key];
      assert.equal(feature.runtimeProvider, feature.defaultConfig.primary.provider);
    }
  });

  test('preserves every hosted feature model default and adds no automatic fallback', () => {
    const sonnet = [
      'agent.ask_staxis',
      'agent.memory_consolidation',
      'walkthrough.step_generation',
      'inventory.photo_count',
      'inventory.invoice_scan',
      'financials.invoice_scan',
      'financials.quote_scan',
      'compliance.photo_reading',
      'compliance.text_reading_parse',
      'compliance.setup_parse',
      'compliance.anomaly_phrasing',
      'communications.staxis_assistant',
    ] as const;
    const haiku = [
      'agent.conversation_summary',
      'communications.action_detection',
      'communications.unread_summary',
      'communications.announcement_polish',
      'communications.ui_translation',
      'communications.message_translation',
      'housekeeping.notice_translation',
      'communications.announcement_translation',
      'complaints.classification',
      'complaints.recovery_draft',
    ] as const;
    for (const key of sonnet) {
      assert.equal(getAiFeatureDefinition(key).defaultConfig.primary.modelId, 'claude-sonnet-4-6');
    }
    for (const key of haiku) {
      assert.equal(getAiFeatureDefinition(key).defaultConfig.primary.modelId, 'claude-haiku-4-5');
    }
    for (const key of ['reports.run_summary'] as const) {
      assert.equal(getAiFeatureDefinition(key).defaultConfig.primary.modelId, 'claude-haiku-4-5-20251001');
    }
    assert.equal(getAiFeatureDefinition('communications.voice_transcription').defaultConfig.primary.modelId, 'whisper-1');
    assert.equal(getAiFeatureDefinition('knowledge.embeddings').defaultConfig.primary.modelId, 'text-embedding-3-small');
    for (const key of AI_FEATURE_KEYS) assert.equal(getAiFeatureDefinition(key).defaultConfig.fallback, null);
  });

  test('known catalog pricing is verified while unknown Anthropic pricing stays explicitly estimated', () => {
    const models = listRegistryModelFallbacks();
    const sonnet5 = models.find((model) => model.modelId === 'claude-sonnet-5');
    const opus = models.find((model) => model.modelId === 'claude-opus-4-7');
    assert.equal(sonnet5?.pricing?.source, 'official-list-price');
    assert.equal(sonnet5?.pricing?.inputUsdPerMillionTokens, 3);
    assert.equal(sonnet5?.pricing?.outputUsdPerMillionTokens, 15);
    assert.equal(sonnet5?.pricing?.cachedInputUsdPerMillionTokens, 0.3);
    assert.equal(sonnet5?.pricing?.cacheCreation5mInputUsdPerMillionTokens, 3.75);
    assert.equal(sonnet5?.pricing?.cacheCreation1hInputUsdPerMillionTokens, 6);
    assert.equal(opus?.pricing?.inputUsdPerMillionTokens, 5);
    assert.equal(opus?.pricing?.outputUsdPerMillionTokens, 25);
  });

  test('locks embedding vector-space compatibility and flags the unwired daily-report endpoint', () => {
    const embeddings = getAiFeatureDefinition('knowledge.embeddings');
    assert.equal(embeddings.editable, false, 'shared protected OCR execution must stay outside admin control');
    assert.equal(embeddings.switchable, false, 'shared protected OCR execution cannot have an admin kill switch');
    assert.equal(embeddings.modelSwitchable, false);
    assert.equal(embeddings.fallbackAllowed, false);
    assert.match(embeddings.modelLockReason ?? '', /protected Knowledge OCR/i);
    assert.match(embeddings.modelLockReason ?? '', /re-index/i);
    // Plain-English copy (2026-07-17): the "can't change it here" signal moved
    // to "information only" wording.
    assert.match(embeddings.description, /information only/i);

    const daily = getAiFeatureDefinition('ml.daily_report_headcount');
    assert.equal(daily.availability, 'unavailable');
    assert.equal(daily.defaultConfig.enabled, false);
  });
});

describe('AI provider discovery and synthetic probes', () => {
  test('registry defaults remain visible before discovery and persisted provider rows win', () => {
    const fallbacks = listRegistryModelFallbacks();
    assert.ok(fallbacks.some((model) => model.modelId === 'claude-sonnet-4-6'));
    assert.ok(fallbacks.some((model) => model.modelId === 'claude-sonnet-5'));
    assert.ok(fallbacks.some((model) => model.modelId === 'whisper-1'));

    const persisted = {
      ...fallbacks.find((model) => model.modelId === 'claude-sonnet-4-6')!,
      displayName: 'Provider Claude Sonnet 4.6',
      source: 'provider+registry' as const,
      maxInputTokens: 999_999,
    };
    const anthropic = mergeAiModelCatalogRows([persisted], 'anthropic');
    assert.equal(
      anthropic.find((model) => model.modelId === 'claude-sonnet-4-6')?.displayName,
      'Provider Claude Sonnet 4.6',
    );
    assert.equal(
      anthropic.find((model) => model.modelId === 'claude-sonnet-4-6')?.maxInputTokens,
      999_999,
    );
    assert.ok(anthropic.every((model) => model.provider === 'anthropic'));
    assert.ok(anthropic.some((model) => model.modelId === 'claude-sonnet-5'));
  });

  test('OpenAI list metadata gets capabilities only from curated overlays', async () => {
    let forwardedSignal: AbortSignal | null | undefined;
    globalThis.fetch = async (_input, init) => {
      forwardedSignal = init?.signal;
      return new Response(JSON.stringify({
        data: [
          { id: 'whisper-1', created: 1, owned_by: 'openai', object: 'model' },
          { id: 'text-embedding-3-small', created: 2, owned_by: 'openai', object: 'model' },
          { id: 'brand-new-unclassified-model', created: 3, owned_by: 'openai', object: 'model' },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const controller = new AbortController();
    const models = await discoverProviderModels('openai', {
      abortSignal: controller.signal,
      deadlineAt: Date.now() + 5_000,
    });
    assert.ok(forwardedSignal);
    controller.abort();
    assert.equal(forwardedSignal?.aborted, true);
    assert.deepEqual(models.find((m) => m.modelId === 'whisper-1')?.capabilities, ['audio_transcription']);
    assert.deepEqual(models.find((m) => m.modelId === 'text-embedding-3-small')?.capabilities, ['embeddings']);
    const unknown = models.find((m) => m.modelId === 'brand-new-unclassified-model');
    assert.deepEqual(unknown?.capabilities, []);
    assert.equal(unknown?.pricing, null);
  });

  test('embedding smoke probe requires a finite vector with exactly 1536 dimensions', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      data: [{ embedding: Array.from({ length: 1536 }, () => 0.01) }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const valid = await probeAiModel(
      { provider: 'openai', modelId: 'text-embedding-3-small' },
      ['embeddings'],
    );
    assert.equal(valid.ok, true);

    globalThis.fetch = async () => new Response(JSON.stringify({
      data: [{ embedding: [0.1, 0.2] }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const invalid = await probeAiModel(
      { provider: 'openai', modelId: 'text-embedding-3-small' },
      ['embeddings'],
    );
    assert.equal(invalid.ok, false);
    assert.match(invalid.error ?? '', /1536/);
  });

  test('transcription smoke probe accepts a valid response without requiring speech in silence', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ text: '' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const result = await probeAiModel(
      { provider: 'openai', modelId: 'whisper-1' },
      ['audio_transcription'],
    );
    assert.equal(result.ok, true);
  });
});

test('model discovery is bounded beneath the admin refresh route ceiling', () => {
  const discovery = readFileSync(
    join(process.cwd(), 'src/lib/ai/provider-discovery.ts'),
    'utf8',
  );
  assert.match(discovery, /PROVIDER_LIST_TIMEOUT_MS = 20_000/);
  assert.match(discovery, /maxRetries:\s*0/);
  assert.match(discovery, /models\.list\(\{ limit: 100 \}, \{ signal: request\.signal \}\)/);
  assert.match(discovery, /AbortSignal\.any\(\[opts\.abortSignal, timeoutSignal\]\)/);

  const route = readFileSync(
    join(process.cwd(), 'src/app/api/admin/ai-control/models/refresh/route.ts'),
    'utf8',
  );
  assert.match(route, /REFRESH_EXECUTION_BUDGET_MS = 25_000/);
  assert.match(route, /const refreshDeadlineAt = Date\.now\(\) \+ REFRESH_EXECUTION_BUDGET_MS/);
  assert.match(route, /deadlineAt:\s*refreshDeadlineAt/);
  assert.match(route, /abortSignal:\s*req\.signal/);
});

test('0313 migration pins service-role RLS, immutable history, and atomic audited activation', () => {
  const sql = readFileSync(
    join(process.cwd(), 'supabase', 'migrations', '0313_ai_control_center.sql'),
    'utf8',
  );
  assert.match(sql, /ai_model_catalog_deny_browser/);
  assert.match(sql, /ai_feature_config_versions_deny_browser/);
  assert.match(sql, /revoke all on public\.ai_feature_config_versions from public, anon, authenticated/i);
  assert.match(sql, /revoke all on public\.ai_feature_config_versions from service_role[\s\S]*grant select on public\.ai_feature_config_versions to service_role/i);
  assert.match(sql, /revoke all on public\.ai_model_catalog from service_role[\s\S]*grant select on public\.ai_model_catalog to service_role/i);
  assert.doesNotMatch(sql, /grant\s+(?:select,\s*)?(?:insert|update|delete)[^;]*ai_(?:feature_config_versions|model_catalog)[^;]*service_role/i);
  assert.match(sql, /ai_feature_config_one_active_uq[\s\S]*where is_active = true/i);
  assert.match(sql, /ai_feature_config_active_must_be_valid[\s\S]*not is_active or validation_status = 'passed'/i);
  assert.match(sql, /ai_feature_config_immutable_guard/);
  const immutableGuard = sql.slice(
    sql.indexOf('create or replace function public.staxis_guard_ai_feature_config_immutable'),
    sql.indexOf('drop trigger if exists ai_feature_config_immutable_guard'),
  );
  assert.doesNotMatch(
    immutableGuard,
    /new\.created_by\s+is distinct from old\.created_by/,
    'accounts ON DELETE SET NULL must not be blocked by the immutable payload trigger',
  );
  assert.match(immutableGuard, /new\.created_by_email\s+is distinct from old\.created_by_email/);
  assert.match(sql, /ai_feature_config_no_delete/);
  assert.match(sql, /staxis_activate_ai_feature_config[\s\S]*security definer/i);
  assert.match(sql, /staxis_create_ai_feature_config[\s\S]*security definer/i);
  assert.match(sql, /staxis_record_ai_feature_validation[\s\S]*security definer/i);
  assert.match(sql, /staxis_refresh_ai_model_catalog[\s\S]*security definer/i);
  assert.match(sql, /p_expected_active_id is distinct from v_previous_id/i);
  assert.match(sql, /ai_config_activation_actor_required/i);
  assert.match(sql, /ai_config_activation_request_id_required/i);
  assert.match(sql, /created_by_email[\s\S]*validated_by_email|validated_by_email[\s\S]*created_by_email/i);
  assert.match(sql, /activated_by_email/i);
  assert.match(sql, /insert into public\.admin_audit_log/i);
  const seedSection = sql.slice(0, sql.indexOf('create or replace function public.staxis_create_ai_feature_config'));
  assert.doesNotMatch(seedSection, /insert into public\.ai_feature_config_versions/i, 'migration must not activate or seed an override');
  assert.match(sql, /staxis_create_ai_feature_config[\s\S]*insert into public\.admin_audit_log/i);
  assert.match(sql, /staxis_record_ai_feature_validation[\s\S]*insert into public\.admin_audit_log/i);
  assert.match(sql, /staxis_refresh_ai_model_catalog[\s\S]*insert into public\.admin_audit_log/i);
  assert.match(
    sql,
    /pg_advisory_xact_lock\(hashtextextended\('ai-model-catalog:'[\s\S]*jsonb_array_elements\(p_models\)[\s\S]*catalog\.model_id/i,
    'provider removals must be derived from the submitted snapshot inside the locked refresh RPC',
  );
  assert.match(sql, /"cacheCreation5mInputUsdPerMillionTokens":3\.75/);
  assert.match(sql, /"cacheCreation1hInputUsdPerMillionTokens":6/);
  assert.match(sql, /values \('0313'/i);
});

test('active runtime hydration rejects provider models marked unavailable without hiding history', () => {
  const source = readFileSync(
    join(process.cwd(), 'src', 'lib', 'ai', 'model-config-store.ts'),
    'utf8',
  );
  assert.match(
    source,
    /if\s*\(!catalog\.available\)\s*return\s*\{\s*model:\s*null,\s*explicitlyUnavailable:\s*true\s*\}/,
    'active runtime hydration must reject catalog rows removed by the provider',
  );
  assert.match(
    source,
    /hydrateRuntimeModelRef\(base\.primary\)/,
  );
  assert.match(
    source,
    /mapConfigRow[\s\S]*hydrateModelRef\(base\.primary\)[\s\S]*loadActiveConfigs/,
    'history mapping should still hydrate unavailable/retired model metadata',
  );
  assert.match(
    source,
    /providerRemovedSelection\s*\?\s*failClosedResolvedConfig[\s\S]*:\s*preserveOrFailClosed\(\)/,
    'an explicit provider removal must safety-lock instead of preserving a stale runnable model',
  );
  assert.match(
    source,
    /defaultResolvedConfigWithCatalogSafety[\s\S]*primary\?\.available\s*===\s*false[\s\S]*failClosedResolvedConfig/,
    'a removed code-default model must safety-lock even before any admin override exists',
  );

  const catalogSource = readFileSync(
    join(process.cwd(), 'src', 'lib', 'ai', 'model-catalog.ts'),
    'utf8',
  );
  assert.match(
    catalogSource,
    /catch\s*\{[\s\S]*catalogCache\?\.rows\.find[\s\S]*if\s*\(cached\)\s*return cached[\s\S]*overlayFallback/,
    'catalog outages must preserve a cached unavailable state before using a static overlay',
  );
});
