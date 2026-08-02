import { defineRoute, adminGate } from '@/lib/api-route';
import { ApiErrorCode } from '@/lib/api-response';
import { checkAndIncrementRateLimit, hashToRateLimitKey, rateLimitedResponse } from '@/lib/api-ratelimit';
import { refreshAiModelCatalog } from '@/lib/ai/model-catalog';
import type { RefreshAiModelsRequest, RefreshAiModelsResponse } from '@/lib/ai/types';
import { aiControlError, NO_STORE_HEADERS, parseHostedProvider } from '../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
const REFRESH_EXECUTION_BUDGET_MS = 25_000;

export const POST = defineRoute({
  resolve: async (req) => {
    const refreshDeadlineAt = Date.now() + REFRESH_EXECUTION_BUDGET_MS;
    const gate = await adminGate(req);
    return gate.ok ? { ...gate, refreshDeadlineAt } : gate;
  },
  handler: async (ctx) => {
    let body: Partial<RefreshAiModelsRequest>;
    try { body = await ctx.req.json() as Partial<RefreshAiModelsRequest>; }
    catch {
      return ctx.err('invalid json', { status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS });
    }
    const provider = parseHostedProvider(body.provider);
    if (!provider) {
      return ctx.err('provider must be anthropic or openai', {
        status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS,
      });
    }
    const rateLimit = await checkAndIncrementRateLimit(
      'admin-ai-models-refresh',
      hashToRateLimitKey(`admin-ai-control:${ctx.accountId}`),
    );
    if (!rateLimit.allowed) {
      return rateLimitedResponse(rateLimit.current, rateLimit.cap, rateLimit.retryAfterSec);
    }
    try {
      const refreshed = await refreshAiModelCatalog(provider, {
        accountId: ctx.accountId,
        userId: ctx.userId,
        email: ctx.email,
        requestId: ctx.requestId,
      }, {
        deadlineAt: ctx.refreshDeadlineAt,
        abortSignal: ctx.req.signal,
      });
      const data: RefreshAiModelsResponse = { provider, ...refreshed };
      return ctx.ok(data, { headers: NO_STORE_HEADERS });
    } catch (error) {
      return aiControlError(error, ctx.requestId);
    }
  },
});
