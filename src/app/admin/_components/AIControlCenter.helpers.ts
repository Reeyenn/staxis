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
  runtimeProvider: string;
  requiredCapabilities: readonly string[];
}

export interface RuntimeCompatibleModel {
  provider: string;
  available: boolean;
  capabilities: readonly string[];
}

export const NO_FALLBACK = '__none__';
export const DEFAULT_MODEL_CATALOG_STALE_MS = 12 * 60 * 60 * 1000;

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
    && model.provider === feature.runtimeProvider
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
