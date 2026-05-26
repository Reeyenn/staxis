/**
 * POST /api/staff-schedule/alerts/[id]/apply
 *
 * Manager confirms the alert's suggested action. The engine performs the
 * underlying scheduled_shifts mutation (insert open or delete latest-added
 * draft) and stamps applied_at on the alert.
 *
 * Two-write transaction shape:
 *   1) lookup alert + verify property + caller can manage
 *   2) carry out add_shift / release_shift via the apply-alert module
 *   3) stamp applied_at + applied_payload on the alert row
 *
 * Idempotent in the "already applied" sense — re-applying an applied alert
 * returns outcome='already_applied' without re-firing the mutation.
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
import { applyAlert } from '@/lib/schedule-reactivity/apply-alert';
import { makeSupabaseApplyWriter } from '@/lib/schedule-reactivity/persist-apply';
import { loadPropertyConfig } from '@/lib/schedule-reactivity/persist';

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

  // Read the alert's property_id so we can scope the manager check + rate
  // limit. The apply-alert module re-reads the row + re-enforces dismiss/
  // apply idempotency — this lookup is purely for the scoping check.
  const { data: row, error: lookupErr } = await supabaseAdmin
    .from('schedule_alerts')
    .select('id, property_id')
    .eq('id', idCheck.value!)
    .maybeSingle();
  if (lookupErr) {
    log.error('[alerts:apply] lookup failed', {
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

  const cfg = await loadPropertyConfig(propertyId);
  const result = await applyAlert(
    idCheck.value!,
    caller.accountId,
    { releaseShiftStrategy: cfg.releaseShiftStrategy },
    makeSupabaseApplyWriter(),
    propertyId,
  );

  if (!result.ok) {
    // Surface the engine's outcome as a 400 + machine-stable code. The UI
    // maps these onto user-friendly toasts.
    const status =
      result.outcome === 'not_found' ? 404 :
      result.outcome === 'forbidden' ? 403 :
      400;
    return err(
      result.detail ?? humanOutcome(result.outcome),
      {
        requestId, status,
        code: ApiErrorCode.ValidationFailed,
        details: { outcome: result.outcome },
      },
    );
  }

  return ok({
    outcome: result.outcome,
    affectedShiftId: result.affectedShiftId ?? null,
  }, { requestId });
}

function humanOutcome(outcome: string): string {
  switch (outcome) {
    case 'already_applied': return 'This alert was already applied.';
    case 'already_dismissed': return 'This alert was dismissed.';
    case 'shift_already_published':
      return 'Shift already published — unpublish or notify staff first.';
    case 'no_shift_to_release':
      return 'No draft shift to release on this day for this department.';
    default: return 'Could not apply alert.';
  }
}
