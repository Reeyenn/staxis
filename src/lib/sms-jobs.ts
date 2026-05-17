/**
 * SMS jobs queue — producer + worker helpers.
 *
 * See migration `0020_sms_jobs.sql` for the schema and the design doc at
 * `Second Brain/02 Projects/HotelOps AI/[C] SMS Job Queue — Design Doc.md`
 * for the rationale.
 *
 * Public surface:
 *   - `enqueueSms(input)` — producers call this from route handlers.
 *     Returns the job row (created or pre-existing if the idempotency
 *     key already exists for the property).
 *   - `processSmsJobs(limit)` — worker entry point. Cron job calls this
 *     each tick. Pops a batch, sends each via Twilio, updates rows.
 *   - `resetStuckSmsJobs()` — watchdog. Resets rows stuck in 'sending'
 *     longer than the threshold so they're retried.
 *
 * Status flow:
 *   queued → sending → sent
 *                   → queued (with backoff) → sending → ...
 *                                          → dead (after max_attempts)
 *
 * The processor is deliberately conservative — one Twilio call at a time,
 * sequential. We can parallelize later when load demands it; today's
 * volume is well below Twilio's per-account rate limit so there's no
 * benefit.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import { sendSms } from '@/lib/sms';
import { errToString } from '@/lib/utils';
import { log } from '@/lib/log';
import { captureException } from '@/lib/sentry';

// ─── shared types ───────────────────────────────────────────────────────────

export interface EnqueueSmsInput {
  propertyId: string;
  toPhone: string;
  body: string;
  /**
   * Caller-supplied dedup key. Same (propertyId, idempotencyKey) within
   * the row's lifetime returns the existing row. Use a per-message UUID
   * (e.g. `crypto.randomUUID()`) when you want every send unique, or a
   * deterministic key like `shift-confirmations:${shiftDate}:${staffId}`
   * when you want at-most-one-send-per-staff-per-shift.
   */
  idempotencyKey: string;
  /**
   * Optional metadata blob. Surfaces in the per-message status row in
   * the UI ("Maria, Room 217 confirmation"). Don't put secrets here.
   */
  metadata?: Record<string, unknown>;
  /**
   * Override the default retry cap (3). Use sparingly — high values mean
   * a permanently broken phone number burns a lot of Twilio retries.
   */
  maxAttempts?: number;
}

