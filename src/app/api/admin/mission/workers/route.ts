/**
 * /api/admin/mission/workers
 *
 * GET — the "background workers" section of Mission Control. Joins each
 * scheduled job's last heartbeat (cron_heartbeats) against the schedule
 * registry (SCHEDULE_REGISTRY) so the owner can see, per worker: what it
 * does in plain English, how often it should run, when it last ran, and
 * whether it's on time.
 *
 * Auth + service-role reads mirror /api/admin/cua-sessions exactly:
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
import { SCHEDULE_REGISTRY } from '@/lib/cron-schedule-registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Buckets the UI groups rows under. Assigned server-side from the map
 *  below so a non-technical owner never has to guess a worker's domain. */
type WorkerGroup = 'Reports' | 'Cleanup' | 'ML' | 'Inventory' | 'Agent' | 'Other';

type WorkerState = 'ok' | 'late' | 'never';

interface WorkerRow {
  name: string;
  /** Plain-English "what it does", read directly by the owner. */
  description: string;
  group: WorkerGroup;
  /** Owner's metric: 'ai' calls a thinking model; 'prediction' is classic ML
   *  math; 'timer' is a plain scheduled chore. */
  tier: 'ai' | 'prediction' | 'timer';
  /** Expected time between runs, in hours (derived from the cron string). */
  cadenceHours: number;
  /** ISO timestamp of the last successful run, or null if it never has. */
  lastBeatAt: string | null;
  /** Hours since the last run, or null when it has never run. */
  ageHours: number | null;
  state: WorkerState;
}

/**
 * Plain-English label + group per heartbeat name. The schedule registry
 * carries only timing (it feeds drift tests), so the human-readable copy
 * lives here — the one place that turns worker names into something the
 * owner can read. Names not listed fall back to a humanized name + 'Other'
 * (a newly-wired cron shows up sensibly before it gets a line here).
 */

// ── Tier — the owner's metric: could this job have existed before thinking
// models were usable? 'ai' = its code path calls Claude/GPT (verified by
// import-tracing each cron on 2026-07-17); 'prediction' = classic ML math
// (learns from numbers, no language model); 'timer' = plain scheduled chore.
export type WorkerTier = 'ai' | 'prediction' | 'timer';
// (run-daily-report / run-weekly-report / run-scheduled-reports removed
// 2026-07-19 — owner cut the automatic report emails entirely.)
// (compliance-anomaly-sweep removed 2026-07-19 with the compliance section.)
const AI_TIER = new Set([
  'agent-consolidate-memory',
  'agent-summarize-long-conversations',
]);
const PREDICTION_TIER = new Set([
  'ml-aggregate-priors',
  'ml-predict-inventory',
  'ml-run-inference',
  'ml-train-demand',
  'ml-train-inventory',
  'ml-train-supply',
]);
function tierOf(name: string): WorkerTier {
  if (AI_TIER.has(name)) return 'ai';
  if (PREDICTION_TIER.has(name)) return 'prediction';
  return 'timer';
}

