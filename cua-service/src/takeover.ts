/**
 * feature/cua-live-assist — founder-initiated, multi-step, robot-PAUSED takeover
 * of the PMS-learning mapper, driven from the admin Learning Board.
 *
 * This is the FULL takeover session the 501 tombstone (/api/admin/mapper/
 * takeover-action) always referred to. The existing single-click takeover
 * (human-assist.ts requestHelp + mapper.ts executeSupervisorClick) only fires
 * when the AGENT declares itself stuck and hands ONE click back before resuming
 * its own loop. Here the FOUNDER interrupts a working robot, the robot PAUSES
 * its AI decisions, and the founder drives click-by-click until Finish / Cancel
 * / Skip.
 *
 * Control surface: the `mapper_takeover_sessions` table (migration 0278), a
 * dedicated interrupt + per-step command channel (NOT mapping_help_requests,
 * whose 15-min TTL / expire-cron / flood-counting are wrong for an open-ended
 * interactive session). Service-role only; the board reads/writes through
 * /api/admin/mapper/* routes (supabaseAdmin) and never touches the table.
 *
 * Integration: `mapper.ts` calls `controller.maybeRun(ctx)` at the TOP of the
 * mapActionCore step loop. It returns `{kind:'none'}` instantly (one cheap read)
 * unless the founder pressed Take over / Skip. When a takeover is live it owns
 * the ENTIRE multi-click loop inside this one call (returns only on
 * finish/cancel/skip/timeout) — so it consumes exactly ONE mapActionCore step
 * (never drains targetStepCap) and the caller credits the elapsed time to
 * helpWaitMs so the wall-clock budget isn't starved by human think-time.
 *
 * SAFETY: the founder's click executes physically in a real PMS browser.
 *  - the click-target frame is published AWAITED to its OWN object
 *    (`{jobId}/takeover.png`), NOT the heartbeat-gated/rate-limited ambient
 *    `live.png` publisher — so the founder never clicks a stale image;
 *  - frame_seq is bumped only AFTER that upload lands; the founder's click
 *    carries command_frame_seq and is executed only if it still matches the
 *    current frame_seq (else the frame is re-published and the click dropped);
 *  - coordinates are bounds-checked against the row's capture viewport;
 *  - the board UI is turn-based (Send disabled until the robot acks the prior
 *    command) so two commands can't race one frame.
 *
 * PRIVACY: frames go through captureHardenedScreenshot (masks credential/SSN/CC,
 * withholds the frame entirely if it can't guarantee redaction) — same contract
 * as the help-card and live-view paths. A withheld frame just isn't published.
 */

import { supabase } from './supabase.js';
import { log } from './log.js';
import { env } from './env.js';
import { executeVisionAction } from './browser-tool-vision.js';
import { captureHardenedScreenshot } from './screenshot-privacy.js';
import type { Page } from 'playwright';
import type { PMSCredentials, RecipeStep } from './types.js';

const BUCKET = 'mapping-screenshots';

/** What `mapActionCore` passes per step. */
export interface TakeoverStepCtx {
  page: Page;
  credentials: PMSCredentials;
  /** The feed currently being mapped (mapper target key). */
  actionKey: string;
  signal?: AbortSignal;
  /** Push a recorded recipe step (the founder's navigation must replay). */
  recordStep: (step: RecipeStep) => void;
}

export type TakeoverOutcome =
  /** No takeover requested for this job — proceed with the normal agent step. */
  | { kind: 'none'; waitedMs: number }
  /** Founder confirmed THIS page is the feed — caller hands back to extraction. */
  | { kind: 'finished'; waitedMs: number }
  /** Founder couldn't find it — caller marks the feed not-found, moves on. */
  | { kind: 'cancelled'; waitedMs: number; reason: string }
  /** Founder skipped this feed — caller abandons it, moves on. */
  | { kind: 'skipped'; waitedMs: number; reason: string };

