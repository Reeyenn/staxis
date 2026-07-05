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
import { getJobCostMicros } from './usage-log.js';
import { env } from './env.js';
import type { SessionSupervisor } from './session-supervisor.js';

const POLL_INTERVAL_MS = 5_000;
const WORKFLOW_TIMEOUT_MS = 10 * 60_000;
/**
 * Pick the mapper timeout for a specific job. Reads (in order):
 *   1. job.payload.timeout_ms — per-job override (admin checkbox)
 *   2. env.MAPPER_JOB_TIMEOUT_MS (default 90min)
 *
 * Plan v8 D.2 deleted MAPPER_MODE + the per-job mapper_mode override —
 * vision is the only mode now and its 90min default covers the 13-target run.
 */
function pickMapperTimeoutMs(job: WorkflowJobRow): number {
  const payload = (job.payload ?? {}) as { timeout_ms?: number };
  if (typeof payload.timeout_ms === 'number' && payload.timeout_ms > 0) {
    return payload.timeout_ms;
  }
  return env.MAPPER_JOB_TIMEOUT_MS;
}

// Plan v7 Phase 2c — workflow kinds that don't require an alive
// SessionDriver. Mapper jobs trigger on paused_no_knowledge_file
// (precisely when no driver is alive), so claimNextJob's alive-driver
// filter would deadlock them forever. These kinds get a separate
// claim path + handler dispatch.
// feature/cua-coverage-editor — `mapper.edit_recipe` is a non-browser recipe
// edit (delete a feed); it never needs an alive SessionDriver, so it shares the
// no-driver claim lane + handler dispatch with mapper.learn_pms_family.
// feature/knowledge-ocr — `doc_ocr` transcribes a scanned PDF / photo with
// Claude vision (downloads the file, rasterizes via mupdf, one vision call per
// page). It owns no PMS browser, so it rides the no-driver lane like the mapper
// kinds — it must run for ANY property, including ones with no live session.
const NO_DRIVER_KINDS = new Set<string>(['mapper.learn_pms_family', 'mapper.edit_recipe', 'mapper.capture_feed', 'doc_ocr']);

interface WorkflowJobRow {
  id: string;
  property_id: string;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  idempotency_key: string;
  /** When the trigger source first enqueued the job. Bounds a non-counting
   *  `defer` (see markDeferred): a job that has been deferring longer than
   *  DEFER_MAX_AGE_MS gives up with a terminal fail so nothing loops forever. */
  created_at: string;
}

/**
 * Upper bound on how long a `defer` outcome may keep re-queueing a job
 * without consuming an attempt. A pms.write deferred because the hotel's
 * session is paused (cost cap resumes at midnight; MFA on operator action)
 * should drain within hours; past this it's a stuck pause and we give up
 * rather than loop forever. 24h covers a full cost-cap day plus slack.
 */
const DEFER_MAX_AGE_MS = 24 * 60 * 60_000;

export interface WorkflowContext {
  jobId: string;
  propertyId: string;
  kind: string;
  payload: Record<string, unknown>;
  /** Plan v7 — null for no-driver kinds (mapper.*). Handler must spawn
   *  its own browser if it needs one (see mapping-driver.ts). */
  page: Page | null;
  /** Plan v7 — abort signal threaded from the workflow timeout. Handlers
   *  SHOULD pass this to long-running async calls (Anthropic, Playwright)
   *  so a timeout actually cancels in-flight work instead of waiting. */
  signal: AbortSignal;
  recordClaudeSpendMicros: (micros: number, note?: string, source?: 'mapping' | 'workflow' | 'repair') => Promise<void>;
}

export type WorkflowHandler = (ctx: WorkflowContext) => Promise<{
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
  /** A TRANSIENT, non-counting deferral (distinct from a retryable failure).
   *  When true the runtime re-queues the job WITHOUT consuming an attempt, so
   *  a pms.write enqueued while its hotel is paused (cost cap / MFA / starting,
   *  all max_attempts=1) survives to drain once the session resumes — instead
   *  of being terminally failed by markFailedOrRetry on its single attempt.
   *  Bounded by DEFER_MAX_AGE_MS in markDeferred. `error` carries the reason. */
  defer?: boolean;
}>;

