import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  AI_FEATURE_KEYS,
  AI_FEATURE_REGISTRY,
  AI_MODEL_OVERLAYS,
  getAiFeatureDefinition,
  isAiFeatureRuntimeProviderCompatible,
} from '@/lib/ai/feature-registry';
import { discoverProviderModels } from '@/lib/ai/provider-discovery';
import { probeAiModel } from '@/lib/ai/provider-probe';
import { listRegistryModelFallbacks, mergeAiModelCatalogRows } from '@/lib/ai/model-catalog';
import { captureTokenUsage } from '@/lib/ai/usage';
import { isRuntimeCompatibleAiModel } from '@/app/admin/_components/AIControlCenter.helpers';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('AI Control Center feature registry', () => {
  // 2026-07-17: the front-desk surface retirement removed lost-found photo
  // description, lost-found match rerank, and package label scan (28→25);
  // the retired Recommendations tab briefly added an administrative-only row.
  // 2026-07-19: reports.weekly_insight removed with the automatic report
  // emails (26→25 controllable, 34→33 keys); the compliance section removal
  // took compliance.photo_reading/text_reading_parse/setup_parse/
  // anomaly_phrasing + speech.engineer_dictation (25→21 controllable,
  // display-only 8→7, 33→28 keys).
  // 2026-07-24: the Housekeeping setup questionnaire added
  // housekeeping.board_photo_read (21→22 controllable, 28→29 keys).
  // 2026-07-26: the findings layer's nightly judge added findings.judge
  // (22→23 controllable, 30→31 keys). It defaults to Haiku on purpose — it
  // sorts and phrases, it never authors a number.
  // 2026-07-26: the findings layer's weekly discovery pass added findings.sweep
  // (23→24 controllable, 31→32 keys). Haiku for the same reason: it picks from
  // a closed list of checks and everything it suggests is re-tested by a
  // deterministic query before it can reach anyone.
  // 2026-07-26: the morning brief's wording pass added findings.brief (24→25
  // controllable, 32→33 keys). Haiku, and deliberately not load-bearing: the
  // brief is assembled from stored numbers before this feature is consulted,
  // and the prose guard throws the rewrite away whole if it invents a figure.
  // 2026-07-26: cross-hotel chat added agent.portfolio_chat (25→26 controllable,
  // 33→34 keys). Its own row rather than a share of Ask Staxis so an operator can
  // move or switch off the company-wide surface without touching the copilot
  // every hotel uses every day.
  // 2026-07-27: knowledge.document_ocr became a real feature (27→28 controllable,
  // 34→35 keys). It already existed as a ledger-only label because the model was
  // pinned inside the Fly robot; reading scans moved on-box when that robot was
  // decommissioned, so there is now a model to switch and a card to show it on.
  // 2026-07-27: the "Catch up" screen removal took its only consumer with it, so
  // communications.unread_summary left too (28→27 controllable, 35→34 keys). A
  // registry entry with no call site is a knob on the AI Control Center that
  // switches nothing — the operator changes its model, saves, and no behaviour
  // anywhere moves. Past spend booked under the key is unaffected: see
  // mission-control-ai-staff-roster.test.ts, "a de-registered feature's history".
  // (The title said 27 while the registry held 28 for a few hours between those
  // two commits — only the title, which nothing asserts. It is true again now.)
  // 2026-07-29: the built-in language selector and automatic app-chrome
  // translation were retired, removing communications.ui_translation. Direct
  // team-message translation remains independently available (27→26
  // controllable, 34→33 keys).
  // 2026-07-30: the administrative Model Recommendations feature and tab were
  // removed (26→25 controllable, 33→32 keys). Historical database rows remain
  // inert by design; removing them would require an out-of-scope migration.
  // 2026-08-01: the companion bubble got its own conversation slot so its
  // model can be chosen without moving the main chat bar (25→26 controllable,
  // 32→33 keys). Display-only count is unchanged.
  test('covers 26 controllable hosted features and 7 display-only features', () => {
    assert.equal(AI_FEATURE_KEYS.length, 33);
    assert.equal(new Set(AI_FEATURE_KEYS).size, AI_FEATURE_KEYS.length);
    assert.deepEqual(Object.keys(AI_FEATURE_REGISTRY).sort(), [...AI_FEATURE_KEYS].sort());

    const informational = AI_FEATURE_KEYS
      .map((key) => AI_FEATURE_REGISTRY[key])
      .filter((feature) => !feature.editable);
    assert.equal(informational.length, 7);
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
      'communications.staxis_assistant',
    ] as const;
    const haiku = [
      'agent.conversation_summary',
      'communications.action_detection',
      'communications.announcement_polish',
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

test('Model Recommendations is absent from the Control Center feature surface and owned code', () => {
  const root = process.cwd();
  assert.equal(existsSync(join(root, 'src/lib/ai/recommendations.ts')), false);
  assert.equal(existsSync(join(root, 'src/app/api/admin/ai-control/recommendations/route.ts')), false);
  assert.ok(!AI_FEATURE_KEYS.includes('admin.model_recommendations' as never));

  for (const path of [
    'src/app/admin/_components/AIControlCenter.tsx',
    'src/lib/ai/feature-registry.ts',
    'src/lib/ai/types.ts',
    'src/lib/api-ratelimit.ts',
    'src/app/api/admin/doctor/route.ts',
  ]) {
    const source = readFileSync(join(root, path), 'utf8');
    assert.doesNotMatch(source, /admin\.model_recommendations|AiRecommendation|recommendations\/route|Model Recommendations/i, path);
  }
});

test('whole-center header controls retain accessible focus, responsive, and draft workflow contracts', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/app/admin/_components/AIControlCenter.tsx'),
    'utf8',
  );
  const enableIndex = source.indexOf('className={styles.headerEnable}');
  const modelsIndex = source.indexOf('className={styles.headerModelButton}');
  const closeIndex = source.indexOf('className={styles.closeButton}', modelsIndex);
  assert.ok(enableIndex > 0 && modelsIndex > enableIndex && closeIndex > modelsIndex);
  assert.match(source, /type="checkbox"[\s\S]*aria-label="Stage all controllable AI features/);
  assert.match(source, /aria-haspopup="dialog"/);
  assert.match(source, /role="dialog"[\s\S]*aria-modal="true"/);
  assert.match(source, /Apply to drafts/);
  assert.match(source, /Test each changed feature before making it live/);
  assert.match(source, /globalModelsOpenRef\.current \? globalModelsDialogRef\.current : dialogRef\.current/);

  const css = readFileSync(
    join(process.cwd(), 'src/app/admin/_components/AIControlCenter.module.css'),
    'utf8',
  );
  assert.match(css, /\.headerEnable[\s\S]*min-height:\s*44px/);
  assert.match(css, /\.headerModelButton[\s\S]*min-height:\s*44px/);
  assert.match(css, /\.headerEnable:focus-within/);
  assert.match(css, /\.headerModelButton:focus-visible/);
  assert.match(css, /@media \(max-width:\s*1040px\)/);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)/);
});

test('Models tab and every model picker share the curated usable catalog without technical clutter', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/app/admin/_components/AIControlCenter.tsx'),
    'utf8',
  );
  assert.match(source, /curateSelectableAiModels\(models, configuredProviders\)/);
  assert.match(source, /const globalPickerModels = useMemo\(\(\) => selectableModels\.filter/);
  assert.match(source, /<FeaturesPanel[\s\S]*models=\{selectableModels\}/);
  assert.match(source, /<ModelsPanel[\s\S]*selectableModels=\{selectableModels\}/);
  assert.match(source, /disabled=\{!model\.available\}[\s\S]*current\/legacy, choose another model/);

  const modelCard = source.slice(source.indexOf('function ModelCard'), source.indexOf('function HistoryPanel'));
  assert.match(modelCard, /model\.displayName/);
  assert.match(modelCard, /providerLabel\(model\.provider\)/);
  assert.match(modelCard, />Input<strong>\{inputPrice\}/);
  assert.match(modelCard, />Output<strong>\{outputPrice\}/);
  assert.match(modelCard, /Current · legacy only/);
  assert.doesNotMatch(modelCard, /Max input|Max output|Context window|Released|Capabilities|Catalog source|cache write/i);

  const route = readFileSync(
    join(process.cwd(), 'src/app/api/admin/ai-control/models/route.ts'),
    'utf8',
  );
  assert.match(route, /configuredProviders:\s*AI_DISCOVERABLE_PROVIDERS\.filter\(isMessagesProviderConfigured\)/);
});

