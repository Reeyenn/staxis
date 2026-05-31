// POST /api/compliance/anomaly-ack
// Body: { pid, alertId }
//
// Manager dismisses (acknowledges) an active anomaly alert from the Compliance
// tab. requireSession + property access; the update is property-scoped.

import { NextRequest } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { validateUuid } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { acknowledgeAnomaly } from '@/lib/compliance/anomaly-engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

interface Body { pid?: unknown; alertId?: unknown }

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return session.response;

  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body) return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const pidV = validateUuid(body.pid, 'pid');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const idV = validateUuid(body.alertId, 'alertId');
  if (idV.error) return err(idV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const pid = pidV.value!;

  if (!(await userHasPropertyAccess(session.userId, pid))) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }
  const rl = await checkAndIncrementRateLimit('compliance-log', pid);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  try {
    const { data: acct } = await supabaseAdmin.from('accounts').select('display_name, username').eq('data_user_id', session.userId).maybeSingle();
    const by = (acct?.display_name as string) || (acct?.username as string) || 'Manager';
    const okAck = await acknowledgeAnomaly(pid, idV.value!, by);
    if (!okAck) return err('Not found or already handled', { requestId, status: 404, code: ApiErrorCode.NotFound });
    return ok({ alertId: idV.value }, { requestId });
  } catch (e) {
    log.error('[compliance/anomaly-ack] failed', { requestId, pid, msg: errToString(e) });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
