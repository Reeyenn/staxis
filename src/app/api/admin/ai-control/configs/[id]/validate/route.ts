import { defineRoute, adminGate } from '@/lib/api-route';
import { ApiErrorCode } from '@/lib/api-response';
import { validateUuid } from '@/lib/api-validate';
import {
  checkAndIncrementRateLimit,
  hashToRateLimitKey,
  rateLimitedResponse,
} from '@/lib/api-ratelimit';
import { validateAiConfigVersion } from '@/lib/ai/model-config-store';
import type { ValidateAiConfigResponse } from '@/lib/ai/types';
import { aiControlError, NO_STORE_HEADERS } from '../../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type AdminGateResult = Awaited<ReturnType<typeof adminGate>>;

export const POST = defineRoute<AdminGateResult, unknown, { id: string }>({
  resolve: (req) => adminGate(req),
  handler: async (ctx) => {
  const { id } = await ctx.params;
  const idV = validateUuid(id, 'id');
  if (idV.error) return ctx.err(idV.error, { status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS });

  const rateLimit = await checkAndIncrementRateLimit(
    'admin-ai-config-validate',
    hashToRateLimitKey(`admin-ai-control:${ctx.accountId}`),
  );
  if (!rateLimit.allowed) {
    return rateLimitedResponse(rateLimit.current, rateLimit.cap, rateLimit.retryAfterSec);
  }

  try {
    const result = await validateAiConfigVersion(idV.value!, {
      accountId: ctx.accountId,
      userId: ctx.userId,
      email: ctx.email,
      requestId: ctx.requestId,
    });
    const data: ValidateAiConfigResponse = result;
    return ctx.ok(data, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return aiControlError(error, ctx.requestId);
  }
  },
});
