/**
 * /api/comms/tasks — the Communications to-do list.
 *   GET   ?pid=...                              → list tasks
 *   POST  { pid, title, notes?, assignedStaffId?, assignedDepartment?, dueAt?, sourceMessageId? }
 *   PATCH { pid, taskId, status }               → check off / reopen
 * Authenticated. NO SMS.
 */
import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { validateUuid, validateString, validateEnum } from '@/lib/api-validate';
import { checkAndIncrementRateLimit, rateLimitedResponse, hashToRateLimitKey } from '@/lib/api-ratelimit';
import { commsContext } from '@/lib/comms/route-helpers';
import { listTasks, createTask, setTaskStatus, getStaffRow } from '@/lib/comms/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEPARTMENTS = ['housekeeping', 'front_desk', 'maintenance', 'all_staff'] as const;

export async function GET(req: NextRequest): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const ctx = await commsContext(req, searchParams.get('pid'));
  if (!ctx.ok) return ctx.response;
  const rl = await checkAndIncrementRateLimit('comms-read', hashToRateLimitKey(`${ctx.pid}:${ctx.userId}`));
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
  const tasks = await listTasks(ctx.pid);
  return ok({ tasks }, { requestId: ctx.requestId, headers: ctx.headers });
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: {
    pid?: string; title?: string; notes?: string;
    assignedStaffId?: string; assignedDepartment?: string; dueAt?: string; sourceMessageId?: string;
  };
  try { body = await req.json(); } catch { body = {}; }

  const ctx = await commsContext(req, body.pid ?? null);
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
    assignedStaffId = sv.value!;
  }
  let assignedDepartment: string | null = null;
  if (body.assignedDepartment) {
    const dv = validateEnum(body.assignedDepartment, DEPARTMENTS, 'assignedDepartment');
    if (dv.error) return err(dv.error, { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
    assignedDepartment = dv.value!;
  }
  let dueAt: string | null = null;
  if (body.dueAt) {
    const ms = Date.parse(body.dueAt);
    if (!Number.isFinite(ms)) return err('invalid dueAt', { requestId: ctx.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: ctx.headers });
    dueAt = new Date(ms).toISOString();
  }
  let sourceMessageId: string | null = null;
  if (body.sourceMessageId) {
    const mv = validateUuid(body.sourceMessageId, 'sourceMessageId');
    if (!mv.error) sourceMessageId = mv.value!;
  }

  const res = await createTask(ctx.pid, {
    title: titleV.value!,
    notes: body.notes ? String(body.notes).slice(0, 2000) : null,
    assignedStaffId,
    assignedDepartment,
    dueAt,
    createdByStaffId: ctx.staffId,
    sourceMessageId,
  });
  return ok({ id: res.id }, { requestId: ctx.requestId, status: 201, headers: ctx.headers });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  let body: { pid?: string; taskId?: string; status?: string };
  try { body = await req.json(); } catch { body = {}; }

  const ctx = await commsContext(req, body.pid ?? null);
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
