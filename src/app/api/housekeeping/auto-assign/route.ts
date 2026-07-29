/**
 * POST /api/housekeeping/auto-assign
 *
 * Manager-initiated "Auto-assign" button on the Schedule board. Runs the
 * SAME assignment engine + persistence path as the 15-min cron (shared
 * runner in src/lib/auto-assign-runner.ts), but scoped to one property +
 * the date the manager is looking at, and with one policy tweak suited
 * to a manual click:
 *
 *   - respectPriority = true — honor the per-housekeeper "Automatic room
 *     assignment" setting on the staff member's card in Staff: never
 *     auto-place onto someone the manager set to "Never".
 *
 * Who gets the rooms is resolved from the Staff schedule for that date
 * (shared helper in src/lib/schedule/active-crew.ts), so the engine can
 * only place work onto crew the manager can actually see on the board.
 *
 * Non-destructive + idempotent: only places cleaning_tasks that have no
 * active hk_assignments row. That means it is a NO-OP once the day is
 * planned — which is why the board's "Re-plan day" button calls
 * POST /api/housekeeping/reset-assignments (no taskId → clear the day)
 * and then this route. Keep the two separate: a manager filling in the
 * gaps must never risk shuffling rooms people are already walking to.
 *
 * Auth: requireSession (manager-facing) + property-access gate.
 *
 * Body: { propertyId: uuid, date: YYYY-MM-DD }
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/api-auth';
import { capabilityUnavailableResponse } from '@/lib/capabilities/api-gate';
import { hotelWriteDecisionForUserId } from '@/lib/team-auth';
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
  const capabilityDecision = await hotelWriteDecisionForUserId(
    auth.userId,
    propertyId,
    'assign_work',
  );
  if (capabilityDecision === 'unavailable') {
    return capabilityUnavailableResponse(requestId);
  }
  if (capabilityDecision === 'denied') {
    return err('forbidden: assigning work is restricted for your role at this property', { requestId, status: 403, code: 'forbidden' });
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
