// @audit: tenant-scope-not-applicable — Cloudflare Email Worker → shared-secret
// webhook (Bearer PMS_INBOX_WEBHOOK_SECRET, constant-time), same boundary as
// /api/pms-inbox/inbound. Not a user/session route; it resolves the property
// itself from the Message-Id of a report delivery this server already accepted.
/**
 * POST /api/pms-inbox/attachment-commit — phase two of the report handshake.
 *
 * WHY THIS IS A SEPARATE ROUTE (the one genuinely new surface in this
 * workstream): /api/pms-inbox/inbound cannot serve it. The bytes go
 * Worker → Supabase Storage directly, and they land AFTER /inbound has already
 * responded with the signed upload URLs. Something has to observe that they
 * arrived and flip the ledger row; that observation is a second request by
 * construction.
 *
 * Sequence: /inbound writes pms_report_files rows in 'pending_upload' and mints
 * per-attachment signed upload URLs → the Worker PUTs the raw bytes → the
 * Worker calls this route with the hashes it uploaded → we verify the object
 * exists at the recorded path with the recorded byte_size, then flip the row.
 *
 * A hash whose object never landed stays 'pending_upload' and is swept to
 * 'failed' an hour later by /api/cron/pms-auth-codes-purge. An abandoned upload
 * is therefore a VISIBLE row, never a silent loss.
 *
 * NO PARSE IS ENQUEUED YET. Report formats are unknown — no parser exists to
 * consume the job, and enqueuing work nothing can run would just accumulate
 * stuck rows in workflow_jobs. The parse enqueue belongs with the parser.
 */

import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { getOrMintRequestId, log } from '@/lib/log';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok } from '@/lib/api-response';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { constantTimeBearerMatch } from '@/lib/pms-inbox/parse';
import {
  PMS_RAW_BUCKET,
  MAX_ATTACHMENTS_PER_MESSAGE,
  isSha256Hex,
  splitObjectPath,
} from '@/lib/pms-inbox/report-files';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

const MAX_BODY_BYTES = 16 * 1024;

interface CommitBody {
  messageId?: unknown;
  sha256?: unknown;
}

