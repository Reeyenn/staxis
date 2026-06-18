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
import { errToString, todayStr } from '@/lib/utils';
import { validateUuid } from '@/lib/api-validate';
import { mergePmsRoomsForDate } from '@/lib/pms-rooms-server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import {
  checkAndIncrementRateLimit,
  rateLimitedResponse,
  hashToRateLimitKey,
} from '@/lib/api-ratelimit';
import { enqueueSms, processSmsJobs } from '@/lib/sms-jobs';

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
    // Find the room on today's board via the pms_* merge (single source) —
    // also yields the assigned housekeeper for the SMS.
    const date = todayStr();
    const merged = await mergePmsRoomsForDate(pid, date);
    const room = merged.find((r) => r.number === roomNumber);
    if (!room) {
      return err('room not found', {
        requestId, status: 404, code: ApiErrorCode.NotFound, headers,
      });
    }

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

    // UPDATE-only (not upsert) on today's assignment row so a rush on a room
    // with no assignment doesn't materialize a phantom 'dirty' tile.
    const { data: rushRows, error: updErr } = await supabaseAdmin
      .from('pms_housekeeping_assignments')
      .update(updatePayload)
      .eq('property_id', pid)
      .eq('room_number', roomNumber)
      .eq('date', date)
      .select('room_number');
    if (updErr) {
      log.error('front-desk/rush: assignment update failed', {
        requestId, err: errToString(updErr),
      });
      return err('Internal server error', {
        requestId, status: 500, code: ApiErrorCode.InternalError, headers,
      });
    }
    if (!rushRows || rushRows.length === 0) {
      // Room is in inventory but has no HK assignment row for today, so the
      // rush didn't persist (UPDATE-only, to avoid materializing a phantom
      // dirty tile). Surface it so a "Housekeeper notified" isn't silently a
      // no-op. Rare in practice — rushed rooms are checkouts already on the plan.
      log.warn('front-desk/rush: no assignment row for today — rush not persisted', {
        requestId, pid, roomNumber, date,
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
      const assignedStaffIds = room.assignedTo ? [room.assignedTo] : [];
      if (assignedStaffIds.length > 0) {
        smsQueued = true;
        // Fan out asynchronously. void-ed promise lets the request return
        // immediately. We ENQUEUE durable SMS jobs (idempotent on the key) and
        // drain promptly — the previous code POST-ed to /api/sms-send, which
        // does not exist, so the housekeeper was NEVER notified while the UI
        // said "Housekeeper notified". (Audit fix 2026-06-18.)
        void (async () => {
          try {
            type StaffRow = { id: string; phone: string | null };
            const { data: staffRows } = await supabaseAdmin
              .from('staff')
              .select('id, phone')
              .in('id', assignedStaffIds);
            const recipients = ((staffRows ?? []) as StaffRow[]).filter((s) => s.phone);
            await Promise.allSettled(
              recipients.map((s) =>
                enqueueSms({
                  propertyId: pid,
                  toPhone: s.phone!,
                  body: `🚨 Rush: Room ${roomNumber} needs to be ready in ${body.due_label}.`,
                  // One rush text per (room, staff, day, duration) — a double-tap
                  // dedups; a genuinely new rush (different duration) re-sends.
                  idempotencyKey: `rush:${pid}:${roomNumber}:${s.id}:${date}:${body.due_label}`,
                  metadata: { source: 'front-desk-rush', roomNumber },
                }),
              ),
            );
            // Drain promptly — a rush is time-sensitive; don't wait for the
            // next process-sms-jobs cron tick. Failures stay queued for retry.
            if (recipients.length > 0) {
              try { await processSmsJobs(20); } catch { /* cron will retry */ }
            }
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
        roomsUpdated: 1,
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
