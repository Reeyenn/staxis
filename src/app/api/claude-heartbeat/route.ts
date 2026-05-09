/**
 * POST /api/claude-heartbeat
 *
 * Pinged by the .claude/hooks/heartbeat.sh script after every Claude
 * Code tool call. Lets the admin System tab show "Claude session N is
 * working on branch X right now" without waiting for commits to land.
 *
 * Body:
 *   { sessionId: string, branch?: string|null, tool?: string|null,
 *     cwd?: string|null }
 *
 * Sessions auto-expire from the "active" list after 2 minutes without
 * a heartbeat — the read endpoint filters by last_heartbeat freshness.
 *
 * No auth: the endpoint is intentionally unauthenticated so the hook
 * can fire without env-var plumbing on every dev machine. The blast
 * radius of abuse is essentially zero (someone could insert fake
 * sessions that vanish on their own after 2 min).
 */

import { NextRequest, NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { supabaseAdmin } from '@/lib/supabase-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 5;

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
  // Sanity-cap to avoid pathological inputs.
  if (sessionId.length > 100) {
    return NextResponse.json({ error: 'sessionId too long' }, { status: 400 });
  }

  const branch = (body.branch as string | undefined)?.slice(0, 200) ?? null;
  const tool = (body.tool as string | undefined)?.slice(0, 100) ?? null;
  const cwd = (body.cwd as string | undefined)?.slice(0, 500) ?? null;
  const now = new Date().toISOString();

  // Upsert. If the session row already exists, started_at stays put and
  // last_heartbeat / current_tool / branch update.
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
    // Still return 200 — we don't want the hook to retry / spam stderr.
  }

  // Bust the active-sessions cache so the next dashboard read sees us.
  try { revalidateTag('claude-sessions', 'max'); } catch { /* swallow */ }

  return NextResponse.json({ ok: true });
}