type CommitOutcome = 'stored' | 'blocked_unapproved_sender' | 'missing_object' | 'size_mismatch' | 'unknown' | 'already_committed';

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);

  // ── 1. Same shared-secret boundary as /inbound (fail-closed if unset) ─────
  const secrets = [env.PMS_INBOX_WEBHOOK_SECRET, env.PMS_INBOX_WEBHOOK_SECRET_NEXT];
  if (!secrets.some(Boolean)) {
    log.error('[pms-inbox/commit] PMS_INBOX_WEBHOOK_SECRET unset — refusing', { requestId });
    return new NextResponse('inbox not configured', { status: 503 });
  }
  if (!constantTimeBearerMatch(req.headers.get('authorization'), secrets)) {
    log.warn('[pms-inbox/commit] bad or absent bearer secret', { requestId });
    return new NextResponse('unauthorized', { status: 401 });
  }

  // ── 2. Body ──────────────────────────────────────────────────────────────
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return new NextResponse('bad_request', { status: 400 });
  }
  if (raw.length > MAX_BODY_BYTES) {
    return ok({ committed: 0, reason: 'too_large' }, { requestId });
  }
  let body: CommitBody;
  try {
    body = JSON.parse(raw) as CommitBody;
  } catch {
    return new NextResponse('bad_request', { status: 400 });
  }

  const messageId = typeof body.messageId === 'string' ? body.messageId.trim() : '';
  const hashes = (Array.isArray(body.sha256) ? body.sha256 : [])
    .filter(isSha256Hex)
    .slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
  if (!messageId || hashes.length === 0) {
    return ok({ committed: 0, reason: 'nothing_to_commit' }, { requestId });
  }

  // ── 3. Resolve the property from the delivery we already accepted. The
  // Worker never names a property — it can only point at a message this server
  // stored, so a forged commit can't reach a hotel we didn't already admit.
  const { data: msg, error: msgErr } = await supabaseAdmin
    .from('pms_inbox_messages')
    .select('id, property_id, report_file_id')
    .eq('message_id', messageId)
    .eq('kind', 'report')
    .maybeSingle();
  if (msgErr) {
    log.error('[pms-inbox/commit] message lookup failed', { requestId, err: msgErr.message });
    return new NextResponse('server_error', { status: 500 });
  }
  if (!msg) {
    log.warn('[pms-inbox/commit] unknown message', { requestId });
    return ok({ committed: 0, reason: 'unknown_message' }, { requestId });
  }
  const propertyId = msg.property_id as string;

  const rl = await checkAndIncrementRateLimit('pms-report-inbound', propertyId);
  if (!rl.allowed) {
    return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
  }

  // ── 4. Verify + flip each hash ───────────────────────────────────────────
  const results: Array<{ sha256: string; outcome: CommitOutcome }> = [];
  let firstCommittedId: string | null = null;

  for (const sha256 of hashes) {
    const { data: file, error: fileErr } = await supabaseAdmin
      .from('pms_report_files')
      .select('id, status, storage_path, byte_size, sender_approved')
      .eq('property_id', propertyId)
      .eq('content_sha256', sha256)
      .maybeSingle();
    if (fileErr) {
      log.error('[pms-inbox/commit] ledger lookup failed', { requestId, propertyId, err: fileErr.message });
      results.push({ sha256, outcome: 'unknown' });
      continue;
    }
    if (!file) {
      results.push({ sha256, outcome: 'unknown' });
      continue;
    }
    if (file.status !== 'pending_upload') {
      results.push({ sha256, outcome: 'already_committed' });
      continue;
    }

    const parts = file.storage_path ? splitObjectPath(String(file.storage_path)) : null;
    if (!parts) {
      results.push({ sha256, outcome: 'missing_object' });
      continue;
    }

    // supabase-js storage has no HEAD; list() on the prefix is the supported
    // way to read an object's size without downloading it.
    const { data: listed, error: listErr } = await supabaseAdmin.storage
      .from(PMS_RAW_BUCKET)
      .list(parts.prefix, { search: parts.name, limit: 100 });
    if (listErr) {
      log.error('[pms-inbox/commit] storage list failed', { requestId, propertyId, err: listErr.message });
      results.push({ sha256, outcome: 'unknown' });
      continue;
    }
    const object = (listed ?? []).find((o) => o.name === parts.name);
    if (!object) {
      // Bytes never landed. Leave the row 'pending_upload' — the hourly sweep
      // marks it failed, which is a visible row rather than a silent loss.
      results.push({ sha256, outcome: 'missing_object' });
      continue;
    }
    const actualSize = Number((object.metadata as { size?: unknown } | null)?.size ?? NaN);
    if (!Number.isFinite(actualSize) || actualSize !== Number(file.byte_size)) {
      log.warn('[pms-inbox/commit] byte size mismatch', {
        requestId, propertyId, expected: Number(file.byte_size), actual: actualSize,
      });
      results.push({ sha256, outcome: 'size_mismatch' });
      continue;
    }

    // Sender approval decides the terminal state. Both are "bytes are safe at
    // rest"; only 'stored' is eligible to be parsed, and the DB CHECK
    // (status <> 'parsed' or sender_approved) makes that structural.
    const nextStatus: CommitOutcome = file.sender_approved ? 'stored' : 'blocked_unapproved_sender';
    const { error: updErr } = await supabaseAdmin
      .from('pms_report_files')
      .update({ status: nextStatus, last_error: null })
      .eq('id', file.id)
      .eq('status', 'pending_upload');
    if (updErr) {
      log.error('[pms-inbox/commit] status flip failed', { requestId, propertyId, err: updErr.message });
      results.push({ sha256, outcome: 'unknown' });
      continue;
    }
    if (!firstCommittedId) firstCommittedId = file.id as string;
    results.push({ sha256, outcome: nextStatus });
  }

  // Link the delivery to a file so the admin viewer can jump between them.
  if (firstCommittedId && !msg.report_file_id) {
    const { error: linkErr } = await supabaseAdmin
      .from('pms_inbox_messages')
      .update({ report_file_id: firstCommittedId })
      .eq('id', msg.id);
    if (linkErr) {
      log.warn('[pms-inbox/commit] message link failed (non-fatal)', { requestId, err: linkErr.message });
    }
  }

  const committed = results.filter((r) => r.outcome === 'stored' || r.outcome === 'blocked_unapproved_sender').length;
  log.info('[pms-inbox/commit] done', {
    requestId,
    propertyId,
    claimed: hashes.length,
    committed,
  });

  return ok({ committed, results }, { requestId });
}
