import 'server-only';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { AI_CAPABILITIES, type AiCapability, type AiHostedProvider, type AiModelCatalogEntry, type AiModelPricing } from './types';
import {
  AI_MODEL_OVERLAYS,
  CONSERVATIVE_ANTHROPIC_PRICING,
  getAiModelOverlay,
} from './feature-registry';
import {
  AiProviderDiscoveryError,
  discoverProviderModels,
  type AiProviderDiscoveryOptions,
} from './provider-discovery';

const CATALOG_CACHE_TTL_MS = 60_000;
let catalogCache: { loadedAt: number; rows: AiModelCatalogEntry[] } | null = null;
let catalogLoad: Promise<AiModelCatalogEntry[]> | null = null;
let catalogGeneration = 0;

interface CatalogDbRow {
  provider: unknown;
  model_id: unknown;
  display_name: unknown;
  status: unknown;
  available: unknown;
  capabilities: unknown;
  max_input_tokens: unknown;
  max_output_tokens: unknown;
  released_at: unknown;
  pricing: unknown;
  source: unknown;
  first_seen_at: unknown;
  last_seen_at: unknown;
  updated_at: unknown;
}

function isHostedProvider(value: unknown): value is AiHostedProvider {
  return value === 'anthropic' || value === 'openai';
}

function isCapability(value: unknown): value is AiCapability {
  return typeof value === 'string' && AI_CAPABILITIES.includes(value as AiCapability);
}

function finitePositiveInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parsePricing(value: unknown): AiModelPricing | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.source !== 'string' || typeof raw.asOf !== 'string') return null;
  const pricing: AiModelPricing = { source: raw.source, asOf: raw.asOf };
  for (const key of [
    'inputUsdPerMillionTokens',
    'outputUsdPerMillionTokens',
    'cachedInputUsdPerMillionTokens',
    'cacheCreation5mInputUsdPerMillionTokens',
    'cacheCreation1hInputUsdPerMillionTokens',
    'usdPerAudioMinute',
  ] as const) {
    const n = Number(raw[key]);
    if (Number.isFinite(n) && n >= 0) pricing[key] = n;
  }
  return pricing;
}

function mapCatalogRow(row: CatalogDbRow): AiModelCatalogEntry | null {
  if (!isHostedProvider(row.provider) || typeof row.model_id !== 'string' || typeof row.display_name !== 'string') {
    return null;
  }
  const status = row.status === 'unavailable' ? 'unavailable' : 'available';
  return {
    provider: row.provider,
    modelId: row.model_id,
    displayName: row.display_name,
    status,
    available: row.available === true,
    capabilities: Array.isArray(row.capabilities) ? row.capabilities.filter(isCapability) : [],
    maxInputTokens: finitePositiveInt(row.max_input_tokens),
    maxOutputTokens: finitePositiveInt(row.max_output_tokens),
    releasedAt: typeof row.released_at === 'string' ? row.released_at : null,
    pricing: parsePricing(row.pricing) ?? (
      row.provider === 'anthropic' ? { ...CONSERVATIVE_ANTHROPIC_PRICING } : null
    ),
    source: row.source === 'registry' || row.source === 'provider+registry' ? row.source : 'provider',
    firstSeenAt: typeof row.first_seen_at === 'string' ? row.first_seen_at : new Date(0).toISOString(),
    lastSeenAt: typeof row.last_seen_at === 'string' ? row.last_seen_at : new Date(0).toISOString(),
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : new Date(0).toISOString(),
  };
}

async function loadCatalog(): Promise<AiModelCatalogEntry[]> {
  const now = Date.now();
  if (catalogCache && now - catalogCache.loadedAt < CATALOG_CACHE_TTL_MS) {
    return catalogCache.rows;
  }
  if (catalogLoad) return catalogLoad;

  const generation = catalogGeneration;
  const pending = (async () => {
    const { data, error } = await supabaseAdmin
      .from('ai_model_catalog')
      .select('provider, model_id, display_name, status, available, capabilities, max_input_tokens, max_output_tokens, released_at, pricing, source, first_seen_at, last_seen_at, updated_at')
      .order('provider')
      .order('display_name');
    if (error) throw new Error(`AI model catalog load failed: ${error.message}`);
    const rows = ((data ?? []) as CatalogDbRow[])
      .map(mapCatalogRow)
      .filter((row): row is AiModelCatalogEntry => row !== null);
    if (generation === catalogGeneration) {
      catalogCache = { loadedAt: Date.now(), rows };
    }
    return rows;
  })();
  catalogLoad = pending;
  try {
    return await pending;
  } finally {
    if (catalogLoad === pending) catalogLoad = null;
  }
}

