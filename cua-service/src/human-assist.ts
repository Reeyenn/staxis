/**
 * Human-assisted mapper help channel — Plan v8 Phase B.
 *
 * When the mapper agent gets stuck on a target (declares unavailable after
 * the floor check), instead of giving up it can request help from a Staxis
 * admin who's watching the Live Mapping console.
 *
 * Flow:
 *
 *   1. mapper.ts calls requestHelp({jobId, targetKey, question, ...}).
 *   2. PER-JOB presence gate (feature/cua-polish): is an admin watching THIS
 *      job right now? (getWatcherFreshness reads the watcher heartbeat the
 *      Learning Board POSTs to /api/admin/mapper/live/[jobId] every 30s while
 *      its tab is open + visible.) If not 'fresh', drop an audit tombstone and
 *      resolve immediately as 'unavailable' — no idle-wait for an absent admin.
 *      (Replaces the old GLOBAL accounts.last_seen_at check, which made a job
 *      wait whenever ANY admin was on ANY admin page.)
 *   3. INSERT a mapping_help_requests row with status='pending'.
 *      Per P1-6, REUSE an existing pending row for the same (job_id,
 *      target_key) — happens when a worker restarts mid-wait and the new
 *      mapper attempt sees the prior request still open.
 *   4. HOLD until the watcher acts. Subscribe to UPDATEs on this row via
 *      Supabase realtime postgres_changes and race against:
 *        - status flipping to 'answered' (admin responded)
 *        - the watcher leaving (getWatcherFreshness goes 'stale' on the 30s
 *          re-check — they closed the tab / walked away)
 *        - HELP_REQUEST_TIMEOUT_MS firing — the HARD safety cap, so a
 *          watched-but-abandoned request (tab still pinging, nobody acting)
 *          still expires under the row's DB TTL
 *        - AbortSignal firing (SIGTERM / job cancel)
 *   5. On admin answer: resolve with {actionType, responseText,
 *      responseCoordinate}. Mapper switches on actionType:
 *        - 'guidance' → rewind messages + push user-turn hint (P0-2)
 *        - 'unavailable' → mark target unavailable, move on
 *        - 'takeover' → enter takeover mode (Phase B chunk 2)
 *        - 'abort' → fail the whole job
 *   6. On hard-cap / watcher-left: update row status='expired', resolve as
 *      'unavailable' (source 'timeout'). These do NOT count toward the flood
 *      breaker (only admin-answered unavailable/abort do).
 *   7. On abort signal: update row status='aborted', reject so caller's
 *      AbortError unwinds cleanly.
 *
 * Sequential-help-request invariant (P2-5): only one in-flight pending
 * request per job at any time. Enforced at DB level by a partial unique
 * index. Mapper processes targets sequentially so this is naturally true.
 *
 * Help-flood circuit-breaker (P2-4): checkHelpFlood(jobId) returns true after
 * an admin has explicitly judged 3 DIFFERENT targets unavailable/abort on the
 * same job. mapper.ts calls this before requestHelp to short-circuit a
 * fundamentally-broken-PMS mapping run.
 */

import { supabase } from './supabase.js';
import { log } from './log.js';
import { env } from './env.js';

// ─── Public types ─────────────────────────────────────────────────────────

export type HelpActionType = 'guidance' | 'unavailable' | 'takeover' | 'abort';

export interface HelpRequestInput {
  jobId: string;
  targetKey: string;
  /** One-sentence question the agent asks. */
  question: string;
  /** Array of strings describing what the agent already tried. */
  whatIveTried?: string[];
  /** Array of strings of admin-helpful guess paths. */
  suggestedPaths?: string[];
  /** Supabase Storage object key for the screenshot snapshot (already
   *  uploaded by the caller). */
  screenshotStoragePath: string;
  /** Viewport state at the moment of capture, for the admin UI. */
  scroll?: { x: number; y: number };
  viewport?: { w: number; h: number };
  /** Abort signal — fired on SIGTERM / job cancel. */
  signal: AbortSignal;
}

