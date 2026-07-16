import 'server-only';

import Anthropic from '@anthropic-ai/sdk';
import { env } from '@/lib/env';
import { CONSERVATIVE_ANTHROPIC_PRICING, getAiModelOverlay } from './feature-registry';
import type {
  AiCapability,
  AiHostedProvider,
  AiModelPricing,
} from './types';

export interface DiscoveredAiModel {
  provider: AiHostedProvider;
  modelId: string;
  displayName: string;
  capabilities: AiCapability[];
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  releasedAt: string | null;
  pricing: AiModelPricing | null;
  source: 'provider' | 'provider+registry';
  rawMetadata: Record<string, unknown>;
}

export class AiProviderDiscoveryError extends Error {
  constructor(
    public readonly provider: AiHostedProvider,
    public readonly reason: 'not_configured' | 'upstream_failure' | 'invalid_response',
    message: string,
  ) {
    super(message);
    this.name = 'AiProviderDiscoveryError';
  }
}

export interface AiProviderDiscoveryOptions {
  /** Route-owned absolute deadline shared by provider discovery and catalog I/O. */
  deadlineAt?: number;
  abortSignal?: AbortSignal;
}

const PROVIDER_LIST_TIMEOUT_MS = 20_000;

function providerDiscoverySignal(
  provider: AiHostedProvider,
  opts: AiProviderDiscoveryOptions,
): { signal: AbortSignal; timeoutMs: number } {
  const remainingMs = opts.deadlineAt === undefined
    ? PROVIDER_LIST_TIMEOUT_MS
    : Math.floor(opts.deadlineAt - Date.now());
  if (remainingMs <= 0 || opts.abortSignal?.aborted) {
    throw new AiProviderDiscoveryError(
      provider,
      'upstream_failure',
      `${provider} model discovery was cancelled or exceeded its refresh deadline.`,
    );
  }
  const timeoutMs = Math.max(1, Math.min(PROVIDER_LIST_TIMEOUT_MS, remainingMs));
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return {
    timeoutMs,
    signal: opts.abortSignal
      ? AbortSignal.any([opts.abortSignal, timeoutSignal])
      : timeoutSignal,
  };
}

function uniqueCapabilities(values: AiCapability[]): AiCapability[] {
  return [...new Set(values)];
}

function mergeOverlay(
  provider: AiHostedProvider,
  modelId: string,
  providerCapabilities: AiCapability[],
): Pick<DiscoveredAiModel, 'capabilities' | 'pricing' | 'source'> {
  const overlay = getAiModelOverlay(provider, modelId);
  return {
    capabilities: uniqueCapabilities([
      ...providerCapabilities,
      ...(overlay?.capabilities ?? []),
    ]),
    pricing: overlay?.pricing
      ? { ...overlay.pricing }
      : provider === 'anthropic'
        ? { ...CONSERVATIVE_ANTHROPIC_PRICING }
        : null,
    source: overlay ? 'provider+registry' : 'provider',
  };
}

async function discoverAnthropicModels(
  opts: AiProviderDiscoveryOptions,
): Promise<DiscoveredAiModel[]> {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new AiProviderDiscoveryError(
      'anthropic',
      'not_configured',
      'Anthropic model discovery is unavailable because the provider is not configured.',
    );
  }

  const request = providerDiscoverySignal('anthropic', opts);
  const client = new Anthropic({
    apiKey,
    timeout: request.timeoutMs,
    // Catalog refresh is a bounded admin operation. SDK retries could turn a
    // 20s list request into 40s+ and outlive the route's 30s platform limit.
    maxRetries: 0,
  });

  try {
    const page = await client.models.list({ limit: 100 }, { signal: request.signal });
    const rows: DiscoveredAiModel[] = [];
    for await (const model of page) {
      if (rows.length >= 1_000) break;
      const capabilities: AiCapability[] = ['text'];
      // All models returned by Anthropic's Messages-model catalog support the
      // Messages tool protocol; the API capability object currently does not
      // expose a dedicated tool-use flag.
      if (model.id.startsWith('claude-')) capabilities.push('tool_use');
      if (model.capabilities?.image_input?.supported) capabilities.push('image_input');
      if (model.capabilities?.pdf_input?.supported) capabilities.push('pdf_input');
      if (model.capabilities?.structured_outputs?.supported) capabilities.push('structured_output');
      const merged = mergeOverlay('anthropic', model.id, capabilities);
      rows.push({
        provider: 'anthropic',
        modelId: model.id,
        displayName: model.display_name || model.id,
        capabilities: merged.capabilities,
        maxInputTokens: model.max_input_tokens ?? null,
        maxOutputTokens: model.max_tokens ?? null,
        releasedAt: model.created_at || null,
        pricing: merged.pricing,
        source: merged.source,
        rawMetadata: {
          type: model.type,
          capabilities: model.capabilities ?? null,
        },
      });
    }
    return rows;
  } catch (error) {
    if (error instanceof AiProviderDiscoveryError) throw error;
    throw new AiProviderDiscoveryError(
      'anthropic',
      'upstream_failure',
      'Anthropic model discovery failed. The configured credentials or provider API may be unavailable.',
    );
  }
}