const WORKER_META: Record<string, { description: string; group: WorkerGroup }> = {
  'agent-sweep-reservations':            { description: 'Frees up AI budget if a task crashes mid-way.',              group: 'Agent' },
  'process-agent-schedules':             { description: 'Delivers reminders and creates recurring team tasks.',       group: 'Agent' },
  'agent-summarize-long-conversations':  { description: 'Tidies up long AI chats so they stay fast.',                group: 'Agent' },
  'agent-consolidate-memory':            { description: "Cleans up the AI assistant's memory overnight.",            group: 'Agent' },
  'agent-archive-stale-conversations':   { description: "Files away old AI chats you're done with.",                 group: 'Agent' },
  'agent-heal-counters':                 { description: 'Fixes the AI usage counters if they drift.',                group: 'Agent' },
  'walkthrough-heal-stale':              { description: "Cleans up show-me-how tutorials that got interrupted.",      group: 'Other' },
  'sweep-orphan-auth-users':             { description: 'Removes leftover half-finished sign-up accounts.',           group: 'Cleanup' },
  'sweep-mfa-verified-sessions':         { description: 'Clears out expired 2-factor sign-in sessions.',              group: 'Cleanup' },
  'ml-predict-inventory':                { description: 'Predicts which supplies each hotel will need.',              group: 'Inventory' },
  'ml-train-inventory':                  { description: 'Retrains the supply-prediction model each week.',            group: 'Inventory' },
  'purge-old-error-logs':                { description: 'Deletes old error logs to keep things tidy.',               group: 'Cleanup' },
  'claude-sessions-purge':               { description: 'Clears out old AI browser sessions.',                       group: 'Cleanup' },
  'webhook-dedup-purge':                 { description: 'Removes old duplicate-message guards.',                     group: 'Cleanup' },
  'pms-auth-codes-purge':                { description: 'Deletes used PMS login codes.',                             group: 'Cleanup' },
  'vercel-watchdog':                     { description: 'Health-checks the app every few minutes.',                  group: 'Other' },
  'expire-help-requests':                { description: 'Clears out expired robot help requests.',                   group: 'Cleanup' },
};

/**
 * Cadence in hours from a 5-field cron string. Covers every pattern the
 * registry actually uses (every-N-minutes, hourly, every-N-hours, daily,
 * weekly). Cadence only drives the amber "late" threshold, so an
 * approximate value on an unusual expression is harmless.
 */
function cadenceHoursFromCron(expr: string): number {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return 24;
  const [minute, hour, dom, , dow] = parts;
  const everyN = (field: string): number | null => {
    const m = /^\*\/(\d+)$/.exec(field);
    return m ? Number(m[1]) : null;
  };
  // A specific day-of-week means weekly; a specific day-of-month, monthly.
  if (dow !== '*') return 24 * 7;
  if (dom !== '*') return 24 * 30;
  const hourEvery = everyN(hour);
  if (hourEvery !== null) return hourEvery;        // e.g. "0 */6 * * *"
  if (hour === '*') {
    const minEvery = everyN(minute);
    if (minEvery !== null) return minEvery / 60;   // e.g. "*/5 * * * *"
    return 1;                                       // e.g. "5 * * * *" — hourly
  }
  return 24;                                        // fixed hour → daily
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdminOrCron(req);
  if (!auth.ok) return err('Admin sign-in required.', { requestId, status: 401, code: 'unauthorized' });

  // Collapse the registry by heartbeat name (a few names have more than one
  // schedule entry). Keep first-seen order for a stable list; take the
  // TIGHTEST cadence across entries so a worker that fires twice a day is
  // judged against its most-frequent slot.
  const byName = new Map<string, { cadenceHours: number }>();
  for (const entry of SCHEDULE_REGISTRY) {
    const cadence = cadenceHoursFromCron(entry.cronExpr);
    const existing = byName.get(entry.heartbeatName);
    if (!existing) byName.set(entry.heartbeatName, { cadenceHours: cadence });
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
  for (const [name, { cadenceHours }] of byName) {
    const meta = WORKER_META[name] ?? {
      description: `Runs the ${name.replace(/-/g, ' ')} job.`,
      group: 'Other' as WorkerGroup,
    };
    const lastBeatAt = lastBeatByName.get(name) ?? null;

    let ageHours: number | null = null;
    let state: WorkerState = 'never';
    if (lastBeatAt) {
      ageHours = Math.round(((now - new Date(lastBeatAt).getTime()) / 3_600_000) * 100) / 100;
      state = ageHours > cadenceHours * 2 ? 'late' : 'ok';
    }

    workers.push({
      name,
      description: meta.description,
      group: meta.group,
      tier: tierOf(name),
      cadenceHours: Math.round(cadenceHours * 1000) / 1000,
      lastBeatAt,
      ageHours,
      state,
    });
  }

  return ok({ workers }, { requestId });
}
