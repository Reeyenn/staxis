/**
 * POST /api/housekeeping/auto-assign
 *
 * Manager-initiated "Auto-assign" button on the Schedule board. Runs the
 * SAME assignment engine + persistence path as the 15-min cron (shared
 * runner in src/lib/auto-assign-runner.ts), but scoped to one property +
 * the date the manager is looking at, and with two policy tweaks suited
 * to a manual click:
 *
 *   - respectScheduledToday = false — the manager is staring at the crew
 *     on the board and wants the unassigned rooms spread across all of
 *     them, not just whoever happens to be flagged scheduled_today.
 *   - respectPriority = true — honor the priority modal: never auto-place
 *     onto a housekeeper the manager marked "Excluded".
 *
 * Non-destructive + idempotent: only places cleaning_tasks that have no
 * active hk_assignments row. To rebalance from scratch the manager hits
 * "Reset" first (POST /api/housekeeping/reset-assignments), then this.
 *
 * Auth: requireSession (manager-facing) + property-access gate.
 *
 * Body: { propertyId: uuid, date: YYYY-MM-DD }
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { canForUserId } from '@/lib/capabilities/server';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { validateUuid, validateDateStr } from '@/lib/api-validate';
import { runAutoAssignForProperty } from '@/lib/auto-assign-runner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface Body {
  propertyId?: unknown;
  date?: unknown;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = getOrMintRequestId(req);
  const auth = await requireSession(req, { requestId });
  if (!auth.ok) return auth.response;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return err('invalid JSON body', { requestId, status: 400, code: 'validation_failed' });
  }

  const pidCheck = validateUuid(body.propertyId, 'propertyId');
  if (pidCheck.error) return err(pidCheck.error, { requestId, status: 400, code: 'validation_failed' });
  const dateCheck = validateDateStr(typeof body.date === 'string' ? body.date : '', { label: 'date' });
  if (dateCheck.error) return err(dateCheck.error, { requestId, status: 400, code: 'validation_failed' });

  const propertyId = pidCheck.value!;
  const businessDate = dateCheck.value!;

  // Tenant-scope gate: the caller must have access to this property
  // before we read its tasks/roster or write any assignments.
  if (!(await canForUserId(auth.userId, 'assign_work', propertyId))) {
    return err('forbidden — assigning work is restricted for your role at this property', { requestId, status: 403, code: 'forbidden' });
  }
  const hasAccess = await userHasPropertyAccess(auth.userId, propertyId);
  if (!hasAccess) {
    log.warn('auto-assign: forbidden — user lacks property access', {
      requestId, userId: auth.userId, propertyId,
    });
    return err('forbidden — no access to this property', {
      requestId, status: 403, code: 'forbidden',
    });
  }

  try {
    // Resolve timezone (the runner needs it for date defaulting + validation,
    // though we pass an explicit businessDate so it won't fall back).
    const { data: propRow } = await supabaseAdmin
      .from('properties')
      .select('timezone')
      .eq('id', propertyId)
      .maybeSingle();
    const tz = (propRow?.timezone as string | null) ?? null;

    const result = await runAutoAssignForProperty(propertyId, tz, {
      businessDate,
      respectScheduledToday: false,
      respectPriority: true,
      assignedBy: 'auto',
      assignedByUserId: auth.userId,
    });

    log.info('auto-assign: complete', { requestId, ...result });
    return ok(
      {
        assigned: result.assigned,
        unassigned: result.unassigned,
        skippedAlreadyAssigned: result.skippedAlreadyAssigned,
        reason: result.reason ?? null,
      },
      { requestId },
    );
  } catch (e) {
    log.error('auto-assign: unexpected error', { requestId, propertyId, msg: errToString(e) });
    return err('auto-assign failed', { requestId, status: 500, code: 'internal_error' });
  }
}
