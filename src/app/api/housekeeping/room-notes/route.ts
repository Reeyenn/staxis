/**
 * Manager room-notes — POST (session-gated, manager dashboard) and
 * GET (public, housekeeper SMS-linked page).
 *
 * One row per (property, room, business_date) is the common case but the
 * table allows multiple — the manager can prepend an "extra towels" note
 * mid-shift without overwriting the morning's "VIP arriving" note.
 *
 * Notes have an optional expires_at; the GET filter respects it so a
 * "for today only" note doesn't bleed into tomorrow's queue.
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

// ── GET ─────────────────────────────────────────────────────────────────
// Returns notes for every room assigned to this staffer on the given date.
export async function GET(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const headers = { 'x-request-id': requestId };
  const { searchParams } = new URL(req.url);

  const pidV = validateUuid(searchParams.get('pid'), 'pid');
  if (pidV.error) {
    return err(pidV.error, {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers,
    });
  }
  const staffV = validateUuid(searchParams.get('staffId'), 'staffId');
  if (staffV.error) {
    return err(staffV.error, {
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
  const staffId = staffV.value!;

  const rl = await checkAndIncrementRateLimit(
    'housekeeping-room-notes-read',
    hashToRateLimitKey(`${pid}:${staffId}`),
  );
  if (!rl.allowed) {
    return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
  }

  const { data: staff } = await supabaseAdmin
    .from('staff')
    .select('id, property_id')
    .eq('id', staffId)
    .maybeSingle();
  if (!staff || staff.property_id !== pid) {
    return err('Not found', { requestId, status: 404, code: ApiErrorCode.NotFound, headers });
  }

  try {
    const nowIso = new Date().toISOString();
    const { data, error: q } = await supabaseAdmin
      .from('manager_room_notes')
      .select('id, room_number, note_text, note_lang, posted_at, expires_at')
      .eq('property_id', pid)
      .eq('business_date', date)
      .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
      .order('posted_at', { ascending: false });
    if (q) throw q;

    type NoteRow = { room_number: string; note_text: string; note_lang: string; posted_at: string; id: string };
    // Index by room_number so the page can pick the latest per room O(1).
    const byRoom: Record<string, NoteRow[]> = {};
    for (const n of (data ?? []) as NoteRow[]) {
      const list = byRoom[n.room_number] ?? [];
      list.push(n);
      byRoom[n.room_number] = list;
    }
    return ok({ byRoom }, { requestId, headers });
  } catch (caughtErr) {
    log.error('room-notes: GET failed', { requestId, err: errToString(caughtErr) });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError, headers,
    });
  }
}

// ── POST ───────────────────────────────────────────────────────────────
// Manager posts a note for a room. Session-gated.
interface PostBody {
  pid?: string;
  room_number?: string;
  business_date?: string; // YYYY-MM-DD
  note_text?: string;
  note_lang?: 'en' | 'es' | 'ht' | 'tl' | 'vi';
  expires_at?: string | null;
}

const ALLOWED_LANGS = new Set(['en', 'es', 'ht', 'tl', 'vi']);

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const headers = { 'x-request-id': requestId };

  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
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
  const businessDate = body.business_date;
  if (!businessDate || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
    return err('invalid business_date', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers,
    });
  }
  const noteText = (body.note_text ?? '').trim();
  if (!noteText) {
    return err('note_text required', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers,
    });
  }
  if (noteText.length > 1000) {
    return err('note_text too long', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers,
    });
  }
  const noteLang = ALLOWED_LANGS.has(body.note_lang ?? '') ? body.note_lang! : 'en';

  let expiresAt: string | null = null;
  if (typeof body.expires_at === 'string' && body.expires_at) {
    const ms = Date.parse(body.expires_at);
    if (!Number.isFinite(ms) || ms <= Date.now()) {
      return err('expires_at must be a future ISO timestamp', {
        requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers,
      });
    }
    expiresAt = new Date(ms).toISOString();
  }

  const hasAccess = await userHasPropertyAccess(session.userId, pid);
  if (!hasAccess) {
    return err('property access denied', {
      requestId, status: 403, code: ApiErrorCode.Forbidden, headers,
    });
  }

  const rl = await checkAndIncrementRateLimit(
    'housekeeping-room-notes-post',
    hashToRateLimitKey(`${pid}:${session.userId}`),
  );
  if (!rl.allowed) {
    return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
  }

  try {
    const { data, error: insErr } = await supabaseAdmin
      .from('manager_room_notes')
      .insert({
        property_id: pid,
        room_number: roomNumber,
        business_date: businessDate,
        note_text: noteText,
        note_lang: noteLang,
        posted_by_account_id: session.userId,
        expires_at: expiresAt,
      })
      .select('id, posted_at')
      .single();
    if (insErr) {
      log.error('room-notes: insert failed', {
        requestId, err: errToString(insErr),
      });
      return err('Internal server error', {
        requestId, status: 500, code: ApiErrorCode.InternalError, headers,
      });
    }

    // Mirror the latest note onto pms_housekeeping_assignments.manager_notes
    // (workflow column, migration 0270) so the housekeeper's JobCard renders
    // the most recent guidance without a second fetch. manager_room_notes
    // remains the auditable history; this column is a display convenience the
    // next post overwrites. UPDATE-only (not upsert) so a note on a room with
    // no assignment row doesn't materialize a phantom 'dirty' tile.
    try {
      const { data: mirrorRows, error: mirrorErr } = await supabaseAdmin
        .from('pms_housekeeping_assignments')
        .update({
          manager_notes: noteText,
          manager_notes_at: data?.posted_at ?? new Date().toISOString(),
          manager_notes_by_account_id: session.userId,
        })
        .eq('property_id', pid)
        .eq('room_number', roomNumber)
        .eq('date', businessDate)
        .select('room_number');
      if (mirrorErr) {
        log.warn('room-notes: manager_notes mirror failed (non-fatal)', {
          requestId, err: mirrorErr.message,
        });
      } else if (!mirrorRows || mirrorRows.length === 0) {
        // No assignment row for the date — the display mirror didn't persist
        // (UPDATE-only). The canonical note is still saved in manager_room_notes.
        log.warn('room-notes: no assignment row for the date — manager_notes mirror skipped', {
          requestId, roomNumber, businessDate,
        });
      }
    } catch (mirrorErr) {
      log.warn('room-notes: manager_notes mirror failed (non-fatal)', {
        requestId, err: errToString(mirrorErr),
      });
    }

    return ok(
      { noteId: data?.id, postedAt: data?.posted_at },
      { requestId, headers },
    );
  } catch (caughtErr) {
    log.error('room-notes: POST threw', {
      requestId, err: errToString(caughtErr),
    });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError, headers,
    });
  }
}

// ── DELETE ──────────────────────────────────────────────────────────────
export async function DELETE(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const headers = { 'x-request-id': requestId };

  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  const { searchParams } = new URL(req.url);
  const noteIdV = validateUuid(searchParams.get('id'), 'id');
  const pidV = validateUuid(searchParams.get('pid'), 'pid');
  if (noteIdV.error || pidV.error) {
    return err(noteIdV.error || pidV.error || 'missing id/pid', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers,
    });
  }
  const pid = pidV.value!;
  const noteId = noteIdV.value!;

  const hasAccess = await userHasPropertyAccess(session.userId, pid);
  if (!hasAccess) {
    return err('property access denied', {
      requestId, status: 403, code: ApiErrorCode.Forbidden, headers,
    });
  }

  const { error: delErr } = await supabaseAdmin
    .from('manager_room_notes')
    .delete()
    .eq('id', noteId)
    .eq('property_id', pid);
  if (delErr) {
    log.error('room-notes: delete failed', { requestId, err: errToString(delErr) });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError, headers,
    });
  }
  return ok({ deleted: true, noteId }, { requestId, headers });
}