// ─── Which providers may serve a feature ────────────────────────────────────
//
// Until 2026-07-26 the answer was "whichever one supplied the default model",
// so every text feature was pinned to Anthropic by an accident of history. It
// is now derived from what each provider's ADAPTER implements.

describe('feature/provider compatibility reflects real adapter capability', () => {
  test('text and tool features can run on either chat provider', () => {
    for (const key of ['agent.ask_staxis', 'findings.judge', 'communications.message_translation'] as const) {
      const feature = getAiFeatureDefinition(key);
      assert.ok(
        isAiFeatureRuntimeProviderCompatible(key, 'openai'),
        `${key} should be selectable on OpenAI — it needs only ${feature.requiredCapabilities.join('+')}`,
      );
      assert.ok(isAiFeatureRuntimeProviderCompatible(key, 'anthropic'));
    }
  });

  test('a feature that needs PDF reading stays Anthropic-only', () => {
    // The OpenAI adapter translates no document block. Offering GPT here would
    // produce a blank extraction that looks like a successful one.
    for (const key of ['inventory.invoice_scan', 'knowledge.fact_extraction', 'knowledge.document_ocr'] as const) {
      assert.ok(getAiFeatureDefinition(key).requiredCapabilities.includes('pdf_input'));
      assert.equal(isAiFeatureRuntimeProviderCompatible(key, 'openai'), false);
      assert.equal(isAiFeatureRuntimeProviderCompatible(key, 'anthropic'), true);
    }
  });

  test('image features without PDF needs are open to both', () => {
    for (const key of ['inventory.photo_count', 'financials.invoice_scan', 'housekeeping.board_photo_read'] as const) {
      assert.equal(getAiFeatureDefinition(key).requiredCapabilities.includes('pdf_input'), false);
      assert.ok(isAiFeatureRuntimeProviderCompatible(key, 'openai'));
    }
  });

  test('locked and non-chat features are never widened', () => {
    // Embeddings share a versioned vector space; the browser and in-house
    // entries are not model APIs at all. None may drift onto a chat provider.
    assert.deepEqual([...getAiFeatureDefinition('knowledge.embeddings').runtimeProviders], ['openai']);
    assert.deepEqual([...getAiFeatureDefinition('speech.ask_staxis_dictation').runtimeProviders], ['browser']);
    assert.deepEqual([...getAiFeatureDefinition('ml.housekeeping_demand').runtimeProviders], ['in_house']);
    // Declares NO required capabilities, which would vacuously match every
    // provider if the lock were not honoured first.
    assert.deepEqual([...getAiFeatureDefinition('ml.daily_report_headcount').runtimeProviders], ['in_house']);
    // Transcription is a separate OpenAI endpoint; Anthropic cannot serve it.
    assert.deepEqual([...getAiFeatureDefinition('communications.voice_transcription').runtimeProviders], ['openai']);
  });

  test('every feature can run on the provider of its own default model', () => {
    // A feature whose picker excluded the model currently serving production
    // would be a silent trap. runtimeProvidersFor throws at module load on
    // this; the assertion documents the invariant.
    for (const key of AI_FEATURE_KEYS) {
      const feature = AI_FEATURE_REGISTRY[key];
      assert.ok(
        feature.runtimeProviders.includes(feature.defaultConfig.primary.provider),
        `${key} excludes its own default provider`,
      );
      assert.ok(feature.runtimeProviders.length >= 1);
    }
  });
});