export function invalidateAiModelCatalogCache(): void {
  catalogCache = null;
  catalogLoad = null;
  catalogGeneration += 1;
}

export function mergeAiModelCatalogRows(
  persistedRows: AiModelCatalogEntry[],
  provider?: AiHostedProvider,
): AiModelCatalogEntry[] {
  const merged = new Map<string, AiModelCatalogEntry>();
  for (const row of listRegistryModelFallbacks()) {
    merged.set(`${row.provider}:${row.modelId}`, row);
  }
  // Persisted provider metadata wins over the static safety net. This keeps
  // known defaults visible before the first discovery refresh while preserving
  // provider availability and release metadata once it exists.
  for (const row of persistedRows) {
    merged.set(`${row.provider}:${row.modelId}`, row);
  }
  const rows = [...merged.values()]
    .filter((row) => !provider || row.provider === provider)
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.displayName.localeCompare(b.displayName));
  return rows;
}

export async function listAiModels(provider?: AiHostedProvider): Promise<AiModelCatalogEntry[]> {
  try {
    return mergeAiModelCatalogRows(await loadCatalog(), provider);
  } catch {
    // The Control Center must still show every known code default while the
    // catalog migration/provider cache is unavailable. Unknown models are not
    // invented here and no selection changes automatically.
    return mergeAiModelCatalogRows([], provider);
  }
}

function overlayFallback(provider: AiHostedProvider, modelId: string): AiModelCatalogEntry | null {
  const overlay = getAiModelOverlay(provider, modelId);
  if (!overlay) return null;
  const epoch = new Date(0).toISOString();
  return {
    provider,
    modelId,
    displayName: overlay.displayName,
    status: 'available',
    available: true,
    capabilities: [...overlay.capabilities],
    maxInputTokens: null,
    maxOutputTokens: null,
    releasedAt: null,
    pricing: overlay.pricing ? { ...overlay.pricing } : null,
    source: 'registry',
    firstSeenAt: epoch,
    lastSeenAt: epoch,
    updatedAt: epoch,
  };
}

export async function getAiCatalogModel(
  provider: AiHostedProvider,
  modelId: string,
): Promise<AiModelCatalogEntry | null> {
  try {
    return (await loadCatalog()).find(
      (row) => row.provider === provider && row.modelId === modelId,
    ) ?? overlayFallback(provider, modelId);
  } catch {
    // Preserve a definitive last-known provider state (including unavailable)
    // during a later catalog outage. Falling straight to a static overlay here
    // could silently resurrect a model the provider already removed.
    const cached = catalogCache?.rows.find(
      (row) => row.provider === provider && row.modelId === modelId,
    );
    if (cached) return cached;
    // Cold-start/migration outage: exact code defaults retain their static
    // safety-net metadata. Unknown models are never invented here.
    return overlayFallback(provider, modelId);
  }
}

