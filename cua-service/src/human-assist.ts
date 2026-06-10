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
 *   2. We check if any admin is online (heartbeat in last 5min). If not,
 *      resolve immediately as 'unavailable' so the mapper doesn't idle-wait
 *      for an absent admin (Plan v8 P1-2 — 13 targets × 5min wait would
 *      consume the entire job budget on a one-admin team).
 *   3. INSERT a mapping_help_requests row with status='pending'.
 *      Per P1-6, REUSE an existing pending row for the same (job_id,
 *      target_key) — happens when a worker restarts mid-wait and the new
 *      mapper attempt sees the prior request still open.
 *   4. Subscribe to UPDATEs on this row via Supabase realtime
 *      postgres_changes. Race against:
 *        - status flipping to 'answered' (admin responded)
 *        - HELP_REQUEST_TIMEOUT_MS firing (default 90s — P1-2)
 *        - AbortSignal firing (SIGTERM / job cancel)
 *   5. On admin answer: resolve with {actionType, responseText,
 *      responseCoordinate}. Mapper switches on actionType:
 *        - 'guidance' → rewind messages + push user-turn hint (P0-2)
 *        - 'unavailable' → mark target unavailable, move on
 *        - 'takeover' → enter takeover mode (Phase B chunk 2)
 *        - 'abort' → fail the whole job
 *   6. On timeout: update row status='expired', resolve as 'unavailable'
 *      so help-flood circuit-breaker (P2-4) counts it correctly.
 *   7. On abort signal: update row status='aborted', reject so caller's
 *      AbortError unwinds cleanly.
 *
 * Sequential-help-request invariant (P2-5): only one in-flight pending
 * request per job at any time. Enforced at DB level by a partial unique
 * index. Mapper processes targets sequentially so this is naturally true.
 *
 * Help-flood circuit-breaker (P2-4): checkHelpFlood(jobId) returns true
 * after 3 unsuccessful (unavailable / abort / expired) requests on the
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

/**
 * Plan v8 P1-2 — admin-online check. We track heartbeats in
 * `accounts.last_seen_at`; the front-end pings /api/admin/heartbeat every
 * 30s while the Live Mapping tab is open. If no admin pinged in the last
 * 5 minutes, treat the org as "nobody's home" — skip requestHelp and let
 * mapper fall through to today's unavailable behavior.
 */
async function isAnyAdminOnline(): Promise<boolean> {
  const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();
  const { count, error } = await supabase
    .from('accounts')
    .select('id', { count: 'exact', head: true })
    .eq('role', 'admin')
    .gte('last_seen_at', cutoff);
  if (error) {
    log.warn('isAnyAdminOnline: query failed — assuming offline', {
      err: error.message,
    });
    return false;
  }
  return (count ?? 0) > 0;
}

interface PendingRequestRow {
  id: string;
}

async function findOrInsertHelpRequest(input: HelpRequestInput): Promise<string> {
  // Plan v8 P1-6 — reuse existing pending request for this (job, target).
  // Happens when a worker restarts mid-help-wait and the new mapper attempt
  // hits the same stuck state. Without reuse, admin sees duplicate cards.
  const { data: existing } = await supabase
    .from('mapping_help_requests')
    .select('id')
    .eq('job_id', input.jobId)
    .eq('target_key', input.targetKey)
    .eq('status', 'pending')
    .maybeSingle<PendingRequestRow>();

  if (existing?.id) {
    log.info('help-request: reusing existing pending row', {
      requestId: existing.id, jobId: input.jobId, targetKey: input.targetKey,
    });
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
        .select('id')
        .eq('job_id', input.jobId)
        .eq('status', 'pending')
        .maybeSingle<PendingRequestRow>();
      if (raced?.id) {
        log.info('help-request: lost INSERT race; reusing winner row', {
          requestId: raced.id, jobId: input.jobId, targetKey: input.targetKey,
        });
        return raced.id;
      }
    }
    throw new Error(`help-request insert failed: ${error?.message ?? 'unknown'}`);
  }
  return inserted.id;
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Request live admin help. Returns when admin answers OR timeout fires
 * (default 90s — env.HELP_REQUEST_TIMEOUT_MS) OR signal aborts.
 *
 * The mapper agent's conversation history is preserved on the caller side
 * — this function does not touch it. Caller (mapper.ts) applies the
 * P0-2 rewind+push-user pattern when actionType is 'guidance'.
 */
