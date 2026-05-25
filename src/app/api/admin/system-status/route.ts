/**
 * GET /api/admin/system-status
 *
 * Lightweight, glance-level live status for every cross-service boundary
 * Staxis depends on. Distinct from /api/admin/doctor (60s, 49 checks, deep
 * diagnostic) — this endpoint runs in <10s with one cheap check per
 * downstream and is intended for client-side polling from the System tab.
 *
 * Phase E2E (2026-05-22).
 *
 * Auth: requireAdminOrCron. The SystemTab fetches with admin session
 * (fetchWithAuth), but watchdog scripts can also poll with CRON_SECRET.
 * CRON_SECRET-only is forbidden on /api/admin/* by Pattern C
 * (src/lib/__tests__/admin-routes-auth-gate.test.ts) so we use the
 * combined helper. Same pattern the doctor route uses.
 *
 * Checks (all parallel, 5s per-check timeout, fail-soft via allSettled):
 *   - web              — trivially green (we're responding)
 *   - ml_service       — GET /health on every shard in ML_SERVICE_URLS
 *   - cua_worker       — onboarding_jobs queue freshness (no HTTP to CUA — see Codex review)
 *   - supabase         — read 1 row from `accounts` (catches PostgREST schema-cache-stale, which SELECT 1 wouldn't)
 *
 * Response shape (NEVER bare 5xx — always 200 with per-service status):
 *   { ok, requestId, generated_at, services: { web: {...}, ml: {...}, ... } }
 *
 * Each service entry: { status: 'green'|'yellow'|'red', latency_ms?, message? }
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdminOrCron } from '@/lib/admin-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { listMlShardUrls } from '@/lib/ml-routing';
import { getOrMintRequestId, log } from '@/lib/log';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

const PER_CHECK_TIMEOUT_MS = 5_000;

export type ServiceColor = 'green' | 'yellow' | 'red';

export interface ServiceStatus {
  status: ServiceColor;
  latency_ms?: number;
  message?: string;
}

export interface SystemStatusResponse {
  ok: boolean;
  requestId: string;
  generated_at: string;
  services: {
    web: ServiceStatus;
    ml: ServiceStatus;
    cua: ServiceStatus;
    supabase: ServiceStatus;
  };
}

async function pingHttp(url: string, timeoutMs: number): Promise<{ ok: boolean; status: number; latencyMs: number; error?: string }> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { ok: res.ok, status: res.status, latencyMs: Date.now() - t0 };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      latencyMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkMl(): Promise<ServiceStatus> {
  const shards = listMlShardUrls();
  if (shards.length === 0) {
    return { status: 'yellow', message: 'ML_SERVICE_URLS not configured' };
  }
  const results = await Promise.all(
    shards.map((shard) =>
      pingHttp(`${shard.replace(/\/$/, '')}/health`, PER_CHECK_TIMEOUT_MS),
    ),
  );
  const anyRed = results.some((r) => !r.ok);
  const allRed = results.every((r) => !r.ok);
  const maxLatency = Math.max(...results.map((r) => r.latencyMs));
  if (allRed) {
    return {
      status: 'red',
      latency_ms: maxLatency,
      message: `All ${shards.length} ML shard(s) unreachable.`,
    };
  }
  if (anyRed) {
    const downCount = results.filter((r) => !r.ok).length;
    return {
      status: 'yellow',
      latency_ms: maxLatency,
      message: `${downCount}/${shards.length} ML shard(s) unhealthy.`,
    };
  }
  return {
    status: 'green',
    latency_ms: maxLatency,
    message: `All ${shards.length} ML shard(s) healthy.`,
  };
}

async function checkCua(): Promise<ServiceStatus> {
  const t0 = Date.now();
  // Queue freshness signal: oldest 'queued' job. CUA polls every 5s
  // (POLL_INTERVAL_MS in cua-service/fly.toml). >5 min unprocessed = yellow;
  // >30 min = red. This matches the policy in the master plan rather than
  // adding HTTP to the Fly worker (which Codex review flagged as CRITICAL).
  const { data, error } = await supabaseAdmin
    .from('onboarding_jobs')
    .select('created_at')
    .eq('status', 'queued')
    .order('created_at', { ascending: true })
    .limit(1);
  const latency = Date.now() - t0;
  if (error) {
    return {
      status: 'red',
      latency_ms: latency,
      message: `Supabase read failed: ${error.message}`,
    };
  }
  if (!data || data.length === 0) {
    return {
      status: 'green',
      latency_ms: latency,
      message: 'No queued jobs — CUA caught up.',
    };
  }
  const rawCreatedAt = data[0].created_at as unknown;
  const parsedMs = typeof rawCreatedAt === 'string' ? Date.parse(rawCreatedAt) : NaN;
  if (!Number.isFinite(parsedMs)) {
    return {
      status: 'green',
      latency_ms: latency,
      message: 'Queued job present but timestamp unreadable.',
    };
  }
  const oldest = new Date(parsedMs);
  const ageMin = Math.floor((Date.now() - oldest.getTime()) / 60_000);
  if (ageMin > 30) {
    return {
      status: 'red',
      latency_ms: latency,
      message: `Oldest queued job is ${ageMin} min old — CUA worker likely stuck.`,
    };
  }
  if (ageMin > 5) {
    return {
      status: 'yellow',
      latency_ms: latency,
      message: `Oldest queued job is ${ageMin} min old.`,
    };
  }
  return {
    status: 'green',
    latency_ms: latency,
    message: `Queue draining (oldest ${ageMin} min).`,
  };
}

// (Plan v4 cleanup: checkScraperHeartbeat + checkScraperOnDemand were
// dropped — they read scraper_status / pinged Railway, both gone post-v4.
// The CUA worker on Fly is the replacement; checkCua above covers it.)
async function checkSupabase(): Promise<ServiceStatus> {
  // Read 1 row from a real application table (`accounts`) rather than
  // SELECT 1, so the check catches PostgREST's schema-cache-stale failure
  // mode that CLAUDE.md explicitly documents as #1 most-recurring bug.
  // SELECT 1 would stay green even when the cache lags after a DDL.
  const t0 = Date.now();
  try {
    const { error } = await supabaseAdmin
      .from('accounts')
      .select('id', { count: 'exact', head: true })
      .limit(1);
    const latency = Date.now() - t0;
    if (error) {
      return {
        status: 'red',
        latency_ms: latency,
        message: `PostgREST error: ${error.message}`,
      };
    }
    return {
      status: 'green',
      latency_ms: latency,
      message: 'Schema cache fresh, accounts table reachable.',
    };
  } catch (err) {
    return {
      status: 'red',
      latency_ms: Date.now() - t0,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdminOrCron(req);
  if (!auth.ok) return auth.response;

  // Fail-soft across all checks via allSettled. A single broken check
  // (e.g. Supabase down) must not 5xx the whole endpoint — the panel
  // needs to render the other services even when one is on fire.
  const settled = await Promise.allSettled([
    checkMl(),
    checkCua(),
    checkSupabase(),
  ]);

  const fallback = (i: number): ServiceStatus => {
    const s = settled[i];
    if (s.status === 'fulfilled') return s.value;
    return {
      status: 'red',
      message: s.reason instanceof Error ? s.reason.message : String(s.reason),
    };
  };

  const services: SystemStatusResponse['services'] = {
    web: { status: 'green', message: 'Web app responding.' },
    ml: fallback(0),
    cua: fallback(1),
    supabase: fallback(2),
  };

  const anyRed = Object.values(services).some((s) => s.status === 'red');

  const body: SystemStatusResponse = {
    ok: !anyRed,
    requestId,
    generated_at: new Date().toISOString(),
    services,
  };

  log.info('system-status: served', {
    requestId,
    anyRed,
    ml: services.ml.status,
    cua: services.cua.status,
    supabase: services.supabase.status,
  });

  return NextResponse.json(body);
}
