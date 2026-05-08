/**
 * CUA Service entry point — poll, claim, run.
 *
 * Lifecycle:
 *   1. Verify ANTHROPIC_API_KEY + Supabase service-role key at startup
 *      (anthropic-client.ts and supabase.ts already throw if missing).
 *   2. Verify Supabase reachability via verifyConnection().
 *   3. Enter the poll loop:
 *      - Every POLL_INTERVAL_MS, look for the oldest queued onboarding_job.
 *      - Claim it (atomic update from 'queued' → 'running' with worker_id).
 *      - Hand to runJob() which orchestrates mapping + extraction.
 *      - On finish (success or failure), the job row reflects the outcome.
 *   4. On SIGTERM (deploys), finish the in-flight job before exiting.
 *
 * Concurrency: one job at a time per machine. Scale by adding machines on
 * Fly. We don't need SKIP LOCKED-style queueing yet — at our current
 * volume the claim race is benign (two workers occasionally both see the
 * same row, only one wins the UPDATE).
 */

import 'dotenv/config';
import { supabase, verifyConnection } from './supabase.js';
import { log, makeWorkerId } from './log.js';
import { runJob } from './job-runner.js';

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? '5000', 10);
const WORKER_ID = makeWorkerId();

// Graceful-shutdown latch. Set true on SIGTERM; the poll loop checks it
// after each iteration. Mid-job, we let the current job finish so the
// onboarding_jobs row doesn't get stuck in 'running' forever.
let shuttingDown = false;
let inFlightJobId: string | null = null;

async function claimNextJob(): Promise<{ id: string } | null> {
  // Atomic claim: find any 'queued' row, update to 'running' with our
  // worker_id, return the row only if the update succeeded. If two
  // workers race here, only one's UPDATE will affect the row.
  const { data: candidate } = await supabase
    .from('onboarding_jobs')
    .select('id')
    .eq('status', 'queued')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!candidate) return null;

  const { data: claimed } = await supabase
    .from('onboarding_jobs')
    .update({
      status: 'running',
      worker_id: WORKER_ID,
      started_at: new Date().toISOString(),
      step: 'starting',
      progress_pct: 5,
    })
    .eq('id', candidate.id)
    .eq('status', 'queued') // double-check: only claim if still queued
    .select('id')
    .maybeSingle();

  return claimed ? { id: claimed.id as string } : null;
}

async function pollLoop(): Promise<void> {
  log.info('CUA worker started', { workerId: WORKER_ID, pollIntervalMs: POLL_INTERVAL_MS });

  // Cycle counter so we only invoke the stale-job reaper periodically
  // rather than on every tick. 12 cycles × 5s = once per minute.
  let cycle = 0;

  while (!shuttingDown) {
    try {
      // Defense-in-depth: every minute, rescue any onboarding_jobs row
      // whose worker died mid-flight (started_at > 5min ago). Migration
      // 0033 also schedules this via pg_cron, but pg_cron isn't always
      // enabled on the project; running it from the worker too means
      // the safety net survives even if cron is disabled.
      if (cycle % 12 === 0) {
        try {
          const { data } = await supabase.rpc('staxis_reap_stale_jobs');
          if (typeof data === 'number' && data > 0) {
            log.warn('reaped stale jobs', { count: data });
          }
        } catch (err) {
          // Reaper is best-effort — never block the poll loop.
          log.warn('reaper rpc failed (non-fatal)', { err: (err as Error).message });
        }
      }

      let job = await claimNextJob();
      // If we lost the claim race to another worker, retry once
      // immediately — there might be more queued jobs to grab without
      // waiting a full POLL_INTERVAL_MS.
      if (!job) {
        const second = await claimNextJob();
        if (second) job = second;
      }

      if (job) {
        inFlightJobId = job.id;
        log.info('claimed job', { jobId: job.id, workerId: WORKER_ID });
        try {
          await runJob(job.id, WORKER_ID);
        } catch (err) {
          // runJob owns marking the job 'failed' on exception. This catch
          // is the absolute backstop — if the job-runner itself crashed,
          // we still want the worker process to keep polling.
          log.error('runJob threw — should have been caught inside', {
            jobId: job.id,
            err: (err as Error).message,
          });
        }
        inFlightJobId = null;
      }
    } catch (err) {
      log.error('poll iteration failed', { err: (err as Error).message });
    }

    cycle++;
    if (shuttingDown) break;
    await sleep(POLL_INTERVAL_MS);
  }

  log.info('poll loop exited cleanly');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setupSignalHandlers(): void {
  const handle = (sig: string) => () => {
    log.info(`received ${sig} — finishing in-flight job before exit`, { inFlightJobId });
    shuttingDown = true;
    // If no job in flight, exit immediately. Otherwise the loop will
    // exit naturally after the current job finishes.
    if (!inFlightJobId) {
      setTimeout(() => process.exit(0), 100);
    } else {
      // Hard-cap: don't let a stuck job keep us alive past 5 min on
      // shutdown. Fly will kill us anyway after grace_period.
      setTimeout(() => {
        log.warn('grace period expired with job still running — exiting');
        process.exit(0);
      }, 5 * 60_000);
    }
  };
  process.on('SIGTERM', handle('SIGTERM'));
  process.on('SIGINT',  handle('SIGINT'));
}

async function main(): Promise<void> {
  setupSignalHandlers();
  const conn = await verifyConnection();
  if (!conn.ok) {
    log.error('supabase connection failed at startup', { err: conn.error });
    process.exit(1);
  }
  await pollLoop();
}

main().catch((err) => {
  log.error('main crashed', { err: (err as Error).message, stack: (err as Error).stack });
  process.exit(1);
});
