import 'server-only';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import {
  AI_FEATURE_KEYS,
  AI_FEATURE_REGISTRY,
  getAiFeatureDefinition,
  getAiModelOverlay,
  isAiFeatureRuntimeProviderCompatible,
  isAiFeatureKey,
  listAiFeatureDefinitions,
} from './feature-registry';
import { getAiCatalogModel } from './model-catalog';
import { probeAiModel } from './provider-probe';
import type {
  ActivateAiConfigResponse,
  AiCapability,
  AiConfigValidationReport,
  AiConfigVersion,
  AiFeatureKey,
  AiFeatureSummary,
  AiHostedProvider,
  AiModelPricing,
  AiModelRef,
  AiModelSelection,
  AiProvider,
  CreateAiConfigRequest,
  ResolvedAiFeatureConfig,
} from './types';

const ACTIVE_CONFIG_CACHE_TTL_MS = 15_000;
const AI_CONFIG_VALIDATION_MAX_AGE_MS = 15 * 60_000;

interface ConfigDbRow {
  id: unknown;
  feature_key: unknown;
  version: unknown;
  enabled: unknown;
  primary_provider: unknown;
  primary_model_id: unknown;
  fallback_provider: unknown;
  fallback_model_id: unknown;
  parameters: unknown;
  validation_status: unknown;
  validation_report: unknown;
  validated_at: unknown;
  validated_by: unknown;
  validated_by_email: unknown;
  is_active: unknown;
  parent_id: unknown;
  change_reason: unknown;
  created_at: unknown;
  created_by: unknown;
  created_by_email: unknown;
  activated_at: unknown;
  activated_by: unknown;
  activated_by_email: unknown;
}

const CONFIG_SELECT = [
  'id',
  'feature_key',
  'version',
  'enabled',
  'primary_provider',
  'primary_model_id',
  'fallback_provider',
  'fallback_model_id',
  'parameters',
  'validation_status',
  'validation_report',
  'validated_at',
  'validated_by',
  'validated_by_email',
  'is_active',
  'parent_id',
  'change_reason',
  'created_at',
  'created_by',
  'created_by_email',
  'activated_at',
  'activated_by',
  'activated_by_email',
].join(', ');

export class AiConfigStoreError extends Error {
  constructor(
    public readonly code:
      | 'not_found'
      | 'validation_failed'
      | 'conflict'
      | 'database_error',
    message: string,
  ) {
    super(message);
    this.name = 'AiConfigStoreError';
  }
}