export interface HelpResponse {
  actionType: HelpActionType;
  /** Reason: 'no_admin_online' | 'timeout' | 'admin_answered' | 'aborted'. */
  source: 'no_admin_online' | 'timeout' | 'admin_answered' | 'aborted';
  /** Admin-typed guidance (action='guidance'). */
  responseText?: string;
  /** Admin click coordinate on the screenshot (action='guidance' with click). */
  responseCoordinate?: { x: number; y: number; dpr?: number };
  /** Admin who answered (when action='admin_answered'). */
  adminUserId?: string;
  /** Help-request row id, for audit logging. */
  requestId?: string;
}

// ─── Internal helpers ─────────────────────────────────────────────────────

/** Bucket + object key for the per-job watcher heartbeat (feature/cua-polish). */
const WATCHER_BUCKET = 'mapping-screenshots';
const watcherObjectKey = (jobId: string) => `${jobId}/watcher.json`;
/**
 * A watcher heartbeat counts as "fresh" if the Learning Board pinged within
 * this window. The board pings POST /api/admin/mapper/live/[jobId] every 30s
 * while its tab is open AND visible; 2.5min tolerates a tab reload and a few
 * dropped pings without abandoning a genuinely-present admin.
 */
const WATCHER_FRESH_MS = 150_000;
/** How often, mid-wait, we re-check the watcher is still on THIS job. */
const WATCHER_RECHECK_MS = 30_000;

type WatcherFreshness = 'fresh' | 'stale' | 'unknown';

/**
 * Per-job, per-watcher presence (feature/cua-polish — replaces the old GLOBAL
 * `accounts.last_seen_at` admin-online check). Reads the tiny watcher object
 * the Learning Board writes for THIS job and judges its freshness:
 *
 *   - 'fresh'   — object exists and was pinged within WATCHER_FRESH_MS: an
 *                 admin is actively watching this job right now.
 *   - 'stale'   — object exists but its last ping is older than the window:
 *                 the watcher closed the tab / walked away. (A job with NO
 *                 watcher ever has no object → surfaces as a download error →
 *                 'unknown', handled fail-closed at the entry gate.)
 *   - 'unknown' — transient storage error, missing object, or unparseable
 *                 body: we can't prove presence.
 *
 * The `at` timestamp is read from the object BODY (not storage metadata, which
 * doesn't reliably refresh on an in-place overwrite). Never throws.
 */
async function getWatcherFreshness(jobId: string): Promise<WatcherFreshness> {
  // One immediate retry absorbs a transient storage blip so a momentary read
  // failure doesn't drop a help request while an admin is actually watching
  // (Codex review [1]). A genuinely-absent watcher object errors on BOTH tries
  // → 'unknown' → the entry gate fails closed (no idle wait for an absent
  // admin), which is the intended conservative default — we deliberately do
  // NOT treat 'unknown' as present, or an unwatched run would camp the hard
  // cap on every stuck target.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data, error } = await supabase.storage
        .from(WATCHER_BUCKET)
        .download(watcherObjectKey(jobId));
      if (error || !data) {
        if (attempt === 0) continue;
        return 'unknown';
      }
      const text = await data.text();
      const at = Date.parse((JSON.parse(text) as { at?: string })?.at ?? '');
      if (!Number.isFinite(at)) return 'unknown';
      return Date.now() - at <= WATCHER_FRESH_MS ? 'fresh' : 'stale';
    } catch (err) {
      if (attempt === 0) continue;
      log.warn('getWatcherFreshness: read failed — treating as unknown', {
        jobId, err: (err as Error).message,
      });
      return 'unknown';
    }
  }
  return 'unknown';
}

interface PendingRequestRow {
  id: string;
  screenshot_storage_path?: string | null;
}

/**
 * ITEM B (audit 40a45bfe) — decide whether a REUSED pending row is safe to
 * wait on. `refreshReusedPendingRow` returns TRUE only when the row now
 * reflects THIS attempt (refresh landed, or an answer legitimately raced in on
 * its own frame). FALSE means the refresh UPDATE errored, so the row still
 * carries the PREVIOUS attempt's — possibly wrong-target — screenshot. The
 * admin clicks these frames, so waiting on a stale one risks a takeover click
 * landing on a page the robot has moved off. Pure so it can be unit-pinned.
 */
export function shouldWaitOnReusedRow(refreshOutcome: boolean): boolean {
  return refreshOutcome === true;
}

