import type {
  AiFeatureSummary,
  AiHostedProvider,
  AiModelCatalogEntry,
  AiModelPricing,
  AiModelRef,
} from '@/lib/ai/types';

export interface SearchableAiFeature {
  key: string;
  label: string;
  description: string;
  group: string;
  activeConfig?: {
    primary: SearchableAiModelRef;
    fallback: SearchableAiModelRef | null;
  };
}

export interface SearchableAiModelRef {
  provider: string;
  modelId: string;
  displayName?: string;
}

export interface ComparableAiModelRef {
  provider: string;
  modelId: string;
}

export interface ComparableAiConfig {
  enabled: boolean;
  primary: ComparableAiModelRef;
  fallback: ComparableAiModelRef | null;
  versionId?: string | null;
  source?: string;
  parameters?: Record<string, unknown>;
}

export interface AiFeatureDraft {
  enabled: boolean;
  primaryKey: string;
  fallbackKey: string;
  changeReason: string;
}

export interface RefreshableAiModel {
  provider: string;
  lastSeenAt: string;
}

export interface RuntimeCompatibleFeature {
  /** Every provider this feature can actually run on. A text feature lists both
   * Claude and GPT; one needing PDF reading lists Anthropic alone. */
  runtimeProviders: readonly string[];
  requiredCapabilities: readonly string[];
}

export interface RuntimeCompatibleModel {
  provider: string;
  available: boolean;
  capabilities: readonly string[];
}

export interface GlobalDraftSkip {
  key: string;
  label: string;
  reason: string;
}

export interface GlobalDraftPlan {
  drafts: Record<string, AiFeatureDraft>;
  changed: string[];
  unchanged: string[];
  skipped: GlobalDraftSkip[];
}

export const NO_FALLBACK = '__none__';
export const DEFAULT_MODEL_CATALOG_STALE_MS = 12 * 60 * 60 * 1000;

/**
 * Models intentionally presented as current production choices. Availability,
 * account access and app compatibility are still checked from the live catalog;
 * this list only prevents the provider's long-tail API inventory from becoming
 * the Control Center's UI.
 */
export const CURATED_AI_MODEL_IDS: Readonly<Record<AiHostedProvider, readonly string[]>> = {
  anthropic: [
    'claude-sonnet-5',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
    'claude-opus-4-7',
  ],
  openai: [
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.5',
    'gpt-5.5-pro',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.4-nano',
    'gpt-5.4-pro',
    'gpt-5.3-codex',
    'chat-latest',
    'whisper-1',
  ],
};

export const CURATED_AI_MODEL_PROVIDER_CAP = 20;

const GLOBAL_CONTROL_EXCLUDED_FEATURE_KEYS = new Set<string>([
  // Knowledge OCR has its own protected ingestion lifecycle. The Control
  // Center can still show its existing configuration, but whole-center bulk
  // actions must not reach into that system.
  'knowledge.document_ocr',
]);

/**
 * Fail-closed selectable catalog for this deployment.
 *
 * `provider+registry` is the intersection of two authoritative facts: the
 * configured account listed the model, and Staxis has an explicit capability /
 * pricing overlay for it. Registry-only safety-net rows and provider-only
 * unknown rows remain useful for runtime/history, but are never new choices.
 */
export function curateSelectableAiModels(
  models: readonly AiModelCatalogEntry[],
  configuredProviders: readonly AiHostedProvider[],
): AiModelCatalogEntry[] {
  const configured = new Set(configuredProviders);
  return (Object.keys(CURATED_AI_MODEL_IDS) as AiHostedProvider[]).flatMap((provider) => {
    if (!configured.has(provider)) return [];
    const byId = new Map(
      models
        .filter((model) => (
          model.provider === provider
          && model.available
          && model.status === 'available'
          && model.source === 'provider+registry'
          && model.capabilities.length > 0
          && model.pricing !== null
        ))
        .map((model) => [model.modelId, model]),
    );
    return CURATED_AI_MODEL_IDS[provider]
      .map((modelId) => byId.get(modelId))
      .filter((model): model is AiModelCatalogEntry => Boolean(model))
      .slice(0, CURATED_AI_MODEL_PROVIDER_CAP);
  });
}

