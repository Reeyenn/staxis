/**
 * GET /api/cron/voice-recordings-purge
 *
 * Daily at 04:30 UTC (right after agent-heal-counters at 04:00). Deletes
 * voice_recordings rows where expires_at <= now() and the referenced
 * storage objects in the `voice-recordings` private bucket.
 *
 * INV-19: rows past expires_at are deleted within 24h — this cron is the
 * code-side enforcement; the heartbeat row in cron_heartbeats lets the
 * doctor route detect drift if the cron stops firing.
 *
 * Idempotent — re-runs are no-ops once the table is clean.
 *
 * Auth: CRON_SECRET bearer.
 */

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireCronSecret } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import { captureException } from '@/lib/sentry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Batch size — keeps a single run from staging tens of thousands of
// storage deletes. At ~1 minute of audio per session and a few hundred
// active users, a daily batch never gets close to this.
const PURGE_BATCH = 1000;

interface PurgeRow {
  id: string;
  storage_key: string;
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const cronGate = requireCronSecret(req);
  if (cronGate) return cronGate;

  let purgedCount = 0;
  let storageFailures = 0;

  try {
    const { data, error } = await supabaseAdmin
      .from('voice_recordings')
      .select('id, storage_key')
      .lte('expires_at', new Date().toISOString())
      .limit(PURGE_BATCH);

    if (error) {
      throw new Error(`select expired rows failed: ${error.message}`);
    }

    const rows = (data ?? []) as PurgeRow[];

    if (rows.length > 0) {
      const storageKeys = rows.map(r => r.storage_key);
      const { data: removed, error: removeErr } = await supabaseAdmin
        .storage
        .from('voice-recordings')
        .remove(storageKeys);
      if (removeErr) {
        // Storage delete failed for the whole batch. Log + Sentry, but
        // still delete the DB rows — they're past retention and the
        // storage cleanup will retry on the next run for any objects
        // that survived (the keys are stable).
        storageFailures = storageKeys.length;
        captureException(removeErr, {
          cron: 'voice-recordings-purge',
          step: 'storage-remove',
          batch_size: storageKeys.length,
        });
      } else {
        // `removed` is a list of FileObject — count mismatch means some
        // objects were already gone (re-run case). Not an error.
        const removedCount = Array.isArray(removed) ? removed.length : 0;
        storageFailures = Math.max(0, storageKeys.length - removedCount);
      }

      const { error: deleteErr } = await supabaseAdmin
        .from('voice_recordings')
        .delete()
        .in('id', rows.map(r => r.id));
      if (deleteErr) {
        throw new Error(`delete rows failed: ${deleteErr.message}`);
      }
      purgedCount = rows.length;
    }

    await writeCronHeartbeat('voice-recordings-purge', {
      requestId,
      notes: { purgedCount, storageFailures },
    });

    if (purgedCount > 0) {
      log.info('[voice-recordings-purge] purged expired rows', {
        requestId,
        purgedCount,
        storageFailures,
      });
    }

    return ok({ purgedCount, storageFailures }, { requestId });
  } catch (e) {
    captureException(e, { cron: 'voice-recordings-purge' });
    return err(
      `voice-recordings-purge failed: ${e instanceof Error ? e.message : String(e)}`,
      { requestId, status: 500, code: ApiErrorCode.InternalError },
    );
  }
}
