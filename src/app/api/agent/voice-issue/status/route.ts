// ─── GET /api/agent/voice-issue/status ─────────────────────────────────────
//
// Returns the maintenance-ticket status for a given voice-session id. The
// VoiceIssueButton on the housekeeper page polls this endpoint once per
// agent message to know whether the agent has actually fired the
// createMaintenanceWorkOrder tool — replacing the previous heuristic that
// counted assistant messages and would mis-fire on clarifying questions
// (Codex 2026-05-25 MAJOR finding).
//
// Auth shape mirrors /api/agent/voice-session:
//   - requireSession verifies a Supabase access token (the housekeeper
//     consumed a magic link earlier in the page lifecycle).
//   - The voiceSessionId is validated by joining to agent_voice_sessions:
//     the row must belong to the same data_user_id as the caller. A
//     caller who guesses another session id sees `not_found` (the row
//     exists but isn't theirs — we collapse to one error class on purpose
//     so guessing returns no signal about row existence).
//
// We deliberately do NOT use the dynamic_variables nonce or trust anything
// from the client beyond what `requireSession` already authenticates.

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { requireSession } from '@/lib/api-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getOrMintRequestId, log } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);

  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;

  const voiceSessionId = req.nextUrl.searchParams.get('voiceSessionId');
  if (!voiceSessionId || !UUID_RX.test(voiceSessionId)) {
    return NextResponse.json(
      { ok: false, error: 'voiceSessionId must be a valid UUID', requestId },
      { status: 400 },
    );
  }

  // Verify the voice session belongs to the caller. We DON'T return any
  // detail about another user's session — the unauthenticated lookup
  // collapses to a single "not_found" so guessing reveals nothing.
  const { data: session, error: sessionErr } = await supabaseAdmin
    .from('agent_voice_sessions')
    .select('id, data_user_id')
    .eq('id', voiceSessionId)
    .maybeSingle();
  if (sessionErr) {
    log.error('[voice-issue.status] session lookup failed', { requestId, voiceSessionId, e: sessionErr });
    return NextResponse.json(
      { ok: false, error: 'lookup failed', requestId },
      { status: 500 },
    );
  }
  if (!session || (session.data_user_id as string) !== auth.userId) {
    return NextResponse.json(
      { ok: true, data: { ticketFiled: false, reason: 'not_found' }, requestId },
    );
  }

  // Look up the ticket for this session. Reads from pms_work_orders_v2
  // (canonical maintenance table since migration 0225). The partial unique
  // index on (voice_session_id) guarantees at most one row. The voice-
  // specific fields live in voice_metadata; we flatten them onto the
  // response so the client doesn't have to reach into jsonb.
  const { data: issue, error: issueErr } = await supabaseAdmin
    .from('pms_work_orders_v2')
    .select('id, room_number, status, created_at, voice_metadata')
    .eq('voice_session_id', voiceSessionId)
    .maybeSingle();
  if (issueErr) {
    log.error('[voice-issue.status] issue lookup failed', { requestId, voiceSessionId, e: issueErr });
    return NextResponse.json(
      { ok: false, error: 'lookup failed', requestId },
      { status: 500 },
    );
  }

  if (!issue) {
    return NextResponse.json(
      { ok: true, data: { ticketFiled: false }, requestId },
    );
  }

  const meta = (issue.voice_metadata ?? {}) as {
    action?: string;
    item?: string;
    location_detail?: string | null;
    severity?: string;
  };

  return NextResponse.json({
    ok: true,
    data: {
      ticketFiled: true,
      issueId: issue.id,
      roomNumber: issue.room_number,
      action: meta.action ?? null,
      item: meta.item ?? null,
      locationDetail: meta.location_detail ?? null,
      severity: meta.severity ?? null,
      status: issue.status,
      createdAt: issue.created_at,
    },
    requestId,
  });
}
