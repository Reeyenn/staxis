import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { validateString, validateUuid } from '@/lib/api-validate';
import { getOrMintRequestId } from '@/lib/log';
import { activateAiConfigVersion } from '@/lib/ai/model-config-store';
import type { ActivateAiConfigRequest } from '@/lib/ai/types';
import { aiControlError, NO_STORE_HEADERS } from '../../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
  let raw: Record<string, unknown>;
  try {
    const body = await req.json() as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid');
    raw = body as Record<string, unknown>;
  } catch {
    return err('invalid json', { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS });
  }
  if (!Object.prototype.hasOwnProperty.call(raw, 'expectedActiveId')) {
    return err('expectedActiveId is required', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS,
    });
  }
  let expectedActiveId: string | null = null;
  if (raw.expectedActiveId !== null) {
    const expectedV = validateUuid(raw.expectedActiveId, 'expectedActiveId');
    if (expectedV.error) return err(expectedV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS });
    expectedActiveId = expectedV.value ?? null;
  }
  const reasonV = validateString(raw.reason, { label: 'reason', min: 3, max: 1000 });
  if (reasonV.error) return err(reasonV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: NO_STORE_HEADERS });
  const body: ActivateAiConfigRequest = { expectedActiveId, reason: reasonV.value!.trim() };
  try {
    const data = await activateAiConfigVersion({
      id: idV.value!,
      expectedActiveId: body.expectedActiveId,
      reason: body.reason,
      action: 'ai.config.rollback',
      requestId,
      actor: { accountId: auth.accountId, userId: auth.userId, email: auth.email },
    });
    return ok(data, { requestId, headers: NO_STORE_HEADERS });
  } catch (error) {
    return aiControlError(error, requestId);
  }
}
