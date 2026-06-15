// ═══════════════════════════════════════════════════════════════════════════
// GET /api/worklist?pid=...
//
// The unified worklist: every open actionable item across the property
// (manual to-dos, complaints, work orders, inspection-due rooms, preventive
// tasks), normalized + sorted. Authenticated via commsContext (session + 2FA +
// property access). All reads go through supabaseAdmin in gatherWorklist — the
// browser never queries these tables directly.
// ═══════════════════════════════════════════════════════════════════════════

import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { errToString } from '@/lib/utils';
import { log } from '@/lib/log';
import { commsContext } from '@/lib/comms/route-helpers';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { gatherWorklist, worklistSeesAllSources } from '@/lib/worklist/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

export async function GET(req: NextRequest): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const ctx = await commsContext(req, searchParams.get('pid'));
  if (!ctx.ok) return ctx.response;

  // Per-property bucket — raw pid (api_limits FK). Read path → fails open.
  const rl = await checkAndIncrementRateLimit('worklist-read', ctx.pid);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  try {
    // Floor staff (housekeeping/maintenance/staff) see only their manual to-dos;
    // complaints/work-orders/inspections/pm stay management + front-desk only.
    const items = await gatherWorklist(ctx.pid, { tasksOnly: !worklistSeesAllSources(ctx.role) });
    return ok({ items }, { requestId: ctx.requestId, headers: ctx.headers });
  } catch (e) {
    log.error('[worklist] GET failed', { requestId: ctx.requestId, pid: ctx.pid, err: errToString(e) });
    return err('Internal server error', {
      requestId: ctx.requestId, status: 500, code: ApiErrorCode.InternalError, headers: ctx.headers,
    });
  }
}