/**
 * feature/cua-assist-board — refresh a REUSED pending row to THIS attempt's
 * reality: fresh screenshot/scroll/viewport/question, the CURRENT target_key,
 * and a fresh TTL. Two reasons, both takeover-critical:
 *  1. The admin CLICKS these screenshots now. The restarted robot's browser
 *     is on whatever page this attempt reached — serving an older attempt's
 *     screenshot (or another TARGET's: the one-pending index is per JOB)
 *     would have the founder click coordinates against a page the robot is
 *     no longer on, and that click executes physically inside a real PMS.
 *  2. The row kept its ORIGINAL expires_at (15min from first insert); a
 *     reuse near the TTL edge could be swept by the expire cron mid-wait.
 * Guarded by status='pending' (an answer racing in wins; refresh no-ops and
 * the OLD screenshot is kept — it's the frame the answer was given against).
 * The replaced screenshot is deleted best-effort only when the refresh
 * landed (the expire cron deletes only the path stored on the row).
 *
 * Returns TRUE only when the reused row now faithfully reflects THIS attempt
 * (refresh UPDATE landed, or an answer raced in first and legitimately won the
 * row on its own frame). Returns FALSE when the refresh UPDATE errored: the row
 * still carries the PREVIOUS attempt's screenshot/target, and the admin clicks
 * these frames — a takeover answer against a stale frame would land a physical
 * click on a page the robot is no longer on, inside a real PMS. On that failure
 * we EXPIRE the stale row (best-effort) so the assist route — which commits only
 * WHERE status='pending' — can't accept an answer against it, and the caller
 * refuses to wait on it (audit 40a45bfe ITEM B).
 */
