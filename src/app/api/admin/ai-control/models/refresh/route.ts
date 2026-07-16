import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { refreshAiModelCatalog } from '@/lib/ai/model-catalog';
import type { RefreshAiModelsRequest, RefreshAiModelsResponse } from '@/lib/ai/types';
import { aiControlError, NO_STORE_HEADERS, parseHostedProvider } from '../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
const REFRESH_EXECUTION_BUDGET_MS = 25_000;

export async function POST(req: NextRequest): Promise<Response> {
  const refreshDeadlineAt = Date.now() + REFRESH_EXECUTION_BUDGET_MS;
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
  let body: Partial<RefreshAiModelsRequest>;
  try { body = await req.json() as Partial<RefreshAiModelsRequest>; }
  catch {
    return err('invalid json', { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS });
  }
  const provider = parseHostedProvider(body.provider);
  if (!provider) {
    return err('provider must be anthropic or openai', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS,
    });
  }
  try {
    const refreshed = await refreshAiModelCatalog(provider, {
      accountId: auth.accountId,
      userId: auth.userId,
      email: auth.email,
      requestId,
    }, {
      deadlineAt: refreshDeadlineAt,
      abortSignal: req.signal,
    });
    const data: RefreshAiModelsResponse = { provider, ...refreshed };
    return ok(data, { requestId, headers: NO_STORE_HEADERS });
  } catch (error) {
    return aiControlError(error, requestId);
  }
}
