import { defineRoute, adminGate } from '@/lib/api-route';
import { ApiErrorCode } from '@/lib/api-response';
import { listAiModels } from '@/lib/ai/model-catalog';
import { isMessagesProviderConfigured } from '@/lib/ai/messages-client';
import { AI_DISCOVERABLE_PROVIDERS } from '@/lib/ai/types';
import type { AiModelsResponse } from '@/lib/ai/types';
import { aiControlError, NO_STORE_HEADERS, parseHostedProvider } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = defineRoute({
  resolve: (req) => adminGate(req),
  handler: async (ctx) => {
    const rawProvider = ctx.req.nextUrl.searchParams.get('provider');
    const provider = rawProvider === null ? null : parseHostedProvider(rawProvider);
    if (rawProvider !== null && !provider) {
      return ctx.err('provider must be anthropic or openai', {
        status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS,
      });
    }
    try {
      const data: AiModelsResponse = {
        models: await listAiModels(provider ?? undefined),
        provider,
        configuredProviders: AI_DISCOVERABLE_PROVIDERS.filter(isMessagesProviderConfigured),
      };
      return ctx.ok(data, { headers: NO_STORE_HEADERS });
    } catch (error) {
      return aiControlError(error, ctx.requestId);
    }
  },
});