describe('OpenAI model pricing honesty', () => {
  const openAiOverlays = AI_MODEL_OVERLAYS.filter((overlay) => overlay.provider === 'openai');

  test('every priced OpenAI chat model cites a source and a date', () => {
    const chatModels = openAiOverlays.filter((o) => o.capabilities.includes('text'));
    assert.ok(chatModels.length >= 10, 'the curated OpenAI chat list should not be empty');
    for (const overlay of chatModels) {
      const pricing = overlay.pricing;
      assert.ok(pricing, `${overlay.modelId} must carry pricing to be selectable`);
      assert.equal(typeof pricing.inputUsdPerMillionTokens, 'number');
      assert.equal(typeof pricing.outputUsdPerMillionTokens, 'number');
      // "No number without a receipt": the receipt is the published sheet.
      assert.match(pricing.source, /^https:\/\/developers\.openai\.com\/api\/docs\/pricing$/);
      assert.match(pricing.asOf, /^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test('no OpenAI cache-write rate is invented', () => {
    // OpenAI publishes input / cached-input / output and charges nothing to
    // POPULATE a cache. An absent line item is not a published zero, so the
    // creation fields stay undefined and the estimator's conservative fallback
    // covers the case that cannot occur (the adapter always reports 0).
    for (const overlay of openAiOverlays) {
      assert.equal(overlay.pricing?.cacheCreation5mInputUsdPerMillionTokens, undefined);
      assert.equal(overlay.pricing?.cacheCreation1hInputUsdPerMillionTokens, undefined);
    }
  });

  test('a discovered model with no published price is unpriced and unselectable', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: [
        { id: 'gpt-5.4-mini', created: 1_770_000_000, object: 'model', owned_by: 'openai' },
        // Still served by the API, no longer on the published price sheet.
        { id: 'gpt-5.1', created: 1_760_000_000, object: 'model', owned_by: 'openai' },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;

    const models = await discoverProviderModels('openai');
    const priced = models.find((m) => m.modelId === 'gpt-5.4-mini');
    const unpriced = models.find((m) => m.modelId === 'gpt-5.1');

    assert.ok(priced?.pricing, 'a curated model keeps its verified price');
    assert.ok(priced.capabilities.includes('text'));

    // The honest outcome for a model we cannot price: no capabilities, so it
    // satisfies no feature's requirements and never reaches the picker. We do
    // not guess a rate and we do not run a hotel's spend through it.
    assert.equal(unpriced?.pricing, null);
    assert.deepEqual(unpriced?.capabilities, []);
    assert.equal(
      isRuntimeCompatibleAiModel(
        { runtimeProviders: ['anthropic', 'openai'], requiredCapabilities: ['text'] },
        { provider: 'openai', available: true, capabilities: unpriced?.capabilities ?? [] },
      ),
      false,
    );
  });

  test('an unpriced model cannot produce a costed ledger row', () => {
    // captureTokenUsage is the only way OpenAI usage reaches agent_costs. With
    // no pricing it throws rather than booking the turn at $0 — spend that
    // silently reads as free is worse than a loud failure.
    assert.throws(
      () => captureTokenUsage([], { provider: 'openai', modelId: 'gpt-5.1', pricing: null }, 'gpt-5.1', {
        input_tokens: 1000, output_tokens: 500,
      }),
      /Missing pricing for openai\/gpt-5\.1/,
    );
  });
});

describe('missing provider key is loud, never a silent empty feature', () => {
  test('the configured check and the throwing factory agree', async () => {
    const { getMessagesClient, getMessagesClientIfConfigured, isMessagesProviderConfigured, resetMessagesClientCache } =
      await import('@/lib/ai/messages-client');
    resetMessagesClientCache();

    // npm test injects a placeholder OPENAI_API_KEY and no ANTHROPIC_API_KEY,
    // which makes this suite a real test of both branches.
    assert.equal(isMessagesProviderConfigured('openai'), true);
    assert.equal(isMessagesProviderConfigured('anthropic'), false);

    // Best-effort surfaces get null and degrade quietly.
    assert.equal(getMessagesClientIfConfigured('anthropic'), null);
    assert.ok(getMessagesClientIfConfigured('openai'));

    // Surfaces with no degraded answer get a named, actionable error.
    assert.throws(() => getMessagesClient('anthropic'), /ANTHROPIC_API_KEY is not set/);
    // A provider with no model API at all is refused outright.
    assert.throws(() => getMessagesClient('browser'), /no model API/);
    resetMessagesClientCache();
  });

  test('an OpenAI probe reports unavailable rather than passing silently', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      error: { message: 'Incorrect API key provided' },
    }), { status: 401, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;

    const result = await probeAiModel({ provider: 'openai', modelId: 'gpt-5.4-mini' }, ['text']);
    assert.equal(result.ok, false);
    assert.equal(result.kind, 'openai_message');
    assert.match(result.error ?? '', /OpenAI/);
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
  assert.match(route, /deadlineAt:\s*ctx\.refreshDeadlineAt/);
  assert.match(route, /abortSignal:\s*ctx\.req\.signal/);
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
