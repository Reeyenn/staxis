/**
 * Generic workflow executor.
 *
 * Plan v4 architecture decision #6: "operator workflows" infrastructure
 * is built now (queue, executor, browser lock, idempotency), but no
 * specific workflows are defined in this rebuild. Reeyen wires up
 * specific workflows + trigger sources (web button, SMS, voice, AI
 * chat) in a separate effort. This runtime is the contract they plug
 * into.
 *
 * Lifecycle of a workflow job:
 *   1. A trigger source (anywhere) inserts a row into workflow_jobs
 *      with kind + payload + idempotency_key.
 *   2. This runtime polls the queue (~5 sec cadence) for queued rows
 *      whose property has a live session-driver.
 *   3. For each picked job:
 *        a. Acquire the SessionDriver's browser lock (read loop pauses).
 *        b. Look up a handler registered for `kind`. If none, mark failed.
 *        c. Call handler(page, payload). Handler returns result.
 *        d. Mark completed with result.
 *        e. Release the browser lock.
 *   4. Retries with exponential backoff up to max_attempts.
 *
 * Handler registration:
 *   workflowRuntime.registerHandler('mark_room_clean', async (ctx) => {
 *     // ctx.page is the Playwright Page from the persistent session
 *     // ctx.payload is the workflow_jobs.payload jsonb
 *     // Drive PMS actions, return result.
 *   });
 *
 * Reeyen registers all his specific handlers from his separate effort.
 * Until that happens, the runtime sits idle (queued jobs accumulate
 * with status=queued).
 */

import type { Page } from 'playwright';
import { supabase } from './supabase.js';
import { log } from './log.js';
import { recordSpend } from './cost-cap.js';
import type { SessionSupervisor } from './session-supervisor.js';

const POLL_INTERVAL_MS = 5_000;
const WORKFLOW_TIMEOUT_MS = 10 * 60_000;

interface WorkflowJobRow {
  id: string;
  property_id: string;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  idempotency_key: string;
}

export interface WorkflowContext {
  jobId: string;
  propertyId: string;
  kind: string;
  payload: Record<string, unknown>;
  page: Page;
  recordClaudeSpendMicros: (micros: number, note?: string) => Promise<void>;
}

export type WorkflowHandler = (ctx: WorkflowContext) => Promise<{
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}>;

export class WorkflowRuntime {
  private readonly supervisor: SessionSupervisor;
  private handlers = new Map<string, WorkflowHandler>();
  private pollHandle: NodeJS.Timeout | null = null;
  private running = false;

  constructor(supervisor: SessionSupervisor) {
    this.supervisor = supervisor;
  }

  /** Register a handler for a workflow kind. Idempotent. */
  registerHandler(kind: string, handler: WorkflowHandler): void {
    if (this.handlers.has(kind)) {
      log.warn('workflow-runtime: handler re-registered', { kind });
    }
    this.handlers.set(kind, handler);
    log.info('workflow-runtime: handler registered', { kind });
  }