export class WorkflowRuntime {
  private readonly supervisor: SessionSupervisor;
  private handlers = new Map<string, WorkflowHandler>();
  private pollHandle: NodeJS.Timeout | null = null;
  private running = false;
  /** Phase 3 / Codex P0-1 + P1: the 5s poll is a setInterval, so without an
   *  in-flight guard a job outlasting the interval would let the next tick
   *  claim a SECOND job and drive the same browser concurrently. TWO lanes so
   *  a long no-driver mapper job (its own browser) can't starve alive-driver
   *  pms.write jobs: one job in flight PER lane. */
  private inFlightNoDriver = false;
  private inFlightAlive = false;

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
    // Plan v7 Phase 2c — SIGTERM-safe retry. On boot, find any
    // `running` rows from a previous worker that crashed mid-job and
    // requeue them. Idempotency key prevents double-execution if the
    // previous worker actually completed but its DB update was lost.
    void this.reclaimStaleRunningJobs();

    this.pollHandle = setInterval(() => {
      void this.pollOnce();
    }, POLL_INTERVAL_MS);
  }

  /** Plan v7 — reclaim `running` rows older than 1.5× the mapper timeout.
   *  Requeue them so the next poll picks them up. The unique-idempotency-key
   *  constraint on workflow_jobs prevents double-execution.
   *
   *  Plan v8 P2-3: multiplier dropped from 2× to 1.5× so a long-running
   *  vision job isn't reclaimed under its own feet. 1.5 × 90 min = 135 min
   *  between crash and reclaim.
   */
  private async reclaimStaleRunningJobs(): Promise<void> {
    const noDriverKinds = [...NO_DRIVER_KINDS];
    // Mapper (no-driver) jobs are long (90 min) — reclaim at 1.5x their timeout.
    const mapperCutoff = new Date(Date.now() - 1.5 * env.MAPPER_JOB_TIMEOUT_MS).toISOString();
    // Everything else (e.g. pms.write) is short — a crashed one must not sit
    // 'running' for ~135 min (Codex P1-3). Reclaim at 2x the workflow timeout.
    // Re-running is safe: the write handler is idempotent (precondition short-
    // circuit) and writes are max_attempts=1, so a reclaim can't loop-mutate.
    const shortCutoff = new Date(Date.now() - 2 * WORKFLOW_TIMEOUT_MS).toISOString();
    const inList = `(${noDriverKinds.map((k) => `"${k}"`).join(',')})`;

    const [mapper, other] = await Promise.all([
      supabase
        .from('workflow_jobs')
        .update({ status: 'queued', error: 'reclaimed: worker restart before completion' })
        .eq('status', 'running')
        .in('kind', noDriverKinds)
        .lt('last_attempt_at', mapperCutoff)
        .select('id'),
      supabase
        .from('workflow_jobs')
        .update({ status: 'queued', error: 'reclaimed: worker restart before completion' })
        .eq('status', 'running')
        .not('kind', 'in', inList)
        .lt('last_attempt_at', shortCutoff)
        .select('id'),
    ]);
    if (mapper.error) log.warn('workflow-runtime: stale mapper reclaim failed', { err: mapper.error.message });
    if (other.error) log.warn('workflow-runtime: stale write reclaim failed', { err: other.error.message });
    const count = (mapper.data?.length ?? 0) + (other.data?.length ?? 0);
    if (count > 0) log.info('workflow-runtime: reclaimed stale running jobs', { count });
  }

  stop(): void {
    if (this.pollHandle) clearInterval(this.pollHandle);
    this.running = false;
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private async pollOnce(): Promise<void> {
    // Two lanes so a long-running no-driver mapper job can't block alive-driver
    // pms.write jobs (Codex P1). Each lane runs at most one job at a time.
    await Promise.allSettled([this.pumpNoDriver(), this.pumpAlive()]);
  }

  private async pumpNoDriver(): Promise<void> {
    if (this.inFlightNoDriver) return;
    this.inFlightNoDriver = true;
    try {
      const job = await this.claimNextJob('noDriver');
      if (job) await this.runJob(job);
    } catch (err) {
      log.warn('workflow-runtime: no-driver poll failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.inFlightNoDriver = false;
    }
  }

  private async pumpAlive(): Promise<void> {
    if (this.inFlightAlive) return;
    this.inFlightAlive = true;
    try {
      const job = await this.claimNextJob('alive');
      if (job) await this.runJob(job);
    } catch (err) {
      log.warn('workflow-runtime: alive poll failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.inFlightAlive = false;
    }
  }

  private async claimNextJob(lane: 'noDriver' | 'alive'): Promise<WorkflowJobRow | null> {
    // Two independent claim lanes (Codex P1 — keep mapper + pms.write apart):
    //   - 'noDriver' (NO_DRIVER_KINDS, e.g. the mapper): owns its own browser.
    //   - 'alive': jobs that drive a live hotel's persistent browser (pms.write).
    const noDriverKinds = [...NO_DRIVER_KINDS];
    let row: WorkflowJobRow | null = null;

    if (lane === 'noDriver') {
      const { data } = await supabase
        .from('workflow_jobs')
        .select('id, property_id, kind, payload, attempts, max_attempts, idempotency_key, created_at')
        .in('kind', noDriverKinds)
        .eq('status', 'queued')
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      row = data ? (data as WorkflowJobRow) : null;
    } else {
      // Alive-driver jobs for hotels with a live SessionDriver only.
      const aliveDriverIds = this.supervisor.listDrivers().map((d) => d.propertyId);
      if (aliveDriverIds.length === 0) return null;
      const { data, error } = await supabase
        .from('workflow_jobs')
        .select('id, property_id, kind, payload, attempts, max_attempts, idempotency_key, created_at')
        .in('property_id', aliveDriverIds)
        .not('kind', 'in', `(${noDriverKinds.map((k) => `"${k}"`).join(',')})`)
        .eq('status', 'queued')
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error || !data) return null;
      row = data as WorkflowJobRow;
    }

    if (!row) return null;

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
    const handler = this.handlers.get(job.kind);
    if (!handler) {
      await this.markFailed(job, `no handler registered for kind=${job.kind}`);
      return;
    }

    // Plan v7 Phase 2c — kind-aware dispatch.
    //   no-driver kinds (mapper.*): handler runs without a SessionDriver
    //     and owns its own browser (see mapping-driver.ts). No browser
    //     lock to acquire/release.
    //   alive-driver kinds: existing path — acquire SessionDriver's
    //     browser lock and pass its page to the handler.
    const isNoDriverKind = NO_DRIVER_KINDS.has(job.kind);
    // Plan v8 Phase A: mapper-kind timeout is mode-aware (DOM 60min,
    // vision 90min) and per-job-overridable. Non-mapper kinds keep the
    // workflow timeout.
    const timeoutMs = isNoDriverKind ? pickMapperTimeoutMs(job) : WORKFLOW_TIMEOUT_MS;

    log.info('workflow-runtime: running job', {
      jobId: job.id,
      propertyId: job.property_id,
      kind: job.kind,
      attempt: job.attempts + 1,
      isNoDriverKind,
      timeoutMs,
    });

    let release: (() => void) | null = null;
    let page: Page | null = null;
    if (!isNoDriverKind) {
      const driver = this.supervisor.getDriver(job.property_id);
      if (!driver) {
        await this.markFailed(job, 'no live session-driver for this property');
        return;
      }
      release = driver.acquireBrowserLock();
      page = driver.getPageForWorkflow();
      if (!page) {
        release();
        await this.markFailed(job, 'session-driver has no page (not started yet?)');
        return;
      }
    }

    // Plan v7 Phase 2c — real AbortController. Handler receives the
    // signal and can pass it to its Anthropic / Playwright calls. The
    // timeout fires abort(); the in-flight async chain unwinds.
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => {
      abortController.abort(new Error(`workflow timeout ${timeoutMs}ms`));
      log.warn('workflow-runtime: timeout — aborting via signal', { jobId: job.id, timeoutMs });
    }, timeoutMs);

    try {
      const result = await handler({
        jobId: job.id,
        propertyId: job.property_id,
        kind: job.kind,
        payload: job.payload,
        page,
        signal: abortController.signal,
        recordClaudeSpendMicros: async (micros, note, source = 'workflow') => {
          // Plan v7 — source='mapping' skips the per-hotel daily cap.
          // For workflow kinds it stays in the cap. Cost-cap.ts handles
          // the source-aware dispatch (Phase 2c chunk 3).
          await recordSpend(job.property_id, micros, { kind: source, note });
        },
      });
      clearTimeout(timeoutHandle);
      if (result.ok) {
        await this.markCompleted(job, result.result ?? {});
      } else if (result.defer) {
        // TRANSIENT non-counting deferral — re-queue without burning an attempt
        // (bounded by DEFER_MAX_AGE_MS). Distinct from a retryable failure so a
        // max_attempts=1 pms.write isn't terminally failed just because its
        // hotel was paused when the job was claimed.
        await this.markDeferred(job, result.error ?? 'deferred');
      } else {
        await this.markFailedOrRetry(job, result.error ?? 'handler returned ok=false');
      }
    } catch (err) {
      clearTimeout(timeoutHandle);
      log.error('workflow-runtime: handler threw', {
        jobId: job.id,
        err: err instanceof Error ? err : new Error(String(err)),
      });
      await this.markFailedOrRetry(job, (err as Error).message);
    } finally {
      if (release) release();
    }
  }

  private async markCompleted(
    job: WorkflowJobRow,
    result: Record<string, unknown>,
  ): Promise<void> {
    // Roll up the job's real Claude spend (summed in claude_usage_log by job_id)
    // into the job row so the admin UIs show the true cost instead of $0. This is
    // DISPLAY-only — the $5/day session cost cap reads a different column
    // (property_sessions.daily_claude_cost_micros) and is unaffected. Best-effort:
    // a cost read/write failure must never fail an otherwise-successful job.
    let claudeCostMicros = 0;
    try {
      claudeCostMicros = await getJobCostMicros(job.id);
    } catch (err) {
      log.warn('workflow-runtime: cost rollup read failed (non-fatal)', {
        jobId: job.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    const { error } = await supabase
      .from('workflow_jobs')
      .update({
        status: 'completed',
        result,
        completed_at: new Date().toISOString(),
        claude_cost_micros: claudeCostMicros,
      })
      .eq('id', job.id);
    if (error) {
      log.error('workflow-runtime: markCompleted failed', { jobId: job.id, err: error });
    }
  }

  /**
   * TRANSIENT non-counting deferral. `claimNextJob` already bumped the row to
   * status='running', attempts=job.attempts+1 for THIS pick. A defer undoes
   * that pick: status back to 'queued' AND attempts back to the pre-claim
   * value (job.attempts), so the deferral never erodes the real retry budget.
   * The next poll re-claims and re-runs it — the loop drains once the hotel's
   * session resumes.
   *
   * Bounded: if the job has been alive longer than DEFER_MAX_AGE_MS the pause
   * is stuck (not the routine midnight cost-cap clear), so we give up with a
   * terminal, clearly-reasoned fail instead of deferring forever.
   */
  private async markDeferred(job: WorkflowJobRow, reason: string): Promise<void> {
    const ageMs = Date.now() - Date.parse(job.created_at);
    if (Number.isFinite(ageMs) && ageMs > DEFER_MAX_AGE_MS) {
      await this.markFailed(
        job,
        `gave up deferring after ${Math.round(ageMs / 3_600_000)}h (${reason})`,
      );
      return;
    }
    const { error } = await supabase
      .from('workflow_jobs')
      .update({
        status: 'queued',
        attempts: job.attempts, // undo claimNextJob's +1 — a defer costs no attempt
        error: `deferred: ${reason}`,
      })
      .eq('id', job.id);
    if (error) {
      log.error('workflow-runtime: defer re-queue failed', { jobId: job.id, err: error });
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
