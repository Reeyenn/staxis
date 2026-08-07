-- ═══════════════════════════════════════════════════════════════════════════
-- Staxis / HotelOps AI — the wake counter counts (Migration 0466)
--
-- ONE FUNCTION. No new table, no new column, no widened grant.
--
-- ─── WHAT WAS WRONG ────────────────────────────────────────────────────────
--
-- `recordWake` in src/lib/companion/event-wake/state.ts wrote
--
--     wakes_today = <value read at the top of this sweep> + 1
--
-- with no predicate on the prior value. The window claim
-- (`claimWakeWindow`) IS a compare-and-set, but it compares on
-- `last_looked_at`, which `recordWake` never touches, so the two writes are not
-- one transaction and the claim does not cover the counter:
--
--   sweep A reads state         wakes_today = 3
--   sweep A claims the window   last_looked_at moves
--   sweep B reads state         wakes_today = 3   (A has not written it yet)
--   sweep A records its wake    wakes_today = 4
--   sweep B claims the window   succeeds, its prior IS A's new value
--   sweep B records its wake    wakes_today = 4   ← two wakes, one counted
--
-- The module doc claimed the claim covered this. It did not. What it costs is
-- the cheap half of the spend ceiling: MAX_WAKES_PER_DAY stops biting and only
-- the dollar cap is left, which is the expensive one to find out about.
--
-- ─── WHY THIS CANNOT BE DONE FROM THE CLIENT ───────────────────────────────
--
-- The fix is `wakes_today = wakes_today + 1`, computed by Postgres inside the
-- row lock the UPDATE already takes. PostgREST cannot express an update whose
-- new value references the old one, so it needs a function. That is the entire
-- reason this migration exists.
--
-- The day rollover is folded into the same statement, for the same reason: a
-- counter that reset in the application and incremented in the database would
-- have two writers of one number again.
--
-- ─── THE CODE SHIPS BEFORE THIS DOES ───────────────────────────────────────
--
-- Migrations are applied by hand (project_migration_application_manual.md), so
-- `recordWake` calls this function and FALLS BACK to the old read-modify-write
-- when the function is not there yet. The fallback is exactly the behaviour
-- that exists today: no worse than the current state, and it disappears the
-- moment this is applied.
--
-- Manual prod apply: per project_migration_application_manual.md.
-- Idempotent: create or replace. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.companion_event_wake_state') IS NULL THEN
    RAISE EXCEPTION '0466 requires companion_event_wake_state from migration 0459';
  END IF;
END
$$;

-- Returns the new value of wakes_today, so the caller can log what it actually
-- got rather than what it assumed. Returns NULL when the hotel has no cursor
-- row, which the caller treats the same way it treats a failed write: loudly,
-- because a lost wake count is a lost ceiling.
create or replace function public.staxis_companion_record_wake(
  p_property_id uuid,
  p_wakes_day   text,
  p_now         timestamptz
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_new integer;
begin
  if p_wakes_day is null or p_wakes_day !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'staxis_companion_record_wake: wakes_day must be YYYY-MM-DD';
  end if;

  update public.companion_event_wake_state
     set last_woke_at = p_now,
         -- THE WHOLE POINT. Both sides read the row as the UPDATE has it
         -- locked, so two overlapping sweeps serialise here instead of both
         -- writing the same number.
         wakes_today  = case when wakes_day = p_wakes_day then wakes_today else 0 end + 1,
         wakes_day    = p_wakes_day,
         wakes_total  = wakes_total + 1,
         updated_at   = p_now
   where property_id = p_property_id
  returning wakes_today into v_new;

  return v_new;
end;
$$;

comment on function public.staxis_companion_record_wake(uuid,text,timestamptz) is
  'Atomically count one companion event-wake for a hotel, resetting the counter when the hotel-local day has turned. The only correct writer of companion_event_wake_state.wakes_today: a read-modify-write from the application loses a count whenever two sweeps overlap, and the window claim does not cover it because that compare-and-set is on last_looked_at.';

revoke all on function public.staxis_companion_record_wake(uuid,text,timestamptz)
  from public, anon, authenticated;
grant execute on function public.staxis_companion_record_wake(uuid,text,timestamptz)
  to service_role;

insert into public.applied_migrations (version, description)
values (
  '0466',
  'Atomic increment for the companion event-wake counter'
)
on conflict (version) do nothing;

COMMIT;

notify pgrst, 'reload schema';
