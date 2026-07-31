// ═══════════════════════════════════════════════════════════════════════════
// POST /api/worklist/complete
//
// Complete an open worklist item from the unified To-do view, routing the write
// back to the item's real module. A dispatcher: switch on sourceType, re-read
// the target row scoped by BOTH id AND property_id (a foreign-hotel id 404s,
// never acts), then write — all through supabaseAdmin.
//
//   task        comms_tasks      → status='done'        (setTaskStatus)
//                                → status='blocked' + the reason, on "Can't do this"
//   complaint   complaints       → status='resolved', resolved_at=now
//   workorder   work_orders      → status='resolved', resolved_at=now, completed_by_name
//   pm          preventive_tasks → last_completed_at=now (recurs — non-terminal)
//   reminder    agent_reminders  → canceled_at=now (it is handled; do not also DM me)
//   inspection  → 400: must be passed/failed in the inspect flow (deep-link)
//   approval    → 400: a decision is made on its own screen, with its own facts
//
// ─── "Can't do this" ───────────────────────────────────────────────────────
// `outcome: 'cant'` needs a one-line reason and REFUSES without one. The whole
// value of the state is the sentence that comes with it: an assigner who learns
// only that the work did not happen has to go and ask, which is the round trip
// the receipt exists to replace. The database says the same thing
// (comms_tasks_blocked_needs_reason, 0410) so a second caller cannot skip it.
//
// NOT gated on the Communications section. See ONE_LIST_CTX.
// ═══════════════════════════════════════════════════════════════════════════

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { errToString } from '@/lib/utils';
import { log } from '@/lib/log';
import { validateUuid, validateEnum, validateString } from '@/lib/api-validate';
import { commsContext, ONE_LIST_CTX } from '@/lib/comms/route-helpers';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { setTaskStatus } from '@/lib/comms/core';
import { worklistSeesAllSources, mayActOnItem } from '@/lib/worklist/core';
import { WORKLIST_SOURCE_TYPES } from '@/lib/worklist/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

interface Body { pid?: string; sourceType?: string; sourceId?: string; outcome?: string; reason?: string }

/** The most a refusal reason can be. Long enough for the real sentence, short
 *  enough that nobody pastes an essay into a list row. */
