import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { ok } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { AI_PROVIDERS, type AiFeaturesResponse } from '@/lib/ai/types';
import { listAiFeatureSummaries } from '@/lib/ai/model-config-store';
import { applyLegacyModelOverridesToSummaries } from '@/lib/ai/legacy-model-overrides';
import { aiControlError, NO_STORE_HEADERS } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
  try {
    const data: AiFeaturesResponse = {
      features: applyLegacyModelOverridesToSummaries(await listAiFeatureSummaries()),
      providers: [...AI_PROVIDERS],
      generatedAt: new Date().toISOString(),
    };
    return ok(data, { requestId, headers: NO_STORE_HEADERS });
  } catch (error) {
    return aiControlError(error, requestId);
  }
}
