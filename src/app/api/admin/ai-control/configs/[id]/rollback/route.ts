import { defineRoute, adminGate } from '@/lib/api-route';
import { ApiErrorCode } from '@/lib/api-response';
import { validateString, validateUuid } from '@/lib/api-validate';
import { activateAiConfigVersion } from '@/lib/ai/model-config-store';
import type { ActivateAiConfigRequest } from '@/lib/ai/types';
import { aiControlError, NO_STORE_HEADERS } from '../../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type AdminGateResult = Awaited<ReturnType<typeof adminGate>>;

export const POST = defineRoute<AdminGateResult, unknown, { id: string }>({
  resolve: (req) => adminGate(req),
  handler: async (ctx) => {
  const { id } = await ctx.params;
  const idV = validateUuid(id, 'id');
  if (idV.error) return ctx.err(idV.error, { status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS });
  let raw: Record<string, unknown>;
  try {
    const body = await ctx.req.json() as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid');
    raw = body as Record<string, unknown>;
  } catch {
    return ctx.err('invalid json', { status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS });
  }
  if (!Object.prototype.hasOwnProperty.call(raw, 'expectedActiveId')) {
    return ctx.err('expectedActiveId is required', {
      status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS,
    });
  }
  let expectedActiveId: string | null = null;
  if (raw.expectedActiveId !== null) {
    const expectedV = validateUuid(raw.expectedActiveId, 'expectedActiveId');
    if (expectedV.error) return ctx.err(expectedV.error, { status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS });
    expectedActiveId = expectedV.value ?? null;
  }
  const reasonV = validateString(raw.reason, { label: 'reason', min: 3, max: 1000 });
  if (reasonV.error) return ctx.err(reasonV.error, { status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS });
  const body: ActivateAiConfigRequest = { expectedActiveId, reason: reasonV.value!.trim() };
  try {
    const data = await activateAiConfigVersion({
      id: idV.value!,
      expectedActiveId: body.expectedActiveId,
      reason: body.reason,
      action: 'ai.config.rollback',
      requestId: ctx.requestId,
      actor: { accountId: ctx.accountId, userId: ctx.userId, email: ctx.email },
    });
    return ctx.ok(data, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return aiControlError(error, ctx.requestId);
  }
  },
});