export interface SmsJobRow {
  id: string;
  property_id: string;
  to_phone: string;
  body: string;
  status: 'queued' | 'sending' | 'sent' | 'failed' | 'dead';
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  started_at: string | null;
  sent_at: string | null;
  twilio_sid: string | null;
  error_code: string | null;
  error_message: string | null;
  idempotency_key: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// ─── producer ───────────────────────────────────────────────────────────────

/**
 * Insert a new SMS job. If a job with the same (propertyId, idempotencyKey)
 * already exists, return the existing row instead of creating a duplicate.
 *
 * Errors:
 *   - Throws if the database is unreachable or the schema is mismatched.
 *     Callers can decide whether to fall back to a synchronous send.
 */
export async function enqueueSms(input: EnqueueSmsInput): Promise<SmsJobRow> {
  // Try insert first. The unique (property_id, idempotency_key) constraint
  // makes duplicate enqueues into "no-op + return existing" via the
  // upsert-style flow below.
  const insertPayload = {
    property_id: input.propertyId,
    to_phone: input.toPhone,
    body: input.body,
    idempotency_key: input.idempotencyKey,
    max_attempts: input.maxAttempts ?? 3,
    metadata: input.metadata ?? {},
  };

  // Matches SmsJobRow interface above. Audit follow-up 2026-05-17.
  const SMS_JOB_FIELDS =
    'id, property_id, to_phone, body, status, attempts, max_attempts, ' +
    'next_attempt_at, started_at, sent_at, twilio_sid, error_code, ' +
    'error_message, idempotency_key, metadata, created_at, updated_at';

  const { data: inserted, error: insertErr } = await supabaseAdmin
    .from('sms_jobs')
    .insert(insertPayload)
    .select(SMS_JOB_FIELDS)
    .single<SmsJobRow>();

  if (!insertErr && inserted) return inserted as SmsJobRow;

  // Conflict — read the existing row and return it.
  // Postgres conflict code is 23505 (unique_violation). supabase-js maps
  // this to error.code === '23505'.
  const isDuplicate = (insertErr as { code?: string } | null)?.code === '23505';
  if (isDuplicate) {
    const { data: existing, error: readErr } = await supabaseAdmin
      .from('sms_jobs')
      .select(SMS_JOB_FIELDS)
      .eq('property_id', input.propertyId)
      .eq('idempotency_key', input.idempotencyKey)
      .single<SmsJobRow>();
    if (readErr || !existing) {
      throw new Error(
        `enqueueSms: duplicate detected for (pid=${input.propertyId}, key=${input.idempotencyKey}) but row not found on re-read: ${errToString(readErr)}`,
      );
    }
    return existing as SmsJobRow;
  }

  throw new Error(`enqueueSms: insert failed: ${errToString(insertErr)}`);
}

// ─── worker ─────────────────────────────────────────────────────────────────

/**
 * Compute the next-attempt timestamp after a transient failure.
 *
 * Backoff: 30s, 2min, 5min for attempts 1-3. After max_attempts we mark
 * the job 'dead' instead.
 */
export function computeBackoffSeconds(attempt: number): number {
  switch (attempt) {
    case 1:  return 30;
    case 2:  return 120;
    case 3:  return 300;
    default: return 600;
  }
}

export interface ProcessResult {
  claimed: number;
  sent: number;
  retried: number;
  dead: number;
}

/**
 * Drain up to `limit` queued jobs by calling Twilio for each. Updates
 * each row to 'sent' (success), 'queued' with backoff (transient
 * failure), or 'dead' (max_attempts exhausted).
 *
 * Idempotent — safe to call from multiple cron instances thanks to
 * `select … for update skip locked` in the RPC.
 *
 * Returns counts so the cron caller can log a summary.
 */
export async function processSmsJobs(limit = 50): Promise<ProcessResult> {
  const result: ProcessResult = { claimed: 0, sent: 0, retried: 0, dead: 0 };

  // Claim a batch atomically.
  const { data: claimed, error: claimErr } = await supabaseAdmin
    .rpc('staxis_claim_sms_jobs', { p_limit: limit });

  if (claimErr) {
    log.error('[sms-jobs] claim rpc failed', { errorCode: claimErr.code, msg: claimErr.message });
    captureException(new Error(`sms-jobs claim failed: ${claimErr.message}`));
    return result;
  }
  const rows = (claimed ?? []) as Array<{
    id: string;
    property_id: string;
    to_phone: string;
    body: string;
    attempts: number;
    max_attempts: number;
    idempotency_key: string;
    metadata: Record<string, unknown>;
  }>;
  result.claimed = rows.length;

  // Send each. Sequential — keeps it simple and within Twilio's per-account
  // pacing without us reasoning about concurrency. Volume today is far
  // below the rate where parallelism would matter.
  //
  // Note: sendSms currently returns void. The Twilio SID would be useful
  // to record on the row for support traceability — when sendSms is
  // upgraded to surface the Message resource, plumb the .sid through here.
  for (const job of rows) {
    // 2026-05-12 (Codex audit fix): the send and the post-send DB write
    // used to share one try block, so a transient Supabase hiccup AFTER
    // a successful Twilio send would land in the catch and reschedule
    // the row — next tick fired the same SMS again, leading to duplicate
    // housekeeper texts. Now: send is one try block; the post-send write
    // is a second one that CANNOT take the row back to 'queued'.
    let sendError: unknown = null;
    try {
      await sendSms(job.to_phone, job.body);
    } catch (err) {
      sendError = err;
    }

    if (sendError) {
      // SMS was NOT sent. Original retry/dead categorization.
      const errMsg = errToString(sendError);
      const errCode = extractTwilioErrorCode(sendError);
      const isTerminal = isTerminalTwilioError(errCode);
      const isFinalAttempt = job.attempts >= job.max_attempts;
      const nextStatus: 'dead' | 'queued' = (isTerminal || isFinalAttempt) ? 'dead' : 'queued';
      const backoffSec = computeBackoffSeconds(job.attempts);
      const nextAt = new Date(Date.now() + backoffSec * 1000).toISOString();

      await supabaseAdmin
        .from('sms_jobs')
        .update({
          status: nextStatus,
          next_attempt_at: nextAt,
          error_code: errCode,
          error_message: errMsg.slice(0, 1000),
          started_at: null,
        })
        .eq('id', job.id);

      if (nextStatus === 'dead') {
        result.dead++;
        log.error('[sms-jobs] job dead', {
          jobId: job.id, pid: job.property_id, errorCode: errCode ?? undefined, msg: errMsg,
        });
        // Side-effect callback: only on terminal failure. While the job is
        // queued for retry, leave shift_confirmations alone so the UI keeps
        // showing "in flight" instead of flipping to "failed" prematurely.
        await applyMetadataCallback(job.metadata, 'dead', errMsg);
      } else {
        result.retried++;
      }
      continue;
    }

    // SMS sent successfully. From here we MUST move the row out of
    // 'sending' or the stuck-job sweep (resetStuckSmsJobs) will requeue
    // it in 5 min and cause a duplicate Twilio send.
    const sentAt = new Date().toISOString();
    let updateOk = false;
    try {
      const { error: updateErr } = await supabaseAdmin
        .from('sms_jobs')
        .update({
          status: 'sent',
          sent_at: sentAt,
          twilio_sid: null, // sendSms doesn't return SID today; see comment above
          error_code: null,
          error_message: null,
          started_at: null,
        })
        .eq('id', job.id);
      if (!updateErr) updateOk = true;
      else log.error('[sms-jobs] post-send update failed, falling back', {
        jobId: job.id, msg: updateErr.message,
      });
    } catch (err) {
      log.error('[sms-jobs] post-send update threw, falling back', {
        jobId: job.id, msg: errToString(err),
      });
    }

    if (!updateOk) {
      // Last-ditch fallback: mark 'dead' so the sweep cannot requeue this
      // row. The customer-facing status page will read 'dead' even though
      // the SMS did arrive — acceptable trade vs. sending a duplicate.
      try {
        await supabaseAdmin
          .from('sms_jobs')
          .update({
            status: 'dead',
            sent_at: sentAt,
            error_code: 'POST_SEND_DB_FAILURE',
            error_message: 'SMS sent successfully via Twilio, but post-send DB update failed. Marked dead to prevent duplicate send on next sweep.',
            started_at: null,
          })
          .eq('id', job.id);
      } catch (err) {
        // If even this fails, the watchdog sweep WILL requeue. Loud log.
        log.error('[sms-jobs] CRITICAL: post-send dead fallback failed too — sweep may duplicate', {
          jobId: job.id, pid: job.property_id, msg: errToString(err),
        });
      }
    }

    result.sent++;
    // Side-effect callback: don't let a failing callback derail us — the
    // SMS already went out and we've already moved the row out of sending.
    try {
      await applyMetadataCallback(job.metadata, 'sent', null);
    } catch (cbErr) {
      log.warn('[sms-jobs] metadata callback failed after send', {
        jobId: job.id, msg: errToString(cbErr),
      });
    }
  }

  return result;
}

/**
 * Side-effect: when a job carries `metadata.shiftConfirmationToken`, mirror
 * the terminal status onto the matching `shift_confirmations` row so the
 * Schedule tab UI badges reflect reality.
 *
 * Why this lives here and not in the route: the worker is the only place
 * that knows when Twilio actually accepted the message. The route can only
 * say "queued."
 *
 * Best-effort — a failure to update shift_confirmations should NOT mark
 * the SMS job as failed. We just log and move on.
 */
async function applyMetadataCallback(
  metadata: Record<string, unknown>,
  status: 'sent' | 'dead',
  errMsg: string | null,
): Promise<void> {
  const token = metadata?.shiftConfirmationToken;
  if (typeof token !== 'string' || token.length === 0) return;

  try {
    if (status === 'sent') {
      await supabaseAdmin
        .from('shift_confirmations')
        .update({ sms_sent: true, sms_error: null })
        .eq('token', token);
    } else {
      await supabaseAdmin
        .from('shift_confirmations')
        .update({ sms_sent: false, sms_error: errMsg ?? 'sms_dead' })
        .eq('token', token);
    }
  } catch (err) {
     
    console.warn(
      `[sms-jobs] shift_confirmations callback failed for token=${token}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Reset rows that have been stuck in 'sending' for `maxSeconds` or more.
 * The worker's container probably crashed mid-Twilio-call. Bounce them
 * back to 'queued' so the next tick picks them up again.
 *
 * Returns the number of rows reset.
 */
export async function resetStuckSmsJobs(maxSeconds = 300): Promise<number> {
  const { data, error } = await supabaseAdmin
    .rpc('staxis_reset_stuck_sms_jobs', { p_max_seconds: maxSeconds });
  if (error) {
    log.error('[sms-jobs] reset stuck rpc failed', { errorCode: error.code, msg: error.message });
    return 0;
  }
  return Number(data ?? 0);
}

// ─── error categorization ───────────────────────────────────────────────────

/**
 * Pull a Twilio error code off whatever shape the SDK / fetch wrapper
 * threw. Twilio's REST errors usually include a numeric `code` like
 * 21211 (invalid phone), 30007 (carrier filter), etc.
 */
function extractTwilioErrorCode(err: unknown): string | null {
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; status?: unknown };
    if (typeof e.code === 'number' || typeof e.code === 'string') return String(e.code);
    if (typeof e.status === 'number' || typeof e.status === 'string') return String(e.status);
  }
  return null;
}

/**
 * Return true if the error is one we should NOT retry. Saves Twilio
 * billing on doomed messages.
 *
 *   21211 — invalid 'To' number
 *   21408 — permission denied for region
 *   21610 — message blocked by recipient (STOP)
 *   21614 — 'To' is not a mobile number
 *   30003 — unreachable destination handset
 *   30005 — unknown destination handset
 *   30006 — landline / unreachable carrier
 */
const TERMINAL_TWILIO_CODES = new Set<string>([
  '21211', '21408', '21610', '21614', '30003', '30005', '30006',
]);

function isTerminalTwilioError(code: string | null): boolean {
  if (!code) return false;
  return TERMINAL_TWILIO_CODES.has(code);
}
