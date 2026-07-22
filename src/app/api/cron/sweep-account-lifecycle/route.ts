import { NextRequest } from 'next/server';

import { processAccountLifecycleIntent } from '@/lib/account-lifecycle';
import { requireCronSecret } from '@/lib/api-auth';
import { err, ok, ApiErrorCode } from '@/lib/api-response';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import { getOrMintRequestId, log } from '@/lib/log';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const STALE_AFTER_MS = 2 * 60 * 1000;
const BATCH_LIMIT = 25;
const CONCURRENCY = 5;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const cronGate = requireCronSecret(req);
  if (cronGate) return cronGate;

  const cutoff = new Date(Date.now() - STALE_AFTER_MS).toISOString();
  const { data, error: queryError } = await supabaseAdmin
    .from('account_lifecycle_intents')
    .select('operation_id')
    .eq('status', 'pending')
    .lte('updated_at', cutoff)
    .order('updated_at', { ascending: true })
    .order('operation_id', { ascending: true })
    .limit(BATCH_LIMIT);

  if (queryError) {
    log.error('[sweep-account-lifecycle] pending query failed', {
      requestId,
      msg: errToString(queryError),
    });
    return err('Account lifecycle sweep unavailable', {
      requestId,
      status: 503,
      code: ApiErrorCode.UpstreamFailure,
      headers: { 'Retry-After': '60' },
    });
  }

  const operationIds = (data ?? [])
    .map((row) => row.operation_id)
    .filter((value): value is string => typeof value === 'string');
  const counts = {
    selected: operationIds.length,
    committed: 0,
    aborted: 0,
    pending: 0,
    conflict: 0,
    notFound: 0,
  };

  for (let offset = 0; offset < operationIds.length; offset += CONCURRENCY) {
    const chunk = operationIds.slice(offset, offset + CONCURRENCY);
    const results = await Promise.all(chunk.map((operationId) => (
      processAccountLifecycleIntent({
        operationId,
        requestId: `${requestId}:${operationId}`,
        source: 'cron',
      })
    )));
    for (const result of results) {
      if (result.kind === 'committed') counts.committed += 1;
      else if (result.kind === 'aborted') counts.aborted += 1;
      else if (result.kind === 'pending') counts.pending += 1;
      else if (result.kind === 'conflict') counts.conflict += 1;
      else counts.notFound += 1;
    }
  }

  await writeCronHeartbeat('sweep-account-lifecycle', {
    requestId,
    notes: { ...counts, cutoff },
  });
  return ok({ ...counts, cutoff, batchLimit: BATCH_LIMIT }, { requestId });
}
