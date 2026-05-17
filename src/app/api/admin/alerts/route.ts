/**
 * GET /api/admin/alerts
 *
 * "What needs Reeyen's attention right now?" — aggregator that returns
 * a flat list of red/amber flags across the fleet:
 *
 *   - HOTEL_PMS_DISCONNECTED  — live hotel whose PMS isn't connected
 *   - HOTEL_STALE_SYNC        — live hotel hasn't synced in 12h+
 *   - HOTEL_PAST_DUE          — Stripe subscription is past_due
 *   - JOB_FAILED              — onboarding_job failed in last 24h
 *   - ERROR_SPIKE             — 20+ same-message errors in last hour
 *
 * Powers the bell-icon dropdown in the admin sticky header.
 *
 * Severity ordering: red first (active customer impact), then amber
 * (gets-eyes-soon), then green ("hey nice"). Returned newest first
 * within severity.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log, getOrMintRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

const STALE_THRESHOLD_MS = 12 * 60 * 60 * 1000;
const ERROR_SPIKE_WINDOW_MS = 60 * 60 * 1000;
const ERROR_SPIKE_COUNT = 20;

type AlertKind =
  | 'HOTEL_PMS_DISCONNECTED'
  | 'HOTEL_STALE_SYNC'
  | 'HOTEL_PAST_DUE'
  | 'JOB_FAILED'
  | 'ERROR_SPIKE';

interface Alert {
  kind: AlertKind;
  severity: 'red' | 'amber';
  title: string;
  detail: string;
  propertyId: string | null;
  href: string | null;
  ts: string; // ISO — when the underlying signal first triggered
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const now = Date.now();
  const dayAgoIso = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const hourAgoIso = new Date(now - ERROR_SPIKE_WINDOW_MS).toISOString();

  const [propsRes, jobsRes, errorsRes] = await Promise.all([
    supabaseAdmin
      .from('properties')
      .select('id, name, subscription_status, pms_connected, last_synced_at')
      .or('subscription_status.eq.active,subscription_status.eq.past_due'),
    supabaseAdmin
      .from('onboarding_jobs')
      .select('id, property_id, pms_type, error, created_at')
      .eq('status', 'failed')
      .gte('created_at', dayAgoIso)
      .order('created_at', { ascending: false })
      .limit(50),
    supabaseAdmin
      .from('error_logs')
      .select('source, message, ts')
      .gte('ts', hourAgoIso)
      .limit(2000),
  ]);

  for (const r of [propsRes, jobsRes, errorsRes]) {
    if (r.error) {
      log.error('alerts query failed', { err: r.error, requestId });
      return err('alerts query failed', { requestId, status: 500, code: ApiErrorCode.InternalError });
    }
  }

  const properties = (propsRes.data ?? []) as { id: string; name: string | null; subscription_status: string | null; pms_connected: boolean | null; last_synced_at: string | null }[];
  const failedJobs = (jobsRes.data ?? []) as { id: string; property_id: string; pms_type: string; error: string | null; created_at: string }[];
  const errorRows = (errorsRes.data ?? []) as { source: string | null; message: string | null; ts: string }[];

  // Build a name lookup so failed-job alerts can show the property name.
  const nameById = new Map(properties.map((p) => [p.id, p.name]));

  // Need names for ANY property surfaced in failed jobs, including those
  // not in the active/past_due slice — fetch separately if missing.
  const missingPropIds = failedJobs
    .map((j) => j.property_id)
    .filter((id) => !nameById.has(id));
  if (missingPropIds.length > 0) {
    const { data: extra } = await supabaseAdmin
      .from('properties')
      .select('id, name')
      .in('id', missingPropIds);
    for (const r of (extra ?? [])) {
      const row = r as { id: string; name: string | null };
      nameById.set(row.id, row.name);
    }
  }

  const alerts: Alert[] = [];

  // ── Hotel-level alerts ───────────────────────────────────────────────
  for (const p of properties) {
    const propHref = `/admin/properties/${p.id}`;
    const propName = p.name ?? '(unnamed hotel)';

    if (p.subscription_status === 'past_due') {
      alerts.push({
        kind: 'HOTEL_PAST_DUE',
        severity: 'red',
        title: `${propName} is past due`,
        detail: 'Stripe subscription needs attention before service is suspended.',
        propertyId: p.id,
        href: propHref,
        ts: new Date(now).toISOString(),
      });
    }

    if (p.subscription_status === 'active' && !p.pms_connected) {
      alerts.push({
        kind: 'HOTEL_PMS_DISCONNECTED',
        severity: 'amber',
        title: `${propName} has no PMS connected`,
        detail: 'Subscription is active but PMS credentials are missing — they\'re flying blind.',
        propertyId: p.id,
        href: propHref,
        ts: new Date(now).toISOString(),
      });
    }

    if (p.subscription_status === 'active' && p.pms_connected && p.last_synced_at) {
      const ageMs = now - Date.parse(p.last_synced_at);
      if (ageMs > STALE_THRESHOLD_MS) {
        const hours = Math.round(ageMs / (60 * 60 * 1000));
        alerts.push({
          kind: 'HOTEL_STALE_SYNC',
          severity: 'red',
          title: `${propName} hasn't synced in ${hours}h`,
          detail: 'Pull job may be stuck or PMS credentials may have expired.',
          propertyId: p.id,
          href: propHref,
          ts: p.last_synced_at,
        });
      }
    }
  }

  // ── Failed onboarding jobs (deduped: one alert per property) ─────────
  // failedJobs is already ordered newest-first by the query above. We
  // keep the most recent failure per property_id and tally how many
  // total failures hit that property in the window so the alert reads
  // like "3 failed onboardings for X — latest: …" instead of spamming
  // the dropdown with one row per attempt.
  const failuresByProperty = new Map<string, { latest: typeof failedJobs[number]; count: number }>();
  for (const j of failedJobs) {
    const existing = failuresByProperty.get(j.property_id);
    if (existing) existing.count += 1;
    else failuresByProperty.set(j.property_id, { latest: j, count: 1 });
  }
  for (const { latest, count } of failuresByProperty.values()) {
    const propName = nameById.get(latest.property_id) ?? '(deleted property)';
    const title = count > 1
      ? `${count} failed onboardings for ${propName}`
      : `Onboarding failed for ${propName}`;
    alerts.push({
      kind: 'JOB_FAILED',
      severity: 'red',
      title,
      detail: latest.error
        ? `${latest.pms_type}: ${latest.error.slice(0, 120)}`
        : `${latest.pms_type} (no error message recorded)`,
      propertyId: latest.property_id,
      href: `/admin/properties/${latest.property_id}`,
      ts: latest.created_at,
    });
  }

  // ── Error spikes (>20 of same message in last hour) ──────────────────
  const errorCounts = new Map<string, { source: string | null; message: string; count: number; latest: string }>();
  for (const e of errorRows) {
    const msg = (e.message ?? '').trim();
    const key = `${e.source ?? 'unknown'}::${msg}`;
    let entry = errorCounts.get(key);
    if (!entry) {
      entry = { source: e.source, message: msg, count: 0, latest: e.ts };
      errorCounts.set(key, entry);
    }
    entry.count += 1;
    if (e.ts > entry.latest) entry.latest = e.ts;
  }
  for (const e of errorCounts.values()) {
    if (e.count >= ERROR_SPIKE_COUNT) {
      alerts.push({
        kind: 'ERROR_SPIKE',
        severity: 'amber',
        title: `Error spike: ${e.count}× in the last hour`,
        detail: `${e.source ?? 'unknown'} — ${e.message.slice(0, 120)}`,
        propertyId: null,
        href: null,
        ts: e.latest,
      });
    }
  }

  // Sort: red first, then amber, then newest-first within bucket.
  alerts.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'red' ? -1 : 1;
    return Date.parse(b.ts) - Date.parse(a.ts);
  });

  const counts = {
    total: alerts.length,
    red: alerts.filter((a) => a.severity === 'red').length,
    amber: alerts.filter((a) => a.severity === 'amber').length,
  };

  return ok({ counts, alerts }, { requestId });
}