export interface TakeoverDeps {
  /** Broadcast a `takeover` nudge so the board refetches state + the frame. */
  notify: () => void;
  /** Also feed the ambient live-view stream (best-effort; heartbeat-gated). */
  onLiveFrame?: (pngBase64: string) => void;
}

export interface TakeoverController {
  /** Called at the top of each mapActionCore step. Cheap no-op unless live. */
  maybeRun(ctx: TakeoverStepCtx): Promise<TakeoverOutcome>;
  /** Best-effort cleanup of the takeover frame object on job end. */
  close(): Promise<void>;
}

interface SessionRow {
  id: string;
  status: 'requested' | 'active' | 'ended';
  target_key: string | null;
  frame_seq: number;
  viewport_w: number;
  viewport_h: number;
  command: 'click' | 'finish' | 'cancel' | 'skip' | null;
  command_coordinate: { x?: unknown; y?: unknown } | null;
  command_note: string | null;
  command_seq: number;
  command_frame_seq: number | null;
  applied_command_seq: number;
}

const SESSION_COLS =
  'id, status, target_key, frame_seq, viewport_w, viewport_h, command, ' +
  'command_coordinate, command_note, command_seq, command_frame_seq, applied_command_seq';

export function createTakeoverController(jobId: string, deps: TakeoverDeps): TakeoverController {
  const objectKey = `${jobId}/takeover.png`;
  let everUploaded = false;

  /** Capture a privacy-hardened frame and upload it AWAITED to the takeover
   *  object. Returns true on a real publish. Never throws. */
  async function publishFrame(page: Page): Promise<boolean> {
    let buf: Buffer | null = null;
    try {
      buf = await captureHardenedScreenshot(page);
    } catch (err) {
      log.warn('takeover: frame capture failed (non-fatal)', { jobId, err: (err as Error).message });
      return false;
    }
    if (!buf) return false; // redaction couldn't be guaranteed — withhold
    try {
      const { error } = await supabase.storage
        .from(BUCKET)
        .upload(objectKey, buf, { contentType: 'image/png', cacheControl: '0', upsert: true });
      if (error) {
        log.warn('takeover: frame upload failed (non-fatal)', { jobId, err: error.message });
        return false;
      }
    } catch (err) {
      log.warn('takeover: frame upload threw (non-fatal)', { jobId, err: (err as Error).message });
      return false;
    }
    everUploaded = true;
    // Belt: also feed the ambient stream so the board's non-takeover view
    // (if shown) doesn't freeze. Heartbeat-gated + rate-limited downstream.
    try { deps.onLiveFrame?.(buf.toString('base64')); } catch { /* noop */ }
    return true;
  }

  async function endSession(id: string, reason: string, appliedSeq?: number): Promise<void> {
    const patch: Record<string, unknown> = {
      status: 'ended',
      ended_at: new Date().toISOString(),
      ended_reason: reason,
    };
    if (typeof appliedSeq === 'number') patch.applied_command_seq = appliedSeq;
    await supabase.from('mapper_takeover_sessions').update(patch).eq('id', id);
    try { deps.notify(); } catch { /* noop */ }
  }

  /** Round + bounds-check a founder coordinate against the capture viewport.
   *  Mirrors validateSupervisorCoordinate / validateCoordinateBounds. */
  function validateCoord(raw: unknown, vw: number, vh: number): { x: number; y: number } | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const { x, y } = raw as { x?: unknown; y?: unknown };
    if (typeof x !== 'number' || typeof y !== 'number') return null;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || xi >= vw || yi < 0 || yi >= vh) return null;
    return { x: xi, y: yi };
  }

  /** Wait for the next founder command (command_seq > lastApplied) on this
   *  session row. Mirrors requestHelp's realtime race: subscribe + a
   *  post-SUBSCRIBED re-read (the command can land inside the handshake) +
   *  idle timeout + abort. */
  function waitForCommand(
    sessionId: string,
    lastApplied: number,
    signal: AbortSignal | undefined,
  ): Promise<{ kind: 'command'; row: SessionRow } | { kind: 'timeout' } | { kind: 'aborted' }> {
    return new Promise((resolve) => {
      let settled = false;
      let channel: ReturnType<typeof supabase.channel> | null = null;
      const settle = (r: { kind: 'command'; row: SessionRow } | { kind: 'timeout' } | { kind: 'aborted' }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (channel) void channel.unsubscribe();
        if (signal) { try { signal.removeEventListener('abort', onAbort); } catch { /* noop */ } }
        resolve(r);
      };
      const consider = (row: SessionRow | null) => {
        if (!row) return;
        if (row.status === 'ended') { settle({ kind: 'aborted' }); return; }
        if (typeof row.command_seq === 'number' && row.command_seq > lastApplied && row.command) {
          settle({ kind: 'command', row });
        }
      };

      const timer = setTimeout(() => settle({ kind: 'timeout' }), env.TAKEOVER_IDLE_TIMEOUT_MS);
      const onAbort = () => settle({ kind: 'aborted' });
      if (signal?.aborted) { settle({ kind: 'aborted' }); return; }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      channel = supabase
        .channel(`takeover:${sessionId}`)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .on('postgres_changes' as any, {
          event: 'UPDATE',
          schema: 'public',
          table: 'mapper_takeover_sessions',
          filter: `id=eq.${sessionId}`,
        }, (payload: { new: Record<string, unknown> }) => consider(payload.new as unknown as SessionRow))
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            // The founder's command can commit inside the subscribe handshake
            // (realtime only delivers post-SUBSCRIBED events) — re-read once.
            void supabase
              .from('mapper_takeover_sessions')
              .select(SESSION_COLS)
              .eq('id', sessionId)
              .maybeSingle()
              .then(({ data }) => consider((data as SessionRow | null) ?? null));
          }
        });
    });
  }

  async function maybeRun(ctx: TakeoverStepCtx): Promise<TakeoverOutcome> {
    const startedAt = Date.now();
    const waited = () => Date.now() - startedAt;

    // Cheap gate: is there an open takeover for this job?
    const { data: open, error } = await supabase
      .from('mapper_takeover_sessions')
      .select(SESSION_COLS)
      .eq('job_id', jobId)
      .in('status', ['requested', 'active'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<SessionRow>();
    if (error) {
      log.warn('takeover: open-session read failed — proceeding without takeover', {
        jobId, err: error.message,
      });
      return { kind: 'none', waitedMs: 0 };
    }
    if (!open) return { kind: 'none', waitedMs: 0 };

    // Stale Skip: a Skip pressed against a DIFFERENT feed (the robot already
    // moved past it) must NOT eat the current feed. End it as a no-op skip and
    // proceed normally with the current feed.
    if (open.command === 'skip' && open.target_key && open.target_key !== ctx.actionKey) {
      log.info('takeover: stale skip for a finished feed — ignoring', {
        jobId, skipTarget: open.target_key, currentFeed: ctx.actionKey,
      });
      await endSession(open.id, 'skipped', open.command_seq);
      return { kind: 'none', waitedMs: waited() };
    }
    // Skip for the current feed (or an untargeted skip) — immediate, no drive.
    if (open.command === 'skip') {
      log.info('takeover: skip — abandoning current feed', { jobId, feed: ctx.actionKey });
      await endSession(open.id, 'skipped', open.command_seq);
      return { kind: 'skipped', waitedMs: waited(), reason: open.command_note?.trim() || 'Skipped by you' };
    }

    // ── Real takeover: PAUSE the agent loop and drive by founder clicks. ──
    log.info('takeover: founder is taking over', { jobId, feed: ctx.actionKey, sessionId: open.id });
    const vw = ctx.page.viewportSize()?.width ?? open.viewport_w ?? 1280;
    const vh = ctx.page.viewportSize()?.height ?? open.viewport_h ?? 800;
    let frameSeq = open.frame_seq ?? 0;
    let lastApplied = open.applied_command_seq ?? 0;

    // Activate + publish the first click-target frame (awaited).
    await publishFrame(ctx.page);
    frameSeq += 1;
    await supabase
      .from('mapper_takeover_sessions')
      .update({
        status: 'active',
        target_key: open.target_key ?? ctx.actionKey,
        started_at: open.status === 'active' ? undefined : new Date().toISOString(),
        viewport_w: vw,
        viewport_h: vh,
        frame_seq: frameSeq,
      })
      .eq('id', open.id);
    try { deps.notify(); } catch { /* noop */ }

    // Drive loop — owns the whole interactive session inside this one call.
    for (;;) {
      const ev = await waitForCommand(open.id, lastApplied, ctx.signal);
      if (ev.kind === 'timeout') {
        log.info('takeover: idle timeout — handing back to the robot', { jobId, feed: ctx.actionKey });
        await endSession(open.id, 'timeout', lastApplied);
        return { kind: 'none', waitedMs: waited() };
      }
      if (ev.kind === 'aborted') {
        await endSession(open.id, 'aborted', lastApplied);
        return { kind: 'none', waitedMs: waited() };
      }

      const row = ev.row;
      const seq = row.command_seq;
      const cmd = row.command;

      if (cmd === 'finish') {
        log.info('takeover: founder pressed Finish — capturing this page as the feed', { jobId, feed: ctx.actionKey });
        await endSession(open.id, 'finished', seq);
        return { kind: 'finished', waitedMs: waited() };
      }
      if (cmd === 'cancel') {
        log.info('takeover: founder pressed Cancel — feed not found', { jobId, feed: ctx.actionKey });
        await endSession(open.id, 'cancelled', seq);
        return { kind: 'cancelled', waitedMs: waited(), reason: row.command_note?.trim() || 'Couldn’t find it' };
      }
      if (cmd === 'skip') {
        await endSession(open.id, 'skipped', seq);
        return { kind: 'skipped', waitedMs: waited(), reason: row.command_note?.trim() || 'Skipped by you' };
      }

      // cmd === 'click' — execute the founder's nudge, then publish a fresh
      // frame. Always ack (applied_command_seq=seq) so the board re-enables.
      const coord = validateCoord(row.command_coordinate, vw, vh);
      const frameMatches = row.command_frame_seq === frameSeq;
      if (coord && frameMatches) {
        try {
          const exec = await executeVisionAction(
            ctx.page,
            { action: 'left_click', coordinate: [coord.x, coord.y] },
            ctx.credentials,
            'action',
          );
          if (exec.recordedStep) ctx.recordStep(exec.recordedStep);
          if (exec.isError) {
            log.warn('takeover: founder click reported an error (page may be unchanged)', {
              jobId, feed: ctx.actionKey, x: coord.x, y: coord.y, output: exec.output.slice(0, 160),
            });
          }
          await ctx.page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {});
          await ctx.page.waitForTimeout(800);
        } catch (err) {
          log.warn('takeover: founder click failed (non-fatal)', {
            jobId, feed: ctx.actionKey, err: (err as Error).message,
          });
        }
      } else {
        log.info('takeover: click dropped — stale frame or out-of-bounds; re-publishing', {
          jobId, feed: ctx.actionKey, frameMatches, hadCoord: Boolean(coord),
          commandFrameSeq: row.command_frame_seq, currentFrameSeq: frameSeq,
        });
      }

      // Fresh frame for the next click (awaited), bump seq, ack the command.
      await publishFrame(ctx.page);
      frameSeq += 1;
      lastApplied = seq;
      await supabase
        .from('mapper_takeover_sessions')
        .update({ frame_seq: frameSeq, applied_command_seq: seq })
        .eq('id', open.id);
      try { deps.notify(); } catch { /* noop */ }
    }
  }

  async function close(): Promise<void> {
    if (!everUploaded) return;
    try { await supabase.storage.from(BUCKET).remove([objectKey]); } catch { /* noop */ }
  }

  return { maybeRun, close };
}
