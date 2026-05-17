-- 0148_sms_jobs_sent_dirty_status.sql
-- Extend sms_jobs.status CHECK to include 'sent_dirty'.
--
-- WHY THIS EXISTS:
--   The SMS worker (src/lib/sms-jobs.ts processSmsJobs) used to mark a row
--   'dead' when Twilio returned success but the post-send Supabase write
--   failed. Logic was correct (preventing the stuck-job sweep from
--   requeuing and double-sending), but the manager-facing UI shows
--   'dead' as a red "failed" badge — exactly the opposite of the truth:
--   the housekeeper DID receive the message; only the DB row update
--   failed.
--
--   The audit's request-tracing report flagged this as a P1 silent UX
--   failure (Flow 3 risk #6). The fix is to mark the row with a new
--   terminal status 'sent_dirty' that says "Twilio confirmed delivery
--   but our internal bookkeeping lagged." The UI can render this
--   distinctly ("Sent (DB lag)" instead of "Failed").
--
-- WHAT THIS DOES:
--   * Drop the old check constraint and add a new one that includes
--     'sent_dirty' as a fifth terminal status.
--   * Old rows already at 'queued' / 'sending' / 'sent' / 'failed' /
--     'dead' continue to be valid — no data migration needed.
--
-- COMPATIBILITY:
--   * resetStuckSmsJobs only rescues rows in 'sending' state, so
--     'sent_dirty' rows are NOT requeued (which is the whole point —
--     we already sent to Twilio).
--   * applyMetadataCallback's 'sent' / 'dead' branches don't need to
--     change because 'sent_dirty' is set inline in the fallback branch,
--     never via applyMetadataCallback.

alter table public.sms_jobs
  drop constraint if exists sms_jobs_status_check;

alter table public.sms_jobs
  add constraint sms_jobs_status_check
  check (status in ('queued', 'sending', 'sent', 'sent_dirty', 'failed', 'dead'));

comment on column public.sms_jobs.status is
  'queued: pending pickup. sending: claimed by worker, Twilio call in flight. sent: Twilio confirmed + DB updated. sent_dirty: Twilio confirmed but post-send DB write failed (do NOT requeue — duplicate-send risk). failed: transient error, will retry. dead: max_attempts exhausted, will not retry.';

-- ─── Bookkeeping ────────────────────────────────────────────────────
insert into public.applied_migrations (version, description)
values ('0148', 'sms_jobs.status check extended to include sent_dirty (audit P1: post-send DB failure must not show as Failed)')
on conflict (version) do nothing;
