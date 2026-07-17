import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { validateUuid } from '@/lib/api-validate';
import { getOrMintRequestId } from '@/lib/log';
import { getAiConfigVersion } from '@/lib/ai/model-config-store';
import { aiControlError, NO_STORE_HEADERS } from '../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const idV = validateUuid(id, 'id');
  if (idV.error) return err(idV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS });
  try {
    const config = await getAiConfigVersion(idV.value!);
    if (!config) return err('AI config version not found', { requestId, status: 404, code: ApiErrorCode.NotFound, headers: NO_STORE_HEADERS });
    return ok({ config }, { requestId, headers: NO_STORE_HEADERS });
  } catch (error) {
    return aiControlError(error, requestId);
  }
}
