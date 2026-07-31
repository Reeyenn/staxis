/**
 * /api/comms/tasks — to-dos. Lives on the Staxis list now, not Communications.
 *   GET   ?pid=...                              → list tasks
 *   POST  { pid, title, notes?, assignedStaffId?, assignedDepartment?,
 *           dueDate? | dueAt?, sourceMessageId?, repeat?, weekday?, dayOfMonth? }
 *   PATCH { pid, taskId, status }               → check off / reopen
 * Authenticated. NO SMS.
 *
 * ─── one engine for both doors ─────────────────────────────────────────────
 * `repeat` is anything other than 'once' ⇒ this creates a recurring TEMPLATE
 * (recurring_task_templates) instead of a single row, through the exact same
 * createTemplate() the chat door's create_recurring_todo tool calls. There is
 * one scheduler in the product and this route does not become a second one:
 * process-agent-schedules spawns the instances either way.
 *
 * NOT gated on the Communications section. See ONE_LIST_CTX.
 */
import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { validateUuid, validateString, validateEnum } from '@/lib/api-validate';
import { checkAndIncrementRateLimit, rateLimitedResponse, hashToRateLimitKey } from '@/lib/api-ratelimit';
import { commsContext, ONE_LIST_CTX } from '@/lib/comms/route-helpers';
import { listTasks, createTask, setTaskStatus, deleteTask, getStaffRow } from '@/lib/comms/core';
import { createTemplate, RECURRING_CADENCES, type RecurringCadence } from '@/lib/recurring-tasks/store';
import { assigneeBlockedReason } from '@/lib/worklist/assignable';
import { propertyTimezoneOf } from '@/lib/worklist/core';
import { endOfLocalDay, propertyLocalToday } from '@/lib/schedule/local-date';
import { isBusinessDate } from '@/lib/business-date';
import { errToString } from '@/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEPARTMENTS = ['housekeeping', 'front_desk', 'maintenance', 'all_staff'] as const;
/** What the composer's Repeat chip can say. 'once' is the default and creates
 *  a plain task; everything else creates a template. */
const REPEATS = ['once', ...RECURRING_CADENCES] as const;

