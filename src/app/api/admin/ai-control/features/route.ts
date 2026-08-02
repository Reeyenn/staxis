import { defineRoute, adminGate } from '@/lib/api-route';
import { AI_PROVIDERS, type AiFeaturesResponse } from '@/lib/ai/types';
import { listAiFeatureSummaries } from '@/lib/ai/model-config-store';
import { applyLegacyModelOverridesToSummaries } from '@/lib/ai/legacy-model-overrides';
import { aiControlError, NO_STORE_HEADERS } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = defineRoute({
  resolve: (req) => adminGate(req),
  handler: async (ctx) => {
    try {
      const data: AiFeaturesResponse = {
        features: applyLegacyModelOverridesToSummaries(await listAiFeatureSummaries()),
        providers: [...AI_PROVIDERS],
        generatedAt: new Date().toISOString(),
      };
      return ctx.ok(data, { headers: NO_STORE_HEADERS });
    } catch (error) {
      return aiControlError(error, ctx.requestId);
    }
  },
});