interface OpenAiModelsResponse {
  data?: Array<{
    id?: unknown;
    created?: unknown;
    owned_by?: unknown;
    object?: unknown;
  }>;
}

function titleFromModelId(modelId: string): string {
  return modelId
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.length <= 3 ? part.toUpperCase() : `${part[0].toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

async function discoverOpenAiModels(
  opts: AiProviderDiscoveryOptions,
): Promise<DiscoveredAiModel[]> {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new AiProviderDiscoveryError(
      'openai',
      'not_configured',
      'OpenAI model discovery is unavailable because the provider is not configured.',
    );
  }

  let response: Response;
  try {
    const request = providerDiscoverySignal('openai', opts);
    response = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: request.signal,
      cache: 'no-store',
    });
  } catch {
    throw new AiProviderDiscoveryError(
      'openai',
      'upstream_failure',
      'OpenAI model discovery failed. The provider API may be unavailable.',
    );
  }

  if (!response.ok) {
    throw new AiProviderDiscoveryError(
      'openai',
      'upstream_failure',
      `OpenAI model discovery returned HTTP ${response.status}.`,
    );
  }

  let payload: OpenAiModelsResponse;
  try {
    payload = await response.json() as OpenAiModelsResponse;
  } catch {
    throw new AiProviderDiscoveryError(
      'openai',
      'invalid_response',
      'OpenAI model discovery returned an invalid response.',
    );
  }
  if (!Array.isArray(payload.data)) {
    throw new AiProviderDiscoveryError(
      'openai',
      'invalid_response',
      'OpenAI model discovery returned no model list.',
    );
  }

  const rows: DiscoveredAiModel[] = [];
  for (const item of payload.data.slice(0, 5_000)) {
    if (typeof item.id !== 'string' || item.id.length === 0 || item.id.length > 200) continue;
    // OpenAI's list endpoint provides identity/ownership only. Unknown models
    // deliberately receive no inferred capabilities; a curated overlay is
    // required before capability validation can pass for a feature.
    const merged = mergeOverlay('openai', item.id, []);
    const created = typeof item.created === 'number' && Number.isFinite(item.created)
      ? new Date(item.created * 1000).toISOString()
      : null;
    rows.push({
      provider: 'openai',
      modelId: item.id,
      displayName: getAiModelOverlay('openai', item.id)?.displayName ?? titleFromModelId(item.id),
      capabilities: merged.capabilities,
      maxInputTokens: null,
      maxOutputTokens: null,
      releasedAt: created,
      pricing: merged.pricing,
      source: merged.source,
      rawMetadata: {
        object: typeof item.object === 'string' ? item.object : null,
        ownedBy: typeof item.owned_by === 'string' ? item.owned_by : null,
      },
    });
  }
  return rows;
}

export async function discoverProviderModels(
  provider: AiHostedProvider,
  opts: AiProviderDiscoveryOptions = {},
): Promise<DiscoveredAiModel[]> {
  if (provider === 'anthropic') return discoverAnthropicModels(opts);
  return discoverOpenAiModels(opts);
}
