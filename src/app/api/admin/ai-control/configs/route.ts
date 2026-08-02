import { defineRoute, adminGate } from '@/lib/api-route';
import { ApiErrorCode } from '@/lib/api-response';
import { validateInt, validateString, validateUuid } from '@/lib/api-validate';
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

export const GET = defineRoute({
  resolve: (req) => adminGate(req),
  handler: async (ctx) => {
    const rawFeatureKey = ctx.req.nextUrl.searchParams.get('featureKey');
    if (rawFeatureKey !== null && !isAiFeatureKey(rawFeatureKey)) {
      return ctx.err('unknown featureKey', {
        status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS,
      });
    }
    const rawLimit = ctx.req.nextUrl.searchParams.get('limit');
    const limitV = rawLimit === null
      ? { value: 100 }
      : validateInt(rawLimit, { min: 1, max: 500, label: 'limit' });
    if (limitV.error) {
      return ctx.err(limitV.error, { status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS });
    }
    try {
      const featureKey = rawFeatureKey && isAiFeatureKey(rawFeatureKey) ? rawFeatureKey : undefined;
      const data: AiConfigsResponse = {
        configs: await listAiConfigVersions({ featureKey, limit: limitV.value }),
        featureKey: featureKey ?? null,
      };
      return ctx.ok(data, { headers: NO_STORE_HEADERS });
    } catch (error) {
      return aiControlError(error, ctx.requestId);
    }
  },
});

export const POST = defineRoute({
  resolve: (req) => adminGate(req),
  handler: async (ctx) => {
    let raw: Record<string, unknown>;
    try {
      const body = await ctx.req.json() as unknown;
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid');
      raw = body as Record<string, unknown>;
    } catch {
      return ctx.err('invalid json', { status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS });
    }
    if (!isAiFeatureKey(raw.featureKey)) {
      return ctx.err('unknown featureKey', { status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS });
    }
    if (typeof raw.enabled !== 'boolean') {
      return ctx.err('enabled must be a boolean', { status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS });
    }
    const primary = parseModelSelection(raw.primary, 'primary');
    if (primary.error || !primary.value) {
      return ctx.err(primary.error ?? 'primary is invalid', { status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS });
    }
    const fallback: { value?: import('@/lib/ai/types').AiModelSelection | null; error?: string } =
      raw.fallback === null || raw.fallback === undefined
      ? { value: null, error: undefined }
      : parseModelSelection(raw.fallback, 'fallback');
    if (fallback.error) {
      return ctx.err(fallback.error, { status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS });
    }
    if (
      fallback.value
      && fallback.value.provider === primary.value.provider
      && fallback.value.modelId === primary.value.modelId
    ) {
      return ctx.err('fallback must differ from primary', { status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS });
    }
    const parameters = raw.parameters ?? {};
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
      return ctx.err('parameters must be an object', { status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS });
    }
    if (JSON.stringify(parameters).length > 10_000) {
      return ctx.err('parameters exceed 10000 characters', { status: 413, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS });
    }
    let parentId: string | null = null;
    if (raw.parentId !== undefined && raw.parentId !== null) {
      const parentV = validateUuid(raw.parentId, 'parentId');
      if (parentV.error) return ctx.err(parentV.error, { status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS });
      parentId = parentV.value ?? null;
    }
    let changeReason: string | null = null;
    if (raw.changeReason !== undefined && raw.changeReason !== null) {
      const reasonV = validateString(raw.changeReason, { label: 'changeReason', max: 1000, allowEmpty: true });
      if (reasonV.error) return ctx.err(reasonV.error, { status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS });
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
          accountId: ctx.accountId,
          userId: ctx.userId,
          email: ctx.email,
          requestId: ctx.requestId,
        }),
      };
      return ctx.ok(data, { status: 201, headers: NO_STORE_HEADERS });
    } catch (error) {
      return aiControlError(error, ctx.requestId);
    }
  },
});
