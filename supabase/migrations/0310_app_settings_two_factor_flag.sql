-- 0310 — Global app-settings singleton + the two_factor_enabled switch.
--
-- Backs an admin-toggleable GLOBAL 2FA on/off switch. There was no
-- global/singleton settings table before this (every toggle was
-- property-scoped), so we add one.
--
--   two_factor_enabled = TRUE  (default) → all HUMAN Staxis 2FA behaves
--     exactly like today (password-login-on-new-device OTP, admin device
--     trust, signup email confirm, phone-handoff code).
--   two_factor_enabled = FALSE → every one of those human 2FA prompts is
--     skipped. Data still loads because the mfa_verified door is opened at
--     the DB + server choke-points (migration 0311 + src/lib/api-auth.ts).
--
-- This switch DOES NOT touch the PMS/CUA robot's own MFA (paused_mfa /
-- awaiting_2fa / mfa-resume / pms-auth-code) — that machinery is separate
-- and stays fully active so the robot can keep logging into the hotel PMS.
--
-- Storage must be a DB row (not an env var) because 2FA enforcement is split
-- between the Postgres custom_access_token_hook (which mints the mfa_verified
-- JWT claim) and Next.js server code — only a DB row is readable by BOTH, and
-- only a DB row is flippable at runtime by a non-technical admin.

-- @rls: service-role-only — global app settings; admin writes via
-- /api/admin/settings (service role), auth hook reads via staxis_2fa_enabled().
create table if not exists public.app_settings (
  id                 boolean primary key default true,
  two_factor_enabled boolean not null default true,
  updated_at         timestamptz not null default now(),
  updated_by         uuid,
  -- Singleton guard: only one row, always id = true.
  constraint app_settings_singleton check (id = true)
);

-- Seed the single row (2FA ON = today's behavior).
insert into public.app_settings (id, two_factor_enabled)
values (true, true)
on conflict (id) do nothing;

-- Service-role-only from the browser. The anon/authenticated clients must not
-- read or write this row directly; the server (supabaseAdmin) and the reader
-- function below are the only access paths. Added to the doctor's
-- RLS_SERVICE_ROLE_ONLY_ALLOWLIST so the rls-coverage check does not flag it.
alter table public.app_settings enable row level security;
drop policy if exists app_settings_deny_browser on public.app_settings;
create policy app_settings_deny_browser on public.app_settings
  as permissive for all to anon, authenticated
  using (false) with check (false);

-- STABLE reader consumed by:
--   • public.custom_access_token_hook (runs as supabase_auth_admin)   [0311]
--   • public.mfa_verified_or_grace()  (SECURITY INVOKER, caller role) [0311]
-- SECURITY DEFINER so those callers don't need a direct SELECT grant on the
-- table (the deny-browser policy above stays intact). Fail-safe: a missing row
-- coalesces to TRUE (2FA ON), matching the fail-closed posture everywhere else.
create or replace function public.staxis_2fa_enabled()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select two_factor_enabled from public.app_settings where id = true limit 1),
    true
  );
$$;

grant execute on function public.staxis_2fa_enabled()
  to supabase_auth_admin, authenticated, anon;

comment on function public.staxis_2fa_enabled() is
  'Global human-2FA switch reader. TRUE (default) = 2FA enforced exactly as '
  'today. FALSE = all human Staxis 2FA disabled (admin-toggleable via '
  '/api/admin/settings). Does NOT affect the PMS/CUA robot MFA. Fail-safe: '
  'defaults TRUE when the app_settings row is missing.';

notify pgrst, 'reload schema';

insert into public.applied_migrations (version, description)
values (
  '0310',
  'Global app_settings singleton + two_factor_enabled flag + staxis_2fa_enabled() reader for the admin-toggleable global 2FA switch.'
)
on conflict (version) do nothing;