async function refreshReusedPendingRow(
  row: PendingRequestRow,
  input: HelpRequestInput,
): Promise<boolean> {
  const { data: refreshed, error } = await supabase
    .from('mapping_help_requests')
    .update({
      target_key: input.targetKey,
      question: input.question,
      what_ive_tried: input.whatIveTried ?? [],
      suggested_paths: input.suggestedPaths ?? [],
      screenshot_storage_path: input.screenshotStoragePath,
      scroll_x: input.scroll?.x ?? 0,
      scroll_y: input.scroll?.y ?? 0,
      viewport_w: input.viewport?.w ?? 1280,
      viewport_h: input.viewport?.h ?? 800,
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    })
    .eq('id', row.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  if (error) {
    // The row still shows the PREVIOUS attempt's (possibly wrong-target)
    // screenshot, but the admin clicks these frames. Rather than let a takeover
    // answer commit against a frame the robot has moved off, EXPIRE the stale
    // pending row so the assist route (commits only WHERE status='pending')
    // can't accept it. Best-effort — if this UPDATE also fails the caller still
    // refuses the row (returns false), so no answer is ever taken against it.
    log.warn('help-request: reused-row refresh failed — expiring the stale row', {
      err: error.message, requestId: row.id, targetKey: input.targetKey,
    });
    try {
      await supabase
        .from('mapping_help_requests')
        .update({ status: 'expired', answered_at: new Date().toISOString() })
        .eq('id', row.id)
        .eq('status', 'pending');
    } catch (expireErr) {
      log.warn('help-request: stale-row expire also failed (non-fatal)', {
        err: (expireErr as Error).message, requestId: row.id,
      });
    }
    return false;
  }
  // refreshed === null means an answer/expire raced in and won the row while
  // still on ITS frame (the status='pending' guard blocked our overwrite) —
  // legitimate, so we keep it and report success. Only delete the old
  // screenshot when OUR refresh actually landed (refreshed truthy).
  const oldPath = row.screenshot_storage_path;
  if (refreshed && oldPath && oldPath !== input.screenshotStoragePath) {
    try {
      await supabase.storage.from('mapping-screenshots').remove([oldPath]);
    } catch (err) {
      log.warn('help-request: stale screenshot cleanup failed (non-fatal)', {
        err: (err as Error).message, oldPath,
      });
    }
  }
  return true;
}

async function findOrInsertHelpRequest(input: HelpRequestInput): Promise<string> {
  // Plan v8 P1-6 — reuse existing pending request for this (job, target).
  // Happens when a worker restarts mid-help-wait and the new mapper attempt
  // hits the same stuck state. Without reuse, admin sees duplicate cards.
  const { data: existing } = await supabase
    .from('mapping_help_requests')
    .select('id, screenshot_storage_path')
    .eq('job_id', input.jobId)
    .eq('target_key', input.targetKey)
    .eq('status', 'pending')
    .maybeSingle<PendingRequestRow>();

  if (existing?.id) {
    log.info('help-request: reusing existing pending row', {
      requestId: existing.id, jobId: input.jobId, targetKey: input.targetKey,
    });
    // If the refresh failed, the row still holds the PREVIOUS attempt's
    // screenshot/target and has been expired above — do NOT wait on it (an
    // admin answering the stale frame could land a click on the wrong page).
    // Throw so requestHelp falls through to 'unavailable' for this target.
    if (!shouldWaitOnReusedRow(await refreshReusedPendingRow(existing, input))) {
      throw new Error('help-request reused-row refresh failed; refusing stale frame');
    }
    return existing.id;
  }

  const { data: inserted, error } = await supabase
    .from('mapping_help_requests')
    .insert({
      job_id: input.jobId,
      target_key: input.targetKey,
      question: input.question,
      what_ive_tried: input.whatIveTried ?? [],
      suggested_paths: input.suggestedPaths ?? [],
      screenshot_storage_path: input.screenshotStoragePath,
      scroll_x: input.scroll?.x ?? 0,
      scroll_y: input.scroll?.y ?? 0,
      viewport_w: input.viewport?.w ?? 1280,
      viewport_h: input.viewport?.h ?? 800,
    })
    .select('id')
    .single<PendingRequestRow>();

  if (error || !inserted) {
    // Plan v8 final review B4 — race: SELECT+INSERT is not atomic and
    // the partial unique index `mapping_help_requests_one_pending_per_job`
    // can reject our INSERT if a concurrent mapper attempt (post-reclaim)
    // inserted first. Postgres returns code '23505' (unique_violation) for
    // that case. Re-select the row the other side just inserted and reuse
    // it — we want to converge on the SAME pending request, not fail.
    if (error?.code === '23505') {
      const { data: raced } = await supabase
        .from('mapping_help_requests')
        .select('id, screenshot_storage_path')
        .eq('job_id', input.jobId)
        .eq('status', 'pending')
        .maybeSingle<PendingRequestRow>();
      if (raced?.id) {
        log.info('help-request: lost INSERT race; reusing winner row', {
          requestId: raced.id, jobId: input.jobId, targetKey: input.targetKey,
        });
        // The one-pending unique index is per JOB, not per target — the
        // winner row can belong to a DIFFERENT target (e.g. a leftover from
        // a pre-restart attempt whose expire UPDATE failed). Refresh it to
        // THIS request's target + screenshot before waiting on it, exactly
        // like the fast-path reuse above. A failed refresh means the row still
        // shows the OTHER target's frame (and has been expired) — refuse it
        // rather than wait on / let the admin answer against a stale frame.
        if (!shouldWaitOnReusedRow(await refreshReusedPendingRow(raced, input))) {
          throw new Error('help-request raced-row refresh failed; refusing stale frame');
        }
        return raced.id;
      }
    }
    throw new Error(`help-request insert failed: ${error?.message ?? 'unknown'}`);
  }
  return inserted.id;
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Request live admin help. Behaviour (feature/cua-polish):
 *   - If an admin is watching THIS job right now (per-job watcher heartbeat
 *     'fresh'), HOLD the request until they act, re-checking presence as we
 *     wait. Bounded by a hard safety cap (env.HELP_REQUEST_TIMEOUT_MS) so a
 *     watched-but-then-abandoned request still expires.
 *   - If nobody is watching this job (freshness not 'fresh'), fast-path:
 *     drop an audit tombstone and return 'unavailable' immediately — no idle
 *     wait for an absent admin.
 *   - Resolves early as answered when the admin clicks/types, or as aborted
 *     on SIGTERM.
 *
 * The mapper agent's conversation history is preserved on the caller side
 * — this function does not touch it. Caller (mapper.ts) applies the
 * P0-2 rewind+push-user pattern when actionType is 'guidance'.
 */
export async function requestHelp(input: HelpRequestInput): Promise<HelpResponse> {
  // Step 1: PER-JOB presence gate (feature/cua-polish). Only hold for an admin
  // who's actually watching THIS job — an admin parked on another job (or any
  // admin page) must not make this stuck job wait. 'stale'/'unknown' both
  // fall through fail-closed: no provable watcher → no wait.
  const freshness = await getWatcherFreshness(input.jobId);
  if (freshness !== 'fresh') {
    log.info('help-request: skipped — no admin watching this job', {
      jobId: input.jobId, targetKey: input.targetKey, freshness,
    });
    // Audit tombstone so the Learning Board's "recent help requests" history
    // shows the robot got stuck while nobody was watching. NOTE: this row does
    // NOT count toward the help-flood breaker (checkHelpFlood counts only
    // admin-ANSWERED unavailable/abort) — the no-watcher path is a fast-path
    // with no wait, so there's no wait-amplification to guard against, and an
    // unwatched run is better off marking targets unavailable and finishing a
    // partial map than aborting the whole job.
    try {
      await supabase
        .from('mapping_help_requests')
        .insert({
          job_id: input.jobId,
          target_key: input.targetKey,
          question: `[skipped — no admin watching this job] ${input.question}`,
          what_ive_tried: input.whatIveTried ?? [],
          suggested_paths: input.suggestedPaths ?? [],
          screenshot_storage_path: input.screenshotStoragePath,
          scroll_x: input.scroll?.x ?? 0,
          scroll_y: input.scroll?.y ?? 0,
          viewport_w: input.viewport?.w ?? 1280,
          viewport_h: input.viewport?.h ?? 800,
          status: 'expired',     // never 'pending' → no one-pending-index conflict
          action_type: 'unavailable',
          response_text: 'no admin watching this job',
          answered_at: new Date().toISOString(),
        });
    } catch (err) {
      // Best-effort tombstone — a failed insert just omits this from the
      // board history. Degraded, not broken.
      log.warn('help-request: no-watcher tombstone insert failed', {
        err: (err as Error).message, jobId: input.jobId, targetKey: input.targetKey,
      });
    }
    return { actionType: 'unavailable', source: 'no_admin_online' };
  }

  // Step 2: INSERT (or reuse existing) pending row.
  let requestId: string;
  try {
    requestId = await findOrInsertHelpRequest(input);
  } catch (err) {
    log.warn('help-request: insert failed — falling through to unavailable', {
      err: (err as Error).message, jobId: input.jobId, targetKey: input.targetKey,
    });
    return { actionType: 'unavailable', source: 'no_admin_online' };
  }

  // Step 3: subscribe + race against timeout + abort.
  return new Promise<HelpResponse>((resolve) => {
    let settled = false;
    // Declared before settle and assigned at the bottom — the already-
    // aborted entry path below calls settle() BEFORE the channel exists
    // (referencing a `const channel` there was a TDZ ReferenceError that
    // turned a clean abort into a promise rejection).
    let channel: ReturnType<typeof supabase.channel> | null = null;
    const settle = (resp: HelpResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      clearInterval(recheckHandle);
      if (channel) void channel.unsubscribe();
      try { input.signal.removeEventListener('abort', abortHandler); } catch { /* noop */ }
      resolve(resp);
    };

    // Settle from a row that reads status='answered' — shared by the
    // realtime handler, the post-SUBSCRIBED re-read, and the timeout's
    // lost-race check below, so all three honor the answer identically.
    const settleFromAnsweredRow = (row: Record<string, unknown>) => {
      const actionType = row.action_type as HelpActionType | null;
      if (!actionType) {
        log.warn('help-request: answered without action_type', { requestId });
        settle({ actionType: 'unavailable', source: 'admin_answered', requestId });
        return;
      }
      settle({
        actionType,
        source: 'admin_answered',
        responseText: typeof row.response_text === 'string' ? row.response_text : undefined,
        responseCoordinate: typeof row.response_coordinate === 'object' && row.response_coordinate !== null
          ? row.response_coordinate as HelpResponse['responseCoordinate']
          : undefined,
        adminUserId: typeof row.admin_user_id === 'string' ? row.admin_user_id : undefined,
        requestId,
      });
    };

    const timeoutMs = env.HELP_REQUEST_TIMEOUT_MS;

    // Mark the row 'expired' (only while still 'pending') and settle as a
    // non-answer. The expire UPDATE is the race arbiter: zero rows matched
    // means an admin answer COMMITTED first but its realtime event hasn't
    // reached us — honor it (the founder's click must not be dropped at the
    // buzzer). Shared by the hard-cap timeout AND the watcher-left re-check.
    const expireOrHonor = async (cause: 'hard_cap' | 'watcher_left'): Promise<void> => {
      if (settled) return;
      // Wrap the DB round-trip so a thrown/rejected query can NEVER leave the
      // hold pending (Codex review [2]): the hard cap is the last line of
      // defense against a hang, so it must settle even when the expire UPDATE
      // fails. On error we fail safe — release the hold as a timeout.
      try {
        const { data: expired } = await supabase
          .from('mapping_help_requests')
          .update({ status: 'expired', answered_at: new Date().toISOString() })
          .eq('id', requestId)
          .eq('status', 'pending')
          .select('id')
          .maybeSingle();
        if (!expired) {
          const { data: row } = await supabase
            .from('mapping_help_requests')
            .select('status, action_type, response_text, response_coordinate, admin_user_id')
            .eq('id', requestId)
            .maybeSingle();
          if (row && (row as { status?: string }).status === 'answered') {
            log.info('help-request: answer beat the expire — honoring it', { requestId, cause });
            settleFromAnsweredRow(row as Record<string, unknown>);
            return;
          }
        }
      } catch (err) {
        log.warn('help-request: expire query failed — releasing hold as timeout anyway', {
          requestId, cause, err: (err as Error).message,
        });
      }
      log.info('help-request: expiring hold', { requestId, cause, timeoutMs });
      settle({ actionType: 'unavailable', source: 'timeout', requestId });
    };

    // Hard safety cap — bounds a watched-but-abandoned wait (the admin's tab
    // is still pinging but nobody is acting). Stays under the row's 15-min DB
    // TTL so the expire cron can't sweep the row mid-wait.
    const timeoutHandle = setTimeout(() => { void expireOrHonor('hard_cap'); }, timeoutMs);

    // Hold-until-acts release valve (feature/cua-polish): while we hold, re-
    // check the watcher is still on THIS job. A DEFINITIVE 'stale' (object
    // exists, last ping older than the window) means they closed the tab /
    // walked away — release the hold early instead of camping to the hard cap.
    // 'unknown' (transient storage blip) keeps holding; the hard cap bounds the
    // worst case either way.
    const recheckHandle = setInterval(() => {
      void (async () => {
        if (settled) return;
        const f = await getWatcherFreshness(input.jobId);
        if (f === 'stale') {
          log.info('help-request: watcher left — releasing the hold', {
            requestId, jobId: input.jobId,
          });
          await expireOrHonor('watcher_left');
        }
      })();
    }, WATCHER_RECHECK_MS);
    // Never let the recheck timer keep the worker process alive on its own.
    recheckHandle.unref?.();

    const abortHandler = () => {
      // Plan v8 P1-6: mark row 'aborted' on SIGTERM so admin UI doesn't
      // dangle a card forever. Supabase builders are LAZY thenables — they
      // only fire when awaited/.then()'d, so the previous bare `void
      // builder` never sent the update and every aborted card dangled.
      void supabase
        .from('mapping_help_requests')
        .update({ status: 'aborted', answered_at: new Date().toISOString() })
        .eq('id', requestId)
        .eq('status', 'pending')
        .then(({ error: abortErr }) => {
          if (abortErr) {
            log.warn('help-request: abort-status update failed', {
              requestId, err: abortErr.message,
            });
          }
        });
      log.info('help-request: aborted via signal', { requestId });
      settle({ actionType: 'unavailable', source: 'aborted', requestId });
    };
    if (input.signal.aborted) {
      abortHandler();
      return;
    }
    input.signal.addEventListener('abort', abortHandler, { once: true });

    // Supabase realtime postgres_changes on this row.
    channel = supabase
      .channel(`help-request:${requestId}`)
      .on(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        'postgres_changes' as any,
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'mapping_help_requests',
          filter: `id=eq.${requestId}`,
        },
        (payload: { new: Record<string, unknown> }) => {
          const newRow = payload.new;
          if (newRow.status !== 'answered') return;
          settleFromAnsweredRow(newRow);
        },
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          log.info('help-request: subscribed + waiting for admin', {
            requestId, timeoutMs,
          });
          // feature/cua-assist-board — one-shot re-read AFTER the channel is
          // live. Realtime delivers only post-SUBSCRIBED events; a REUSED
          // row has been on the admin's board for a while (worker restart),
          // so his answer can land inside the subscribe handshake window
          // and would otherwise never be delivered — the robot would idle
          // the full timeout and mark the feed unavailable despite a
          // committed answer.
          void supabase
            .from('mapping_help_requests')
            .select('status, action_type, response_text, response_coordinate, admin_user_id')
            .eq('id', requestId)
            .maybeSingle()
            .then(({ data: row }) => {
              if (row && (row as { status?: string }).status === 'answered') {
                log.info('help-request: row was already answered before subscribe completed', { requestId });
                settleFromAnsweredRow(row as Record<string, unknown>);
              }
            });
        }
      });
  });
}