export function currentModelRefs(features: readonly AiFeatureSummary[]): AiModelRef[] {
  const refs = new Map<string, AiModelRef>();
  for (const feature of features) {
    for (const ref of [feature.activeConfig.primary, feature.activeConfig.fallback]) {
      if (!ref || (ref.provider !== 'anthropic' && ref.provider !== 'openai')) continue;
      refs.set(modelRefKey(ref), ref);
    }
  }
  return [...refs.values()];
}

export interface PresentableAiModel {
  model: AiModelCatalogEntry;
  currentOnly: boolean;
}

export function modelsForControlCenterPresentation(
  models: readonly AiModelCatalogEntry[],
  selectableModels: readonly AiModelCatalogEntry[],
  features: readonly AiFeatureSummary[],
): PresentableAiModel[] {
  const rows = new Map<string, PresentableAiModel>();
  selectableModels.forEach((model) => rows.set(modelRefKey(model), { model, currentOnly: false }));
  const fullByKey = new Map(models.map((model) => [modelRefKey(model), model]));

  for (const ref of currentModelRefs(features)) {
    const key = modelRefKey(ref);
    if (rows.has(key)) continue;
    const catalog = fullByKey.get(key);
    rows.set(key, {
      currentOnly: true,
      model: catalog ?? {
        provider: ref.provider as AiHostedProvider,
        modelId: ref.modelId,
        displayName: ref.displayName ?? ref.modelId,
        status: 'unavailable',
        available: false,
        capabilities: ref.capabilities ?? [],
        maxInputTokens: null,
        maxOutputTokens: null,
        releasedAt: null,
        pricing: ref.pricing,
        source: 'registry',
        firstSeenAt: '',
        lastSeenAt: '',
        updatedAt: '',
      },
    });
  }
  return [...rows.values()];
}

export function essentialAiModelRates(pricing: AiModelPricing | null): {
  inputUsdPerMillionTokens: number | null;
  outputUsdPerMillionTokens: number | null;
  audioUsdPerMinute: number | null;
} {
  return {
    inputUsdPerMillionTokens: pricing?.inputUsdPerMillionTokens ?? null,
    outputUsdPerMillionTokens: pricing?.outputUsdPerMillionTokens ?? null,
    audioUsdPerMinute: pricing?.usdPerAudioMinute ?? null,
  };
}

export function isGloballyControllableAiFeature(feature: AiFeatureSummary): boolean {
  return !GLOBAL_CONTROL_EXCLUDED_FEATURE_KEYS.has(feature.key)
    && feature.editable
    && feature.switchable
    && feature.availability === 'available'
    && (feature.activeConfig.primary.provider === 'anthropic'
      || feature.activeConfig.primary.provider === 'openai');
}

function globalFeatureSkip(feature: AiFeatureSummary, modelsOnly: boolean): GlobalDraftSkip | null {
  if (GLOBAL_CONTROL_EXCLUDED_FEATURE_KEYS.has(feature.key)) {
    return { key: feature.key, label: feature.label, reason: 'Managed outside whole-center controls' };
  }
  if (feature.availability === 'unavailable') {
    return { key: feature.key, label: feature.label, reason: 'Unavailable' };
  }
  if (!feature.editable || (modelsOnly ? !feature.modelSwitchable : !feature.switchable)) {
    return {
      key: feature.key,
      label: feature.label,
      reason: modelsOnly ? 'Read-only or fixed model' : 'Read-only',
    };
  }
  if (feature.activeConfig.primary.provider !== 'anthropic'
    && feature.activeConfig.primary.provider !== 'openai') {
    return { key: feature.key, label: feature.label, reason: 'Not an external-AI feature' };
  }
  return null;
}

