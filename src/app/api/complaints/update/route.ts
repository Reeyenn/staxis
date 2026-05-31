/**
 * POST /api/complaints/update
 *
 * One endpoint, four actions on an existing complaint:
 *   - assign            → set assignee/department; SMS the assignee; open→in_progress
 *   - status            → change status; resolved/closed stamps resolved_at + notes
 *   - schedule_callback → set a satisfaction-callback time
 *   - callback_done     → mark a callback completed (+ notes)
 *
 * Session-gated + per-property capability check + an explicit cross-tenant
 * guard: the complaint row's property_id MUST equal the caller's pid, so a
 * forged complaintId from another hotel is rejected (403).
 */

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log, getOrMintRequestId } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { validateUuid, validateString, validateEnum } from '@/lib/api-validate';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { checkAndIncrementRateLimit, rateLimitedResponse, hashToRateLimitKey } from '@/lib/api-ratelimit';
import { sendSms } from '@/lib/sms';
import { COMPLAINT_STATUSES, COMPLAINT_DEPTS } from '@/lib/complaints-shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

const ACTIONS = ['assign', 'status', 'schedule_callback', 'callback_done'] as const;

interface Body {
  pid?: string;
  complaintId?: string;
  action?: string;
  // assign
  assignedTo?: string | null;
  assignedName?: string | null;
  assignedDept?: string | null;
  // status
  status?: string;
  resolutionNotes?: string;
  // callback
  callbackAt?: string;
  callbackNotes?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const headers = { 'x-request-id': requestId };

  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return err('invalid json', { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });
  }

  const pidV = validateUuid(body.pid, 'pid');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });
  const pid = pidV.value!;

  const cidV = validateUuid(body.complaintId, 'complaintId');
  if (cidV.error) return err(cidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });
  const complaintId = cidV.value!;

  const actV = validateEnum(body.action, ACTIONS, 'action');
  if (actV.error) return err(actV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });
  const action = actV.value!;

  const hasAccess = await userHasPropertyAccess(session.userId, pid);
  if (!hasAccess) return err('property access denied', { requestId, status: 403, code: ApiErrorCode.Forbidden, headers });

  const rl = await checkAndIncrementRateLimit('complaints-update', hashToRateLimitKey(`${pid}:${session.userId}`));
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  try {
    // Cross-tenant guard — fetch the row and confirm it belongs to pid.
    // Scope the read by BOTH id AND property_id so a complaint from another
    // hotel is indistinguishable from a nonexistent one — no 403-vs-404
    // existence oracle (Codex review #12).
    const { data: existing, error: readErr } = await supabaseAdmin
      .from('complaints')
      .select('id, property_id, status, room_number, description')
      .eq('id', complaintId)
      .eq('property_id', pid)
      .maybeSingle();
    if (readErr) {
      log.error('complaints/update: read failed', { requestId, err: errToString(readErr) });
      return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError, headers });
    }
    if (!existing) return err('complaint not found', { requestId, status: 404, code: ApiErrorCode.NotFound, headers });

    const patch: Record<string, unknown> = {};
    let smsTarget: { assignedTo: string } | null = null;

    if (action === 'assign') {
      if (body.assignedTo != null) {
        const aV = validateUuid(body.assignedTo, 'assignedTo');
        if (aV.error) return err(aV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });
        // The assignee MUST belong to this property, and name/dept are derived
        // server-side from the staff row — never trusted from the caller — so a
        // manager can't assign to a foreign-property staff id or spoof the
        // displayed name (Codex review #4).
        const { data: staff, error: staffErr } = await supabaseAdmin
          .from('staff')
          .select('id, name, department')
          .eq('id', aV.value!)
          .eq('property_id', pid)
          .maybeSingle();
        if (staffErr) {
          log.error('complaints/update: staff lookup failed', { requestId, err: errToString(staffErr) });
          return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError, headers });
        }
        if (!staff) return err('assignee not found on this property', { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });
        patch.assigned_to = staff.id;
        patch.assigned_name = (staff.name as string | null) ?? null;
        // Map the staff department onto a complaint dept when it's one we track.
        const dept = staff.department as string | null;
        if (dept && (COMPLAINT_DEPTS as readonly string[]).includes(dept)) patch.assigned_dept = dept;
        smsTarget = { assignedTo: staff.id };
      } else {
        // Explicit unassign — clear the snapshot fields too.
        patch.assigned_to = null;
        patch.assigned_name = null;
      }
      // Picking up an open complaint moves it into progress.
      if (existing.status === 'open') patch.status = 'in_progress';
    } else if (action === 'status') {
      const stV = validateEnum(body.status, COMPLAINT_STATUSES, 'status');
      if (stV.error) return err(stV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });
      patch.status = stV.value;
      if (body.resolutionNotes != null) {
        const rV = validateString(body.resolutionNotes, { max: 2000, label: 'resolutionNotes', allowEmpty: true });
        if (rV.error) return err(rV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });
        patch.resolution_notes = body.resolutionNotes.trim() || null;
      }
      // Stamp resolved_at when moving into a terminal state; clear it if reopened.
      patch.resolved_at = (stV.value === 'resolved' || stV.value === 'closed')
        ? new Date().toISOString()
        : null;
    } else if (action === 'schedule_callback') {
      // Require an explicit timezone (Z or ±HH:MM). A timezone-less string
      // would be parsed in the server's local zone and silently schedule the
      // callback at the wrong wall-clock time (Codex review #7). The UI sends
      // new Date(...).toISOString() (always Z), so this only rejects raw API
      // callers that omit the zone.
      const cbStr = typeof body.callbackAt === 'string' ? body.callbackAt.trim() : '';
      if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(cbStr)) {
        return err('callbackAt must include a timezone (e.g. ...Z or +00:00)', {
          requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers,
        });
      }
      const ts = Date.parse(cbStr);
      if (isNaN(ts)) return err('invalid callbackAt', { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });
      patch.callback_at = new Date(ts).toISOString();
      patch.callback_done = false;
      patch.callback_nudged_at = null; // re-arm the nudge for the new time
    } else if (action === 'callback_done') {
      patch.callback_done = true;
      if (body.callbackNotes != null) {
        const cnV = validateString(body.callbackNotes, { max: 2000, label: 'callbackNotes', allowEmpty: true });
        if (cnV.error) return err(cnV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });
        patch.callback_notes = body.callbackNotes.trim() || null;
      }
    }

    const { error: updErr } = await supabaseAdmin.from('complaints').update(patch).eq('id', complaintId);
    if (updErr) {
      log.error('complaints/update: update failed', { requestId, err: errToString(updErr) });
      return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError, headers });
    }

    // Best-effort SMS to a newly assigned staff member (billing-gated).
    if (smsTarget) {
      try {
        const { data: staff } = await supabaseAdmin
          .from('staff')
          .select('phone, name')
          .eq('id', smsTarget.assignedTo)
          .eq('property_id', pid)
          .maybeSingle();
        const phone = (staff?.phone as string | null) ?? null;
        if (phone) {
          const smsRl = await checkAndIncrementRateLimit('complaints-sms', pid);
          if (smsRl.allowed) {
            const room = existing.room_number ? `Room ${existing.room_number} — ` : '';
            const desc = String(existing.description ?? '').slice(0, 120);
            await sendSms(phone, `New complaint assigned to you: ${room}${desc}`);
          }
        }
      } catch (smsErr) {
        log.warn('complaints/update: assignee SMS failed (non-fatal)', { requestId, err: errToString(smsErr) });
      }
    }

    return ok({ updated: true, action }, { requestId, headers });
  } catch (caughtErr) {
    log.error('complaints/update: unexpected error', { requestId, err: errToString(caughtErr) });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError, headers });
  }
}
