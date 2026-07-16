import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { validateUuid } from '@/lib/api-validate';
import {
  checkAndIncrementRateLimit,
  hashToRateLimitKey,
  rateLimitedResponse,
} from '@/lib/api-ratelimit';
import { getOrMintRequestId } from '@/lib/log';
import { validateAiConfigVersion } from '@/lib/ai/model-config-store';
import type { ValidateAiConfigResponse } from '@/lib/ai/types';
import { aiControlError, NO_STORE_HEADERS } from '../../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const idV = validateUuid(id, 'id');
  if (idV.error) return err(idV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS });

  const rateLimit = await checkAndIncrementRateLimit(
    'admin-ai-config-validate',
    hashToRateLimitKey(`admin-ai-control:${auth.accountId}`),
  );
  if (!rateLimit.allowed) {
    return rateLimitedResponse(rateLimit.current, rateLimit.cap, rateLimit.retryAfterSec);
  }

  try {
    const result = await validateAiConfigVersion(idV.value!, {
      accountId: auth.accountId,
      userId: auth.userId,
      email: auth.email,
      requestId,
    });
    const data: ValidateAiConfigResponse = result;
    return ok(data, { requestId, headers: NO_STORE_HEADERS });
  } catch (error) {
    return aiControlError(error, requestId);
  }
}
