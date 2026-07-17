import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { listAiModels } from '@/lib/ai/model-catalog';
import type { AiModelsResponse } from '@/lib/ai/types';
import { aiControlError, NO_STORE_HEADERS, parseHostedProvider } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
  const rawProvider = req.nextUrl.searchParams.get('provider');
  const provider = rawProvider === null ? null : parseHostedProvider(rawProvider);
  if (rawProvider !== null && !provider) {
    return err('provider must be anthropic or openai', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS,
    });
  }
  try {
    const data: AiModelsResponse = {
      models: await listAiModels(provider ?? undefined),
      provider,
    };
    return ok(data, { requestId, headers: NO_STORE_HEADERS });
  } catch (error) {
    return aiControlError(error, requestId);
  }
}
