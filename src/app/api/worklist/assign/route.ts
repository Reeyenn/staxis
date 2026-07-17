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
//   workorder   work_orders  → severity (priority lane: urgent|normal|low) — the
//                              legacy table has no per-staff assignee column
//   pm / inspection → 400 (no assign control: preventive has no department col;
//                          inspections are auto-derived)
// ═══════════════════════════════════════════════════════════════════════════

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { errToString } from '@/lib/utils';
import { log } from '@/lib/log';
import { validateUuid, validateEnum } from '@/lib/api-validate';
import { commsContext } from '@/lib/comms/route-helpers';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { COMPLAINT_DEPTS } from '@/lib/complaints-shared';
import { worklistSeesAllSources } from '@/lib/worklist/core';
import { WORKLIST_SOURCE_TYPES } from '@/lib/worklist/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

const WORKORDER_PRIORITIES = ['urgent', 'normal', 'low'] as const;
const PRIORITY_TO_SEVERITY: Record<(typeof WORKORDER_PRIORITIES)[number], string> = {
  urgent: 'urgent', normal: 'medium', low: 'low',
};

interface Body { pid?: string; sourceType?: string; sourceId?: string; assigneeStaffId?: string | null; priority?: string }

export async function POST(req: NextRequest): Promise<Response> {
  let body: Body;
  try { body = (await req.json()) as Body; } catch { body = {}; }

  const ctx = await commsContext(req, body.pid ?? null);
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
  const wantsAssignee = sourceType === 'task' || sourceType === 'complaint';
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
      case 'pm':
      case 'inspection':
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
async function staffOnProperty(staffId: string, pid: string): Promise<{ id: string; name: string | null; department: string | null } | null> {
  const { data } = await supabaseAdmin
    .from('staff').select('id, name, department').eq('id', staffId).eq('property_id', pid).maybeSingle();
  return data ? { id: data.id as string, name: (data.name as string | null) ?? null, department: (data.department as string | null) ?? null } : null;
}

async function existsScoped(table: 'comms_tasks' | 'work_orders', id: string, pid: string): Promise<boolean> {
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
