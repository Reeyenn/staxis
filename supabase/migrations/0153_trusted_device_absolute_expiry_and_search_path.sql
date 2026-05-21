-- 0153 — trusted_devices.absolute_expires_at + SECURITY DEFINER search_path pin.
--
-- Two security-plan items rolled into one migration:
--
-- F-03: Trust cookie has no absolute upper bound. Today's `expires_at` is
--   10 years from insert, and check-trust re-issues the cookie on every
--   successful trust check — so an active device stays trusted forever.
--   Add absolute_expires_at (default created_at + 365 days), enforced by
--   check-trust and NEVER bumped on re-issue. Backfill existing rows
--   defensively: never invalidate a device on day 1, but cap at 365d from
--   creation going forward.
--
-- F-05 + F-09: Pin search_path on two SECURITY DEFINER functions —
--   public.user_owns_property(uuid) (the foundation of every per-property
--   RLS policy) and public.staxis_release_join_code_slot(uuid) (called
--   from /api/auth/use-join-code on rollback). Newer SECURITY DEFINER
--   functions (0037, 0126) are already pinned to pg_catalog, public; this
--   brings the older ones into line. Defense-in-depth — on managed
--   Supabase the `authenticated` role can't create schemas anyway, but
--   the inconsistency itself is a footgun.
--
-- Idempotent. Safe to re-run.

-- ── F-03: absolute_expires_at on trusted_devices ──────────────────────

alter table public.trusted_devices
  add column if not exists absolute_expires_at timestamptz;

-- Backfill ANY rows where absolute_expires_at is currently null. The
-- math: give every existing device at least 30 days from this migration
-- to re-trust naturally (so we don't invalidate every active user on
-- the next sign-in), capped at 365 days from created_at going forward.
-- Without the greatest() floor, devices older than 1 year would get
-- absolute_expires_at in the past and bounce off the gate immediately.
update public.trusted_devices
   set absolute_expires_at = greatest(
     now() + interval '30 days',
     least(expires_at, created_at + interval '365 days')
   )
 where absolute_expires_at is null;

-- Lock the column down now that every row has a value.
alter table public.trusted_devices
  alter column absolute_expires_at set not null;

-- Default for new inserts. The trust-device route doesn't pass this
-- column on insert, so the default fills it in. 365 days from now is
-- the upper bound; the rolling expires_at can roll forward, but
-- absolute_expires_at is fixed at insert time.
alter table public.trusted_devices
  alter column absolute_expires_at set default (now() + interval '365 days');

-- ── F-05: pin search_path on user_owns_property(uuid) ─────────────────

-- This function gates every per-property RLS policy. Without an explicit
-- search_path, a SECURITY DEFINER function inherits the caller's session
-- search_path — historically a privilege-escalation primitive on
-- self-hosted Postgres. On managed Supabase `authenticated` can't add
-- schemas so the vector is closed in practice, but pinning the path
-- removes the inconsistency with the newer hardened functions and
-- silences the doctor's SECURITY DEFINER tripwire when we add one.
do $$
begin
  if exists (
    select 1 from pg_proc
    where proname = 'user_owns_property'
      and pronamespace = 'public'::regnamespace
  ) then
    execute 'alter function public.user_owns_property(uuid) set search_path = pg_catalog, public';
  end if;
end $$;

-- ── F-09: pin search_path on staxis_release_join_code_slot(uuid) ──────

do $$
begin
  if exists (
    select 1 from pg_proc
    where proname = 'staxis_release_join_code_slot'
      and pronamespace = 'public'::regnamespace
  ) then
    execute 'alter function public.staxis_release_join_code_slot(uuid) set search_path = pg_catalog, public';
  end if;
end $$;

-- Bookkeeping
insert into public.applied_migrations (version, description)
values (
  '0153',
  'F-03+F-05+F-09: trusted_devices.absolute_expires_at (with safe backfill) + search_path pin on user_owns_property and staxis_release_join_code_slot'
)
on conflict (version) do nothing;