export async function refreshAiModelCatalog(
  provider: AiHostedProvider,
  actor: { accountId: string; userId: string; email: string | null; requestId: string },
  opts: AiProviderDiscoveryOptions = {},
): Promise<{
  discovered: number;
  available: number;
  refreshedAt: string;
  models: AiModelCatalogEntry[];
}> {
  const discovered = await discoverProviderModels(provider, opts);
  if (discovered.length === 0) {
    throw new AiProviderDiscoveryError(
      provider,
      'invalid_response',
      `${provider} model discovery returned an empty catalog; existing availability was preserved.`,
    );
  }

  const refreshStopped = (): boolean => opts.abortSignal?.aborted === true ||
    (opts.deadlineAt !== undefined && Date.now() >= opts.deadlineAt);
  if (refreshStopped()) {
    throw new AiProviderDiscoveryError(
      provider,
      'upstream_failure',
      `${provider} model refresh was cancelled or exceeded its deadline before catalog update.`,
    );
  }

  const { data: existingData, error: existingError } = await supabaseAdmin
    .from('ai_model_catalog')
    .select('model_id, first_seen_at, pricing, capabilities, source')
    .eq('provider', provider);
  if (existingError) throw new Error(`AI model catalog preflight failed: ${existingError.message}`);
  const existing = new Map(
    ((existingData ?? []) as Array<Record<string, unknown>>)
      .filter((row) => typeof row.model_id === 'string')
      .map((row) => [row.model_id as string, row]),
  );

  const refreshedAt = new Date().toISOString();
  const rows = discovered.map((model) => {
    const previous = existing.get(model.modelId);
    const previousCapabilities = Array.isArray(previous?.capabilities)
      ? previous.capabilities.filter(isCapability)
      : [];
    const capabilities = [...new Set([...model.capabilities, ...previousCapabilities])];
    const previousPricing = parsePricing(previous?.pricing);
    // Provider list APIs do not publish prices. Never overwrite a separately
    // verified/manual catalog rate with the conservative unknown-model estimate.
    const pricing = model.pricing?.source === 'conservative-unverified' && previousPricing
      && previousPricing.source !== 'conservative-unverified'
      ? previousPricing
      : model.pricing ?? previousPricing;
    // Registry-baseline rows (appended because the provider list omitted an
    // alias the application ships with) stay 'registry' — they were NOT
    // observed on the provider list this refresh.
    const source = model.source === 'registry'
      ? 'registry'
      : model.source === 'provider+registry' || previous?.source === 'registry'
        ? 'provider+registry'
        : 'provider';
    return {
      model_id: model.modelId,
      display_name: model.displayName,
      capabilities,
      max_input_tokens: model.maxInputTokens,
      max_output_tokens: model.maxOutputTokens,
      released_at: model.releasedAt,
      pricing,
      source,
      raw_metadata: model.rawMetadata,
      first_seen_at: typeof previous?.first_seen_at === 'string' ? previous.first_seen_at : refreshedAt,
    };
  });

  const discoveredIds = new Set(discovered.map((model) => model.modelId));
  const missingIds = [...existing.keys()].filter((modelId) => !discoveredIds.has(modelId));

  // Do not begin the atomic catalog mutation at the edge of the route budget.
  // Once started, let it settle rather than racing/abandoning an audited write.
  const remainingMs = opts.deadlineAt === undefined
    ? Number.POSITIVE_INFINITY
    : opts.deadlineAt - Date.now();
  if (refreshStopped() || remainingMs < 3_000) {
    throw new AiProviderDiscoveryError(
      provider,
      'upstream_failure',
      `${provider} model refresh deadline left insufficient time for the atomic catalog update.`,
    );
  }

  const { data: refreshResult, error: refreshError } = await supabaseAdmin.rpc(
    'staxis_refresh_ai_model_catalog',
    {
      p_provider: provider,
      p_models: rows,
      p_missing_model_ids: missingIds,
      p_refreshed_at: refreshedAt,
      p_actor_account_id: actor.accountId,
      p_actor_user_id: actor.userId,
      p_actor_email: actor.email,
      p_request_id: actor.requestId,
    },
  );
  if (refreshError) {
    throw new Error(`AI model catalog update and audit failed: ${refreshError.message}`);
  }

  invalidateAiModelCatalogCache();
  const models = await listAiModels(provider);
  const result = refreshResult && typeof refreshResult === 'object' && !Array.isArray(refreshResult)
    ? refreshResult as Record<string, unknown>
    : {};
  const available = Number(result.available);
  return {
    discovered: discovered.length,
    available: Number.isInteger(available)
      ? available
      : models.filter((model) => model.available).length,
    refreshedAt,
    models,
  };
}

export function listRegistryModelFallbacks(): AiModelCatalogEntry[] {
  return AI_MODEL_OVERLAYS
    .map((overlay) => overlayFallback(overlay.provider as AiHostedProvider, overlay.modelId))
    .filter((row): row is AiModelCatalogEntry => row !== null);
}
