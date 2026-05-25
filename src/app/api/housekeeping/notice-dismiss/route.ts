/**
 * POST /api/housekeeping/notice-dismiss
 *
 * Housekeeper dismisses a notice from their banner. Public (SMS-linked
 * surface). Idempotent via the housekeeper_dismissed_notices unique
 * constraint on (staff_id, notice_id) — re-dismissing returns 200.
 *
 * Pinned notices can be dismissed too (a busy housekeeper can choose to
 * collapse it for the day); the manager UI will get a "1 housekeeper
 * dismissed" count in a future surface.
 */

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { gateHousekeeperRequest } from '@/lib/housekeeper-workflow/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

interface Body {
  pid?: string;
  staffId?: string;
  noticeId?: string;
  // Idempotency key for offline replay — see offline-replay route.
  actionId?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  const gate = await gateHousekeeperRequest<Body>(req, 'housekeeping-notice-dismiss');
  if (!gate.ok) return gate.response;
  const body = gate.body;
  if (!body.noticeId) {
    return err('missing noticeId', {
      requestId: gate.requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
      headers: gate.headers,
    });
  }

  try {
    // Confirm the notice exists on this property — stop a forged id from
    // creating a dangling dismissal row on a stranger's notice.
    const { data: notice } = await supabaseAdmin
      .from('housekeeping_notices')
      .select('id, property_id')
      .eq('id', body.noticeId)
      .maybeSingle();
    if (!notice || notice.property_id !== gate.pid) {
      return err('notice not found', {
        requestId: gate.requestId,
        status: 404,
        code: ApiErrorCode.NotFound,
        headers: gate.headers,
      });
    }

    const { error: insErr } = await supabaseAdmin
      .from('housekeeper_dismissed_notices')
      .upsert(
        {
          property_id: gate.pid,
          staff_id: gate.staffId,
          notice_id: body.noticeId,
        },
        { onConflict: 'staff_id,notice_id', ignoreDuplicates: true },
      );
    if (insErr) {
      log.error('notice-dismiss: insert failed', {
        requestId: gate.requestId,
        err: errToString(insErr),
      });
      return err('Internal server error', {
        requestId: gate.requestId,
        status: 500,
        code: ApiErrorCode.InternalError,
        headers: gate.headers,
      });
    }

    return ok(
      { dismissed: true, noticeId: body.noticeId },
      { requestId: gate.requestId, headers: gate.headers },
    );
  } catch (caughtErr) {
    log.error('notice-dismiss: threw', {
      requestId: gate.requestId,
      err: errToString(caughtErr),
    });
    return err('Internal server error', {
      requestId: gate.requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
      headers: gate.headers,
    });
  }
}