/**
 * Plan v8 P2-4 — help-flood circuit-breaker. Mapper calls this BEFORE
 * each requestHelp; if 3+ DIFFERENT targets have been explicitly judged
 * unmappable by an admin, the PMS is fundamentally hard and we auto-abort
 * instead of asking for help on a 4th target.
 *
 * feature/cua-polish — count ONLY admin-ANSWERED unavailable/abort rows.
 * The breaker now exists for exactly one signal: a watching admin keeps
 * saying "this PMS doesn't have it" / "stop" across ≥3 targets. Everything
 * else is deliberately excluded:
 *   - no-watcher tombstones (status='expired') — the no-watcher path is a
 *     fast-path with no wait, so an unwatched run should mark targets
 *     unavailable and finish a partial map, NOT abort the whole job.
 *   - hard-cap / watcher-left expiries (status='expired') and SIGTERM
 *     aborts (status='aborted') — a slow or departed human isn't evidence
 *     the PMS lacks the data.
 * (Bounded regardless by the per-job cost cap + the 90-min job timeout.)
 */
export async function checkHelpFlood(jobId: string): Promise<boolean> {
  // Plan v8 final review B2 — count UNIQUE target_keys, not rows, so 3
  // retries of the SAME target (admin sent 3 unhelpful hints) don't trip the
  // breaker; we abort only when 3 DIFFERENT targets are admin-confirmed
  // unmappable.
  const { data, error } = await supabase
    .from('mapping_help_requests')
    .select('target_key')
    .eq('job_id', jobId)
    .eq('status', 'answered')
    .in('action_type', ['unavailable', 'abort']);
  if (error) {
    log.warn('checkHelpFlood: query failed — treating as no-flood', {
      err: error.message, jobId,
    });
    return false;
  }
  const uniqueTargets = new Set((data ?? []).map((r) => (r as { target_key: string }).target_key));
  return uniqueTargets.size >= 3;
}