export async function GET(req: NextRequest): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const ctx = await commsContext(req, searchParams.get('pid'), ONE_LIST_CTX);
  if (!ctx.ok) return ctx.response;
  const rl = await checkAndIncrementRateLimit('comms-read', hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`));
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
  const tasks = await listTasks(ctx.pid);
  return ok({ tasks }, { requestId: ctx.requestId, headers: ctx.headers });
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: {
    pid?: string; title?: string; notes?: string; priority?: string;
    assignedStaffId?: string; assignedDepartment?: string; dueAt?: string; dueDate?: string; sourceMessageId?: string;
    repeat?: string; weekday?: number; dayOfMonth?: number;
  };
  try { body = await req.json(); } catch { body = {}; }

  const ctx = await commsContext(req, body.pid ?? null, ONE_LIST_CTX);
  if (!ctx.ok) return ctx.response;

  const titleV = validateString(body.title, { max: 300, label: 'title' });
  if (titleV.error) {
    return err(titleV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
  }

  const rl = await checkAndIncrementRateLimit('comms-task', hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`));
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  // Validate assignee — staff must belong to this property.
  let assignedStaffId: string | null = null;
  if (body.assignedStaffId) {
    const sv = validateUuid(body.assignedStaffId, 'assignedStaffId');
    if (sv.error) return err(sv.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
    const row = await getStaffRow(ctx.pid, sv.value!);
    if (!row) return err('assignee not found', { requestId: ctx.requestId, status: 404, code: ApiErrorCode.NotFound, headers: ctx.headers });
    // The row was already being read and then thrown away. Housekeepers never
    // open the to-do list, so handing one a to-do loses it silently; an
    // inactive staff member loses it just as thoroughly.
    const blocked = assigneeBlockedReason(row);
    if (blocked) return err(blocked, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
    assignedStaffId = sv.value!;
  }
  let assignedDepartment: string | null = null;
  if (body.assignedDepartment) {
    const dv = validateEnum(body.assignedDepartment, DEPARTMENTS, 'assignedDepartment');
    if (dv.error) return err(dv.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
    assignedDepartment = dv.value!;
  }
  // ── when the work is due ─────────────────────────────────────────────────
  // Two doors. `dueDate` (YYYY-MM-DD) is a calendar DAY and is resolved to the
  // end of that day IN THE HOTEL'S OWN TIMEZONE — the composer sends this,
  // because a client that stamps its own instant produces "due today" items
  // that go red at 7pm. `dueAt` stays for callers that genuinely mean a precise
  // moment. dueDate wins when both are present.
  let dueAt: string | null = null;
  if (body.dueDate) {
    if (!isBusinessDate(body.dueDate)) {
      return err('invalid dueDate', { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
    }
    dueAt = endOfLocalDay(body.dueDate, await propertyTimezoneOf(ctx.pid)).toISOString();
  } else if (body.dueAt) {
    const ms = Date.parse(body.dueAt);
    if (!Number.isFinite(ms)) return err('invalid dueAt', { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
    dueAt = new Date(ms).toISOString();
  }
  let priority: 'normal' | 'high' | 'urgent' = 'normal';
  if (body.priority) {
    const pv = validateEnum(body.priority, ['normal', 'high', 'urgent'] as const, 'priority');
    if (pv.error) return err(pv.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
    priority = pv.value!;
  }
  let sourceMessageId: string | null = null;
  if (body.sourceMessageId) {
    const mv = validateUuid(body.sourceMessageId, 'sourceMessageId');
    if (!mv.error) sourceMessageId = mv.value!;
  }

  let repeat: (typeof REPEATS)[number] = 'once';
  if (body.repeat) {
    const rv = validateEnum(body.repeat, REPEATS, 'repeat');
    if (rv.error) return err(rv.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
    repeat = rv.value!;
  }

  // ── A repeating to-do is a TEMPLATE, not a task ──────────────────────────
  // The same createTemplate the chat door calls, so there is exactly one
  // recurrence engine and one spawner. A template does not produce today's row
  // itself: process-agent-schedules does that on the first tick of each due
  // local day, which is what keeps a per-day done/undone history.
  if (repeat !== 'once') {
    try {
      const tpl = await createTemplate({
        propertyId: ctx.pid,
        createdByStaffId: ctx.staffId,
        title: titleV.value!,
        assignedStaffId,
        assignedDepartment,
        priority,
        cadence: repeat as RecurringCadence,
        weekday: typeof body.weekday === 'number' ? body.weekday : null,
        dayOfMonth: typeof body.dayOfMonth === 'number' ? body.dayOfMonth : null,
        // "Every other Tuesday starting this week" is anchored on the day the
        // person said it, in the hotel's own calendar. Left to default, the
        // anchor was the UTC day, which after ~7pm Central is TOMORROW — and an
        // anchor one day late flips the fortnight, so the to-do quietly came
        // back on the wrong alternating week for as long as it existed.
        anchorDate: propertyLocalToday(new Date(), await propertyTimezoneOf(ctx.pid)),
      });
      return ok({ templateId: tpl.id, repeat }, { requestId: ctx.requestId, status: 201, headers: ctx.headers });
    } catch (e) {
      // normalizeCadence throws a sentence a person can act on ("a monthly
      // recurring to-do needs a day of the month between 1 and 28"). Pass it
      // through rather than flattening it to "invalid request".
      return err(errToString(e), {
        requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers,
      });
    }
  }

  const res = await createTask(ctx.pid, {
    title: titleV.value!,
    notes: body.notes ? String(body.notes).slice(0, 2000) : null,
    assignedStaffId,
    assignedDepartment,
    dueAt,
    priority,
    createdByStaffId: ctx.staffId,
    sourceMessageId,
  });
  return ok({ id: res.id }, { requestId: ctx.requestId, status: 201, headers: ctx.headers });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  let body: { pid?: string; taskId?: string; status?: string };
  try { body = await req.json(); } catch { body = {}; }

  const ctx = await commsContext(req, body.pid ?? null, ONE_LIST_CTX);
  if (!ctx.ok) return ctx.response;

  const idV = validateUuid(body.taskId, 'taskId');
  if (idV.error) return err(idV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
  const stV = validateEnum(body.status, ['open', 'done'] as const, 'status');
  if (stV.error) return err(stV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });

  const rl = await checkAndIncrementRateLimit('comms-task', hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`));
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const okUpdate = await setTaskStatus(ctx.pid, idV.value!, stV.value!, ctx.staffId);
  if (!okUpdate) return err('Not found', { requestId: ctx.requestId, status: 404, code: ApiErrorCode.NotFound, headers: ctx.headers });
  return ok({ updated: true }, { requestId: ctx.requestId, headers: ctx.headers });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const ctx = await commsContext(req, searchParams.get('pid'), ONE_LIST_CTX);
  if (!ctx.ok) return ctx.response;

  const idV = validateUuid(searchParams.get('taskId'), 'taskId');
  if (idV.error) return err(idV.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });

  const rl = await checkAndIncrementRateLimit('comms-task', hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`));
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const okDel = await deleteTask(ctx.pid, idV.value!, ctx.staffId, ctx.isManager);
  if (!okDel) return err('Not found', { requestId: ctx.requestId, status: 404, code: ApiErrorCode.NotFound, headers: ctx.headers });
  return ok({ deleted: true }, { requestId: ctx.requestId, headers: ctx.headers });
}