export async function requestHelp(input: HelpRequestInput): Promise<HelpResponse> {
  // Step 1: skip entirely when no admin online (P1-2).
  const adminOnline = await isAnyAdminOnline();
  if (!adminOnline) {
    log.info('help-request: skipped — no admin online', {
      jobId: input.jobId, targetKey: input.targetKey,
    });
    // Plan v8 hardening (Codex P2 #6) — insert a tombstone row so
    // checkHelpFlood counts this attempt. Without the tombstone, a job
    // could hit "no admin online" on every target endlessly without
    // tripping the 3-attempt circuit-breaker.
    try {
      await supabase
        .from('mapping_help_requests')
        .insert({
          job_id: input.jobId,
          target_key: input.targetKey,
          question: `[skipped — no admin online] ${input.question}`,
          what_ive_tried: input.whatIveTried ?? [],
          suggested_paths: input.suggestedPaths ?? [],
          screenshot_storage_path: input.screenshotStoragePath,
          scroll_x: input.scroll?.x ?? 0,
          scroll_y: input.scroll?.y ?? 0,
          viewport_w: input.viewport?.w ?? 1280,
          viewport_h: input.viewport?.h ?? 800,
          status: 'expired',     // counts toward flood (per checkHelpFlood OR clause)
          action_type: 'unavailable',
          response_text: 'no admin online',
          answered_at: new Date().toISOString(),
        });
    } catch (err) {
      // Best-effort tombstone. If the INSERT fails the flood breaker
      // just won't count this attempt — degraded but not broken.
      log.warn('help-request: no-admin tombstone insert failed', {
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
    const settle = (resp: HelpResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      void channel.unsubscribe();
      try { input.signal.removeEventListener('abort', abortHandler); } catch { /* noop */ }
      resolve(resp);
    };

    const timeoutMs = env.HELP_REQUEST_TIMEOUT_MS;
    const timeoutHandle = setTimeout(() => {
      // Plan v8 P1-6: mark row 'expired' so help-flood (P2-4) counts it.
      void supabase
        .from('mapping_help_requests')
        .update({ status: 'expired', answered_at: new Date().toISOString() })
        .eq('id', requestId)
        .eq('status', 'pending');
      log.info('help-request: timed out — marking expired', { requestId, timeoutMs });
      settle({ actionType: 'unavailable', source: 'timeout', requestId });
    }, timeoutMs);

    const abortHandler = () => {
      // Plan v8 P1-6: mark row 'aborted' on SIGTERM so admin UI doesn't
      // dangle a card forever.
      void supabase
        .from('mapping_help_requests')
        .update({ status: 'aborted', answered_at: new Date().toISOString() })
        .eq('id', requestId)
        .eq('status', 'pending');
      log.info('help-request: aborted via signal', { requestId });
      settle({ actionType: 'unavailable', source: 'aborted', requestId });
    };
    if (input.signal.aborted) {
      abortHandler();
      return;
    }
    input.signal.addEventListener('abort', abortHandler, { once: true });

    // Supabase realtime postgres_changes on this row.
    const channel = supabase
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
          const actionType = newRow.action_type as HelpActionType | null;
          if (!actionType) {
            log.warn('help-request: answered without action_type', { requestId });
            settle({ actionType: 'unavailable', source: 'admin_answered', requestId });
            return;
          }
          settle({
            actionType,
            source: 'admin_answered',
            responseText: typeof newRow.response_text === 'string' ? newRow.response_text : undefined,
            responseCoordinate: typeof newRow.response_coordinate === 'object' && newRow.response_coordinate !== null
              ? newRow.response_coordinate as HelpResponse['responseCoordinate']
              : undefined,
            adminUserId: typeof newRow.admin_user_id === 'string' ? newRow.admin_user_id : undefined,
            requestId,
          });
        },
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          log.info('help-request: subscribed + waiting for admin', {
            requestId, timeoutMs,
          });
        }
      });
  });
}

/**
 * Plan v8 P2-4 — help-flood circuit-breaker. Mapper calls this BEFORE
 * each requestHelp; if 3+ unsuccessful (unavailable / abort / expired /
 * aborted / no-admin-online) requests have stacked up on this job, the
 * PMS is fundamentally hard for the mapper and we auto-abort instead
 * of asking for help on a 4th target.
 *
 * Plan v8 hardening (Codex P2 #6) — previous version missed two cases:
 *   1. status='aborted' rows (SIGTERM during a help-wait) had no
 *      action_type set, so the old `action_type.in.(unavailable,abort)`
 *      filter skipped them.
 *   2. no-admin-online early returns inserted NO row at all, so the
 *      mapper could endlessly hit "no admin online" without ever
 *      tripping the flood breaker.
 *
 * Both fixed: filter now includes status.in.(expired,aborted), and
 * requestHelp() inserts a tombstone row when no admin is online so the
 * counter captures it.
 */
export async function checkHelpFlood(jobId: string): Promise<boolean> {
  // Plan v8 final review B2 — count UNIQUE target_keys, not rows.
  // Previous version counted rows, so 3 retries of the SAME target (e.g.
  // admin sent 3 unhelpful hints, all rejected) tripped the breaker even
  // though only one target was actually unmappable. We want to abort
  // when 3 DIFFERENT targets are unmappable.
  const { data, error } = await supabase
    .from('mapping_help_requests')
    .select('target_key')
    .eq('job_id', jobId)
    .or('action_type.in.(unavailable,abort),status.in.(expired,aborted)');
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
 * the frame entirely if it can't verify coverage — so this row never holds an
 * unredacted credential snapshot. Do not call this with a raw page.screenshot.
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
