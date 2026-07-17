/**
 * POST /api/housekeeper/add-note
 *
 * Housekeeper attaches a quick note to a room. Distinct from "Report
 * Issue" — this doesn't open a work order. The note lands on
 * `rooms.housekeeper_note` so manager dashboards can see it, and an
 * audit row goes into housekeeper_audit_log.
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
  noteText?: string;
  /** Empty string or null clears the note. */
  actionId?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  return runHousekeeperRoomAction<Body>(req, {
    endpoint: 'housekeeper-add-note',
    replayEndpoint: 'add-note',
    buildFields: ({ body, now }) => {
      const noteText = (body.noteText ?? '').trim().slice(0, 1000);
      return {
        housekeeper_note: noteText || null,
        housekeeper_note_at: noteText ? now.toISOString() : null,
      };
    },
    auditEvent: ({ body }) => {
      const noteText = (body.noteText ?? '').trim().slice(0, 1000);
      return {
        event_type: 'add_note',
        payload: { note: noteText, cleared: !noteText },
      };
    },
    buildResult: ({ body }) => {
      const noteText = (body.noteText ?? '').trim().slice(0, 1000);
      return { saved: true, noteText: noteText || null };
    },
  });
}