  /** Start polling the queue. */
  start(): void {
    if (this.running) return;
    this.running = true;
    log.info('workflow-runtime: starting', {
      pollIntervalMs: POLL_INTERVAL_MS,
      registeredKinds: Array.from(this.handlers.keys()),
    });
    this.pollHandle = setInterval(() => {
      void this.pollOnce();
    }, POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.pollHandle) clearInterval(this.pollHandle);
    this.running = false;
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private async pollOnce(): Promise<void> {
    try {
      const job = await this.claimNextJob();
      if (!job) return;
      await this.runJob(job);
    } catch (err) {
      log.warn('workflow-runtime: poll failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async claimNextJob(): Promise<WorkflowJobRow | null> {
    // Find oldest queued job for any property that has an alive session.
    const aliveDriverIds = this.supervisor.listDrivers().map((d) => d.propertyId);
    if (aliveDriverIds.length === 0) return null;

    const { data, error } = await supabase
      .from('workflow_jobs')
      .select('id, property_id, kind, payload, attempts, max_attempts, idempotency_key')
      .in('property_id', aliveDriverIds)
      .eq('status', 'queued')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (error || !data) return null;
    const row = data as WorkflowJobRow;

    // Atomic claim: flip status to 'running' for THIS row only.
    const { data: claim, error: claimErr } = await supabase
      .from('workflow_jobs')
      .update({
        status: 'running',
        attempts: row.attempts + 1,
        started_at: new Date().toISOString(),
        last_attempt_at: new Date().toISOString(),
      })
      .eq('id', row.id)
      .eq('status', 'queued')
      .select('id')
      .maybeSingle();

    if (claimErr || !claim) {
      // Lost the claim race — another instance grabbed it.
      return null;
    }
    return row;
  }

  private async runJob(job: WorkflowJobRow): Promise<void> {
    const driver = this.supervisor.getDriver(job.property_id);
    if (!driver) {
      await this.markFailed(job, 'no live session-driver for this property');
      return;
    }
    const handler = this.handlers.get(job.kind);
    if (!handler) {
      await this.markFailed(job, `no handler registered for kind=${job.kind}`);
      return;
    }

    log.info('workflow-runtime: running job', {
      jobId: job.id,
      propertyId: job.property_id,
      kind: job.kind,
      attempt: job.attempts + 1,
    });

    const release = driver.acquireBrowserLock();
    const page = driver.getPageForWorkflow();
    if (!page) {
      release();
      await this.markFailed(job, 'session-driver has no page (not started yet?)');
      return;
    }

    let finished = false;
    const timeoutHandle = setTimeout(() => {
      if (!finished) {
        log.warn('workflow-runtime: timeout — workflow will be marked failed if it returns', {
          jobId: job.id,
        });
      }
    }, WORKFLOW_TIMEOUT_MS);

    try {
      const result = await handler({
        jobId: job.id,
        propertyId: job.property_id,
        kind: job.kind,
        payload: job.payload,
        page,
        recordClaudeSpendMicros: async (micros, note) => {
          await recordSpend(job.property_id, micros, { kind: 'workflow', note });
        },
      });
      finished = true;
      clearTimeout(timeoutHandle);
      if (result.ok) {
        await this.markCompleted(job, result.result ?? {});
      } else {
        await this.markFailedOrRetry(job, result.error ?? 'handler returned ok=false');
      }
    } catch (err) {
      finished = true;
      clearTimeout(timeoutHandle);
      log.error('workflow-runtime: handler threw', {
        jobId: job.id,
        err: err instanceof Error ? err : new Error(String(err)),
      });
      await this.markFailedOrRetry(job, (err as Error).message);
    } finally {
      release();
    }
  }

  private async markCompleted(
    job: WorkflowJobRow,
    result: Record<string, unknown>,
  ): Promise<void> {
    const { error } = await supabase
      .from('workflow_jobs')
      .update({
        status: 'completed',
        result,
        completed_at: new Date().toISOString(),
      })
      .eq('id', job.id);
    if (error) {
      log.error('workflow-runtime: markCompleted failed', { jobId: job.id, err: error });
    }
  }

  private async markFailedOrRetry(job: WorkflowJobRow, reason: string): Promise<void> {
    const newAttempts = job.attempts + 1;
    if (newAttempts >= job.max_attempts) {
      await this.markFailed(job, reason);
      return;
    }
    // Re-queue for retry.
    const { error } = await supabase
      .from('workflow_jobs')
      .update({
        status: 'queued',
        error: reason,
      })
      .eq('id', job.id);
    if (error) {
      log.error('workflow-runtime: re-queue failed', { jobId: job.id, err: error });
    }
  }

  private async markFailed(job: WorkflowJobRow, reason: string): Promise<void> {
    const { error } = await supabase
      .from('workflow_jobs')
      .update({
        status: 'failed',
        error: reason,
        completed_at: new Date().toISOString(),
      })
      .eq('id', job.id);
    if (error) {
      log.error('workflow-runtime: markFailed failed', { jobId: job.id, err: error });
    }
  }
}
