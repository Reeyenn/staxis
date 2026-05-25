/**
 * GET /api/housekeeping/inspections/queue?pid=...&date=YYYY-MM-DD
 *
 * Returns rooms ready for inspection plus rooms ready for re-check.
 *
 *   pending_inspection — room status='clean' AND no completed inspection
 *                        exists for that room on the same business date.
 *
 *   pending_recheck    — there's a prior failed inspection (today) AND the
 *                        room has since been re-cleaned (room.completedAt
 *                        > inspection.completedAt).
 *
 * Used by the manager InspectionsTab. requireSession + property access
 * gate. Standard envelope response.
 */

import { NextRequest } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { validateUuid } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { mergePmsRoomsForDate } from '@/lib/pms-rooms-server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { fromInspectionRow, lookupStaffNames } from '@/lib/db/inspections';
import type { InspectionQueueRoom } from '@/types/inspections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireSession(req, { requestId });
  if (!auth.ok) return auth.response;

  const { searchParams } = new URL(req.url);
  const pidV = validateUuid(searchParams.get('pid'), 'pid');
  if (pidV.error) {
    return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const pid = pidV.value!;

  const date = searchParams.get('date') ?? '';
  if (!DATE_RE.test(date)) {
    return err('date must be YYYY-MM-DD', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  const hasAccess = await userHasPropertyAccess(auth.userId, pid);
  if (!hasAccess) {
    return err('forbidden — no access to this property', {
      requestId, status: 403, code: ApiErrorCode.Forbidden,
    });
  }

  try {
    const queue = await buildQueue(pid, date);
    return ok(queue, { requestId });
  } catch (e: unknown) {
    log.error('[inspections/queue] failed', { requestId, pid, date, msg: errToString(e) });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}

async function buildQueue(pid: string, date: string): Promise<InspectionQueueRoom[]> {
  // 1. All rooms for today with current status + last completed time +
  // assignment. Same shape the manager RoomsTab uses.
  const rooms = await mergePmsRoomsForDate(pid, date);
  const cleanRooms = rooms.filter((r) => r.status === 'clean' && r.completedAt);

  // 2. Recent inspections — used to filter out rooms already inspected
  // and to detect pending re-checks. Window extends 48h backwards
  // (Codex M6 post-merge sweep) so an overnight fail can chain to a
  // morning re-clean across the midnight boundary instead of being
  // silently dropped.
  const windowStart = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const { data: inspectionRows, error: inspErr } = await supabaseAdmin
    .from('inspections')
    .select('*')
    .eq('property_id', pid)
    .gte('started_at', windowStart)
    .order('started_at', { ascending: false });
  if (inspErr) throw inspErr;
  const inspections = (inspectionRows ?? []).map((r) => fromInspectionRow(r as Parameters<typeof fromInspectionRow>[0]));

  // Latest inspection per room (today). If the latest is a pass / fail,
  // that's what the queue logic considers.
  const latestByRoom = new Map<string, ReturnType<typeof fromInspectionRow>>();
  for (const insp of inspections) {
    if (!latestByRoom.has(insp.roomNumber)) latestByRoom.set(insp.roomNumber, insp);
  }

  // Pre-compute the housekeeper name lookup so the queue rows can show it.
  const staffIds = new Set<string>();
  for (const r of cleanRooms) {
    const assignedToId = r.assignedTo;
    if (assignedToId) staffIds.add(assignedToId);
  }
  const staffNames = await lookupStaffNames(Array.from(staffIds));

  const out: InspectionQueueRoom[] = [];

  for (const r of cleanRooms) {
    const latest = latestByRoom.get(r.number);
    const completedAt = r.completedAt instanceof Date ? r.completedAt.toISOString() : (r.completedAt ?? null);

    if (!latest) {
      // Never inspected today → pending_inspection.
      out.push({
        roomId: r.id,
        roomNumber: r.number,
        roomType: String(r.type ?? ''),
        housekeeperStaffId: r.assignedTo ?? null,
        housekeeperName: r.assignedTo ? staffNames.get(r.assignedTo) ?? r.assignedName ?? null : r.assignedName ?? null,
        completedAt,
        reason: 'pending_inspection',
        parentInspectionId: null,
        priorFailCount: 0,
      });
      continue;
    }

    if (latest.result === 'pass') {
      // Already inspected today and passed — nothing to do.
      continue;
    }

    if (latest.result === 'fail') {
      // Latest is a fail. Pending re-check if the room has been re-cleaned
      // since the fail (i.e., room.completedAt > inspection.completedAt).
      if (latest.completedAt && completedAt && completedAt > latest.completedAt) {
        // Count prior fails on the chain (this one + any earlier in the
        // parent chain) — used to surface "this is failing repeatedly".
        const priorFailCount = await countFailsInChain(latest.id);
        out.push({
          roomId: r.id,
          roomNumber: r.number,
          roomType: String(r.type ?? ''),
          housekeeperStaffId: r.assignedTo ?? null,
          housekeeperName: r.assignedTo ? staffNames.get(r.assignedTo) ?? r.assignedName ?? null : r.assignedName ?? null,
          completedAt,
          reason: 'pending_recheck',
          parentInspectionId: latest.id,
          priorFailCount,
        });
      }
      // If the room hasn't been re-cleaned yet, it sits in the housekeeper's
      // queue (issue_note set) and is NOT visible in the inspections queue.
    }

    if (latest.result === 'in_progress') {
      // Another inspector is on it — don't include in the queue.
      continue;
    }
  }

  // Sort: oldest-ready-first (FIFO).
  out.sort((a, b) => {
    if (!a.completedAt) return 1;
    if (!b.completedAt) return -1;
    return a.completedAt.localeCompare(b.completedAt);
  });

  return out;
}

async function countFailsInChain(inspectionId: string): Promise<number> {
  let count = 0;
  let cursor: string | null = inspectionId;
  for (let i = 0; i < 20 && cursor; i++) {
    const { data, error }: { data: { result: string; parent_inspection_id: string | null } | null; error: unknown } =
      await supabaseAdmin
        .from('inspections')
        .select('result, parent_inspection_id')
        .eq('id', cursor)
        .maybeSingle();
    if (error || !data) break;
    if (data.result === 'fail') count += 1;
    if (data.result !== 'fail' && data.result !== 'in_progress') break;
    cursor = data.parent_inspection_id;
  }
  return count;
}
