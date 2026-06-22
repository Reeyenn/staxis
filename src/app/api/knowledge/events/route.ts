/**
 * /api/knowledge/events — simple team calendar.
 *
 *   GET    ?pid=                                   → list (ALL STAFF)
 *   POST   { pid, title, eventDate, endDate?, notes? }  → create (MANAGERS)
 *   DELETE ?pid=&id=                                → delete (MANAGERS)
 *
 * Auth: commsContext; writes require the manage_knowledge capability
 * (default: every role; restricted per hotel from the Access tab). Service-role via core.
 */
import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { validateUuid, validateString, validateDateStr } from '@/lib/api-validate';
import { canForUserId } from '@/lib/capabilities/server';
import { commsContext } from '@/lib/comms/route-helpers';
import { listEvents, createEvent, deleteEvent } from '@/lib/knowledge/core';
import { KNOWLEDGE_LIMITS } from '@/lib/knowledge/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const ctx = await commsContext(req, req.nextUrl.searchParams.get('pid'));
  if (!ctx.ok) return ctx.response;
  const events = await listEvents(ctx.pid);
  return ok({ events }, { requestId: ctx.requestId, headers: ctx.headers });
}

export async function POST(req: NextRequest): Promise<Response> {
  let raw: { pid?: string; title?: unknown; eventDate?: unknown; endDate?: unknown; notes?: unknown };
  try { raw = await req.json(); } catch { raw = {}; }

  const ctx = await commsContext(req, raw.pid ?? null);
  if (!ctx.ok) return ctx.response;
  if (!(await canForUserId(ctx.userId, 'manage_knowledge', ctx.pid))) {
    return err('Only managers can add calendar events', { requestId: ctx.requestId, status: 403, code: ApiErrorCode.Forbidden, headers: ctx.headers });
  }

  const titleV = validateString(raw.title, { max: KNOWLEDGE_LIMITS.TITLE_MAX, label: 'title' });
  if (titleV.error) return err(titleV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
  // Allow events up to ~3 years out / ~1 year back so planning isn't blocked.
  const dateV = validateDateStr(raw.eventDate, { label: 'eventDate', allowFutureDays: 1100, allowPastDays: 400 });
  if (dateV.error) return err(dateV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });

  let endDate: string | null = null;
  if (raw.endDate !== undefined && raw.endDate !== null && raw.endDate !== '') {
    const endV = validateDateStr(raw.endDate, { label: 'endDate', allowFutureDays: 1100, allowPastDays: 400 });
    if (endV.error) return err(endV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
    if (endV.value! < dateV.value!) {
      return err('endDate cannot be before eventDate', { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
    }
    endDate = endV.value!;
  }

  let notes: string | null = null;
  if (raw.notes !== undefined && raw.notes !== null && raw.notes !== '') {
    const notesV = validateString(raw.notes, { max: KNOWLEDGE_LIMITS.NOTES_MAX, label: 'notes' });
    if (notesV.error) return err(notesV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
    notes = notesV.value!;
  }

  const { id } = await createEvent(
    ctx.pid,
    { title: titleV.value!, eventDate: dateV.value!, endDate, notes },
    { accountId: ctx.accountId, name: ctx.displayName },
  );
  return ok({ id }, { requestId: ctx.requestId, status: 201, headers: ctx.headers });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const ctx = await commsContext(req, req.nextUrl.searchParams.get('pid'));
  if (!ctx.ok) return ctx.response;
  if (!(await canForUserId(ctx.userId, 'manage_knowledge', ctx.pid))) {
    return err('Only managers can delete calendar events', { requestId: ctx.requestId, status: 403, code: ApiErrorCode.Forbidden, headers: ctx.headers });
  }
  const idV = validateUuid(req.nextUrl.searchParams.get('id'), 'id');
  if (idV.error) return err(idV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });

  const deleted = await deleteEvent(ctx.pid, idV.value!);
  if (!deleted) return err('Not found', { requestId: ctx.requestId, status: 404, code: ApiErrorCode.NotFound, headers: ctx.headers });
  return ok({ id: idV.value }, { requestId: ctx.requestId, headers: ctx.headers });
}
