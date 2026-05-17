/**
 * GET /api/admin/active-sessions
 *
 * Returns Claude Code sessions whose last heartbeat landed within the
 * "alive" window (45 seconds). Used by the System tab to show
 * what's being worked on across multiple Claude Code instances in
 * real time.
 *
 * Each session row is the latest state from .claude/hooks/heartbeat.sh:
 * which branch the session was on, which tool it last fired, and how
 * long ago.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log, getOrMintRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

// Safety-net window only — the primary signal that a session has
// stopped is the Stop hook (.claude/hooks/stop.sh), which backdates
// last_heartbeat the moment Claude finishes responding. This window
// just catches sessions that crash or lose network before Stop can
// fire. 20s is short enough to make a crashed-out badge fade quickly,
// long enough to bridge silent thinking between tool calls.
const ALIVE_WINDOW_MS = 20 * 1000;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const cutoff = new Date(Date.now() - ALIVE_WINDOW_MS).toISOString();

  const { data, error } = await supabaseAdmin
    .from('claude_sessions')
    .select('session_id, branch, current_tool, started_at, last_heartbeat, cwd')
    .gte('last_heartbeat', cutoff)
    .order('last_heartbeat', { ascending: false })
    .limit(20);

  if (error) {
    log.error('active-sessions query failed', { err: error, requestId });
    return err('active-sessions query failed', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }

  // Group by branch so the UI can show "main: 2 sessions, feat/inventory: 1"
  type Session = NonNullable<typeof data>[number];
  const byBranch = new Map<string, Session[]>();
  for (const s of data ?? []) {
    const b = (s.branch as string | null) ?? '(no branch)';
    if (!byBranch.has(b)) byBranch.set(b, []);
    byBranch.get(b)!.push(s);
  }

  const grouped = Array.from(byBranch.entries()).map(([branch, sessions]) => ({
    branch,
    sessionCount: sessions.length,
    sessions,
  }));

  return ok({
    sessions: data ?? [],
    grouped,
    totalActive: (data ?? []).length,
  }, { requestId });
}
