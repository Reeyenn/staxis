/**
 * POST /api/housekeeper/offline-replay
 *
 * When the housekeeper's phone comes back online, the service worker
 * forwards each queued action one at a time to its original endpoint with
 * the recorded body. THIS endpoint is the fallback / health-check probe:
 * the client POSTs a one-shot ping with the count of items it's about to
 * replay so we can log telemetry on how often offline mode kicks in.
 *
 * It does NOT replay actions itself — that responsibility stays on the
 * service worker, which calls each original endpoint with the queued
 * body and the action_id. The mutating endpoints (start-clean, done,
 * pause, exception, structured-issue, add-note, mark-for-inspection,
 * notice-dismiss) all check offline_action_replays(action_id) and skip
 * the side effect if they've already processed it.
 */

import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log } from '@/lib/log';
import { gateHousekeeperRequest } from '@/lib/housekeeper-workflow/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 5;

interface Body {
  pid?: string;
  staffId?: string;
  queuedCount?: number;
  offlineDurationMs?: number;
}

export async function POST(req: NextRequest): Promise<Response> {
  const gate = await gateHousekeeperRequest<Body>(req, 'housekeeper-offline-replay');
  if (!gate.ok) return gate.response;
  const body = gate.body;
  const queuedCount = Number.isFinite(Number(body.queuedCount))
    ? Math.max(0, Math.min(1000, Number(body.queuedCount)))
    : 0;
  const offlineMs = Number.isFinite(Number(body.offlineDurationMs))
    ? Math.max(0, Number(body.offlineDurationMs))
    : 0;

  if (queuedCount > 0) {
    log.info('offline-replay: housekeeper queue draining', {
      requestId: gate.requestId,
      pid: gate.pid,
      staffId: gate.staffId,
      queuedCount,
      offlineMs,
    });
  }

  if (!Number.isFinite(queuedCount)) {
    return err('invalid queuedCount', {
      requestId: gate.requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
      headers: gate.headers,
    });
  }

  return ok(
    { ack: true, queuedCount, offlineMs },
    { requestId: gate.requestId, headers: gate.headers },
  );
}
