/**
 * POST /api/front-desk/rush
 *
 * Front-desk clerk taps a "Rush" button on a room tile to ask the
 * housekeeper to prioritize it. The endpoint:
 *   1. Validates pid/room_number/due_label.
 *   2. Sets rooms.is_rush=true + rush_due_by + rush_set_at + rush_set_by
 *      (the columns added in 0222) + rush_requested_by_account_id +
 *      rush_duration_label (0225).
 *   3. ALSO updates the matching cleaning_tasks row (priority='urgent',
 *      due_by) when one exists, so any UI reading from cleaning_tasks
 *      sees the same urgency.
 *   4. Fires an SMS to the assigned housekeeper if there is one (one
 *      best-effort send; we don't block on it).
 *
 * Session-gated (front desk is signed in). Two clerks racing on the same
 * room produce idempotent state — both UPDATEs would land the same set of
 * fields. SMS dedup is left to /api/sms-send's rate limit.
 */

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log, getOrMintRequestId } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { validateUuid } from '@/lib/api-validate';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import {
  checkAndIncrementRateLimit,
  rateLimitedResponse,
  hashToRateLimitKey,
} from '@/lib/api-ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

interface Body {
  pid?: string;
  room_number?: string;
  /** One of '15min' | '30min' | '1hr' — controls the due_by timestamp. */
  due_label?: '15min' | '30min' | '1hr';
  /** Set true to CLEAR a rush instead of setting one. */
  clear?: boolean;
}

