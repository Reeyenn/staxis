// ═══════════════════════════════════════════════════════════════════════════
// POST /api/worklist/assign
//
// Reassign an open worklist item from the unified To-do view, routing the write
// back to the item's real module. A dispatcher: switch on sourceType, re-read
// the target row scoped by BOTH id AND property_id (a foreign-hotel id 404s,
// never acts), then write — all through supabaseAdmin.
//
//   task        comms_tasks  → assigned_staff_id (+ derived assigned_department)
//   complaint   complaints   → assigned_to/name/dept (server-derived from staff),
//                              open→in_progress
//   workorder   work_orders  → assigned_to/assigned_name when the body names a
//                              person ("Give it to someone else"), otherwise the
//                              severity priority lane (urgent|normal|low)
//   pm          preventive_tasks → frequency_days ("Change the schedule")
//   inspection / reminder / approval → 400 (no control: inspections are derived,
//                          a reminder belongs to whoever set it, and a decision
//                          cannot be handed to somebody else)
//
// ─── why the cadence lives on THIS route ───────────────────────────────────
// This route is named for assignment and has never been only about assignment:
// its work-order branch changes a priority lane, which nobody is handed. What it
// actually is, and has been since it was written, is the ONE dispatcher for
// "change something about a worklist row without settling it" — /complete being
// the dispatcher for settling one. A cadence is exactly that, and a third
// worklist route carrying one integer would need its own copy of every gate this
// one already has (session, property access, role, rate limit, envelope) for
// four lines of dispatch. CLAUDE.md: extend before you add.
//
// ─── the work order's assignee columns ─────────────────────────────────────
// `work_orders.assigned_to` (uuid, FK to staff) and `assigned_name` have existed
// since 0001 and nothing ever wrote them: the header of this file used to say
// the table had no per-staff assignee column, which was simply wrong, and the
// Maintenance board has no assignee control either. So "who is on this?" had no
// answer anywhere, and the honest one was sitting in two empty columns.
//
// The NAME is derived here from the staff row, never taken from the caller, for
// the same reason the complaint branch does it: a body that could name its own
// assignee display name is a body that can write anything onto a ticket. The
// housekeeper exclusion (assigneeBlockedReason) applies here too — a work order
// handed to somebody who works from the housekeeping board is one nobody sees.
//
// NOT gated on the Communications section. See ONE_LIST_CTX.
// ═══════════════════════════════════════════════════════════════════════════

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { errToString } from '@/lib/utils';
import { log } from '@/lib/log';
import { validateUuid, validateEnum } from '@/lib/api-validate';
import { commsContext, ONE_LIST_CTX } from '@/lib/comms/route-helpers';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { COMPLAINT_DEPTS } from '@/lib/complaints-shared';
import { worklistSeesAllSources } from '@/lib/worklist/core';
import { assigneeBlockedReason } from '@/lib/worklist/assignable';
import { WORKLIST_SOURCE_TYPES } from '@/lib/worklist/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

const WORKORDER_PRIORITIES = ['urgent', 'normal', 'low'] as const;
const PRIORITY_TO_SEVERITY: Record<(typeof WORKORDER_PRIORITIES)[number], string> = {
  urgent: 'urgent', normal: 'medium', low: 'low',
};

interface Body {
  pid?: string; sourceType?: string; sourceId?: string;
  assigneeStaffId?: string | null; priority?: string; frequencyDays?: number | string;
}

/**
 * The cadence bounds an upkeep schedule may be changed to.
 *
 * 1 is allowed, unlike the to-do composer's `MIN_INTERVAL_DAYS` of 2: a daily
 * boiler-room walk is a real preventive schedule, and the composer's floor
 * exists only because a repeating to-do already has a word for "every day".
 * The ceiling is ten years, because the Preventive tab's own editor offers a
 * cadence in YEARS and a five-yearly fire-system certification has to fit.
 */
export const MIN_CADENCE_DAYS = 1;
export const MAX_CADENCE_DAYS = 3650;

