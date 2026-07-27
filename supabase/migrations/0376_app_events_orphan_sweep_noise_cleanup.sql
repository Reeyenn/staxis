-- 0376_app_events_orphan_sweep_noise_cleanup.sql
--
-- One-time removal of 18,174 stranded rows that are 71% of `app_events`.
--
-- ═══ WHAT THESE ROWS ARE ═════════════════════════════════════════════════
-- `/api/cron/sweep-orphan-auth-users` deletes auth users that never finished
-- signing up. It refuses to touch anything older than 7 days — a deliberate
-- safety rule — and it wrote one `app_events` row per refusal, EVERY RUN.
--
-- That is the bug. The refused users are permanently older than 7 days, so
-- they are refused again on every single run, forever. The cron ran every 30
-- minutes until 2026-07-19 and daily since. Each pass re-logged the same handful
-- of auth users, and the count grew without bound while carrying no new
-- information: every row after the first is a duplicate statement of a fact
-- that had not changed.
--
-- Verified in production 2026-07-27:
--   orphan_auth_user_skipped_too_old   18174   ← this migration deletes these
--   page_view                           4428
--   auth.skip_2fa_used                  2942
--   auth.trust_revoked                     7
--   auth.skip_2fa_blocked_by_env           6
--   auth.skip_2fa_account_not_allowlisted  3
--   orphan_auth_user_swept                 3   ← real actions, KEPT
--
-- ═══ WHY DELETING IS SAFE HERE ═══════════════════════════════════════════
-- `app_events` is a genuine longitudinal corpus and this migration is NOT a
-- precedent for trimming it. These specific rows are safe because they record
-- a NON-EVENT: "the sweeper looked at this user and, correctly, did nothing."
-- Nothing reads them (no dashboard, no report, no detector), they encode no
-- state transition, and the underlying fact — which auth users are being
-- refused — is still fully answerable from `auth.users` itself.
--
-- The companion code change makes the writer emit ONE summary row per run
-- instead of one row per refused user, so the same information survives at
-- 1/N the volume and the table stops growing on a no-op.
--
-- `orphan_auth_user_swept` rows are deliberately untouched: those record a real
-- irreversible action (an account was deleted) and are exactly what an audit
-- would want.
--
-- ═══ NOT AUTO-APPLIED ════════════════════════════════════════════════════
-- Migrations in this repo are applied by hand. This one deletes rows, so read
-- the count first:
--
--   select count(*) from public.app_events
--    where event_type = 'orphan_auth_user_skipped_too_old';
--
-- Expect ~18k. If it is wildly different, stop and re-read the situation
-- before running the delete below.

-- Bounded, oldest-first, in batches — so this never holds a long lock, even if
-- the count has grown well past 18k by the time it is applied.
do $$
declare
  v_deleted   bigint := 0;
  v_batch     bigint;
begin
  loop
    with doomed as (
      select id
        from public.app_events
       where event_type = 'orphan_auth_user_skipped_too_old'
       order by ts asc
       limit 2000
    )
    delete from public.app_events ae
     using doomed
     where ae.id = doomed.id;

    get diagnostics v_batch = row_count;
    v_deleted := v_deleted + v_batch;
    exit when v_batch = 0;
  end loop;

  raise notice 'app_events: deleted % stranded orphan-sweep rows', v_deleted;
end $$;

-- Leave a marker so the history of this table explains its own shape: someone
-- looking at row counts later should not have to rediscover why 71% of the
-- table vanished on one day.
comment on table public.app_events is
  'Longitudinal product/ops event corpus. NOTE: migration 0376 removed ~18k '
  '`orphan_auth_user_skipped_too_old` rows — a no-op sweeper logged one row per '
  'refused user on every run, forever. The writer now emits one summary row per '
  'run. This was a one-off; app_events is otherwise keep-everything.';

INSERT INTO public.applied_migrations (version, description)
VALUES ('0376', 'One-time removal of ~18k stranded orphan_auth_user_skipped_too_old rows — 71% of app_events. The orphan sweeper wrote one row per refused auth user on EVERY run, and the refused users are permanently older than its 7-day floor, so each run re-logged the same handful forever. Deletes in bounded batches. Safe because these rows record a non-event nothing reads; orphan_auth_user_swept rows (real deletions) are untouched, and the companion code change makes the writer emit one summary row per run. Not a precedent for trimming app_events generally.')
ON CONFLICT (version) DO NOTHING;
