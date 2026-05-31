// POST /api/compliance/log-pm-check
// Body: { pid, pmTaskId, status, unitsChecked?, note? }
//
// Manager logs a PM check-off from the desktop Compliance tab.

import { NextRequest } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { validateUuid, validateString, validateEnum, validateInt } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { logPmCheck } from '@/lib/compliance/store';
import { PM_STATUSES } from '@/lib/compliance/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

interface Body { pid?: unknown; pmTaskId?: unknown; status?: unknown; unitsChecked?: unknown; note?: unknown }

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return session.response;

  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body) return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const pidV = validateUuid(body.pid, 'pid');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const taskV = validateUuid(body.pmTaskId, 'pmTaskId');
  if (taskV.error) return err(taskV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const statusV = validateEnum(body.status, PM_STATUSES, 'status');
  if (statusV.error) return err(statusV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const pid = pidV.value!, pmTaskId = taskV.value!, status = statusV.value!;

  let unitsChecked: number | null = null;
  if (body.unitsChecked !== undefined && body.unitsChecked !== null && body.unitsChecked !== '') {
    const uv = validateInt(body.unitsChecked, { min: 0, max: 100000, label: 'unitsChecked' });
    if (uv.error) return err(uv.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    unitsChecked = uv.value!;
  }
  let note: string | null = null;
  if (body.note !== undefined && body.note !== null) {
    const nv = validateString(body.note, { max: 500, label: 'note', allowEmpty: true });
    if (nv.error) return err(nv.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    note = nv.value || null;
  }

  if (!(await userHasPropertyAccess(session.userId, pid))) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }
  const rl = await checkAndIncrementRateLimit('compliance-log', pid);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  try {
    const { data: acct } = await supabaseAdmin.from('accounts').select('display_name, username').eq('data_user_id', session.userId).maybeSingle();
    const name = (acct?.display_name as string) || (acct?.username as string) || 'Manager';
    const result = await logPmCheck({ pid, pmTaskId, status, unitsChecked, note, staffId: null, staffName: name });
    return ok({ checkId: result.check.id, periodKey: result.check.periodKey, workOrderCreated: !!result.workOrderId }, { requestId });
  } catch (e) {
    const msg = errToString(e);
    log.error('[compliance/log-pm-check] failed', { requestId, pid, msg });
    if (/not found/i.test(msg)) return err('PM task not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