function isHostedProvider(value: unknown): value is AiHostedProvider {
  return value === 'anthropic' || value === 'openai';
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function clonePricing(pricing: AiModelPricing | null): AiModelPricing | null {
  return pricing ? { ...pricing } : null;
}

function cloneModelRef(model: AiModelRef): AiModelRef {
  return {
    ...model,
    capabilities: model.capabilities ? [...model.capabilities] : undefined,
    pricing: clonePricing(model.pricing),
  };
}

function defaultResolvedConfig(featureKey: AiFeatureKey): ResolvedAiFeatureConfig {
  const defaults = getAiFeatureDefinition(featureKey).defaultConfig;
  return {
    featureKey,
    enabled: defaults.enabled,
    primary: cloneModelRef(defaults.primary),
    fallback: defaults.fallback ? cloneModelRef(defaults.fallback) : null,
    parameters: { ...defaults.parameters },
    source: 'default',
    versionId: null,
    version: null,
  };
}

async function defaultResolvedConfigWithCatalogSafety(
  featureKey: AiFeatureKey,
): Promise<ResolvedAiFeatureConfig> {
  const resolved = defaultResolvedConfig(featureKey);
  if (!isHostedProvider(resolved.primary.provider)) return resolved;
  const primary = await getAiCatalogModel(resolved.primary.provider, resolved.primary.modelId);
  // No catalog row during a cold migration/outage keeps today's baked-in
  // default. A definitive provider refresh marking the model unavailable is
  // different: stop dispatching even when no database override exists.
  if (primary?.available === false) return failClosedResolvedConfig(featureKey);
  return resolved;
}

type BasicConfig = NonNullable<ReturnType<typeof basicConfigRow>>;

function modelRefFromStoredSelection(selection: AiModelSelection): AiModelRef {
  const overlay = getAiModelOverlay(selection.provider, selection.modelId);
  return {
    provider: selection.provider,
    modelId: selection.modelId,
    displayName: overlay?.displayName,
    capabilities: overlay ? [...overlay.capabilities] : undefined,
    pricing: clonePricing(overlay?.pricing ?? null),
  };
}

function failClosedResolvedConfig(
  featureKey: AiFeatureKey,
  base?: BasicConfig,
): ResolvedAiFeatureConfig {
  const defaults = getAiFeatureDefinition(featureKey).defaultConfig;
  return {
    featureKey,
    enabled: false,
    primary: base ? modelRefFromStoredSelection(base.primary) : cloneModelRef(defaults.primary),
    fallback: base?.fallback ? modelRefFromStoredSelection(base.fallback) : null,
    parameters: base ? { ...base.parameters } : { ...defaults.parameters },
    source: 'fail_closed',
    versionId: base?.id ?? null,
    version: base?.version ?? null,
  };
}

function databaseResolvedConfig(
  base: BasicConfig,
  primary: AiModelRef,
  fallback: AiModelRef | null,
): ResolvedAiFeatureConfig {
  return {
    featureKey: base.featureKey,
    enabled: base.enabled,
    primary,
    fallback,
    parameters: base.parameters,
    source: 'database',
    versionId: base.id,
    version: base.version,
  };
}

async function hydrateModelRef(selection: AiModelSelection): Promise<AiModelRef | null> {
  if (!isHostedProvider(selection.provider)) return null;
  const catalog = await getAiCatalogModel(selection.provider, selection.modelId);
  if (!catalog) return null;
  return {
    provider: selection.provider,
    modelId: selection.modelId,
    displayName: catalog.displayName,
    capabilities: [...catalog.capabilities],
    pricing: clonePricing(catalog.pricing),
  };
}

interface RuntimeModelHydration {
  model: AiModelRef | null;
  explicitlyUnavailable: boolean;
}

async function hydrateRuntimeModelRef(
  selection: AiModelSelection,
): Promise<RuntimeModelHydration> {
  if (!isHostedProvider(selection.provider)) {
    return { model: null, explicitlyUnavailable: false };
  }
  const catalog = await getAiCatalogModel(selection.provider, selection.modelId);
  if (!catalog) return { model: null, explicitlyUnavailable: false };
  if (!catalog.available) return { model: null, explicitlyUnavailable: true };
  return {
    model: {
      provider: selection.provider,
      modelId: selection.modelId,
      displayName: catalog.displayName,
      capabilities: [...catalog.capabilities],
      pricing: clonePricing(catalog.pricing),
    },
    explicitlyUnavailable: false,
  };
}

function basicConfigRow(row: ConfigDbRow): {
  id: string;
  featureKey: AiFeatureKey;
  version: number;
  enabled: boolean;
  primary: AiModelSelection;
  fallback: AiModelSelection | null;
  parameters: Record<string, unknown>;
} | null {
  if (
    typeof row.id !== 'string'
    || !isAiFeatureKey(row.feature_key)
    || !Number.isInteger(Number(row.version))
    || !isHostedProvider(row.primary_provider)
    || typeof row.primary_model_id !== 'string'
  ) return null;
  const hasFallback = isHostedProvider(row.fallback_provider) && typeof row.fallback_model_id === 'string';
  return {
    id: row.id,
    featureKey: row.feature_key,
    version: Number(row.version),
    enabled: row.enabled === true,
    primary: { provider: row.primary_provider, modelId: row.primary_model_id },
    fallback: hasFallback
      ? { provider: row.fallback_provider as AiHostedProvider, modelId: row.fallback_model_id as string }
      : null,
    parameters: asObject(row.parameters),
  };
}

async function mapConfigRow(row: ConfigDbRow): Promise<AiConfigVersion | null> {
  const base = basicConfigRow(row);
  if (!base) return null;
  const [primary, fallback] = await Promise.all([
    hydrateModelRef(base.primary),
    base.fallback ? hydrateModelRef(base.fallback) : Promise.resolve(null),
  ]);
  const validationStatus = row.validation_status === 'passed' || row.validation_status === 'failed'
    ? row.validation_status
    : 'pending';
  return {
    id: base.id,
    featureKey: base.featureKey,
    version: base.version,
    enabled: base.enabled,
    primary: primary ?? modelRefFromStoredSelection(base.primary),
    fallback: base.fallback
      ? fallback ?? modelRefFromStoredSelection(base.fallback)
      : null,
    parameters: base.parameters,
    validationStatus,
    validationReport: asObject(row.validation_report),
    validatedAt: typeof row.validated_at === 'string' ? row.validated_at : null,
    validatedBy: typeof row.validated_by === 'string' ? row.validated_by : null,
    validatedByEmail: typeof row.validated_by_email === 'string' ? row.validated_by_email : null,
    isActive: row.is_active === true,
    parentId: typeof row.parent_id === 'string' ? row.parent_id : null,
    changeReason: typeof row.change_reason === 'string' ? row.change_reason : null,
    createdAt: typeof row.created_at === 'string' ? row.created_at : new Date(0).toISOString(),
    createdBy: typeof row.created_by === 'string' ? row.created_by : null,
    createdByEmail: typeof row.created_by_email === 'string' ? row.created_by_email : null,
    activatedAt: typeof row.activated_at === 'string' ? row.activated_at : null,
    activatedBy: typeof row.activated_by === 'string' ? row.activated_by : null,
    activatedByEmail: typeof row.activated_by_email === 'string' ? row.activated_by_email : null,
  };
}

let activeCache: {
  loadedAt: number;
  configs: Map<AiFeatureKey, ResolvedAiFeatureConfig>;
} | null = null;
let activeLoad: Promise<Map<AiFeatureKey, ResolvedAiFeatureConfig>> | null = null;
let activeGeneration = 0;
let lastLoadFailureAt = 0;
const LOAD_FAILURE_COOLDOWN_MS = 5_000;

/** Signals "we are inside the post-failure cooldown; no query was attempted". */
class AiConfigLoadCooldownError extends Error {
  constructor() {
    super('AI config load skipped: within failure cooldown');
    this.name = 'AiConfigLoadCooldownError';
  }
}

async function loadActiveConfigs(): Promise<Map<AiFeatureKey, ResolvedAiFeatureConfig>> {
  const now = Date.now();
  if (activeCache && now - activeCache.loadedAt < ACTIVE_CONFIG_CACHE_TTL_MS) {
    return activeCache.configs;
  }
  if (activeLoad) return activeLoad;
  // Negative caching: after a failed load, don't re-run the doomed query (or
  // re-log the failure) on every sequential AI call — at most one probe per
  // cooldown window per instance. Callers fall back to last-known/defaults.
  if (now - lastLoadFailureAt < LOAD_FAILURE_COOLDOWN_MS) {
    throw new AiConfigLoadCooldownError();
  }

  const generation = activeGeneration;
  const pending = (async () => {
    const { data, error } = await supabaseAdmin
      .from('ai_feature_config_versions')
      .select(CONFIG_SELECT)
      .eq('is_active', true);
    if (error) throw new Error(`active AI config load failed: ${error.message}`);

    const previousConfigs = activeCache?.configs;
    const configs = new Map<AiFeatureKey, ResolvedAiFeatureConfig>();
    for (const raw of (data ?? []) as unknown as ConfigDbRow[]) {
      const base = basicConfigRow(raw);
      if (!base) continue;
      const definition = AI_FEATURE_REGISTRY[base.featureKey];
      if (!definition.editable) continue;

      if (
        !isAiFeatureRuntimeProviderCompatible(base.featureKey, base.primary.provider)
        || (base.fallback && !isAiFeatureRuntimeProviderCompatible(base.featureKey, base.fallback.provider))
      ) {
        configs.set(base.featureKey, failClosedResolvedConfig(base.featureKey, base));
        continue;
      }

      const preserveOrFailClosed = (): ResolvedAiFeatureConfig => {
        const previous = previousConfigs?.get(base.featureKey);
        return previous?.versionId === base.id
          ? previous
          : failClosedResolvedConfig(base.featureKey, base);
      };

      if (raw.validation_status !== 'passed') {
        configs.set(base.featureKey, preserveOrFailClosed());
        continue;
      }

      // A kill switch must remain authoritative even if provider catalog
      // hydration is unavailable. No provider request can occur while disabled,
      // so the stored model identifiers are sufficient for display/history.
      if (!base.enabled) {
        configs.set(base.featureKey, databaseResolvedConfig(
          base,
          modelRefFromStoredSelection(base.primary),
          base.fallback ? modelRefFromStoredSelection(base.fallback) : null,
        ));
        continue;
      }

      const [primaryHydration, fallbackHydration] = await Promise.all([
        hydrateRuntimeModelRef(base.primary),
        base.fallback
          ? hydrateRuntimeModelRef(base.fallback)
          : Promise.resolve<RuntimeModelHydration>({ model: null, explicitlyUnavailable: false }),
      ]);
      const primary = primaryHydration.model;
      const fallback = fallbackHydration.model;
      if (!primary || (base.fallback && !fallback)) {
        const providerRemovedSelection = primaryHydration.explicitlyUnavailable
          || fallbackHydration.explicitlyUnavailable;
        configs.set(
          base.featureKey,
          providerRemovedSelection ? failClosedResolvedConfig(base.featureKey, base) : preserveOrFailClosed(),
        );
        continue;
      }
      const defaultPrimary = definition.defaultConfig.primary;
      if (!definition.modelSwitchable && (
        primary.provider !== defaultPrimary.provider || primary.modelId !== defaultPrimary.modelId
      )) {
        configs.set(base.featureKey, preserveOrFailClosed());
        continue;
      }
      if (!definition.fallbackAllowed && fallback) {
        configs.set(base.featureKey, preserveOrFailClosed());
        continue;
      }
      const primaryCapabilities = new Set(primary.capabilities ?? []);
      if (definition.requiredCapabilities.some((capability) => !primaryCapabilities.has(capability))) {
        configs.set(base.featureKey, preserveOrFailClosed());
        continue;
      }
      if (fallback) {
        const fallbackCapabilities = new Set(fallback.capabilities ?? []);
        if (definition.requiredCapabilities.some((capability) => !fallbackCapabilities.has(capability))) {
          configs.set(base.featureKey, preserveOrFailClosed());
          continue;
        }
      }
      configs.set(base.featureKey, databaseResolvedConfig(base, primary, fallback));
    }
    if (generation === activeGeneration) {
      activeCache = { loadedAt: Date.now(), configs };
    }
    return configs;
  })();
  activeLoad = pending;

  try {
    const configs = await pending;
    lastLoadFailureAt = 0;
    return configs;
  } catch (error) {
    lastLoadFailureAt = Date.now();
    throw error;
  } finally {
    if (activeLoad === pending) activeLoad = null;
  }
}

export function invalidateAiFeatureConfigCache(): void {
  activeCache = null;
  activeLoad = null;
  activeGeneration += 1;
}

export async function resolveAiFeatureConfig(
  featureKey: AiFeatureKey,
): Promise<ResolvedAiFeatureConfig> {
  const definition = getAiFeatureDefinition(featureKey);
  if (!definition.editable) return defaultResolvedConfig(featureKey);
  try {
    return (await loadActiveConfigs()).get(featureKey)
      ?? await defaultResolvedConfigWithCatalogSafety(featureKey);
  } catch (error) {
    const lastKnown = activeCache?.configs;
    if (!(error instanceof AiConfigLoadCooldownError)) {
      log.error('[ai-config] active config unavailable; preserving last-known state or using code defaults', {
        featureKey,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    }
    if (lastKnown) {
      return lastKnown.get(featureKey) ?? defaultResolvedConfig(featureKey);
    }
    // Infra failure with a cold cache (DB blip on a fresh instance) is NOT an
    // explicit config state: fall back to the baked-in registry defaults —
    // exactly the behavior these features had before the config store existed.
    // Fail-closed is reserved for hydrated rows that are invalid/unavailable.
    // Tradeoff (accepted): a DB-stored kill switch can't be seen during the
    // outage window on cold instances, but a store blip must never black out
    // every AI feature fleet-wide.
    return defaultResolvedConfig(featureKey);
  }
}

export async function getAiModelPricing(
  provider: AiProvider,
  modelId: string,
): Promise<AiModelPricing | null> {
  if (isHostedProvider(provider)) {
    const catalog = await getAiCatalogModel(provider, modelId);
    if (catalog?.pricing) return clonePricing(catalog.pricing);
  }
  return clonePricing(getAiModelOverlay(provider, modelId)?.pricing ?? null);
}

export async function listAiFeatureSummaries(): Promise<AiFeatureSummary[]> {
  return Promise.all(listAiFeatureDefinitions().map(async (definition) => ({
    ...definition,
    requiredCapabilities: [...definition.requiredCapabilities],
    defaultConfig: {
      ...definition.defaultConfig,
      primary: cloneModelRef(definition.defaultConfig.primary),
      fallback: definition.defaultConfig.fallback ? cloneModelRef(definition.defaultConfig.fallback) : null,
      parameters: { ...definition.defaultConfig.parameters },
    },
    activeConfig: await resolveAiFeatureConfig(definition.key),
  })));
}

export async function listAiConfigVersions(opts: {
  featureKey?: AiFeatureKey;
  limit?: number;
} = {}): Promise<AiConfigVersion[]> {
  const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
  let query = supabaseAdmin
    .from('ai_feature_config_versions')
    .select(CONFIG_SELECT)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (opts.featureKey) query = query.eq('feature_key', opts.featureKey);
  const { data, error } = await query;
  if (error) throw new AiConfigStoreError('database_error', `AI config history load failed: ${error.message}`);
  const mapped = await Promise.all(((data ?? []) as unknown as ConfigDbRow[]).map(mapConfigRow));
  return mapped.filter((row): row is AiConfigVersion => row !== null);
}

export async function getAiConfigVersion(id: string): Promise<AiConfigVersion | null> {
  const { data, error } = await supabaseAdmin
    .from('ai_feature_config_versions')
    .select(CONFIG_SELECT)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new AiConfigStoreError('database_error', `AI config load failed: ${error.message}`);
  return data ? mapConfigRow(data as unknown as ConfigDbRow) : null;
}

export async function createAiConfigVersion(
  input: CreateAiConfigRequest,
  actor: { accountId: string; userId: string; email: string | null; requestId: string },
): Promise<AiConfigVersion> {
  const definition = getAiFeatureDefinition(input.featureKey);
  if (!definition.editable) {
    throw new AiConfigStoreError('validation_failed', 'This feature is informational and cannot be configured here.');
  }
  if (
    !isAiFeatureRuntimeProviderCompatible(input.featureKey, input.primary.provider)
    || (input.fallback && !isAiFeatureRuntimeProviderCompatible(input.featureKey, input.fallback.provider))
  ) {
    throw new AiConfigStoreError(
      'validation_failed',
      `This feature is implemented by the ${definition.runtimeProvider} runtime; select ${definition.runtimeProvider} models only.`,
    );
  }
  const defaultPrimary = definition.defaultConfig.primary;
  if (!definition.modelSwitchable && (
    input.primary.provider !== defaultPrimary.provider || input.primary.modelId !== defaultPrimary.modelId
  )) {
    throw new AiConfigStoreError('validation_failed', 'This feature’s model is fixed because changing its vector/model contract requires a data migration.');
  }
  if (!definition.fallbackAllowed && input.fallback) {
    throw new AiConfigStoreError('validation_failed', 'This feature does not support a fallback model.');
  }
  if (!isHostedProvider(input.primary.provider) || (input.fallback && !isHostedProvider(input.fallback.provider))) {
    throw new AiConfigStoreError('validation_failed', 'Only configured hosted providers may be selected.');
  }
  const fallbackSelection = input.fallback && isHostedProvider(input.fallback.provider)
    ? { provider: input.fallback.provider, modelId: input.fallback.modelId }
    : null;
  const [primaryCatalog, fallbackCatalog] = await Promise.all([
    getAiCatalogModel(input.primary.provider, input.primary.modelId),
    fallbackSelection
      ? getAiCatalogModel(fallbackSelection.provider, fallbackSelection.modelId)
      : Promise.resolve(null),
  ]);
  if (!primaryCatalog) {
    throw new AiConfigStoreError('validation_failed', 'The primary model is not in the provider catalog.');
  }
  if (input.fallback && !fallbackCatalog) {
    throw new AiConfigStoreError('validation_failed', 'The fallback model is not in the provider catalog.');
  }
  if (Object.keys(input.parameters ?? {}).length > 0) {
    throw new AiConfigStoreError('validation_failed', 'Runtime parameters are not supported yet; create the version with an empty parameters object.');
  }

  if (input.parentId) {
    const parent = await getAiConfigVersion(input.parentId);
    if (!parent || parent.featureKey !== input.featureKey) {
      throw new AiConfigStoreError('validation_failed', 'parentId must identify a version of the same feature.');
    }
  }

  const { data, error } = await supabaseAdmin.rpc('staxis_create_ai_feature_config', {
    p_feature_key: input.featureKey,
    p_enabled: input.enabled,
    p_primary_provider: input.primary.provider,
    p_primary_model_id: input.primary.modelId,
    p_fallback_provider: input.fallback?.provider ?? null,
    p_fallback_model_id: input.fallback?.modelId ?? null,
    p_parameters: input.parameters ?? {},
    p_parent_id: input.parentId ?? null,
    p_change_reason: input.changeReason ?? null,
    p_actor_account_id: actor.accountId,
    p_actor_user_id: actor.userId,
    p_actor_email: actor.email,
    p_request_id: actor.requestId,
  });
  if (error) {
    if (error.code === '23505') throw new AiConfigStoreError('conflict', 'Another version was created concurrently. Refresh and try again.');
    if (error.code === '22000' || error.code === '22023' || error.code === '23514') {
      throw new AiConfigStoreError('validation_failed', 'The AI config version could not be created from that payload.');
    }
    throw new AiConfigStoreError('database_error', `AI config creation failed: ${error.message}`);
  }
  if (typeof data !== 'string') {
    throw new AiConfigStoreError('database_error', 'Created AI config returned an invalid identifier.');
  }
  const config = await getAiConfigVersion(data);
  if (!config) throw new AiConfigStoreError('database_error', 'Created AI config could not be reloaded.');
  return config;
}

async function validateSelection(
  selection: AiModelSelection,
  requiredCapabilities: AiCapability[],
  enforceRuntimeCompatibility = true,
  runtimeProvider?: AiProvider,
): Promise<{ model: AiModelRef | null; errors: string[]; warnings: string[] }> {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isHostedProvider(selection.provider)) {
    return { model: null, errors: ['Only Anthropic and OpenAI models can be activated.'], warnings };
  }
  if (runtimeProvider && selection.provider !== runtimeProvider) {
    errors.push(
      `${selection.provider}/${selection.modelId} cannot run through this feature's ${runtimeProvider} runtime.`,
    );
  }
  const catalog = await getAiCatalogModel(selection.provider, selection.modelId);
  if (!catalog) {
    if (enforceRuntimeCompatibility) {
      return { model: null, errors: [`${selection.provider}/${selection.modelId} is not in the model catalog.`], warnings };
    }
    warnings.push(`${selection.provider}/${selection.modelId} is not currently in the model catalog; runtime checks were skipped because the feature is disabled.`);
    return {
      model: {
        provider: selection.provider,
        modelId: selection.modelId,
        pricing: clonePricing(getAiModelOverlay(selection.provider, selection.modelId)?.pricing ?? null),
      },
      errors,
      warnings,
    };
  }
  if (enforceRuntimeCompatibility) {
    if (!catalog.available) errors.push(`${selection.provider}/${selection.modelId} is currently marked unavailable.`);
    const capabilities = new Set(catalog.capabilities);
    const missing = requiredCapabilities.filter((capability) => !capabilities.has(capability));
    if (missing.length > 0) errors.push(`${selection.provider}/${selection.modelId} is missing: ${missing.join(', ')}.`);
  } else {
    warnings.push('Availability, capability, and provider probes were skipped because this version disables the feature.');
  }
  if (!catalog.pricing) {
    warnings.push(`${selection.provider}/${selection.modelId} has no verified pricing metadata.`);
  } else if (catalog.pricing.source === 'conservative-unverified') {
    warnings.push(`${selection.provider}/${selection.modelId} uses a conservative unverified pricing estimate for cost safety.`);
  }
  return {
    model: {
      provider: selection.provider,
      modelId: selection.modelId,
      displayName: catalog.displayName,
      capabilities: [...catalog.capabilities],
      pricing: clonePricing(catalog.pricing),
    },
    errors,
    warnings,
  };
}

export async function validateAiConfigVersion(
  id: string,
  actor: { accountId: string; userId: string; email: string | null; requestId: string },
): Promise<{ config: AiConfigVersion; report: AiConfigValidationReport }> {
  const { data: raw, error: loadError } = await supabaseAdmin
    .from('ai_feature_config_versions')
    .select(CONFIG_SELECT)
    .eq('id', id)
    .maybeSingle();
  if (loadError) throw new AiConfigStoreError('database_error', `AI config load failed: ${loadError.message}`);
  if (!raw) throw new AiConfigStoreError('not_found', 'AI config version not found.');
  if ((raw as unknown as ConfigDbRow).is_active === true) {
    throw new AiConfigStoreError(
      'validation_failed',
      'Active versions cannot be revalidated. Create and test a new version instead.',
    );
  }
  const base = basicConfigRow(raw as unknown as ConfigDbRow);
  if (!base) throw new AiConfigStoreError('validation_failed', 'AI config row is malformed.');
  const definition = getAiFeatureDefinition(base.featureKey);
  if (!definition.editable) throw new AiConfigStoreError('validation_failed', 'This feature is informational only.');

  const defaultPrimary = definition.defaultConfig.primary;
  const registryErrors: string[] = [];
  if (!definition.modelSwitchable && (
    base.primary.provider !== defaultPrimary.provider || base.primary.modelId !== defaultPrimary.modelId
  )) registryErrors.push('This feature’s model is fixed because changing it requires a data migration.');
  if (!definition.fallbackAllowed && base.fallback) registryErrors.push('This feature does not support a fallback model.');
  if (!isAiFeatureRuntimeProviderCompatible(base.featureKey, base.primary.provider)) {
    registryErrors.push(`The primary model must use the ${definition.runtimeProvider} runtime provider.`);
  }
  if (base.fallback && !isAiFeatureRuntimeProviderCompatible(base.featureKey, base.fallback.provider)) {
    registryErrors.push(`The fallback model must use the ${definition.runtimeProvider} runtime provider.`);
  }

  const [primaryResult, fallbackResult] = await Promise.all([
    validateSelection(base.primary, definition.requiredCapabilities, base.enabled, definition.runtimeProvider),
    base.fallback
      ? validateSelection(base.fallback, definition.requiredCapabilities, base.enabled, definition.runtimeProvider)
      : Promise.resolve(null),
  ]);
  const errors = [...registryErrors, ...primaryResult.errors, ...(fallbackResult?.errors ?? [])];
  const warnings = [...primaryResult.warnings, ...(fallbackResult?.warnings ?? [])];
  if (Object.keys(base.parameters).length > 0) errors.push('Runtime parameters are not supported yet.');
  const probes = [];
  if (base.enabled && errors.length === 0) {
    const probeResults = await Promise.all([
      probeAiModel(base.primary, definition.requiredCapabilities),
      ...(base.fallback ? [probeAiModel(base.fallback, definition.requiredCapabilities)] : []),
    ]);
    probes.push(...probeResults);
    for (const probe of probeResults) {
      if (!probe.ok) errors.push(`${probe.provider}/${probe.modelId}: ${probe.error ?? 'synthetic probe failed'}`);
    }
  }
  const checkedAt = new Date().toISOString();
  const report: AiConfigValidationReport = {
    valid: errors.length === 0,
    checkedAt,
    errors,
    warnings,
    requiredCapabilities: [...definition.requiredCapabilities],
    primaryCapabilities: primaryResult.model?.capabilities ?? [],
    fallbackCapabilities: fallbackResult?.model?.capabilities ?? null,
    probes,
  };

  const { error: updateError } = await supabaseAdmin.rpc('staxis_record_ai_feature_validation', {
    p_config_id: id,
    p_validation_status: report.valid ? 'passed' : 'failed',
    p_validation_report: report,
    p_checked_at: checkedAt,
    p_actor_account_id: actor.accountId,
    p_actor_user_id: actor.userId,
    p_actor_email: actor.email,
    p_request_id: actor.requestId,
  });
  if (updateError) {
    if (updateError.code === 'P0002') throw new AiConfigStoreError('not_found', 'AI config version not found.');
    if (updateError.code === '22000' || updateError.code === '22023' || updateError.code === '23514') {
      throw new AiConfigStoreError('validation_failed', 'The validation result could not be recorded for this version.');
    }
    throw new AiConfigStoreError('database_error', `AI config validation update failed: ${updateError.message}`);
  }
  const config = await getAiConfigVersion(id);
  if (!config) throw new AiConfigStoreError('database_error', 'Validated AI config could not be reloaded.');
  return { config, report };
}

export async function activateAiConfigVersion(input: {
  id: string;
  expectedActiveId: string | null;
  reason: string;
  action: 'ai.config.activate' | 'ai.config.rollback';
  requestId: string;
  actor: { accountId: string; userId: string; email: string | null };
}): Promise<ActivateAiConfigResponse> {
  const current = await getAiConfigVersion(input.id);
  if (!current) throw new AiConfigStoreError('not_found', 'AI config version not found.');
  if (current.validationStatus !== 'passed') {
    throw new AiConfigStoreError('validation_failed', 'Validate this version successfully before activating it.');
  }
  if (current.enabled) {
    const validatedAt = current.validatedAt ? Date.parse(current.validatedAt) : Number.NaN;
    if (!Number.isFinite(validatedAt) || Date.now() - validatedAt > AI_CONFIG_VALIDATION_MAX_AGE_MS) {
      throw new AiConfigStoreError(
        'validation_failed',
        'This model test is older than 15 minutes. Test the version again before activating it.',
      );
    }
  }
  if (input.action === 'ai.config.rollback' && !current.activatedAt) {
    throw new AiConfigStoreError('validation_failed', 'Rollback targets must be a version that was active previously.');
  }
  // Recheck current catalog capability/availability immediately before the DB
  // transaction. Provider network calls are deliberately not made while a row
  // lock is held.
  const definition = getAiFeatureDefinition(current.featureKey);
  const defaultPrimary = definition.defaultConfig.primary;
  if (!definition.modelSwitchable && (
    current.primary.provider !== defaultPrimary.provider || current.primary.modelId !== defaultPrimary.modelId
  )) throw new AiConfigStoreError('validation_failed', 'This feature’s model is fixed.');
  if (!definition.fallbackAllowed && current.fallback) {
    throw new AiConfigStoreError('validation_failed', 'This feature does not support a fallback model.');
  }
  if (!isAiFeatureRuntimeProviderCompatible(current.featureKey, current.primary.provider)) {
    throw new AiConfigStoreError('validation_failed', `The primary model must use the ${definition.runtimeProvider} runtime provider.`);
  }
  if (current.fallback && !isAiFeatureRuntimeProviderCompatible(current.featureKey, current.fallback.provider)) {
    throw new AiConfigStoreError('validation_failed', `The fallback model must use the ${definition.runtimeProvider} runtime provider.`);
  }
  const primary = await validateSelection(
    current.primary,
    definition.requiredCapabilities,
    current.enabled,
    definition.runtimeProvider,
  );
  const fallback = current.fallback
    ? await validateSelection(
        current.fallback,
        definition.requiredCapabilities,
        current.enabled,
        definition.runtimeProvider,
      )
    : null;
  const errors = [...primary.errors, ...(fallback?.errors ?? [])];
  if (errors.length > 0) throw new AiConfigStoreError('validation_failed', errors.join(' '));

  const { data, error } = await supabaseAdmin.rpc('staxis_activate_ai_feature_config', {
    p_config_id: input.id,
    p_expected_active_id: input.expectedActiveId,
    p_actor_account_id: input.actor.accountId,
    p_actor_user_id: input.actor.userId,
    p_actor_email: input.actor.email,
    p_action: input.action,
    p_reason: input.reason,
    p_request_id: input.requestId,
  });
  if (error) {
    if (error.code === '40001') throw new AiConfigStoreError('conflict', 'The active version changed. Refresh before activating.');
    if (error.code === 'P0002') throw new AiConfigStoreError('not_found', 'AI config version not found.');
    if (error.code === '22000' || error.code === '22023') {
      throw new AiConfigStoreError('validation_failed', 'The selected version is not eligible for activation.');
    }
    throw new AiConfigStoreError('database_error', `AI config activation failed: ${error.message}`);
  }
  invalidateAiFeatureConfigCache();
  const result = asObject(data);
  const config = await getAiConfigVersion(input.id);
  if (!config) throw new AiConfigStoreError('database_error', 'Activated AI config could not be reloaded.');
  return {
    featureKey: isAiFeatureKey(result.featureKey) ? result.featureKey : config.featureKey,
    previousConfigId: typeof result.previousConfigId === 'string' ? result.previousConfigId : null,
    activeConfigId: typeof result.activeConfigId === 'string' ? result.activeConfigId : config.id,
    version: Number.isInteger(Number(result.version)) ? Number(result.version) : config.version,
    config,
  };
}

export const AI_CONFIGURABLE_FEATURE_KEYS = AI_FEATURE_KEYS.filter(
  (key) => AI_FEATURE_REGISTRY[key].editable,
);
