import { err, ApiErrorCode } from '@/lib/api-response';
import { log } from '@/lib/log';
import { AiConfigStoreError } from '@/lib/ai/model-config-store';
import { AiProviderDiscoveryError } from '@/lib/ai/provider-discovery';
import type { AiHostedProvider, AiModelSelection } from '@/lib/ai/types';

export const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const;

export function parseHostedProvider(value: unknown): AiHostedProvider | null {
  return value === 'anthropic' || value === 'openai' ? value : null;
}

export function parseModelSelection(
  value: unknown,
  label: string,
): { value?: AiModelSelection; error?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: `${label} must be an object` };
  }
  const raw = value as Record<string, unknown>;
  const provider = parseHostedProvider(raw.provider);
  if (!provider) return { error: `${label}.provider must be anthropic or openai` };
  if (typeof raw.modelId !== 'string' || raw.modelId.length < 1 || raw.modelId.length > 200) {
    return { error: `${label}.modelId must be 1-200 characters` };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(raw.modelId)) {
    return { error: `${label}.modelId contains unsupported characters` };
  }
  return { value: { provider, modelId: raw.modelId } };
}

export function aiControlError(error: unknown, requestId: string): Response {
  if (error instanceof AiConfigStoreError) {
    if (error.code === 'not_found') {
      return err(error.message, { requestId, status: 404, code: ApiErrorCode.NotFound, headers: NO_STORE_HEADERS });
    }
    if (error.code === 'validation_failed') {
      return err(error.message, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS });
    }
    if (error.code === 'conflict') {
      return err(error.message, { requestId, status: 409, code: ApiErrorCode.IdempotencyConflict, headers: NO_STORE_HEADERS });
    }
  }
  if (error instanceof AiProviderDiscoveryError) {
    const status = error.reason === 'not_configured' ? 409 : 502;
    return err(error.message, { requestId, status, code: ApiErrorCode.UpstreamFailure, headers: NO_STORE_HEADERS });
  }
  log.error('[admin/ai-control] operation failed', {
    requestId,
    err: error instanceof Error ? error : new Error(String(error)),
  });
  return err('AI control operation failed.', {
    requestId,
    status: 500,
    code: ApiErrorCode.InternalError,
    headers: NO_STORE_HEADERS,
  });
}
