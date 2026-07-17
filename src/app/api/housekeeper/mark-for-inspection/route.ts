/**
 * POST /api/housekeeper/mark-for-inspection
 *
 * Flips `rooms.marked_for_inspection_at` on a room so the inspections
 * queue picks it up. The inspections tab + worker on main already keys
 * off this column; this endpoint just provides the housekeeper-side tap.
 *
 * Idempotent — re-marking is a no-op (uses the existing timestamp's
 * presence as the "already marked" signal). Set `clear: true` in the
 * body to un-mark.
 *
 * Runs on the shared runHousekeeperRoomAction runner (gate → idempotency
 * claim → loadRoomForStaff → writeWorkflowFields → audit → replay).
 */

import type { NextRequest } from 'next/server';
import { runHousekeeperRoomAction } from '@/lib/housekeeper-workflow/room-action-runner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

interface Body {
  pid?: string;
  staffId?: string;
  roomId?: string;
  clear?: boolean;
  actionId?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  return runHousekeeperRoomAction<Body>(req, {
    endpoint: 'housekeeper-mark-inspection',
    replayEndpoint: 'mark-for-inspection',
    buildFields: ({ body, now }) => ({
      marked_for_inspection_at: body.clear === true ? null : now.toISOString(),
    }),
    auditEvent: ({ body }) => ({
      event_type: 'mark_for_inspection',
      payload: { cleared: body.clear === true },
    }),
    buildResult: ({ body, now }) => ({
      marked: body.clear !== true,
      markedAt: body.clear === true ? null : now.toISOString(),
    }),
  });
}
