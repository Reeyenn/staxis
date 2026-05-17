/**
 * POST /api/populate-rooms-from-plan
 *
 * Manual "load all 74 rooms from the CSV" button on the Rooms tab.
 * Reads plan_snapshots(property_id=pid, date=date) (the last CSV pull at 6am or
 * 7pm) and seeds every room in that snapshot into the `rooms` table so the
 * Rooms tab grid shows the full property, not just the 15 rooms Maria assigned.
 *
 * Behavior:
 *   • NEW row (doesn't exist yet) → create with type + status from CSV
 *   • EXISTING row → overwrite type + status from CSV, clear stale progress;
 *     PRESERVE assigned_to/assigned_name/is_dnd/stayover_* so Maria's Send
 *     shift confirmations work and HK progress are not lost.
 *
 * This endpoint is fired only when the user clicks the button. Nothing
 * calls it automatically.
 *
 * Body: { pid, date, uid?: string }  (uid ignored — legacy)
 */
import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { validateUuid, validateDateStr, LIMITS } from '@/lib/api-validate';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log, getOrMintRequestId } from '@/lib/log';
import { seedRoomsForDate } from '@/lib/rooms/seed';

interface RequestBody {
  pid: string;
  date: string;
  /** Legacy — ignored. */
  uid?: string;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  // Auth: writes/upserts every room row for the date. Without auth, any
  // caller could rewrite our rooms table.
  const session = await requireSession(req);
  if (!session.ok) return session.response;
  try {
    const body = await req.json().catch(() => null) as RequestBody | null;
    if (!body || typeof body !== 'object') {
      return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }

    const pidV = validateUuid(body.pid, 'pid');
    if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    const dateV = validateDateStr(body.date, { allowFutureDays: LIMITS.SHIFT_DATE_FUTURE_DAYS, allowPastDays: 14, label: 'date' });
    if (dateV.error) return err(dateV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

    const pid = pidV.value!;
    const date = dateV.value!;

    if (!(await userHasPropertyAccess(session.userId, pid))) {
      return err('forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
    }
    // 20/hour/property is plenty: this is a manual button click that
    // upserts ~74 rows. Anything more than ~1/min is either a bug or abuse.
    const limit = await checkAndIncrementRateLimit('populate-rooms-from-plan', pid);
    if (!limit.allowed) return rateLimitedResponse(limit.current, limit.cap, limit.retryAfterSec);

    // Preserve the legacy 404 when no CSV is available — managers expect
    // "no CSV pulled yet" to surface as an actionable error from the
    // manual button, not silently fall through to a vacant-everywhere
    // seed. The cron (seed-rooms-daily) takes the silent-fallback path
    // because there's no human there to read the message.
    const { data: planRow, error: planErr } = await supabaseAdmin
      .from('plan_snapshots')
      .select('rooms')
      .eq('property_id', pid)
      .eq('date', date)
      .maybeSingle();
    if (planErr) throw planErr;
    if (!planRow) {
      return err(
        `No plan_snapshots row found for (${pid}, ${date}) — no CSV has been pulled for that date yet.`,
        { requestId, status: 404, code: ApiErrorCode.NotFound },
      );
    }
    if (!Array.isArray(planRow.rooms) || (planRow.rooms as unknown[]).length === 0) {
      return err(
        `plan_snapshots row has no rooms array — CSV pull may have failed.`,
        { requestId, status: 404, code: ApiErrorCode.NotFound },
      );
    }

    // Delegate the union + phantom-seed work to the shared helper. Single
    // code path for both this manual route and the daily cron.
    const result = await seedRoomsForDate(pid, date);

    return ok({
      date,
      created: result.created,
      updated: result.updated,
      phantomCreated: result.phantomCreated,
      total: result.created + result.updated,
      csvPulledAt: result.csvPulledAt,
    }, { requestId });
  } catch (caughtErr: unknown) {
    // Don't echo errToString back — Postgres / supabase-js errors leak
    // schema details. Log full error server-side, generic 500 to caller.
    log.error('[populate-rooms-from-plan] Error', { err: caughtErr, requestId });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