export const MAX_BLOCKED_REASON = 400;

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

  const outcomeV = validateEnum(body.outcome ?? 'done', ['done', 'cant'] as const, 'outcome');
  if (outcomeV.error) return err(outcomeV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers });
  const outcome = outcomeV.value!;

  let reason: string | null = null;
  if (outcome === 'cant') {
    if (sourceType !== 'task') {
      return err('only a to-do can be marked as one you could not do', {
        requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers,
      });
    }
    const reasonV = validateString(body.reason, { max: MAX_BLOCKED_REASON, label: 'reason' });
    if (reasonV.error || !reasonV.value!.trim()) {
      return err('say in one line why you could not do it', {
        requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers,
      });
    }
    reason = reasonV.value!.trim();
  }

  // Floor staff may only complete manual to-dos (same property-wide scope as the
  // existing /api/comms/tasks PATCH). The cross-department sources
  // (complaint/workorder/pm/inspection) are management + front-desk only.
  // Checked before any row read, so it never leaks whether an id exists.
  // A reminder joins 'task' on the floor-staff side: it is a note somebody left
  // for themselves or for one person, and dismissing your own reminder is not a
  // cross-department action.
  if (sourceType !== 'task' && sourceType !== 'reminder' && !worklistSeesAllSources(ctx.role)) {
    return err('forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden, headers });
  }

  const rl = await checkAndIncrementRateLimit('worklist-complete', pid);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  // ── whose item is this? ──────────────────────────────────────────────────
  // The list narrowed to "what is on my screen" but this handler still took any
  // id in the property, so the two drifted: a to-do handed to one person could
  // be closed by anybody who had its id, and a reminder aimed at one person
  // could be cancelled by somebody it was never for. The read rule and the
  // write rule are now the same rule. Management and the author keep their
  // override — see mayActOnItem.
  const viewer = { staffId: ctx.staffId, accountId: ctx.accountId, role: ctx.role, dept: ctx.dept };
  if (sourceType === 'task' || sourceType === 'reminder') {
    const owner = await itemOwnership(sourceType, sourceId, pid);
    if (!owner) return notFound(requestId, headers);
    if (!mayActOnItem(owner, viewer)) {
      return err('this one is not yours to close', {
        requestId, status: 403, code: ApiErrorCode.Forbidden, headers,
      });
    }
  }

  try {
    switch (sourceType) {
      case 'task': {
        if (outcome === 'cant') {
          // Scoped by id AND property_id, and only from 'open' — so a second tap
          // on a stale screen cannot overwrite a completion with a refusal.
          const { data, error } = await supabaseAdmin
            .from('comms_tasks')
            .update({
              status: 'blocked',
              blocked_at: new Date().toISOString(),
              blocked_by_staff_id: ctx.staffId,
              blocked_reason: reason,
              updated_at: new Date().toISOString(),
            })
            .eq('id', sourceId).eq('property_id', pid).eq('status', 'open')
            .select('id').maybeSingle();
          if (error) return fail(requestId, headers, error.message);
          if (!data) return notFound(requestId, headers);
          break;
        }
        // setTaskStatus is itself scoped by id + property_id; false = not found.
        const done = await setTaskStatus(pid, sourceId, 'done', ctx.staffId);
        if (!done) return notFound(requestId, headers);
        break;
      }
      case 'complaint': {
        if (!(await existsScoped('complaints', sourceId, pid))) return notFound(requestId, headers);
        const { error } = await supabaseAdmin
          .from('complaints')
          .update({ status: 'resolved', resolved_at: new Date().toISOString() })
          .eq('id', sourceId).eq('property_id', pid);
        if (error) return fail(requestId, headers, error.message);
        break;
      }
      case 'workorder': {
        if (!(await existsScoped('work_orders', sourceId, pid))) return notFound(requestId, headers);
        const { error } = await supabaseAdmin
          .from('work_orders')
          .update({ status: 'resolved', resolved_at: new Date().toISOString(), completed_by_name: ctx.displayName })
          .eq('id', sourceId).eq('property_id', pid);
        if (error) return fail(requestId, headers, error.message);
        break;
      }
      case 'pm': {
        if (!(await existsScoped('preventive_tasks', sourceId, pid))) return notFound(requestId, headers);
        // Recurring: stamping last_completed_at resets the cycle (not terminal).
        const { error } = await supabaseAdmin
          .from('preventive_tasks')
          .update({ last_completed_at: new Date().toISOString(), last_completed_by: ctx.displayName })
          .eq('id', sourceId).eq('property_id', pid);
        if (error) return fail(requestId, headers, error.message);
        break;
      }
      case 'reminder': {
        // Handled means stop reminding me. Cancel rather than delete so the row
        // stays auditable, and only from still-pending so a reminder that fired
        // a second ago is not retroactively rewritten as cancelled.
        const { data, error } = await supabaseAdmin
          .from('agent_reminders')
          .update({ canceled_at: new Date().toISOString() })
          .eq('id', sourceId).eq('property_id', pid)
          .is('fired_at', null).is('canceled_at', null)
          .select('id').maybeSingle();
        if (error) return fail(requestId, headers, error.message);
        if (!data) return notFound(requestId, headers);
        break;
      }
      case 'inspection':
        return err('inspections are passed or failed in the inspect flow', {
          requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers,
        });
      case 'approval':
        // Deliberate: a one-tap yes on a list row is a decision made with less
        // than the facts. Letting somebody onto the payroll or granting a day
        // off happens on the screen that shows the rest of the picture.
        return err('open this one to decide it', {
          requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers,
        });
    }
    return ok({ completed: true, sourceType, outcome }, { requestId, headers });
  } catch (e) {
    log.error('[worklist] complete failed', { requestId, pid, sourceType, err: errToString(e) });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError, headers });
  }
}

/**
 * Who a to-do or reminder belongs to, scoped by id AND property_id.
 *
 * Returns null when the row is not this hotel's — a foreign id is
 * indistinguishable from a missing one, so it 404s rather than 403s and never
 * reveals that the id exists somewhere.
 */
async function itemOwnership(
  sourceType: 'task' | 'reminder',
  id: string,
  pid: string,
): Promise<{ assignedStaffId: string | null; assignedDepartment: string | null; createdByStaffId: string | null } | null> {
  const [table, assignee, dept] = sourceType === 'task'
    ? ['comms_tasks', 'assigned_staff_id', 'assigned_department'] as const
    : ['agent_reminders', 'target_staff_id', 'target_department'] as const;
  const { data } = await supabaseAdmin
    .from(table)
    .select(`${assignee}, ${dept}, created_by_staff_id`)
    .eq('id', id).eq('property_id', pid)
    .maybeSingle();
  if (!data) return null;
  const row = data as Record<string, unknown>;
  return {
    assignedStaffId: (row[assignee] as string | null) ?? null,
    assignedDepartment: (row[dept] as string | null) ?? null,
    createdByStaffId: (row.created_by_staff_id as string | null) ?? null,
  };
}

/** Re-read a row scoped by BOTH id AND property_id — a foreign id is indistinguishable from a missing one. */
async function existsScoped(table: 'complaints' | 'work_orders' | 'preventive_tasks', id: string, pid: string): Promise<boolean> {
  const { data } = await supabaseAdmin.from(table).select('id').eq('id', id).eq('property_id', pid).maybeSingle();
  return !!data;
}

function notFound(requestId: string, headers: Record<string, string>) {
  return err('item not found', { requestId, status: 404, code: ApiErrorCode.NotFound, headers });
}
function fail(requestId: string, headers: Record<string, string>, msg: string) {
  log.error('[worklist] complete write failed', { requestId, err: msg });
  return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError, headers });
}
