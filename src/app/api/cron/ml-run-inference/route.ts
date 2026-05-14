/**
 * GET /api/cron/ml-run-inference
 *
 * Daily cron at 05:30 CT — runs:
 *   1. /predict/demand on the ML service for tomorrow
 *   2. /predict/supply for tomorrow
 *   3. /predict/optimizer (Layer 3 Monte Carlo over L1+L2)
 *
 * Sequenced because L3 needs L1 + L2 outputs already written. Uses
 * AbortSignal.timeout so a stuck ML service doesn't hang Vercel for
 * 5 minutes.
 *
 * Why 05:30 CT: matches the post-CSV-pull window (5am hourly pulls land
 * tomorrow's plan_snapshot row). Earlier = no data; later = Maria's
 * morning planning has already happened.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCronSecret } from '@/lib/api-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { runWithConcurrency, applyShardFilter } from '@/lib/parallel';
import { listMlShardUrls, resolveMlShardUrl } from '@/lib/ml-routing';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import {
  emitPropertyMisconfiguredEvent,
  parsePropertyMisconfiguredError,
} from '@/lib/ml-misconfigured-events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Bumped from 60 (Hobby cap) to 300 (Pro cap) — we're on Pro and other
// cron routes already use 90. At fleet scale, three sequential stages
// per property × ~5s ML latency × concurrency 3 = ~250s wall-clock at
// 50 hotels. shard_count param below splits past that threshold.
export const maxDuration = 300;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = getOrMintRequestId(req);
  const unauth = requireCronSecret(req);
  if (unauth) return unauth;

  const shardUrls = listMlShardUrls();
  const mlServiceSecret = process.env.ML_SERVICE_SECRET;
  if (shardUrls.length === 0 || !mlServiceSecret) {
    log.warn('ml-run-inference: ML service not configured — skipping', { requestId });
    return NextResponse.json({ ok: true, skipped: 'ML service not configured yet', requestId });
  }

  // Pull `timezone` along with id so each property's "tomorrow" is computed
  // against its own local clock — a Florida hotel on America/New_York must
  // not predict a Texas-timed date.
  const { data: properties, error } = await supabaseAdmin
    .from('properties')
    .select('id, name, timezone')
    .order('id');  // stable order so sharding is deterministic across calls
  if (error) {
    return NextResponse.json({ ok: false, error: errToString(error) }, { status: 500 });
  }

  // Shard filter: workflow can dispatch N parallel jobs with
  // ?shard_offset=K&shard_count=N to split the fanout. Defaults to no
  // sharding (this instance handles every property).
  const url = new URL(req.url);
  const sharded = applyShardFilter(properties ?? [], url.searchParams);
  const propertiesForThisShard = sharded.items;
  log.info('ml-run-inference: start', { requestId, shardHeader: sharded.header });

  const tomorrowInTz = (tz: string): string => {
    // Compute tomorrow as YYYY-MM-DD in the given IANA TZ.
    const todayLocal = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
    const tomorrow = new Date(todayLocal + 'T12:00:00Z');
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    return tomorrow.toISOString().slice(0, 10);
  };

  const callStage = async (
    stage: 'demand' | 'supply' | 'optimizer',
    propertyId: string,
    propertyTz: string,
    targetDate: string,
  ) => {
    const path = stage === 'optimizer' ? '/predict/optimizer' : `/predict/${stage}`;
    // resolveMlShardUrl per property — all three stages for one property
    // pin to the same shard (deterministic hash on property_id), so the
    // optimizer's read of demand+supply rows lands on the shard that
    // just wrote them. Single-shard deploys keep ML_SERVICE_URL.
    const mlServiceUrl = resolveMlShardUrl(propertyId)!;
    const t0 = Date.now();
    try {
      const res = await fetch(`${mlServiceUrl.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${mlServiceSecret}`,
          'Content-Type': 'application/json',
          'x-request-id': requestId,
        },
        // Pass both the computed date AND the property's tz — the date is
        // authoritative for the prediction key, the tz is belt-and-suspenders
        // so the ML service's own date fallback uses the same zone.
        body: JSON.stringify({ property_id: propertyId, date: targetDate, property_timezone: propertyTz }),
        signal: AbortSignal.timeout(45_000),
      });
      const json = await res.json().catch(() => ({ status: 'non_json_response', http: res.status }));
      log.info('ml-run-inference: stage complete', {
        requestId, stage, property_id: propertyId, elapsedMs: Date.now() - t0,
        mlStatus: (json as { status?: string }).status ?? 'unknown',
      });

      // Codex adversarial review 2026-05-13 (#2): the ML service signals
      // misconfigured properties via {error: 'property_misconfigured: ...'},
      // not via a status field. Without this branch, those responses
      // were getting mapped to status: 'unknown' — the heartbeat-degraded
      // logic missed them and no app_events row was ever written.
      const errStr = (json as { error?: string }).error;
      if (typeof errStr === 'string' && errStr.startsWith('property_misconfigured:')) {
        const parsed = parsePropertyMisconfiguredError(errStr);
        if (parsed) {
          await emitPropertyMisconfiguredEvent({
            requestId,
            propertyId,
            layer: stage,
            field: parsed.field,
            originalField: parsed.originalField,
            value: parsed.value,
          });
        }
        return { stage, status: 'skipped', detail: errStr };
      }
      // Non-misconfiguration errors stay as errors so the cron heartbeat
      // refuses to write OK.
      if (typeof errStr === 'string' || !res.ok) {
        return {
          stage,
          status: 'error',
          detail: errStr ?? (json as { http?: number }).http ?? `HTTP ${res.status}`,
        };
      }

      return { stage, status: (json as { status?: string }).status ?? 'unknown', detail: json };
    } catch (err) {
      log.error('ml-run-inference: stage failed', { requestId, stage, property_id: propertyId, err: err as Error });
      return { stage, status: 'error', detail: errToString(err) };
    }
  };

  // Inter-property: parallel (concurrency 3 — Layer-3 optimizer is the most
  // memory-heavy stage and runs Monte Carlo simulation on Railway).
  // Intra-property: still sequential — optimizer depends on demand+supply
  // outputs being already written.
  const outcomes = await runWithConcurrency(propertiesForThisShard, async (property) => {
    // Codex adversarial review 2026-05-13 (#1): the prior code did
    //   const propertyTz = property.timezone ?? 'America/Chicago';
    // which silently bypassed the Phase 3.5 PropertyMisconfiguredError
    // validator on the ML service. Any non-Texas hotel with a missing
    // timezone got predictions for the WRONG operational date. Now we
    // skip the property at the TS boundary, emit a structured event,
    // and let the heartbeat status flip to 'degraded' (Phase 3.4) so
    // the doctor surfaces it.
    if (!property.timezone) {
      log.warn('ml-run-inference: property missing timezone — skip', {
        requestId, property_id: property.id, property_name: property.name,
      });
      await emitPropertyMisconfiguredEvent({
        requestId,
        propertyId: property.id,
        layer: 'orchestrator',
        field: 'timezone',
        value: null,
      });
      const skip = (stage: 'demand' | 'supply' | 'optimizer') => ({
        stage,
        status: 'skipped' as const,
        detail: 'property_misconfigured: timezone is null',
      });
      return {
        target_date: null,
        demand: skip('demand'),
        supply: skip('supply'),
        optimizer: skip('optimizer'),
      };
    }
    const propertyTz = property.timezone as string;
    const targetDate = tomorrowInTz(propertyTz);
    const demandResult    = await callStage('demand',    property.id, propertyTz, targetDate);
    const supplyResult    = await callStage('supply',    property.id, propertyTz, targetDate);
    // Phase M3.1 (2026-05-14): optimizer un-paused. Triggered by
    // ScheduleTab.tsx's new "Tomorrow's confidence" panel which reads
    // optimizer_results via getActiveOptimizerForTomorrow. The optimizer
    // depends on demand_predictions (required) and supply_predictions
    // (optional, falls back to uniform distribution) — both now exist for
    // any property with a cold-start model after M3.1's NameError +
    // AttributeError fixes ship.
    const optimizerResult = await callStage('optimizer', property.id, propertyTz, targetDate);
    return { target_date: targetDate, demand: demandResult, supply: supplyResult, optimizer: optimizerResult };
  }, 3);

  const results = outcomes.map((o) => {
    if (o.ok) {
      return {
        property_id: o.input.id,
        target_date: o.value.target_date,
        demand: o.value.demand,
        supply: o.value.supply,
        optimizer: o.value.optimizer,
      };
    }
    log.error('ml-run-inference: property loop failed', {
      requestId, property_id: o.input.id, err: o.error as Error,
    });
    return {
      property_id: o.input.id,
      target_date: null,
      demand: { stage: 'demand', status: 'error', detail: errToString(o.error) },
      supply: null,
      optimizer: null,
    };
  });

  const anyStageError = results.some((r) =>
    r.demand?.status === 'error' ||
    r.supply?.status === 'error' ||
    r.optimizer?.status === 'error',
  );
  // Phase 3.4 (2026-05-13): mark the heartbeat 'degraded' when any stage
  // returned 'skipped'. Codex follow-up 2026-05-13 (B4): the optimizer
  // is hardcoded `status: 'skipped'` because it's paused — that means
  // anyStageSkipped was always true and the heartbeat was permanently
  // degraded, making the signal useless. Filter the optimizer's paused
  // skip out so 'degraded' fires only on demand/supply skips (real
  // misconfigured properties or actual ML-service problems). When the
  // optimizer is unpaused, this filter needs to come back out — the
  // test below pins the optimizer-only case as 'ok' to make the
  // requirement obvious.
  const stageIsRealSkip = (r: typeof results[number]): boolean => (
    r.demand?.status === 'skipped' ||
    r.supply?.status === 'skipped'
    // optimizer.status === 'skipped' is currently always true (paused);
    // re-enable the optimizer check when the cron is unpaused.
  );
  const anyStageSkipped = results.some(stageIsRealSkip);
  const propertiesSkipped = results.filter(stageIsRealSkip).length;
  if (!anyStageError) {
    await writeCronHeartbeat('ml-run-inference', {
      requestId,
      status: anyStageSkipped ? 'degraded' : 'ok',
      notes: {
        properties_processed: results.length,
        properties_skipped: propertiesSkipped,
      },
    });
  }
  // Outer ok reflects inner state — see ml-train-demand for full notes.
  return NextResponse.json(
    { ok: !anyStageError, requestId, results },
    { status: anyStageError ? 502 : 200 },
  );
}
