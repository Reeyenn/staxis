-- ═══════════════════════════════════════════════════════════════════════════
-- 0462 — "Skip this one": one occurrence of an upkeep schedule, put down
--        without anybody claiming the work happened.
--
-- WHY THIS COLUMN HAD TO EXIST
-- A preventive schedule on the Staxis list carried exactly one button: Done.
-- Real life has a third answer that is neither "it happened" nor "somebody has
-- been called" — the pool heater service that is genuinely not worth doing this
-- cycle because the pool is drained, the quarterly deep clean the week the
-- carpets are being replaced anyway. Until now the only way to clear one of
-- those was to tap Done, which writes `last_completed_at` and therefore writes
-- into this hotel's maintenance record that a job nobody performed was
-- performed. That is the single most damaging thing this feature could get
-- wrong (see src/lib/findings/preventive-log.ts), and it was the only exit.
--
-- ═══ WHY IT IS NOT `last_completed_at` WITH A DIFFERENT `last_completed_by` ═══
-- `last_completed_by` is free text and the temptation is to write "Skipped" into
-- it and move the date. Every reader of these two columns — the detector, the
-- Preventive tab's bands, the work-order trigger below, an auditor six months
-- from now — treats a moved date as a performed service. One free-text word
-- cannot undo that for all of them, and the readers that got it wrong would be
-- silently wrong. A skip is a different fact and it gets its own column.
--
-- ═══ WHY THE REST IS SELF-EXPIRING, AND WHY THAT MATTERS ═══
-- The rest runs for ONE FULL CADENCE from the moment of the skip:
--   quiet while  today < skipped_at + frequency_days
-- That is deliberately not "until the next scheduled occurrence", because a
-- schedule that is 200 days late on a 30-day cadence would come straight back,
-- and a person who just said "not this one" would read that as the button
-- having done nothing.
--
-- It also means NO TRIGGER IS NEEDED to clear this flag when the work is later
-- done, which is the whole reason it is shaped this way. `called_at` needed one
-- (0366 §4) because a stale called_at could suppress a LATER cycle's card. A
-- stale skipped_at cannot: if the job is completed at time C, the next due date
-- is C + frequency_days, and C > skipped_at, so the rest window has always
-- closed before the schedule is due again. The flag goes inert on its own.
--
-- `last_completed_at` IS NOT TOUCHED. That is the point. A skipped schedule
-- still reports honestly on the Preventive tab as "last done <the real date>",
-- and the lateness the card shows when it comes back is measured from the real
-- date, not from the skip.
--
-- ACCESS MODEL — UNCHANGED. Same reasoning as 0366: `preventive_tasks` carries
-- its four existing RLS policies, the new columns inherit them, and grants are
-- table-level so nothing needs re-granting. The Staxis list writes these through
-- service-role behind the /api/worklist/complete gates, never from the browser.
--
-- NOT APPLIED automatically — migrations are applied by hand (CLAUDE.md).
-- Idempotent; safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.preventive_tasks
  add column if not exists skipped_at timestamptz,
  add column if not exists skipped_by text;

comment on column public.preventive_tasks.skipped_at is
  'Somebody put THIS occurrence down without the work being done. Set by "Skip this one" on the Staxis list. While it is set, the schedule stays quiet for one full cadence from that instant (skipped_at + frequency_days), then comes back as an ordinary due card with its real lateness intact. Deliberately does NOT move last_completed_at: nothing was serviced. Self-expiring, so no trigger clears it. Added 0462.';

comment on column public.preventive_tasks.skipped_by is
  'Display name of whoever skipped the occurrence. Free text, same convention as called_by and last_completed_by.';

-- Same guard, and for the same reason, as preventive_tasks_called_at_not_future
-- (0366): a skipped_at in the future is a schedule silenced for longer than
-- anybody asked for, and a typo that does it leaves no trace. NOT VALID so the
-- constraint governs new writes without a table rewrite on rows that predate it.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'preventive_tasks_skipped_at_not_future'
  ) then
    alter table public.preventive_tasks
      add constraint preventive_tasks_skipped_at_not_future
      check (skipped_at is null or skipped_at <= now() + interval '1 day') not valid;
  end if;
end $$;

insert into public.applied_migrations (version, description)
values ('0462', 'preventive_tasks.skipped_at/skipped_by: one occurrence put down without claiming the work happened')
on conflict (version) do nothing;
