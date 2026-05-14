// ─── POST /api/walkthrough/start ──────────────────────────────────────────
// First call in the walkthrough lifecycle. Inserts a `walkthrough_runs` row
// (via staxis_walkthrough_start RPC). The RPC enforces the partial unique
// "one active run per user" index — concurrent calls from a second tab,
// a retry storm, or a buggy client all hit 409 here instead of being able
// to run two walkthroughs in parallel.
//
// Returns the run id which the client must pass to every subsequent
// /api/walkthrough/step call and to /api/walkthrough/end on termination.
//
// RC2 root-cause fix (2026-05-14): without this endpoint there was no
// server-side concept of "a walkthrough is in progress." The /step route
// had no rate limit, no step cap, no concurrent-run dedup, and no
// telemetry hook. Funneling all walkthrough traffic through start → step
// → end gives the server the visibility it was missing.

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { getOrMintRequestId, log } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

const MAX_TASK_CHARS = 200;
const WALKTHROUGH_MAX_RUNS_PER_HOUR = 10;

interface StartRequestBody {
  task: string;
  propertyId: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);

  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;

  let body: StartRequestBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid json', requestId }, { status: 400 });
  }
  const task = (body.task ?? '').trim();
  if (!task) {
    return Response.json({ ok: false, error: 'task is required', requestId }, { status: 400 });
  }
  if (task.length > MAX_TASK_CHARS) {
    return Response.json({ ok: false, error: `task exceeds ${MAX_TASK_CHARS} chars`, requestId }, { status: 413 });
  }
  if (!body.propertyId) {
    return Response.json({ ok: false, error: 'propertyId is required', requestId }, { status: 400 });
  }

  const hasAccess = await userHasPropertyAccess(auth.userId, body.propertyId);
  if (!hasAccess) {
    return Response.json({ ok: false, error: 'no access to this property', requestId }, { status: 403 });
  }

  const { data: account, error: accountErr } = await supabaseAdmin
    .from('accounts')
    .select('id')
    .eq('data_user_id', auth.userId)
    .maybeSingle();
  if (accountErr || !account) {
    return Response.json({ ok: false, error: 'account not found', requestId }, { status: 404 });
  }
  const accountId = account.id as string;

  // ── Per-user rate limit (S1 — scale-readiness) ───────────────────────
  // The chatbot's reserveCostBudget rate-limits at 10/min by counting
  // agent_messages. Walkthrough doesn't write there, so that rate limit
  // sees zero — meaning a malicious client could `/start → 12×/step →
  // /end` in a tight loop and only the $5 daily cap stops them. At
  // 300-hotel scale, 5 abusers in parallel could saturate the Anthropic
  // org rate limit and slow real users.
  //
  // Counter the attack here: cap legitimate walkthroughs at 10/hr/user.
  // Average user runs ~3/day; 10/hr is 10× normal use, well below abuse.
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count: recentRuns, error: rateErr } = await supabaseAdmin
    .from('walkthrough_runs')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', accountId)
    .gte('started_at', hourAgo);
  if (rateErr) {
    log.error('[walkthrough/start] rate-limit query failed', { requestId, accountId, err: rateErr });
    // Fail open here — losing the rate limit briefly is less bad than
    // blocking all walkthroughs when the DB hiccups. The dollar cap
    // is still in place via reservation.
  } else if ((recentRuns ?? 0) >= WALKTHROUGH_MAX_RUNS_PER_HOUR) {
    log.warn('[walkthrough/start] rate_limit hit', { requestId, accountId, recentRuns });
    return Response.json(
      {
        ok: false,
        code: 'rate_limit',
        error: "You've started a lot of walkthroughs in the last hour — take a break and try again later.",
        requestId,
      },
      { status: 429 },
    );
  }

  // The RPC returns null if the partial unique index "one active run per
  // user" blocks the insert. Convert that to a 409 the client can show
  // a friendly "another tab is running a walkthrough" message for.
  const { data: rpcData, error: rpcErr } = await supabaseAdmin.rpc('staxis_walkthrough_start', {
    p_user_id: accountId,
    p_property_id: body.propertyId,
    p_task: task,
  });
  if (rpcErr) {
    log.error('[walkthrough/start] RPC failed', { requestId, accountId, err: rpcErr });
    return Response.json({ ok: false, error: 'failed to start walkthrough', requestId }, { status: 500 });
  }

  // supabase-js returns the scalar directly for a scalar RPC.
  const runId = (rpcData as string | null) ?? null;
  if (!runId) {
    return Response.json(
      {
        ok: false,
        code: 'already_active',
        error: 'You already have a walkthrough running in another tab. Close it first.',
        requestId,
      },
      { status: 409 },
    );
  }

  log.info('[walkthrough/start]', { requestId, runId, accountId, task: task.slice(0, 80) });
  return Response.json({ ok: true, runId, requestId });
}
