/**
 * /api/admin/mission/workers
 *
 * GET — the "background workers" section of Mission Control. Joins each
 * scheduled job's last heartbeat (cron_heartbeats) against the observational
 * job catalog so the owner can see, per worker: what it
 * does in plain English, how often it should run, when it last ran, and
 * whether it's on time.
 *
 * Auth + service-role reads use the same admin-or-cron boundary as the other
 * mission data routes:
 * requireAdminOrCron gate, supabaseAdmin only, envelope via ok()/err().
 *
 * "Late" is amber-only and never alerts — it means a heartbeat is older
 * than 2x the worker's cadence. Registry entries with no heartbeat row
 * yet are state 'never' (a worker that has been wired but hasn't fired).
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdminOrCron } from '@/lib/admin-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import {
  ACTIVE_MISSION_JOBS,
  cronCadenceHours,
  type JobMissionGroup,
  type JobMissionTier,
  type MissionMonitoredJobCatalogEntry,
} from '@/lib/automation/job-catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Buckets the UI groups rows under. Assigned server-side from the map
 *  below so a non-technical owner never has to guess a worker's domain. */
type WorkerGroup = JobMissionGroup;

type WorkerState = 'ok' | 'late' | 'never';

export type WorkerTier = JobMissionTier;

interface WorkerRow {
  name: string;
  /** Plain-English "what it does", read directly by the owner. */
  description: string;
  group: WorkerGroup;
  /** Owner's metric: 'ai' calls a thinking model; 'prediction' is classic ML
   *  math; 'timer' is a plain scheduled chore. */
  tier: JobMissionTier;
  /** Expected time between runs, in hours (derived from the cron string). */
  cadenceHours: number;
  /** ISO timestamp of the last successful run, or null if it never has. */
  lastBeatAt: string | null;
  /** Hours since the last run, or null when it has never run. */
  ageHours: number | null;
  state: WorkerState;
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdminOrCron(req);
  if (!auth.ok) return err('Admin sign-in required.', { requestId, status: 401, code: 'unauthorized' });

  // Collapse the monitored catalog by heartbeat name (a few names may have more than one
  // schedule entry). Keep first-seen order for a stable list; take the
  // TIGHTEST cadence across entries so a worker that fires twice a day is
  // judged against its most-frequent slot.
  const byName = new Map<string, { cadenceHours: number; job: MissionMonitoredJobCatalogEntry }>();
  for (const job of ACTIVE_MISSION_JOBS) {
    const cadence = cronCadenceHours(job.schedule);
    const existing = byName.get(job.heartbeat.name);
    if (!existing) byName.set(job.heartbeat.name, { cadenceHours: cadence, job });
    else existing.cadenceHours = Math.min(existing.cadenceHours, cadence);
  }

  const { data: beatRows, error: beatErr } = await supabaseAdmin
    .from('cron_heartbeats')
    .select('cron_name, last_success_at');
  if (beatErr) return err(beatErr.message, { requestId, status: 500, code: 'internal_error' });

  const lastBeatByName = new Map<string, string>();
  for (const r of (beatRows ?? []) as Array<{ cron_name: string; last_success_at: string }>) {
    lastBeatByName.set(r.cron_name, r.last_success_at);
  }

  const now = Date.now();
  const workers: WorkerRow[] = [];
  for (const [name, { cadenceHours, job }] of byName) {
    const lastBeatAt = lastBeatByName.get(name) ?? null;

    let ageHours: number | null = null;
    let state: WorkerState = 'never';
    if (lastBeatAt) {
      ageHours = Math.round(((now - new Date(lastBeatAt).getTime()) / 3_600_000) * 100) / 100;
      state = ageHours > cadenceHours * 2 ? 'late' : 'ok';
    }

    workers.push({
      name,
      description: job.mission.description,
      group: job.mission.group,
      tier: job.mission.tier,
      cadenceHours: Math.round(cadenceHours * 1000) / 1000,
      lastBeatAt,
      ageHours,
      state,
    });
  }

  return ok({ workers }, { requestId });
}
