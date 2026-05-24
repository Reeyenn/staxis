/**
 * CUA Service entry point — session supervisor + workflow runtime.
 *
 * Plan v4 architecture: this entry replaces the old poll-for-jobs model
 * (claim onboarding_job → run → claim pull_job → run) with a persistent
 * session supervisor (one BrowserContext per hotel, 24/7) plus a generic
 * workflow runtime (queue + executor for operator writes).
 *
 * The legacy job-runner.ts + pull-job-runner.ts are NOT invoked from
 * here. They remain in the repo for the cutover window so existing
 * onboarding flows still work, and get deleted in the final cutover
 * step (per plan v4 Week 2). To run the legacy entrypoint instead, set
 * CUA_ENTRY=legacy in env.
 *
 * Lifecycle:
 *   1. Verify env + Supabase reachable.
 *   2. Start SessionSupervisor (boots a SessionDriver per enabled hotel,
 *      memory monitor, reconcile loop).
 *   3. Start WorkflowRuntime (polls workflow_jobs queue, dispatches to
 *      registered handlers — none registered in this rebuild; Reeyen
 *      adds them separately).
 *   4. Run forever. On SIGTERM, stop supervisor + runtime gracefully so
 *      each driver saves its storageState before exit.
 */

import 'dotenv/config';
import { initSentry, flushSentry } from './sentry.js';
const sentryReady = initSentry();

import { verifyConnection } from './supabase.js';
import { log, makeWorkerId } from './log.js';
import { env } from './env.js';
import { SessionSupervisor } from './session-supervisor.js';
import { WorkflowRuntime } from './workflow-runtime.js';
import { runMappingJob, type MappingJobInput } from './mapping-driver.js';

const WORKER_ID = makeWorkerId();

let supervisor: SessionSupervisor | null = null;
let runtime: WorkflowRuntime | null = null;
let shuttingDown = false;

function setupSignalHandlers(): void {
  const handle = (sig: string) => async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`received ${sig} — stopping supervisor + runtime`, { workerId: WORKER_ID });
    try {
      if (runtime) runtime.stop();
      if (supervisor) await supervisor.stop();
    } catch (err) {
      log.warn('graceful shutdown error', { err: err instanceof Error ? err.message : String(err) });
    }
    await flushSentry(2000);
    setTimeout(() => process.exit(0), 200);
    // Hard escape after 30s.
    setTimeout(() => {
      log.warn('graceful shutdown timed out — forcing exit');
      process.exit(0);
    }, 30_000);
  };
  process.on('SIGTERM', handle('SIGTERM'));
  process.on('SIGINT', handle('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    log.error('unhandledRejection', {
      err: reason instanceof Error ? reason : new Error(String(reason)),
    });
  });
  process.on('uncaughtException', (err) => {
    log.error('uncaughtException', { err });
    process.exitCode = 1;
    void flushSentry(2000).finally(() => process.exit(1));
    setTimeout(() => process.exit(1), 3000).unref();
  });
}

async function main(): Promise<void> {
  setupSignalHandlers();
  log.info('cua-service starting', { sentryReady, workerId: WORKER_ID });

  log.info('cua_posture', {
    policyMode: env.CUA_POLICY_ENFORCE,
    signingMode: env.RECIPE_SIGNING_ENFORCE,
    dnsPreflight: env.CUA_DNS_PREFLIGHT,
    autoScreenshot: env.CUA_AUTO_SCREENSHOT,
    signingKeyPresent: !!env.RECIPE_SIGNING_KEY,
  });

  const conn = await verifyConnection();
  if (!conn.ok) {
    log.error('supabase connection failed at startup', { err: new Error(conn.error) });
    process.exit(1);
  }

  supervisor = new SessionSupervisor();
  runtime = new WorkflowRuntime(supervisor);

  await supervisor.start();
  runtime.start();

  // ─── Plan v7 Phase 2c — mapper.learn_pms_family handler ──────────────
  // Bridges workflow-runtime → mapping-driver. The no-driver claim path
  // in workflow-runtime (NO_DRIVER_KINDS) picks up mapper jobs even when
  // no SessionDriver is alive — exactly the paused_no_knowledge_file
  // case where session-driver enqueued the mapper job.
  runtime.registerHandler('mapper.learn_pms_family', async (ctx) => {
    const input = ctx.payload as unknown as MappingJobInput;
    const result = await runMappingJob(input, ctx.jobId, ctx.signal);
    if (!result.ok) {
      return { ok: false, error: result.error ?? 'mapping failed' };
    }
    return {
      ok: true,
      result: {
        knowledge_file_id: result.knowledgeFileId,
        knowledge_file_version: result.knowledgeFileVersion,
        targets_found: result.targetsFound,
        targets_unavailable: result.targetsUnavailable,
        targets_failed: result.targetsFailed,
        spent_micros: result.spentMicros,
        promotion_decision: result.promotionDecision,
        promotion_reason: result.promotionReason,
      },
    };
  });

  log.info('cua-service ready', {
    workerId: WORKER_ID,
    flyMachineId: env.FLY_MACHINE_ID,
    flyRegion: env.FLY_REGION,
  });

  // Keep alive forever. Signal handlers drive shutdown.
  await new Promise<void>(() => {});
}

main().catch((err) => {
  log.error('main crashed', {
    err: (err as Error).message,
    stack: (err as Error).stack,
  });
  process.exit(1);
});