/**
 * Upload a screenshot Buffer to Supabase Storage under a per-job path and
 * return the object key. The path is intentionally per-job so the admin
 * UI can list all snapshots for a job, and so cleanup is a single prefix
 * delete after the job completes.
 *
 * Bucket: 'mapping-screenshots' (private). RLS on the bucket gates
 * downloads to admin role; cua-service writes via service role.
 *
 * PRIVACY CONTRACT: `pngBuffer` MUST already be privacy-hardened. The only
 * caller (mapper.ts help-card) produces it via `captureHardenedScreenshot`
 * (screenshot-privacy.ts), which masks credential/SSN/CC fields and withholds
 * the frame entirely if it can't produce a masked image — so this row never
 * holds an unredacted credential snapshot. Do not call this with a raw
 * page.screenshot.
 */
export async function saveScreenshotToStorage(
  jobId: string,
  targetKey: string,
  pngBuffer: Buffer,
): Promise<string> {
  const objectKey = `${jobId}/${Date.now()}-${targetKey.replace(/[^a-z0-9_-]/gi, '_')}.png`;
  const { error } = await supabase.storage
    .from('mapping-screenshots')
    .upload(objectKey, pngBuffer, {
      contentType: 'image/png',
      cacheControl: '60',
      upsert: false,
    });
  if (error) {
    throw new Error(`screenshot upload failed: ${error.message}`);
  }
  return objectKey;
}
