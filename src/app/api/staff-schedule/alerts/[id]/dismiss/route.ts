/**
 * POST /api/staff-schedule/alerts/[id]/dismiss
 *
 * Manager marks an alert dismissed. Idempotent — re-dismissing returns
 * { dismissed: true, alreadyDismissed: true }.
 *
 * Property scoping is enforced via verifyTeamManager + canManageHotel
 * (the route loads the alert's property_id and checks it).
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { verifyTeamManager, canManageHotel } from '@/lib/team-auth';
import { validateUuid } from '@/lib/api-validate';
import {
  checkAndIncrementRateLimit, rateLimitedResponse,
} from '@/lib/api-ratelimit';
import {
  dismissAlert, makeSupabaseDismissWriter,
} from '@/lib/schedule-reactivity/dismiss-alert';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req);
  if (!caller) {
    return err('Unauthorized', {
      requestId, status: 403, code: ApiErrorCode.Unauthorized,
    });
  }

  const { id } = await ctx.params;
  const idCheck = validateUuid(id, 'id');
  if (idCheck.error) {
    return err(idCheck.error, {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  // Load the alert to discover its property_id and bounce-check the caller.
  const { data: row, error: lookupErr } = await supabaseAdmin
    .from('schedule_alerts')
    .select('id, property_id, dismissed_at, applied_at')
    .eq('id', idCheck.value!)
    .maybeSingle();
  if (lookupErr) {
    log.error('[alerts:dismiss] lookup failed', {
      requestId, msg: errToString(lookupErr),
    });
    return err('lookup failed', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
  if (!row) {
    return err('alert not found', {
      requestId, status: 404, code: ApiErrorCode.NotFound,
    });
  }
  const propertyId = String(row.property_id);
  if (!canManageHotel(caller, propertyId)) {
    return err('Forbidden', {
      requestId, status: 403, code: ApiErrorCode.Unauthorized,
    });
  }

  const rl = await checkAndIncrementRateLimit('schedule-alerts-write', propertyId);
  if (!rl.allowed) {
    return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
  }

  const result = await dismissAlert(
    idCheck.value!,
    caller.accountId,
    makeSupabaseDismissWriter(),
  );
  if (result.notFound) {
    // Race: row vanished between lookup and write. Surface as 404.
    return err('alert not found', {
      requestId, status: 404, code: ApiErrorCode.NotFound,
    });
  }
  return ok(
    { dismissed: result.ok, alreadyDismissed: result.alreadyDismissed },
    { requestId },
  );
}
