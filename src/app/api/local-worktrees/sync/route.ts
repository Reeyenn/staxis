/**
 * POST /api/local-worktrees/sync
 *
 * Reeyen's local machine pings this endpoint with the current full list
 * of git worktrees on disk. The admin Marvel timeline reads this table
 * to render every worktree as a branch tendril — making the timeline a
 * single pane of glass (no need to look at GitHub or his filesystem).
 *
 * Body:
 *   {
 *     host?: string,                  // identifier for this machine
 *     worktrees: Array<{
 *       name: string,                 // basename of the worktree path
 *       branch: string | null,
 *       dirtyFiles: number,
 *       commitsAhead: number,
 *       commitsBehind: number,
 *       headCommittedAt?: string|null, // ISO
 *       headMessage?: string|null
 *     }>
 *   }
 *
 * Atomic semantics:
 *   - Every worktree in the payload is upserted with last_seen=now().
 *   - Any row whose last_seen is older than 10 minutes for this host is
 *     deleted (catch-up for worktrees the user removed locally — the
 *     next sync after a deletion will sweep them).
 *
 * No auth: same rationale as /api/claude-heartbeat — the hook fires
 * from Reeyen's machine without env-var plumbing, and the data isn't
 * sensitive (branch names, dirty counts).
 */

import { NextRequest, NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { supabaseAdmin } from '@/lib/supabase-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

interface IncomingWorktree {
  name?: unknown;
  branch?: unknown;
  dirtyFiles?: unknown;
  commitsAhead?: unknown;
  commitsBehind?: unknown;
  headCommittedAt?: unknown;
  headMessage?: unknown;
}

const STALE_AFTER_MS = 10 * 60 * 1000; // 10 minutes

function asInt(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function asStr(v: unknown, max = 500): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const host = (asStr(body.host, 100) ?? 'reeyen-mac');
  const list = Array.isArray(body.worktrees) ? body.worktrees : [];

  const now = new Date().toISOString();
  const cleanRows = list
    .map((wt: IncomingWorktree) => {
      const name = asStr(wt.name, 200);
      if (!name) return null;
      return {
        host,
        name,
        branch: asStr(wt.branch, 200),
        dirty_files: asInt(wt.dirtyFiles),
        commits_ahead: asInt(wt.commitsAhead),
        commits_behind: asInt(wt.commitsBehind),
        head_committed_at: asStr(wt.headCommittedAt, 50),
        head_message: asStr(wt.headMessage, 500),
        last_seen: now,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (cleanRows.length > 0) {
    const { error } = await supabaseAdmin
      .from('local_worktrees')
      .upsert(cleanRows, { onConflict: 'host,name' });
    if (error) {
      console.error('[local-worktrees/sync] upsert failed', { msg: error.message });
      return NextResponse.json({ error: 'db error' }, { status: 500 });
    }
  }

  // Sweep stale rows for this host. Anything not seen in the last
  // STALE_AFTER_MS window must have been removed from disk locally.
  const staleCutoff = new Date(Date.now() - STALE_AFTER_MS).toISOString();
  const { error: pruneErr } = await supabaseAdmin
    .from('local_worktrees')
    .delete()
    .eq('host', host)
    .lt('last_seen', staleCutoff);
  if (pruneErr) {
    console.error('[local-worktrees/sync] prune failed', { msg: pruneErr.message });
    // Not fatal — the sweep can retry next sync.
  }

  try { revalidateTag('github-data', 'max'); } catch { /* swallow */ }

  return NextResponse.json({ ok: true, count: cleanRows.length });
}
