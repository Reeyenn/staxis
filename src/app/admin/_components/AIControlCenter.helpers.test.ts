import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  CURATED_AI_MODEL_IDS,
  CURATED_AI_MODEL_PROVIDER_CAP,
  NO_FALLBACK,
  curateSelectableAiModels,
  describeConfigChange,
  draftFromConfig,
  essentialAiModelRates,
  findStaleModelProviders,
  formatAiCatalogDate,
  groupAiFeatures,
  hasAiConfigBaseChanged,
  isAiFeatureDraftDirty,
  isRuntimeCompatibleAiModel,
  modelRefKey,
  modelsForControlCenterPresentation,
  normalizeAiSearchText,
  parseModelRefKey,
  planGlobalModelDrafts,
  stageGlobalEnabledDrafts,
} from './AIControlCenter.helpers';
import type {
  AiCapability,
  AiFeatureKey,
  AiFeatureSummary,
  AiHostedProvider,
  AiModelCatalogEntry,
  AiProvider,
} from '@/lib/ai/types';

function makeModel(
  modelId: string,
  provider: AiHostedProvider = 'openai',
  overrides: Partial<AiModelCatalogEntry> = {},
): AiModelCatalogEntry {
  return {
    provider,
    modelId,
    displayName: modelId,
    status: 'available',
    available: true,
    capabilities: ['text', 'tool_use'],
    maxInputTokens: 128_000,
    maxOutputTokens: 16_000,
    releasedAt: '2026-01-01',
    pricing: {
      inputUsdPerMillionTokens: 2.5,
      outputUsdPerMillionTokens: 15,
      cachedInputUsdPerMillionTokens: 0.25,
      source: 'https://provider.example/pricing',
      asOf: '2026-07-01',
    },
    source: 'provider+registry',
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

interface FeatureFixtureOptions {
  key?: AiFeatureKey;
  provider?: AiProvider;
  modelId?: string;
  enabled?: boolean;
  editable?: boolean;
  switchable?: boolean;
  modelSwitchable?: boolean;
  fallbackAllowed?: boolean;
  availability?: 'available' | 'unavailable';
  runtimeProviders?: readonly AiProvider[];
  requiredCapabilities?: AiCapability[];
}

function makeFeature(options: FeatureFixtureOptions = {}): AiFeatureSummary {
  const key = options.key ?? 'agent.ask_staxis';
  const provider = options.provider ?? 'openai';
  const primary = {
    provider,
    modelId: options.modelId ?? (provider === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-5.4-mini'),
    pricing: null,
  };
  const enabled = options.enabled ?? true;
  return {
    key,
    label: key,
    description: `${key} fixture`,
    group: key.startsWith('knowledge.') ? 'Knowledge' : 'Agent',
    runtimeProvider: provider,
    runtimeProviders: options.runtimeProviders ?? [provider],
    editable: options.editable ?? true,
    switchable: options.switchable ?? true,
    modelSwitchable: options.modelSwitchable ?? true,
    fallbackAllowed: options.fallbackAllowed ?? true,
    availability: options.availability ?? 'available',
    requiredCapabilities: options.requiredCapabilities ?? ['text'],
    defaultConfig: { enabled, primary, fallback: null, parameters: {} },
    activeConfig: {
      featureKey: key,
      enabled,
      primary,
      fallback: null,
      parameters: {},
      source: 'default',
      versionId: null,
      version: null,
    },
  };
}

test('runtime-compatible model filtering requires provider and capabilities', () => {
  // A feature only Anthropic can run (it needs PDF reading, which the OpenAI
  // adapter does not translate).
  const anthropicOnly = { runtimeProviders: ['anthropic'], requiredCapabilities: ['text', 'pdf_input'] };
  assert.equal(isRuntimeCompatibleAiModel(anthropicOnly, {
    provider: 'anthropic', available: true, capabilities: ['text', 'pdf_input', 'tool_use'],
  }), true);
  assert.equal(isRuntimeCompatibleAiModel(anthropicOnly, {
    provider: 'openai', available: true, capabilities: ['text', 'pdf_input'],
  }), false);
  assert.equal(isRuntimeCompatibleAiModel(anthropicOnly, {
    provider: 'anthropic', available: true, capabilities: ['text'],
  }), false);
});

test('a feature both providers can run offers models from either', () => {
  const eitherProvider = {
    runtimeProviders: ['anthropic', 'openai'],
    requiredCapabilities: ['text', 'tool_use'],
  };
  assert.equal(isRuntimeCompatibleAiModel(eitherProvider, {
    provider: 'openai', available: true, capabilities: ['text', 'tool_use', 'image_input'],
  }), true);
  assert.equal(isRuntimeCompatibleAiModel(eitherProvider, {
    provider: 'anthropic', available: true, capabilities: ['text', 'tool_use'],
  }), true);
  // Capability gating still applies per model: a discovered OpenAI model with
  // no curated overlay has no capabilities and must stay unselectable, because
  // we can neither price it nor vouch for what it can do.
  assert.equal(isRuntimeCompatibleAiModel(eitherProvider, {
    provider: 'openai', available: true, capabilities: [],
  }), false);
  // An unavailable model is never offered, whatever it can do.
  assert.equal(isRuntimeCompatibleAiModel(eitherProvider, {
    provider: 'openai', available: false, capabilities: ['text', 'tool_use'],
  }), false);
});

const active = {
  enabled: true,
  primary: { provider: 'anthropic', modelId: 'claude-sonnet-5' },
  fallback: { provider: 'anthropic', modelId: 'claude-haiku-4-5' },
};

describe('AI Control Center helpers', () => {
  test('model reference keys round-trip without losing provider or model id', () => {
    const key = modelRefKey(active.primary);
    assert.equal(key, 'anthropic::claude-sonnet-5');
    assert.deepEqual(parseModelRefKey(key), active.primary);
    assert.equal(parseModelRefKey(NO_FALLBACK), null);
    assert.equal(parseModelRefKey('broken'), null);
  });

  test('draft dirty check ignores the audit note and compares runtime fields', () => {
    const draft = draftFromConfig(active);
    draft.changeReason = 'Just documenting the current setup';
    assert.equal(isAiFeatureDraftDirty(active, draft), false);
    draft.fallbackKey = NO_FALLBACK;
    assert.equal(isAiFeatureDraftDirty(active, draft), true);
  });

  test('server base change detection catches concurrent versions without treating identical bases as changed', () => {
    const first = { ...active, versionId: 'version-1', source: 'database', parameters: { temperature: 0 } };
    assert.equal(hasAiConfigBaseChanged(first, { ...first }), false);
    assert.equal(hasAiConfigBaseChanged(first, { ...first, versionId: 'version-2' }), true);
    assert.equal(hasAiConfigBaseChanged(first, {
      ...first,
      primary: { provider: 'anthropic', modelId: 'claude-sonnet-5-1' },
    }), true);
  });

  test('catalog dates preserve date-only and month-only precision without timezone shifting', () => {
    assert.equal(formatAiCatalogDate('2026-07'), 'Jul 2026');
    assert.equal(formatAiCatalogDate('2026-07-01'), 'Jul 1, 2026');
    assert.equal(formatAiCatalogDate('2026-02-30'), '—');
    assert.equal(normalizeAiSearchText(' Image_Input  '), 'image input');
    assert.equal(normalizeAiSearchText('image-input'), 'image input');
  });

  test('feature search covers labels, descriptions, groups, stable keys, and active model use', () => {
    const features = [
      {
        key: 'inventory.photo_count',
        label: 'Count inventory photos',
        description: 'Reads shelf photos',
        group: 'Inventory',
        activeConfig: {
          primary: { provider: 'anthropic', modelId: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6' },
          fallback: { provider: 'openai', modelId: 'gpt-5-mini', displayName: 'GPT-5 mini' },
        },
      },
      {
        key: 'comms.translate',
        label: 'Translate messages',
        description: 'English and Spanish',
        group: 'Communications',
      },
    ];
    assert.equal(groupAiFeatures(features, 'shelf')[0]?.features[0]?.key, 'inventory.photo_count');
    assert.equal(groupAiFeatures(features, 'communications')[0]?.features[0]?.key, 'comms.translate');
    assert.equal(groupAiFeatures(features, 'comms.translate')[0]?.features[0]?.key, 'comms.translate');
    assert.equal(groupAiFeatures(features, 'sonnet-4-6')[0]?.features[0]?.key, 'inventory.photo_count');
    assert.equal(groupAiFeatures(features, 'openai')[0]?.features[0]?.key, 'inventory.photo_count');
    assert.equal(groupAiFeatures(features, 'gpt-5 mini')[0]?.features[0]?.key, 'inventory.photo_count');
  });

  test('groups and rows are presented alphabetically for a stable scan order', () => {
    const grouped = groupAiFeatures([
      { key: 'z', label: 'Zulu', description: '', group: 'Reports' },
      { key: 'a', label: 'Alpha', description: '', group: 'Inventory' },
      { key: 'b', label: 'Beta', description: '', group: 'Inventory' },
    ], '');
    assert.deepEqual(grouped.map((group) => group.group), ['Inventory', 'Reports']);
    assert.deepEqual(grouped[0]?.features.map((feature) => feature.label), ['Alpha', 'Beta']);
  });

  test('change description is concise and audit-friendly', () => {
    const draft = draftFromConfig(active);
    draft.enabled = false;
    draft.primaryKey = 'openai::gpt-5';
    draft.fallbackKey = NO_FALLBACK;
    assert.equal(
      describeConfigChange('Photo counting', active, draft),
      'Photo counting: disabled, changed primary model, removed fallback',
    );
  });

  test('catalog refresh targets only missing or stale providers', () => {
    const now = Date.parse('2026-07-15T18:00:00.000Z');
    const models = [
      { provider: 'anthropic', lastSeenAt: '2026-07-15T17:00:00.000Z' },
      { provider: 'openai', lastSeenAt: '2026-07-14T18:00:00.000Z' },
    ];
    assert.deepEqual(
      findStaleModelProviders(['anthropic', 'openai'], models, now),
      ['openai'],
    );
    assert.deepEqual(
      findStaleModelProviders(['anthropic', 'openai'], models.slice(0, 1), now),
      ['openai'],
    );
  });

  test('curated choices fail closed and cap each configured provider at 20', () => {
    const validMain = makeModel('gpt-5.4-mini');
    const validAudio = makeModel('whisper-1', 'openai', {
      capabilities: ['audio_transcription'],
      pricing: { usdPerAudioMinute: 0.006, source: 'official', asOf: '2026-07-01' },
    });
    const models = [
      validMain,
      validAudio,
      makeModel('gpt-5.4', 'openai', { available: false, status: 'unavailable' }),
      makeModel('gpt-5.5', 'openai', { source: 'registry' }),
      makeModel('gpt-5.6-sol', 'openai', { source: 'provider' }),
      makeModel('gpt-5.4-nano', 'openai', { pricing: null }),
      makeModel('gpt-5.4-pro', 'openai', { capabilities: [] }),
      makeModel('provider-long-tail-model'),
      makeModel('claude-sonnet-5', 'anthropic'),
    ];

    const openAiOnly = curateSelectableAiModels(models, ['openai']);
    assert.deepEqual(openAiOnly.map((model) => model.modelId), ['gpt-5.4-mini', 'whisper-1']);
    assert.ok(openAiOnly.every((model) => model.available && model.source === 'provider+registry'));
    assert.ok(openAiOnly.filter((model) => model.provider === 'openai').length <= CURATED_AI_MODEL_PROVIDER_CAP);
    assert.ok(CURATED_AI_MODEL_IDS.openai.length <= CURATED_AI_MODEL_PROVIDER_CAP);

    const bothProviders = curateSelectableAiModels(models, ['openai', 'anthropic']);
    assert.ok(bothProviders.some((model) => model.modelId === 'claude-sonnet-5'));
    assert.ok(!bothProviders.some((model) => model.modelId === 'provider-long-tail-model'));
  });

  test('a selected model outside the curated list remains visible only as a legacy current value', () => {
    const main = makeModel('gpt-5.4-mini');
    const legacy = makeModel('gpt-4-legacy', 'openai', {
      status: 'unavailable',
      available: false,
      source: 'registry',
    });
    const feature = makeFeature({ modelId: legacy.modelId });
    const displayed = modelsForControlCenterPresentation([main, legacy], [main], [feature]);
    assert.equal(displayed.find(({ model }) => model.modelId === main.modelId)?.currentOnly, false);
    assert.equal(displayed.find(({ model }) => model.modelId === legacy.modelId)?.currentOnly, true);
    assert.ok(!curateSelectableAiModels([main, legacy], ['openai']).some((model) => model.modelId === legacy.modelId));
  });

  test('essential price fields stay exact while technical cache details stay out of the presentation contract', () => {
    assert.deepEqual(essentialAiModelRates({
      inputUsdPerMillionTokens: 1.25,
      outputUsdPerMillionTokens: 9.5,
      cachedInputUsdPerMillionTokens: 0.125,
      cacheCreation5mInputUsdPerMillionTokens: 2,
      source: 'official',
      asOf: '2026-07-01',
    }), {
      inputUsdPerMillionTokens: 1.25,
      outputUsdPerMillionTokens: 9.5,
      audioUsdPerMinute: null,
    });
    assert.deepEqual(essentialAiModelRates({
      usdPerAudioMinute: 0.006,
      source: 'official',
      asOf: '2026-07-01',
    }), {
      inputUsdPerMillionTokens: null,
      outputUsdPerMillionTokens: null,
      audioUsdPerMinute: 0.006,
    });
  });

  test('whole-center enable and disable stage only user-controllable external AI features', () => {
    const features = [
      makeFeature({ key: 'agent.ask_staxis', enabled: false, runtimeProviders: ['openai', 'anthropic'] }),
      makeFeature({ key: 'communications.voice_transcription', enabled: true, requiredCapabilities: ['audio_transcription'] }),
      makeFeature({
        key: 'knowledge.embeddings', editable: false, switchable: false, modelSwitchable: false,
        fallbackAllowed: false, requiredCapabilities: ['embeddings'],
      }),
      makeFeature({ key: 'knowledge.document_ocr', provider: 'anthropic', runtimeProviders: ['anthropic'] }),
      makeFeature({
        key: 'speech.ask_staxis_dictation', provider: 'browser', editable: false, switchable: false,
        modelSwitchable: false, fallbackAllowed: false, requiredCapabilities: ['speech_recognition'],
      }),
      makeFeature({
        key: 'ml.daily_report_headcount', provider: 'in_house', availability: 'unavailable', enabled: false,
        editable: false, switchable: false, modelSwitchable: false, fallbackAllowed: false,
        requiredCapabilities: ['forecasting'],
      }),
    ];
    const drafts = Object.fromEntries(features.map((feature) => [feature.key, {
      ...draftFromConfig(feature.activeConfig),
      changeReason: `Keep note for ${feature.key}`,
    }]));

    const enable = stageGlobalEnabledDrafts(features, drafts, true);
    assert.deepEqual(enable.changed, ['agent.ask_staxis']);
    assert.deepEqual(enable.unchanged, ['communications.voice_transcription']);
    assert.equal(enable.drafts['agent.ask_staxis']?.changeReason, 'Keep note for agent.ask_staxis');
    assert.deepEqual(enable.skipped.map((item) => item.key), [
      'knowledge.embeddings',
      'knowledge.document_ocr',
      'speech.ask_staxis_dictation',
      'ml.daily_report_headcount',
    ]);

    const disable = stageGlobalEnabledDrafts(features, drafts, false);
    assert.deepEqual(disable.changed, ['communications.voice_transcription']);
    assert.deepEqual(disable.unchanged, ['agent.ask_staxis']);
    assert.equal(disable.drafts['communications.voice_transcription']?.primaryKey, drafts['communications.voice_transcription']?.primaryKey);
  });

  test('whole-center model staging applies both models only where the complete pair is compatible', () => {
    const primary = makeModel('gpt-5.4-mini');
    const fallback = makeModel('gpt-5.4-nano');
    const features = [
      makeFeature({ key: 'agent.ask_staxis', enabled: false, runtimeProviders: ['openai', 'anthropic'] }),
      makeFeature({
        key: 'inventory.invoice_scan', provider: 'anthropic', runtimeProviders: ['anthropic'],
        requiredCapabilities: ['text', 'pdf_input'],
      }),
      makeFeature({
        key: 'communications.voice_transcription', runtimeProviders: ['openai'],
        requiredCapabilities: ['audio_transcription'], fallbackAllowed: false,
      }),
      makeFeature({
        key: 'knowledge.embeddings', editable: false, switchable: false, modelSwitchable: false,
        fallbackAllowed: false, requiredCapabilities: ['embeddings'],
      }),
      makeFeature({ key: 'knowledge.document_ocr', provider: 'anthropic', runtimeProviders: ['anthropic'] }),
    ];
    const drafts = Object.fromEntries(features.map((feature) => [feature.key, {
      ...draftFromConfig(feature.activeConfig),
      changeReason: `Retain ${feature.key}`,
    }]));
    const plan = planGlobalModelDrafts(
      features,
      [primary, fallback],
      drafts,
      modelRefKey(primary),
      modelRefKey(fallback),
    );

    assert.deepEqual(plan.changed, ['agent.ask_staxis']);
    assert.deepEqual(plan.skipped.map((item) => item.key), [
      'inventory.invoice_scan',
      'communications.voice_transcription',
      'knowledge.embeddings',
      'knowledge.document_ocr',
    ]);
    assert.equal(plan.drafts['agent.ask_staxis']?.enabled, false);
    assert.equal(plan.drafts['agent.ask_staxis']?.changeReason, 'Retain agent.ask_staxis');
    assert.equal(plan.drafts['agent.ask_staxis']?.primaryKey, modelRefKey(primary));
    assert.equal(plan.drafts['agent.ask_staxis']?.fallbackKey, modelRefKey(fallback));

    const perFeatureOverride = {
      ...plan.drafts,
      'agent.ask_staxis': { ...plan.drafts['agent.ask_staxis']!, primaryKey: 'anthropic::claude-sonnet-5' },
    };
    assert.equal(perFeatureOverride['agent.ask_staxis'].primaryKey, 'anthropic::claude-sonnet-5');
  });
});
