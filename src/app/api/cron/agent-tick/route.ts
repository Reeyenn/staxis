/**
 * GET /api/cron/agent-tick
 *
 * Schedule trigger for the Agent Builder. Every 5 min (Vercel). For each
 * active schedule-triggered agent that is DUE in its property's local time,
 * run it once (mode:live, scheduled). One UTC tick serves every timezone —
 * the per-agent local-time + per-day idempotency gate (an EXISTS over today's
 * runs, backed by the scheduled-live unique index) does the rest.
 *
 * Also: a REAPER (stranded 'running' runs older than 10 min → 'failed' + frees
 * the day's slot for a bounded retry) and a 90-day inputs_snapshot retention
 * sweep. Folded in here to avoid a second cron registry entry.
 *
 * Auth: Bearer ${CRON_SECRET}.
 */

import { NextRequest } from 'next/server';
import { requireCronSecret } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { env } from '@/lib/env';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import { agentRepo } from '@/lib/db/agents';
import { runAgent, isAgentDue, todayInTz, localHHMM, localDow, STALE_RUN_MS } from '@/lib/agents/engine';
import type { ScheduleTriggerConfig } from '@/lib/agents/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_RUNS_PER_TICK = 50; // remainder is safely deferred to the next tick by the due-check
const SNAPSHOT_RETENTION_DAYS = 90;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const gate = requireCronSecret(req);
  if (gate) return gate;

  if (env.AGENTS_ENABLED === 'false') {
    await writeCronHeartbeat('agent-tick', { requestId, notes: { disabled: true } });
    return ok({ disabled: true }, { requestId });
  }

  const now = Date.now();
  let reaped = 0;
  let purged = 0;
  let due = 0;
  let ran = 0;
  let errors = 0;

  try {
    reaped = await agentRepo.reapStaleRuns(new Date(now - STALE_RUN_MS).toISOString());
  } catch (e) {
    log.warn('agent-tick: reaper failed', { requestId, msg: errToString(e) });
  }
  const retentionCutoff = new Date(now - SNAPSHOT_RETENTION_DAYS * 86_400_000).toISOString();
  try {
    purged = await agentRepo.purgeOldSnapshots(retentionCutoff);
  } catch (e) {
    log.warn('agent-tick: snapshot purge failed', { requestId, msg: errToString(e) });
  }
  try {
    await agentRepo.purgeOldActionPii(retentionCutoff);
  } catch (e) {
    log.warn('agent-tick: action PII purge failed', { requestId, msg: errToString(e) });
  }

  try {
    const agents = await agentRepo.listActiveScheduleAgents();

    const pids = Array.from(new Set(agents.map((a) => a.propertyId)));
    const tzMap = new Map<string, string | null>();
    if (pids.length > 0) {
      const { data } = await supabaseAdmin.from('properties').select('id, timezone').in('id', pids);
      for (const p of (data ?? []) as Array<{ id: string; timezone: string | null }>) tzMap.set(p.id, p.timezone);
    }

    for (const a of agents) {
      if (ran >= MAX_RUNS_PER_TICK) break;
      if (a.config.trigger.type !== 'schedule') continue;
      const trigger = a.config.trigger as ScheduleTriggerConfig;
      const tz = tzMap.get(a.propertyId) ?? null;
      const today = todayInTz(tz, now);
      const hhmm = localHHMM(tz, now);
      const dow = localDow(tz, now);

      let statuses;
      try {
        statuses = await agentRepo.runStatusesForAgentOnDate(a.id, today);
      } catch (e) {
        errors += 1;
        log.warn('agent-tick: due-check failed', { agentId: a.id, msg: errToString(e) });
        continue;
      }
      if (!isAgentDue(trigger, statuses, hhmm, dow)) continue;

      due += 1;
      try {
        const out = await runAgent(a.id, { mode: 'live', triggerSource: 'scheduled' });
        if (out.runId) ran += 1;
      } catch (e) {
        errors += 1;
        log.warn('agent-tick: run failed', { agentId: a.id, msg: errToString(e) });
      }
    }
  } catch (e) {
    log.error('agent-tick: unexpected error', { requestId, msg: errToString(e) });
    await writeCronHeartbeat('agent-tick', {
      requestId,
      status: 'degraded',
      notes: { reaped, purged, due, ran, errors, error: errToString(e) },
    });
    return err('agent-tick failed', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }

  await writeCronHeartbeat('agent-tick', {
    requestId,
    status: errors > 0 ? 'degraded' : 'ok',
    notes: { reaped, purged, due, ran, errors },
  });
  return ok({ reaped, purged, due, ran, errors }, { requestId });
}
