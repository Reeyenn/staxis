import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { validateInt, validateString, validateUuid } from '@/lib/api-validate';
import { getOrMintRequestId } from '@/lib/log';
import { isAiFeatureKey } from '@/lib/ai/feature-registry';
import {
  createAiConfigVersion,
  listAiConfigVersions,
} from '@/lib/ai/model-config-store';
import type {
  AiConfigsResponse,
  CreateAiConfigRequest,
  CreateAiConfigResponse,
} from '@/lib/ai/types';
import { aiControlError, NO_STORE_HEADERS, parseModelSelection } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
  const rawFeatureKey = req.nextUrl.searchParams.get('featureKey');
  if (rawFeatureKey !== null && !isAiFeatureKey(rawFeatureKey)) {
    return err('unknown featureKey', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS,
    });
  }
  const rawLimit = req.nextUrl.searchParams.get('limit');
  const limitV = rawLimit === null
    ? { value: 100 }
    : validateInt(rawLimit, { min: 1, max: 500, label: 'limit' });
  if (limitV.error) {
    return err(limitV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS });
  }
  try {
    const featureKey = rawFeatureKey && isAiFeatureKey(rawFeatureKey) ? rawFeatureKey : undefined;
    const data: AiConfigsResponse = {
      configs: await listAiConfigVersions({ featureKey, limit: limitV.value }),
      featureKey: featureKey ?? null,
    };
    return ok(data, { requestId, headers: NO_STORE_HEADERS });
  } catch (error) {
    return aiControlError(error, requestId);
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
  let raw: Record<string, unknown>;
  try {
    const body = await req.json() as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid');
    raw = body as Record<string, unknown>;
  } catch {
    return err('invalid json', { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS });
  }
  if (!isAiFeatureKey(raw.featureKey)) {
    return err('unknown featureKey', { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS });
  }
  if (typeof raw.enabled !== 'boolean') {
    return err('enabled must be a boolean', { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS });
  }
  const primary = parseModelSelection(raw.primary, 'primary');
  if (primary.error || !primary.value) {
    return err(primary.error ?? 'primary is invalid', { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS });
  }
  const fallback: { value?: import('@/lib/ai/types').AiModelSelection | null; error?: string } =
    raw.fallback === null || raw.fallback === undefined
    ? { value: null, error: undefined }
    : parseModelSelection(raw.fallback, 'fallback');
  if (fallback.error) {
    return err(fallback.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS });
  }
  if (
    fallback.value
    && fallback.value.provider === primary.value.provider
    && fallback.value.modelId === primary.value.modelId
  ) {
    return err('fallback must differ from primary', { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS });
  }
  const parameters = raw.parameters ?? {};
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
    return err('parameters must be an object', { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS });
  }
  if (JSON.stringify(parameters).length > 10_000) {
    return err('parameters exceed 10000 characters', { requestId, status: 413, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS });
  }
  let parentId: string | null = null;
  if (raw.parentId !== undefined && raw.parentId !== null) {
    const parentV = validateUuid(raw.parentId, 'parentId');
    if (parentV.error) return err(parentV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS });
    parentId = parentV.value ?? null;
  }
  let changeReason: string | null = null;
  if (raw.changeReason !== undefined && raw.changeReason !== null) {
    const reasonV = validateString(raw.changeReason, { label: 'changeReason', max: 1000, allowEmpty: true });
    if (reasonV.error) return err(reasonV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS });
    changeReason = reasonV.value?.trim() || null;
  }
  const input: CreateAiConfigRequest = {
    featureKey: raw.featureKey,
    enabled: raw.enabled,
    primary: primary.value,
    fallback: fallback.value ?? null,
    parameters: parameters as Record<string, unknown>,
    parentId,
    changeReason,
  };
  try {
    const data: CreateAiConfigResponse = {
      config: await createAiConfigVersion(input, {
        accountId: auth.accountId,
        userId: auth.userId,
        email: auth.email,
        requestId,
      }),
    };
    return ok(data, { requestId, status: 201, headers: NO_STORE_HEADERS });
  } catch (error) {
    return aiControlError(error, requestId);
  }
}
