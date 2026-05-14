// ─── POST /api/walkthrough/end ────────────────────────────────────────────
// Final call in the walkthrough lifecycle. Closes the `walkthrough_runs`
// row with a terminal status so the partial unique index releases and the
// user can start another walkthrough.
//
// Idempotent — calling it twice is a no-op on the second call (the RPC's
// `where status = 'active'` clause makes the update a noop on already-
// closed rows). Safe to retry from the client.
//
// Possible terminal statuses:
//   done    — Claude returned `done` for the task
//   stopped — user hit the Stop (×) button
//   capped  — server-side MAX_STEPS=12 hit (set by /step, not here)
//   errored — overlay caught an exception
//   timeout — 90-second wait-for-click expired (RC5; future Phase E)
//
// RC2 root-cause fix (2026-05-14).

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireSession } from '@/lib/api-auth';
import { getOrMintRequestId, log } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

const ALLOWED_STATUSES = new Set(['done', 'stopped', 'capped', 'errored', 'timeout']);

interface EndRequestBody {
  runId: string;
  status: 'done' | 'stopped' | 'capped' | 'errored' | 'timeout';
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);

  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;

  let body: EndRequestBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid json', requestId }, { status: 400 });
  }
  if (!body.runId) {
    return Response.json({ ok: false, error: 'runId is required', requestId }, { status: 400 });
  }
  if (!ALLOWED_STATUSES.has(body.status)) {
    return Response.json(
      { ok: false, error: `invalid status; allowed: ${Array.from(ALLOWED_STATUSES).join(', ')}`, requestId },
      { status: 400 },
    );
  }

  // Ownership check: only the user who started the run can end it. We
  // rely on the RPC being security-definer + idempotent; verify ownership
  // explicitly so a malicious client can't close other users' runs.
  const { data: account } = await supabaseAdmin
    .from('accounts')
    .select('id')
    .eq('data_user_id', auth.userId)
    .maybeSingle();
  if (!account) {
    return Response.json({ ok: false, error: 'account not found', requestId }, { status: 404 });
  }
  const { data: run } = await supabaseAdmin
    .from('walkthrough_runs')
    .select('id, user_id, status')
    .eq('id', body.runId)
    .maybeSingle();
  if (!run) {
    return Response.json({ ok: false, error: 'run not found', requestId }, { status: 404 });
  }
  if (run.user_id !== account.id) {
    return Response.json({ ok: false, error: 'not your run', requestId }, { status: 403 });
  }

  const { error: rpcErr } = await supabaseAdmin.rpc('staxis_walkthrough_end', {
    p_run_id: body.runId,
    p_status: body.status,
  });
  if (rpcErr) {
    log.error('[walkthrough/end] RPC failed', { requestId, runId: body.runId, err: rpcErr });
    return Response.json({ ok: false, error: 'failed to end walkthrough', requestId }, { status: 500 });
  }

  // Use `runStatus` not `status` — LogFields reserves `status` for HTTP codes.
  log.info('[walkthrough/end]', { requestId, runId: body.runId, runStatus: body.status });
  return Response.json({ ok: true, requestId });
}
