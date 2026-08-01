/**
 * GET /api/cron/claude-sessions-purge
 *
 * ┌─ DORMANT since 2026-07-27 (chore audit) — UNSCHEDULED, NOT DELETED ─────┐
 * │ `claude_sessions` has never held a single row, so this daily sweep has  │
 * │ never deleted anything.                                                 │
 * │                                                                         │
 * │ Root cause (verified 2026-07-27): the only writer is                    │
 * │ .claude/hooks/heartbeat.sh, a developer-laptop Claude Code hook. It     │
 * │ POSTs to https://hotelops-ai.vercel.app/api/claude-heartbeat, which     │
 * │ 308-redirects to getstaxis.com — and its `curl` has no `-L`, so the     │
 * │ request dies at the redirect and the body is dropped. The route and the │
 * │ table are both fine; nothing ever reaches them.                         │
 * │                                                                         │
 * │ DELIBERATELY LEFT BROKEN. The hook was not "fixed" here on purpose:     │
 * │ pointing it at getstaxis.com would immediately start filling a table    │
 * │ whose only pruner is this now-dormant cron. The two must be re-enabled  │
 * │ TOGETHER or not at all.                                                 │
 * │                                                                         │
 * │ This is developer tooling ("which Claude session is live on which       │
 * │ branch"), not a hotel chore — which is why it lost its slot rather than │
 * │ getting repaired. To re-enable BOTH halves: add `-L` to the curl in     │
 * │ .claude/hooks/heartbeat.sh (or point it at getstaxis.com directly),     │
 * │ then restore its vercel.json crons[] entry ("30 3 * * *") and promote  │
 * │ its retired job-catalog row; Mission Control and CI parity metadata     │
 * │ are catalog projections.                                                │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Daily at 03:30 UTC. DELETEs rows in `claude_sessions` whose
 * last_heartbeat is older than 24 hours.
 *
 * Why this exists (2026-05-20 security audit M2): the heartbeat endpoint
 * upserts one row per session_id. The active-sessions reader filters
 * out rows older than the 2-minute freshness window — but that's only
 * a READ-side filter; the rows themselves stick around. A random-
 * sessionId flood (or just normal long-tail usage) would grow the
 * table without bound. This cron is the storage-side counterpart.
 *
 * Retention: 24h gives the admin live-view a full day of history if
 * we ever surface "sessions that worked yesterday" in the UI; beyond
 * that the rows are dead weight on the (session_id) primary key and
 * the (last_heartbeat desc) index.
 *
 * Auth: CRON_SECRET bearer (same gate every other cron uses).
 * Heartbeat: writes to cron_heartbeats so the doctor route can detect
 * a stalled cron.
 *
 * Returns: { purged: number, cutoff: ISO, retentionHours: 24 }
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireCronSecret } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const RETENTION_HOURS = 24;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const cronGate = requireCronSecret(req);
  if (cronGate) return cronGate;

  const cutoff = new Date(Date.now() - RETENTION_HOURS * 60 * 60 * 1000).toISOString();

  // DELETE … RETURNING session_id — gives us the count without a
  // separate COUNT round-trip.
  const { data: deleted, error } = await supabaseAdmin
    .from('claude_sessions')
    .delete()
    .lt('last_heartbeat', cutoff)
    .select('session_id');

  if (error) {
    return err(`Could not purge claude_sessions: ${error.message}`, {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  const purgedCount = (deleted ?? []).length;

  await writeCronHeartbeat('claude-sessions-purge', {
    requestId,
    notes: { purged: purgedCount },
  });

  return ok({
    purged: purgedCount,
    cutoff,
    retentionHours: RETENTION_HOURS,
  }, { requestId });
}
