import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  NO_FALLBACK,
  describeConfigChange,
  draftFromConfig,
  findStaleModelProviders,
  formatAiCatalogDate,
  groupAiFeatures,
  hasAiConfigBaseChanged,
  isAiFeatureDraftDirty,
  isRuntimeCompatibleAiModel,
  modelRefKey,
  normalizeAiSearchText,
  parseModelRefKey,
} from './AIControlCenter.helpers';

test('runtime-compatible model filtering requires provider and capabilities', () => {
  const feature = { runtimeProvider: 'anthropic', requiredCapabilities: ['text', 'image_input'] };
  assert.equal(isRuntimeCompatibleAiModel(feature, {
    provider: 'anthropic', available: true, capabilities: ['text', 'image_input', 'tool_use'],
  }), true);
  assert.equal(isRuntimeCompatibleAiModel(feature, {
    provider: 'openai', available: true, capabilities: ['text', 'image_input'],
  }), false);
  assert.equal(isRuntimeCompatibleAiModel(feature, {
    provider: 'anthropic', available: true, capabilities: ['text'],
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
});