export function stageGlobalEnabledDrafts(
  features: readonly AiFeatureSummary[],
  drafts: Readonly<Record<string, AiFeatureDraft>>,
  enabled: boolean,
): GlobalDraftPlan {
  const next = { ...drafts };
  const changed: string[] = [];
  const unchanged: string[] = [];
  const skipped: GlobalDraftSkip[] = [];

  for (const feature of features) {
    const skip = globalFeatureSkip(feature, false);
    if (skip) {
      skipped.push(skip);
      continue;
    }
    const draft = drafts[feature.key] ?? draftFromConfig(feature.activeConfig);
    if (draft.enabled === enabled) {
      unchanged.push(feature.key);
      continue;
    }
    next[feature.key] = { ...draft, enabled };
    changed.push(feature.key);
  }

  return { drafts: next, changed, unchanged, skipped };
}

export function planGlobalModelDrafts(
  features: readonly AiFeatureSummary[],
  models: readonly AiModelCatalogEntry[],
  drafts: Readonly<Record<string, AiFeatureDraft>>,
  primaryKey: string,
  fallbackKey: string,
): GlobalDraftPlan {
  const next = { ...drafts };
  const changed: string[] = [];
  const unchanged: string[] = [];
  const skipped: GlobalDraftSkip[] = [];
  const primary = models.find((model) => modelRefKey(model) === primaryKey);
  const fallback = models.find((model) => modelRefKey(model) === fallbackKey);

  if (!primary || !fallback || primaryKey === fallbackKey) {
    return { drafts: next, changed, unchanged, skipped };
  }

  for (const feature of features) {
    const skip = globalFeatureSkip(feature, true);
    if (skip) {
      skipped.push(skip);
      continue;
    }
    if (!feature.fallbackAllowed) {
      skipped.push({ key: feature.key, label: feature.label, reason: 'Fallback models are not supported' });
      continue;
    }
    if (!isRuntimeCompatibleAiModel(feature, primary)) {
      skipped.push({
        key: feature.key,
        label: feature.label,
        reason: `${primary.displayName} is incompatible`,
      });
      continue;
    }
    if (!isRuntimeCompatibleAiModel(feature, fallback)) {
      skipped.push({
        key: feature.key,
        label: feature.label,
        reason: `${fallback.displayName} cannot be the fallback`,
      });
      continue;
    }

    const draft = drafts[feature.key] ?? draftFromConfig(feature.activeConfig);
    if (draft.primaryKey === primaryKey && draft.fallbackKey === fallbackKey) {
      unchanged.push(feature.key);
      continue;
    }
    next[feature.key] = { ...draft, primaryKey, fallbackKey };
    changed.push(feature.key);
  }

  return { drafts: next, changed, unchanged, skipped };
}

