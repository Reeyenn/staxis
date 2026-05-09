/**
 * POST /api/claude-heartbeat
 *
 * Two events from Claude Code via .claude/hooks/:
 *   - PostToolUse → heartbeat.sh → { sessionId, branch?, tool?, cwd? }
 *     Marks the session as actively working RIGHT NOW.
 *   - Stop       → stop.sh      → { sessionId, event: 'stop' }
 *     Marks the session as ended (Claude finished responding). Sets
 *     last_heartbeat to epoch so the active-sessions read filters it
 *     out IMMEDIATELY — the WORKING badge vanishes within one poll
 *     cycle (~2s) instead of waiting for the freshness window.
 *
 * Sessions also auto-expire if no heartbeat arrives within the read
 * endpoint's freshness window — a safety net for sessions that crash
 * or lose network before the Stop hook can fire.
 *
 * No auth: the endpoint is intentionally unauthenticated so the hook
 * can fire without env-var plumbing on every dev machine. The blast
 * radius of abuse is near zero — fake sessions vanish on their own.
 */

import { NextRequest, NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { supabaseAdmin } from '@/lib/supabase-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 5;

// Sentinel "very old" timestamp used when Claude tells us the session
// has ended. Anything before now()-window will be filtered out by the
// active-sessions reader, so this is "instantly expired" for our
// purposes. We use 2000-01-01 instead of epoch (1970) because some
// PG client libs choke on dates that old.
const ENDED_TIMESTAMP = '2000-01-01T00:00:00Z';

export async function POST(req: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const sessionId = (body.sessionId as string | undefined)?.trim();
  if (!sessionId) {
    return NextResponse.json({ error: 'sessionId required' }, { status: 400 });
  }
  if (sessionId.length > 100) {
    return NextResponse.json({ error: 'sessionId too long' }, { status: 400 });
  }

  const event = (body.event as string | undefined) ?? 'tool';

  if (event === 'stop') {
    // End-of-turn signal. Backdate the heartbeat so the next dashboard
    // poll filters this row out — no waiting for the alive-window
    // timeout.
    const { error } = await supabaseAdmin
      .from('claude_sessions')
      .update({
        last_heartbeat: ENDED_TIMESTAMP,
        current_tool: null,
      })
      .eq('session_id', sessionId);
    if (error) {
      console.error('[claude-heartbeat] stop update failed', { msg: error.message });
    }
    try { revalidateTag('claude-sessions', 'max'); } catch { /* swallow */ }
    return NextResponse.json({ ok: true, event: 'stop' });
  }

  // Default: PostToolUse heartbeat.
  const branch = (body.branch as string | undefined)?.slice(0, 200) ?? null;
  const tool = (body.tool as string | undefined)?.slice(0, 100) ?? null;
  const cwd = (body.cwd as string | undefined)?.slice(0, 500) ?? null;
  const now = new Date().toISOString();

  const { error } = await supabaseAdmin
    .from('claude_sessions')
    .upsert(
      {
        session_id: sessionId,
        branch,
        current_tool: tool,
        cwd,
        last_heartbeat: now,
      },
      { onConflict: 'session_id' },
    );

  if (error) {
    console.error('[claude-heartbeat] upsert failed', { msg: error.message });
  }

  try { revalidateTag('claude-sessions', 'max'); } catch { /* swallow */ }

  return NextResponse.json({ ok: true });
}
