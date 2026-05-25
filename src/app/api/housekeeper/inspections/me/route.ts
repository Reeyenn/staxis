/**
 * GET /api/housekeeper/inspections/me?pid=&staffId=&date=YYYY-MM-DD
 *
 * Returns the inspector's bootstrap payload for the mobile InspectorView:
 *   - canInspect: whether the staff member is permitted to inspect
 *   - queue: pending inspections + pending re-checks (same shape as the
 *     manager queue endpoint, filtered to today)
 *
 * Public route (no session auth) — the housekeeper page is opened from
 * an SMS link with pid + staffId in the URL. We validate the pair and
 * use supabaseAdmin to bypass RLS the same way the existing housekeeper
 * routes do.
 */

import { NextRequest } from 'next/server';
import { validateUuid } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { mergePmsRoomsForDate } from '@/lib/pms-rooms-server';
import { fromInspectionRow, lookupStaffNames, staffCanInspect } from '@/lib/db/inspections';
import type { InspectionQueueRoom } from '@/types/inspections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const { searchParams } = new URL(req.url);

  const pidV = validateUuid(searchParams.get('pid'), 'pid');
  if (pidV.error) {
    return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const pid = pidV.value!;

  const staffV = validateUuid(searchParams.get('staffId'), 'staffId');
  if (staffV.error) {
    return err(staffV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const staffId = staffV.value!;

  const date = searchParams.get('date') ?? '';
  if (!DATE_RE.test(date)) {
    return err('date must be YYYY-MM-DD', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  try {
    // Capability check: the (pid, staffId) pair must exist AND the staff
    // row must have can_inspect=true. Two queries in one — the staff
    // lookup also serves as the capability gate.
    const canInspect = await staffCanInspect(pid, staffId);
    if (!canInspect) {
      // Return canInspect=false rather than 403 so InspectorView can
      // gracefully render nothing for non-inspectors without log spam.
      return ok({ canInspect: false, queue: [] }, { requestId });
    }

    const queue = await buildQueue(pid, date);
    return ok({ canInspect: true, queue }, { requestId });
  } catch (e: unknown) {
    log.error('[housekeeper/inspections/me] failed', {
      requestId, pid, staffId, date, msg: errToString(e),
    });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}

async function buildQueue(pid: string, date: string): Promise<InspectionQueueRoom[]> {
  const rooms = await mergePmsRoomsForDate(pid, date);
  const cleanRooms = rooms.filter((r) => r.status === 'clean' && r.completedAt);

  // Window extends 48h backwards (Codex M6 post-merge sweep) so an
  // overnight fail can still chain to a morning re-clean instead of
  // being silently dropped.
  const windowStart = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const { data: inspectionRows, error: inspErr } = await supabaseAdmin
    .from('inspections')
    .select('*')
    .eq('property_id', pid)
    .gte('started_at', windowStart)
    .order('started_at', { ascending: false });
  if (inspErr) throw inspErr;

  const inspections = (inspectionRows ?? []).map((r) => fromInspectionRow(r as Parameters<typeof fromInspectionRow>[0]));
  const latestByRoom = new Map<string, ReturnType<typeof fromInspectionRow>>();
  for (const insp of inspections) {
    if (!latestByRoom.has(insp.roomNumber)) latestByRoom.set(insp.roomNumber, insp);
  }

  const staffIds = new Set<string>();
  for (const r of cleanRooms) {
    if (r.assignedTo) staffIds.add(r.assignedTo);
  }
  const staffNames = await lookupStaffNames(Array.from(staffIds));

  const out: InspectionQueueRoom[] = [];
  for (const r of cleanRooms) {
    const latest = latestByRoom.get(r.number);
    const completedAt = r.completedAt instanceof Date ? r.completedAt.toISOString() : (r.completedAt ?? null);

    if (!latest) {
      out.push({
        roomId: r.id,
        roomNumber: r.number,
        roomType: String(r.type ?? ''),
        housekeeperStaffId: r.assignedTo ?? null,
        housekeeperName: r.assignedTo
          ? staffNames.get(r.assignedTo) ?? r.assignedName ?? null
          : r.assignedName ?? null,
        completedAt,
        reason: 'pending_inspection',
        parentInspectionId: null,
        priorFailCount: 0,
      });
      continue;
    }

    if (latest.result === 'pass') continue;
    if (latest.result === 'in_progress') continue;

    if (latest.result === 'fail') {
      if (latest.completedAt && completedAt && completedAt > latest.completedAt) {
        out.push({
          roomId: r.id,
          roomNumber: r.number,
          roomType: String(r.type ?? ''),
          housekeeperStaffId: r.assignedTo ?? null,
          housekeeperName: r.assignedTo
            ? staffNames.get(r.assignedTo) ?? r.assignedName ?? null
            : r.assignedName ?? null,
          completedAt,
          reason: 'pending_recheck',
          parentInspectionId: latest.id,
          priorFailCount: 1,
        });
      }
    }
  }

  out.sort((a, b) => {
    if (!a.completedAt) return 1;
    if (!b.completedAt) return -1;
    return a.completedAt.localeCompare(b.completedAt);
  });

  return out;
}
