-- Custom access token hook v1 — Hole #1 fix (audit 2026-05-22).
--
-- Supabase Auth calls this function on every JWT issuance and passes an
-- event payload containing { user_id, authentication_method, claims }.
-- We inspect authentication_method and write a password_signin_proofs
-- row ONLY when the method is 'password'. Methods like 'otp',
-- 'magiclink', 'recovery', 'token_refresh', 'oauth' do NOT write a row.
--
-- The proof is the gate that /api/auth/trust-device checks. An attacker
-- calling supabase.auth.signInWithOtp({email}) directly cannot lie about
-- the authentication_method — Supabase tags it as 'otp' regardless of
-- the caller. So the attacker gets a valid JWT but no proof, and
-- trust-device refuses to issue a persistent staxis_device cookie.
--
-- Phase B will replace this function (CREATE OR REPLACE in migration
-- 0159) to ALSO compute and inject the mfa_verified claim. v1 only
-- handles proof writing; mfa_verified is not yet in the JWT.
--
-- DEFENSIVE: the hook is wrapped in exception blocks so a function
-- failure can NEVER block JWT issuance. A broken hook would otherwise
-- lock out every Staxis user from signing in.
--
-- DASHBOARD STEP (manual, after applying this migration):
-- Supabase Dashboard → Authentication → Hooks → Custom Access Token →
-- enable, function = public.custom_access_token_hook. Until this is
-- done, the function exists but is never invoked, and the trust-device
-- proof check (in app code) will reject every user. See RUNBOOKS.md.

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
volatile  -- writes to password_signin_proofs, so not STABLE
security definer
set search_path = public, auth
as $$
declare
  v_user_id uuid;
  v_method text;
begin
  v_user_id := (event ->> 'user_id')::uuid;
  v_method := event ->> 'authentication_method';

  -- Phase A (Hole #1): write password proof when authentication method is
  -- 'password'. Wrapped in its own exception block so an insert failure
  -- (DB hiccup, FK race) doesn't propagate up and block the JWT.
  if v_method = 'password' then
    begin
      insert into public.password_signin_proofs (user_id, expires_at)
      values (v_user_id, now() + interval '10 minutes');
    exception when others then
      raise notice 'custom_access_token_hook: password proof insert failed for %: %', v_user_id, sqlerrm;
    end;
  end if;

  return event;

exception when others then
  -- Last-resort guard: if anything else throws (NULL fields, type
  -- coercion, etc.), return the event unchanged so JWT issuance still
  -- succeeds. Better to let the user sign in without a proof (and have
  -- trust-device reject them, prompting a retry) than to lock everyone
  -- out of auth entirely.
  raise notice 'custom_access_token_hook: top-level exception for %: %', v_user_id, sqlerrm;
  return event;
end;
$$;

-- Grants per Supabase Auth Hooks docs:
-- https://supabase.com/docs/guides/auth/auth-hooks/custom-access-token-hook
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook(jsonb) from authenticated, anon, public;

comment on function public.custom_access_token_hook(jsonb) is
  'Audit 2026-05-22 Hole #1 fix (v1). Writes password_signin_proofs rows '
  'when authentication_method=''password''. Phase B (migration 0159) will '
  'extend this function to also inject the mfa_verified claim for Door B.';

notify pgrst, 'reload schema';

insert into public.applied_migrations (version, description)
values (
  '0158',
  'Audit 2026-05-22 Hole #1: custom_access_token_hook v1 writes password_signin_proofs on method=password.'
)
on conflict (version) do nothing;
