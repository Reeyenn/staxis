// POST /api/compliance/log-reading
// Body: { pid, readingTypeId, value?, textValue?, note? }
//
// Manager logs a reading from the desktop Compliance tab. Same logging path
// (out-of-range auto-act) as the engineer surface; attributed to the manager.

import { NextRequest } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { validateUuid, validateString } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { checkAndIncrementRateLimit, rateLimitedResponse, hashToRateLimitKey } from '@/lib/api-ratelimit';
import { logReading } from '@/lib/compliance/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

interface Body { pid?: unknown; readingTypeId?: unknown; value?: unknown; textValue?: unknown; note?: unknown }

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return session.response;

  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body) return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const pidV = validateUuid(body.pid, 'pid');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const typeV = validateUuid(body.readingTypeId, 'readingTypeId');
  if (typeV.error) return err(typeV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const pid = pidV.value!, readingTypeId = typeV.value!;

  let value: number | null = null;
  if (body.value !== null && body.value !== undefined && body.value !== '') {
    const n = Number(body.value);
    if (!Number.isFinite(n) || n < -1e9 || n > 1e9) return err('value must be a number', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    value = n;
  }
  let textValue: string | null = null;
  if (body.textValue !== undefined && body.textValue !== null) {
    const tv = validateString(body.textValue, { max: 200, label: 'textValue', allowEmpty: true });
    if (tv.error) return err(tv.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    textValue = tv.value || null;
  }
  if (value === null && !textValue) return err('Provide a numeric value or a text value', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  let note: string | null = null;
  if (body.note !== undefined && body.note !== null) {
    const nv = validateString(body.note, { max: 500, label: 'note', allowEmpty: true });
    if (nv.error) return err(nv.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    note = nv.value || null;
  }

  if (!(await userHasPropertyAccess(session.userId, pid))) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }
  const rl = await checkAndIncrementRateLimit('compliance-log', hashToRateLimitKey(`${pid}:${session.userId}`));
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  try {
    const { data: acct } = await supabaseAdmin.from('accounts').select('display_name, username').eq('data_user_id', session.userId).maybeSingle();
    const name = (acct?.display_name as string) || (acct?.username as string) || 'Manager';
    const result = await logReading({ pid, readingTypeId, value, textValue, source: 'manual', note, staffId: null, staffName: name });
    return ok({ readingId: result.reading.id, outOfRange: result.outOfRange, workOrderCreated: !!result.workOrderId }, { requestId });
  } catch (e) {
    const msg = errToString(e);
    log.error('[compliance/log-reading] failed', { requestId, pid, msg });
    if (/not found/i.test(msg)) return err('Reading type not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