/** A body value as a whole-day cadence, or null when it is not one. */
export function readCadenceDays(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isInteger(n)) return null;
  if (n < MIN_CADENCE_DAYS || n > MAX_CADENCE_DAYS) return null;
  return n;
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: Body;
  try { body = (await req.json()) as Body; } catch { body = {}; }

  const ctx = await commsContext(req, body.pid ?? null, ONE_LIST_CTX);
  if (!ctx.ok) return ctx.response;
  const { pid, requestId, headers } = ctx;

  const typeV = validateEnum(body.sourceType, WORKLIST_SOURCE_TYPES, 'sourceType');
  if (typeV.error) return err(typeV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });
  const idV = validateUuid(body.sourceId, 'sourceId');
  if (idV.error) return err(idV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });
  const sourceType = typeV.value!;
  const sourceId = idV.value!;

  // Floor staff may only assign manual to-dos. Reassigning a complaint or
  // changing a work order's priority lane is management + front-desk only.
  // Checked before any row read, so it never leaks whether an id exists.
  if (sourceType !== 'task' && !worklistSeesAllSources(ctx.role)) {
    return err('forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden, headers });
  }

  const rl = await checkAndIncrementRateLimit('worklist-assign', pid);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  // assigneeStaffId may be null/'' (explicit unassign) or a UUID. Validate when present.
  const wantsAssignee = sourceType === 'task' || sourceType === 'complaint' || sourceType === 'workorder';
  let assigneeStaffId: string | null = null;
  if (wantsAssignee && body.assigneeStaffId) {
    const aV = validateUuid(body.assigneeStaffId, 'assigneeStaffId');
    if (aV.error) return err(aV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });
    assigneeStaffId = aV.value!;
  }

  try {
    switch (sourceType) {
      case 'task': {
        if (!(await existsScoped('comms_tasks', sourceId, pid))) return notFound(requestId, headers);
        let department: string | null = null;
        if (assigneeStaffId) {
          const staff = await staffOnProperty(assigneeStaffId, pid);
          if (!staff) return err('assignee not found on this property', { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });
          // The dropdown never offers a housekeeper, but a dropdown is not a
          // rule: this route accepts an id, and an id can arrive from a stale
          // page or a crafted call. A to-do that lands on a housekeeper is
          // seen by nobody, so it is refused here rather than lost silently.
          const blocked = assigneeBlockedReason(staff);
          if (blocked) return err(blocked, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });
          department = staff.department;
        }
        const { error } = await supabaseAdmin
          .from('comms_tasks')
          .update({ assigned_staff_id: assigneeStaffId, assigned_department: department, updated_at: new Date().toISOString() })
          .eq('id', sourceId).eq('property_id', pid);
        if (error) return fail(requestId, headers, error.message);
        break;
      }
      case 'complaint': {
        const { data: existing } = await supabaseAdmin
          .from('complaints')
          .select('id, status, room_number, description')
          .eq('id', sourceId).eq('property_id', pid).maybeSingle();
        if (!existing) return notFound(requestId, headers);

        const patch: Record<string, unknown> = {};
        if (assigneeStaffId) {
          const staff = await staffOnProperty(assigneeStaffId, pid);
          if (!staff) return err('assignee not found on this property', { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });
          patch.assigned_to = staff.id;
          patch.assigned_name = staff.name;
          if (staff.department && (COMPLAINT_DEPTS as readonly string[]).includes(staff.department)) patch.assigned_dept = staff.department;
          if (existing.status === 'open') patch.status = 'in_progress';   // picking it up

        } else {
          patch.assigned_to = null;
          patch.assigned_name = null;
        }
        const { error } = await supabaseAdmin.from('complaints').update(patch).eq('id', sourceId).eq('property_id', pid);
        if (error) return fail(requestId, headers, error.message);

        // (Assignee SMS removed 2026-07 — all Twilio texting retired.)
        break;
      }
      case 'workorder': {
        // Which of the two things is being changed is decided by what the body
        // carries, and NOT by an extra mode field: a mode that could disagree
        // with the payload is a way to send "set the priority lane" with an
        // assignee in it and have one of them silently win.
        const handingOver = 'assigneeStaffId' in body;
        if (!handingOver) {
          const prV = validateEnum(body.priority, WORKORDER_PRIORITIES, 'priority');
          if (prV.error) return err(prV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });
          if (!(await existsScoped('work_orders', sourceId, pid))) return notFound(requestId, headers);
          const { error } = await supabaseAdmin
            .from('work_orders')
            .update({ severity: PRIORITY_TO_SEVERITY[prV.value!] })
            .eq('id', sourceId).eq('property_id', pid);
          if (error) return fail(requestId, headers, error.message);
          break;
        }
        if (!(await existsScoped('work_orders', sourceId, pid))) return notFound(requestId, headers);
        const patch: Record<string, unknown> = { assigned_to: null, assigned_name: null };
        if (assigneeStaffId) {
          const staff = await staffOnProperty(assigneeStaffId, pid);
          if (!staff) return err('assignee not found on this property', { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });
          // Same wall as a to-do, and for the same reason: a ticket handed to
          // somebody who works from the housekeeping board is not late, it is
          // invisible. A dropdown that never offers them is not a guard.
          const blocked = assigneeBlockedReason(staff);
          if (blocked) return err(blocked, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });
          patch.assigned_to = staff.id;
          patch.assigned_name = staff.name;
        }
        const { error } = await supabaseAdmin
          .from('work_orders')
          .update(patch)
          .eq('id', sourceId).eq('property_id', pid);
        if (error) return fail(requestId, headers, error.message);
        break;
      }
      case 'pm': {
        const days = readCadenceDays(body.frequencyDays);
        if (days === null) {
          return err(`say how many days between each one, from ${MIN_CADENCE_DAYS} to ${MAX_CADENCE_DAYS}`, {
            requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers,
          });
        }
        if (!(await existsScoped('preventive_tasks', sourceId, pid))) return notFound(requestId, headers);
        // ONLY the cadence. Not the last-done date, which is the one field on
        // this row that is a claim about what happened in the building: a
        // "change the schedule" control that could also move it would be a way
        // to record a service from a list row, silently.
        const { error } = await supabaseAdmin
          .from('preventive_tasks')
          .update({ frequency_days: days })
          .eq('id', sourceId).eq('property_id', pid);
        if (error) return fail(requestId, headers, error.message);
        break;
      }
      case 'inspection':
      case 'reminder':
      case 'approval':
        return err('this item type cannot be reassigned from the worklist', {
          requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers,
        });
    }
    return ok({ assigned: true, sourceType }, { requestId, headers });
  } catch (e) {
    log.error('[worklist] assign failed', { requestId, pid, sourceType, err: errToString(e) });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError, headers });
  }
}

/** A staff member scoped to this property — name/dept derived server-side, never trusted from the caller. */
async function staffOnProperty(staffId: string, pid: string): Promise<{ id: string; name: string | null; department: string | null; is_active: boolean | null } | null> {
  const { data } = await supabaseAdmin
    .from('staff').select('id, name, department, is_active').eq('id', staffId).eq('property_id', pid).maybeSingle();
  return data
    ? {
      id: data.id as string,
      name: (data.name as string | null) ?? null,
      department: (data.department as string | null) ?? null,
      is_active: (data.is_active as boolean | null) ?? null,
    }
    : null;
}

async function existsScoped(table: 'comms_tasks' | 'work_orders' | 'preventive_tasks', id: string, pid: string): Promise<boolean> {
  const { data } = await supabaseAdmin.from(table).select('id').eq('id', id).eq('property_id', pid).maybeSingle();
  return !!data;
}

function notFound(requestId: string, headers: Record<string, string>) {
  return err('item not found', { requestId, status: 404, code: ApiErrorCode.NotFound, headers });
}
function fail(requestId: string, headers: Record<string, string>, msg: string) {
  log.error('[worklist] assign write failed', { requestId, err: msg });
  return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError, headers });
}