const DUE_OFFSET_MS: Record<NonNullable<Body['due_label']>, number> = {
  '15min': 15 * 60_000,
  '30min': 30 * 60_000,
  '1hr':   60 * 60_000,
};

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const headers = { 'x-request-id': requestId };

  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return err('invalid json', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers,
    });
  }

  const pidV = validateUuid(body.pid, 'pid');
  if (pidV.error) {
    return err(pidV.error, {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers,
    });
  }
  const pid = pidV.value!;
  const roomNumber = (body.room_number ?? '').trim();
  if (!roomNumber || roomNumber.length > 20) {
    return err('invalid room_number', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers,
    });
  }
  const isClear = body.clear === true;
  if (!isClear && !body.due_label) {
    return err('due_label required', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers,
    });
  }
  if (!isClear && !DUE_OFFSET_MS[body.due_label!]) {
    return err('invalid due_label', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers,
    });
  }

  const hasAccess = await userHasPropertyAccess(session.userId, pid);
  if (!hasAccess) {
    return err('property access denied', {
      requestId, status: 403, code: ApiErrorCode.Forbidden, headers,
    });
  }

  const rl = await checkAndIncrementRateLimit(
    'front-desk-rush',
    hashToRateLimitKey(`${pid}:${session.userId}`),
  );
  if (!rl.allowed) {
    return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
  }

  const now = new Date();
  const dueByIso = isClear ? null : new Date(now.getTime() + DUE_OFFSET_MS[body.due_label!]).toISOString();

  try {
    // Find every rooms row for this number today + the assigned staff
    // (typically there's one but stayover/checkout can produce more). We
    // also want the assigned staff for the SMS.
    type RoomRow = { id: string; date: string | null; assigned_to: string | null; number: string };
    const { data: roomRows, error: roomErr } = await supabaseAdmin
      .from('rooms')
      .select('id, date, assigned_to, number')
      .eq('property_id', pid)
      .eq('number', roomNumber);
    if (roomErr) {
      log.error('front-desk/rush: rooms read failed', {
        requestId, err: errToString(roomErr),
      });
      return err('Internal server error', {
        requestId, status: 500, code: ApiErrorCode.InternalError, headers,
      });
    }

    const rooms = (roomRows ?? []) as RoomRow[];
    if (rooms.length === 0) {
      return err('room not found', {
        requestId, status: 404, code: ApiErrorCode.NotFound, headers,
      });
    }

    const roomIds = rooms.map((r) => r.id);
    const updatePayload: Record<string, unknown> = isClear
      ? {
          is_rush: false,
          rush_due_by: null,
          rush_set_at: null,
          rush_set_by: null,
          rush_requested_by_account_id: null,
          rush_duration_label: null,
        }
      : {
          is_rush: true,
          rush_due_by: dueByIso,
          rush_set_at: now.toISOString(),
          rush_set_by: null, // staff_id-typed column; front-desk user is an account, not a staff row
          rush_requested_by_account_id: session.userId,
          rush_duration_label: body.due_label,
        };

    const { error: updErr } = await supabaseAdmin
      .from('rooms')
      .update(updatePayload)
      .in('id', roomIds);
    if (updErr) {
      log.error('front-desk/rush: rooms update failed', {
        requestId, err: errToString(updErr),
      });
      return err('Internal server error', {
        requestId, status: 500, code: ApiErrorCode.InternalError, headers,
      });
    }

    // Mirror into cleaning_tasks if a Staxis-side task exists. Use the same
    // dedupe key shape the rules engine uses: room_number + business_date.
    if (!isClear) {
      const today = new Date().toISOString().slice(0, 10);
      const { error: tasksErr } = await supabaseAdmin
        .from('cleaning_tasks')
        .update({
          priority: 'urgent',
          due_by: dueByIso,
        })
        .eq('property_id', pid)
        .eq('room_number', roomNumber)
        .eq('business_date', today);
      if (tasksErr) {
        log.warn('front-desk/rush: cleaning_tasks update failed (non-fatal)', {
          requestId, err: errToString(tasksErr),
        });
      }
    } else {
      // Clearing a rush: drop priority back to 'normal' (rules engine
      // default). Leave due_by alone — the original rule-engine-derived
      // value should re-apply on next run.
      const today = new Date().toISOString().slice(0, 10);
      await supabaseAdmin
        .from('cleaning_tasks')
        .update({ priority: 'normal' })
        .eq('property_id', pid)
        .eq('room_number', roomNumber)
        .eq('business_date', today);
    }

    // Notify housekeeper(s). Fire-and-forget — DON'T `await` the SMS
    // pipeline. The Twilio path can take 3-5 seconds; blocking the
    // response here was making the front-desk's "Rush" button feel slow,
    // and a manager mash-tapping the button could rack up SMS spend
    // before the first response returns to throttle them.
    //
    // The `smsSent` field in the response is now an optimistic "we
    // queued the notification" indicator rather than a confirmed
    // delivery. Twilio failures are logged on the SMS endpoint itself.
    let smsQueued = false;
    if (!isClear) {
      const assignedStaffIds = rooms
        .map((r) => r.assigned_to)
        .filter((s): s is string => !!s);
      if (assignedStaffIds.length > 0) {
        smsQueued = true;
        const origin = new URL(req.url).origin;
        // Fan out asynchronously. void-ed promises let the request
        // continue; the SMS rate limiter inside /api/sms-send caps any
        // runaway send-loop separately.
        void (async () => {
          try {
            type StaffRow = { id: string; phone: string | null };
            const { data: staffRows } = await supabaseAdmin
              .from('staff')
              .select('id, phone')
              .in('id', assignedStaffIds);
            await Promise.allSettled(
              ((staffRows ?? []) as StaffRow[])
                .filter((s) => s.phone)
                .map((s) =>
                  fetch(`${origin}/api/sms-send`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      to: s.phone,
                      message: `🚨 Rush: Room ${roomNumber} needs to be ready in ${body.due_label}.`,
                      source: 'front-desk-rush',
                      propertyId: pid,
                    }),
                  }),
                ),
            );
          } catch (smsErr) {
            log.warn('front-desk/rush: async sms fan-out failed', {
              requestId, err: errToString(smsErr),
            });
          }
        })();
      }
    }

    return ok(
      {
        roomNumber,
        cleared: isClear,
        dueBy: dueByIso,
        // smsQueued = true means we kicked off the async fan-out; it
        // does NOT mean Twilio confirmed delivery. The client UI shows
        // "Housekeeper notified" optimistically.
        smsSent: smsQueued,
        roomsUpdated: rooms.length,
      },
      { requestId, headers },
    );
  } catch (caughtErr) {
    log.error('front-desk/rush: unexpected error', {
      requestId, err: errToString(caughtErr),
    });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError, headers,
    });
  }
}
