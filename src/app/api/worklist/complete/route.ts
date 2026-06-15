// ═══════════════════════════════════════════════════════════════════════════
// POST /api/worklist/complete
//
// Complete an open worklist item from the unified To-do view, routing the write
// back to the item's real module. A dispatcher: switch on sourceType, re-read
// the target row scoped by BOTH id AND property_id (a foreign-hotel id 404s,
// never acts), then write — all through supabaseAdmin.
//
//   task        comms_tasks      → status='done'        (setTaskStatus)
//   complaint   complaints       → status='resolved', resolved_at=now
//   workorder   work_orders      → status='resolved', resolved_at=now, completed_by_name
//   pm          preventive_tasks → last_completed_at=now (recurs — non-terminal)
//   inspection  → 400: must be passed/failed in the inspect flow (deep-link)
// ═══════════════════════════════════════════════════════════════════════════

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { errToString } from '@/lib/utils';
import { log } from '@/lib/log';
import { validateUuid, validateEnum } from '@/lib/api-validate';
import { commsContext } from '@/lib/comms/route-helpers';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { setTaskStatus } from '@/lib/comms/core';
import { worklistSeesAllSources } from '@/lib/worklist/core';
import { WORKLIST_SOURCE_TYPES } from '@/lib/worklist/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

interface Body { pid?: string; sourceType?: string; sourceId?: string }

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

  // Floor staff may only complete their own manual to-dos. The cross-department
  // sources (complaint/workorder/pm/inspection) are management + front-desk only.
  // Checked before any row read, so it never leaks whether an id exists.
  if (sourceType !== 'task' && !worklistSeesAllSources(ctx.role)) {
    return err('forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden, headers });
  }

  const rl = await checkAndIncrementRateLimit('worklist-complete', pid);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  try {
    switch (sourceType) {
      case 'task': {
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
      case 'inspection':
        return err('inspections are passed or failed in the inspect flow', {
          requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers,
        });
    }
    return ok({ completed: true, sourceType }, { requestId, headers });
  } catch (e) {
    log.error('[worklist] complete failed', { requestId, pid, sourceType, err: errToString(e) });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError, headers });
  }
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
