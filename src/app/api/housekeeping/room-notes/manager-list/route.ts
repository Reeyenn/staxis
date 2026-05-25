/**
 * GET /api/housekeeping/room-notes/manager-list?pid=...&date=...
 *
 * Manager-side list of room notes for a date. Session-gated (the housekeeper-
 * facing GET on the sibling route requires staffId for capability scoping
 * which managers don't have).
 *
 * Indexes the response by room_number so the RoomsTab modal can render
 * just the notes for the selected room in O(1).
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
export const maxDuration = 10;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const headers = { 'x-request-id': requestId };

  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  const { searchParams } = new URL(req.url);
  const pidV = validateUuid(searchParams.get('pid'), 'pid');
  if (pidV.error) {
    return err(pidV.error, {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers,
    });
  }
  const date = searchParams.get('date');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return err('invalid date', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers,
    });
  }
  const pid = pidV.value!;

  const hasAccess = await userHasPropertyAccess(session.userId, pid);
  if (!hasAccess) {
    return err('property access denied', {
      requestId, status: 403, code: ApiErrorCode.Forbidden, headers,
    });
  }

  const rl = await checkAndIncrementRateLimit(
    'housekeeping-room-notes-read',
    hashToRateLimitKey(`${pid}:${session.userId}`),
  );
  if (!rl.allowed) {
    return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
  }

  try {
    const nowIso = new Date().toISOString();
    type NoteRow = {
      id: string;
      room_number: string;
      note_text: string;
      note_lang: string;
      posted_at: string;
      expires_at: string | null;
    };
    const { data, error: q } = await supabaseAdmin
      .from('manager_room_notes')
      .select('id, room_number, note_text, note_lang, posted_at, expires_at')
      .eq('property_id', pid)
      .eq('business_date', date)
      .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
      .order('posted_at', { ascending: false });
    if (q) throw q;
    const byRoom: Record<string, NoteRow[]> = {};
    for (const n of (data ?? []) as NoteRow[]) {
      const list = byRoom[n.room_number] ?? [];
      list.push(n);
      byRoom[n.room_number] = list;
    }
    return ok({ byRoom }, { requestId, headers });
  } catch (caughtErr) {
    log.error('housekeeping/room-notes/manager-list: GET failed', {
      requestId, err: errToString(caughtErr),
    });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError, headers,
    });
  }
}
