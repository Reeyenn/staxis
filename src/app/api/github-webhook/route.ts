/**
 * POST /api/github-webhook
 *
 * Receives GitHub webhook events (push / pull_request / create / delete /
 * ping) for the staxis repo. On a verified delivery we:
 *
 *   1. Insert a row into github_events so the admin System tab can
 *      detect "something just happened" via a cheap cursor query.
 *   2. Call revalidateTag('github-data') so the build-status cache
 *      drops and the very next fetch returns fresh data from GitHub.
 *
 * Combined those two steps deliver near-real-time timeline updates:
 *   GitHub event → ~250ms to here → DB row + cache busted → client's
 *   2s cursor poll sees the new ts → client refetches → server hits
 *   GitHub fresh → user-visible update in ~3 seconds total.
 *
 * Security: every payload is verified against the GITHUB_WEBHOOK_SECRET
 * env var via HMAC SHA-256 (the X-Hub-Signature-256 header). Anything
 * else is rejected with 401.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { revalidateTag } from 'next/cache';
import { supabaseAdmin } from '@/lib/supabase-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

export async function POST(req: NextRequest) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[github-webhook] GITHUB_WEBHOOK_SECRET not set');
    return NextResponse.json({ error: 'webhook not configured' }, { status: 500 });
  }

  const sigHeader = req.headers.get('x-hub-signature-256');
  const eventType = req.headers.get('x-github-event') ?? 'unknown';
  // Read raw body for HMAC — we MUST verify against the exact bytes
  // GitHub sent, before parsing JSON.
  const body = await req.text();

  // Verify signature (constant-time compare)
  const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  if (!sigHeader) {
    return NextResponse.json({ error: 'missing signature' }, { status: 401 });
  }
  const sigBuf = Buffer.from(sigHeader);
  const expBuf = Buffer.from(expected);
  let valid = false;
  if (sigBuf.length === expBuf.length) {
    try { valid = timingSafeEqual(sigBuf, expBuf); } catch { valid = false; }
  }
  if (!valid) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  // 'ping' is GitHub's connectivity test when you first wire up the hook.
  // Acknowledge it and bail — we don't want to log noise for it.
  if (eventType === 'ping') {
    return NextResponse.json({ ok: true, pong: true });
  }

  // Best-effort write — failures here MUST NOT block the 200 to GitHub
  // or we'll get retries that flood the table.
  const branch =
    typeof payload.ref === 'string' ? payload.ref :
    typeof (payload.pull_request as { head?: { ref?: string } } | undefined)?.head?.ref === 'string'
      ? (payload.pull_request as { head: { ref: string } }).head.ref
      : null;

  try {
    await supabaseAdmin.from('github_events').insert({
      event_type: eventType,
      branch,
      metadata: {
        action: payload.action ?? null,
        sender: (payload.sender as { login?: string } | undefined)?.login ?? null,
        head_commit: (payload.head_commit as { id?: string; message?: string } | undefined)?.id ?? null,
        commit_message: (payload.head_commit as { id?: string; message?: string } | undefined)?.message ?? null,
        pull_request_number: (payload.pull_request as { number?: number } | undefined)?.number ?? null,
        pull_request_merged: (payload.pull_request as { merged?: boolean } | undefined)?.merged ?? null,
      },
    });
  } catch (err) {
    console.error('[github-webhook] failed to record event', {
      eventType, err: err instanceof Error ? err.message : String(err),
    });
  }

  // Bust the build-status cache so the next admin fetch returns fresh data.
  // Next.js 16 made the second arg required — 'max' = full invalidation.
  try {
    revalidateTag('github-data', 'max');
  } catch (err) {
    console.error('[github-webhook] revalidateTag failed', { err });
  }

  return NextResponse.json({ ok: true, eventType, branch });
}
