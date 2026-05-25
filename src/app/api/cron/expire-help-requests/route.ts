/**
 * GET /api/cron/expire-help-requests
 *
 * Plan v8 hardening (Codex P1 #5) — runs every few minutes to:
 *   1. Flip mapping_help_requests rows past expires_at from 'pending'
 *      to 'expired' via the expire_stale_help_requests() SECURITY DEFINER
 *      function (migration 0214).
 *   2. Delete the corresponding screenshot objects from Supabase Storage
 *      so the mapping-screenshots bucket doesn't grow unbounded.
 *
 * At 300 hotels onboarding over months, unbounded growth of either the
 * help-request rows or the storage objects is a real cost + ops burden.
 *
 * Auth: CRON_SECRET bearer (matches every other cron route).
 *
 * Schedule: every 5 min via Vercel cron (vercel.json) — TTL on a row is
 * 15 min by default, so a 5-min sweep catches each one within one tick
 * of expiry.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireCronSecret } from '@/lib/api-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface ExpiredRow {
  id: string;
  screenshot_storage_path: string;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  // requireCronSecret returns null on success, a NextResponse on failure
  // (matches every other admin/cron route).
  const authErr = requireCronSecret(req);
  if (authErr) return authErr;

  // Step 1: flip pending rows past expires_at to 'expired'.
  // expire_stale_help_requests() returns (id, screenshot_storage_path) per row.
  const { data, error } = await supabaseAdmin.rpc('expire_stale_help_requests');
  if (error) {
    return err(`expire RPC failed: ${error.message}`, {
      requestId, status: 500, code: 'rpc_error',
    });
  }
  const rows = (data ?? []) as ExpiredRow[];

  // Step 2: delete each screenshot object from Storage. Best-effort —
  // a missing object is fine (idempotent re-runs would hit this).
  let storageDeleted = 0;
  let storageFailed = 0;
  if (rows.length > 0) {
    const paths = rows.map((r) => r.screenshot_storage_path).filter(Boolean);
    if (paths.length > 0) {
      const { error: storageErr } = await supabaseAdmin.storage
        .from('mapping-screenshots')
        .remove(paths);
      if (storageErr) {
        // Don't fail the cron — log + report. Next tick retries.
        storageFailed = paths.length;
      } else {
        storageDeleted = paths.length;
      }
    }
  }

  return ok({
    expired: rows.length,
    storageDeleted,
    storageFailed,
  }, { requestId });
}