export function normalizeAiSearchText(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

export function isRuntimeCompatibleAiModel(
  feature: RuntimeCompatibleFeature,
  model: RuntimeCompatibleModel,
): boolean {
  return model.available
    && feature.runtimeProviders.includes(model.provider)
    // Still capability-gated per MODEL, not just per provider: an OpenAI model
    // with no curated overlay carries no capabilities at all, so it stays out of
    // the picker rather than appearing as a selectable option whose price and
    // abilities we cannot vouch for.
    && feature.requiredCapabilities.every((capability) => model.capabilities.includes(capability));
}

export function findStaleModelProviders<T extends string>(
  providers: readonly T[],
  models: readonly RefreshableAiModel[],
  now = Date.now(),
  staleAfterMs = DEFAULT_MODEL_CATALOG_STALE_MS,
): T[] {
  return providers.filter((provider) => {
    const providerModels = models.filter((model) => model.provider === provider);
    if (providerModels.length === 0) return true;
    const latestSeenAt = providerModels.reduce((latest, model) => {
      const timestamp = Date.parse(model.lastSeenAt);
      return Number.isFinite(timestamp) ? Math.max(latest, timestamp) : latest;
    }, Number.NEGATIVE_INFINITY);
    return !Number.isFinite(latestSeenAt) || now - latestSeenAt > staleAfterMs;
  });
}

export function modelRefKey(ref: ComparableAiModelRef): string {
  return `${ref.provider}::${ref.modelId}`;
}

export function parseModelRefKey(value: string): ComparableAiModelRef | null {
  if (!value || value === NO_FALLBACK) return null;
  const splitAt = value.indexOf('::');
  if (splitAt <= 0 || splitAt === value.length - 2) return null;
  return {
    provider: value.slice(0, splitAt),
    modelId: value.slice(splitAt + 2),
  };
}

export function draftFromConfig(config: ComparableAiConfig): AiFeatureDraft {
  return {
    enabled: config.enabled,
    primaryKey: modelRefKey(config.primary),
    fallbackKey: config.fallback ? modelRefKey(config.fallback) : NO_FALLBACK,
    changeReason: '',
  };
}

export function isAiFeatureDraftDirty(
  config: ComparableAiConfig,
  draft: AiFeatureDraft | undefined,
): boolean {
  if (!draft) return false;
  return draft.enabled !== config.enabled
    || draft.primaryKey !== modelRefKey(config.primary)
    || draft.fallbackKey !== (config.fallback ? modelRefKey(config.fallback) : NO_FALLBACK);
}

export function hasAiConfigBaseChanged(
  previous: ComparableAiConfig,
  current: ComparableAiConfig,
): boolean {
  return previous.enabled !== current.enabled
    || modelRefKey(previous.primary) !== modelRefKey(current.primary)
    || (previous.fallback ? modelRefKey(previous.fallback) : NO_FALLBACK)
      !== (current.fallback ? modelRefKey(current.fallback) : NO_FALLBACK)
    || previous.versionId !== current.versionId
    || previous.source !== current.source
    || JSON.stringify(previous.parameters) !== JSON.stringify(current.parameters);
}

export function groupAiFeatures<T extends SearchableAiFeature>(
  features: readonly T[],
  query: string,
): Array<{ group: string; features: T[] }> {
  const needle = query.trim().toLocaleLowerCase();
  const visible = needle
    ? features.filter((feature) => (
        feature.label.toLocaleLowerCase().includes(needle)
        || feature.description.toLocaleLowerCase().includes(needle)
        || feature.group.toLocaleLowerCase().includes(needle)
        || feature.key.toLocaleLowerCase().includes(needle)
        || [feature.activeConfig?.primary, feature.activeConfig?.fallback]
          .filter((model): model is SearchableAiModelRef => Boolean(model))
          .some((model) => (
            model.provider.toLocaleLowerCase().includes(needle)
            || model.modelId.toLocaleLowerCase().includes(needle)
            || model.displayName?.toLocaleLowerCase().includes(needle)
          ))
      ))
    : [...features];

  const grouped = new Map<string, T[]>();
  for (const feature of visible) {
    const group = feature.group.trim() || 'Other';
    const rows = grouped.get(group) ?? [];
    rows.push(feature);
    grouped.set(group, rows);
  }

  return Array.from(grouped.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, rows]) => ({
      group,
      features: rows.sort((a, b) => a.label.localeCompare(b.label)),
    }));
}

export function describeConfigChange(
  label: string,
  config: ComparableAiConfig,
  draft: AiFeatureDraft,
): string {
  const changes: string[] = [];
  if (draft.enabled !== config.enabled) changes.push(draft.enabled ? 'enabled' : 'disabled');
  if (draft.primaryKey !== modelRefKey(config.primary)) changes.push('changed primary model');
  if (draft.fallbackKey !== (config.fallback ? modelRefKey(config.fallback) : NO_FALLBACK)) {
    changes.push(draft.fallbackKey === NO_FALLBACK ? 'removed fallback' : 'changed fallback');
  }
  return changes.length > 0
    ? `${label}: ${changes.join(', ')}`
    : `${label}: revalidated active configuration`;
}

export function formatAiDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

export function formatAiCatalogDate(value: string | null | undefined): string {
  if (!value) return '—';
  const monthOnly = /^(\d{4})-(\d{2})$/.exec(value);
  if (monthOnly) {
    const year = Number(monthOnly[1]);
    const month = Number(monthOnly[2]);
    if (month < 1 || month > 12) return '—';
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(Date.UTC(year, month - 1, 1)));
  }

  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '—';
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(date);
  }

  return formatAiDate(value);
}
