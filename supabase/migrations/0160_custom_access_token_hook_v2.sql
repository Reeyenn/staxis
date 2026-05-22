-- Phase 2B / Door B fix (audit 2026-05-22) — custom_access_token_hook v2.
--
-- Supersedes the v1 function installed in migration 0158 via CREATE OR
-- REPLACE. v2 keeps the Phase A proof-writing behavior (insert a row
-- into password_signin_proofs when authentication_method='password')
-- AND adds the session-bound mfa_verified claim computation.
--
-- mfa_verified = true when:
--   - accounts.skip_2fa = true AND accounts.role <> 'admin'
--     (preserves Phase 1's admin-refusal policy + investor demo bypass)
--   - OR a mfa_verified_sessions row exists for the JWT's session_id
--   - OTHERWISE: false (with EXPLICIT false claim — see below)
--
-- Why explicit false instead of "missing claim":
--   The original design returned `event` unchanged on failures. That
--   made coalesce-true (grace) and coalesce-false (post-grace) produce
--   OPPOSITE results for the same failure, which is a latent landmine.
--   v2 writes mfa_verified=false explicitly so the failure mode is
--   deterministic across grace and post-grace.
--
-- DEFENSIVE: nested exception blocks ensure NO failure path blocks JWT
-- issuance. A broken hook would otherwise lock out every Staxis user
-- from signing in. The top-level catch writes mfa_verified=false; the
-- last-resort catch returns the event unchanged (avoids losing JWTs
-- entirely if even the explicit-false write throws).

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, auth
as $$
declare
  v_user_id    uuid;
  v_session_id uuid;
  v_method     text;
  v_skip_2fa   boolean := false;
  v_role       text;
  v_session_verified boolean := false;
  v_mfa_verified boolean := false;
  v_claims     jsonb;
  v_inner_claims jsonb;
begin
  -- Top-level claim extraction. Supabase Auth passes:
  --   event = { user_id, authentication_method, claims: { session_id, ... } }
  v_user_id    := nullif(event ->> 'user_id', '')::uuid;
  v_method     := event ->> 'authentication_method';
  v_inner_claims := coalesce(event -> 'claims', '{}'::jsonb);
  v_session_id := nullif(v_inner_claims ->> 'session_id', '')::uuid;
  v_claims     := v_inner_claims;

  -- ── Phase A behavior preserved: write password proof ───────────────
  -- When Supabase tags the token with authentication_method='password',
  -- write a password_signin_proofs row that /api/auth/trust-device
  -- requires before issuing the staxis_device cookie.
  if v_method = 'password' and v_user_id is not null then
    begin
      insert into public.password_signin_proofs (user_id, expires_at)
      values (v_user_id, now() + interval '10 minutes');
    exception when others then
      raise notice 'custom_access_token_hook: password proof insert failed for %: %', v_user_id, sqlerrm;
    end;
  end if;

  -- ── Phase B compute: session-bound mfa_verified ────────────────────
  begin
    if v_user_id is null then
      -- Anon traffic or service-role mint (hook shouldn't fire for these
      -- in practice, but be defensive). mfa_verified stays false.
      null;
    else
      -- Demo bypass path (preserves Phase 1 admin refusal).
      select a.skip_2fa, a.role
        into v_skip_2fa, v_role
        from public.accounts a
       where a.data_user_id = v_user_id
       limit 1;

      if v_skip_2fa is true and coalesce(v_role, '') <> 'admin' then
        v_mfa_verified := true;
      elsif v_session_id is not null then
        -- Session-bound trust check. THIS is the load-bearing change.
        -- An attacker creating a fresh signInWithPassword session gets
        -- a new session_id with no matching row → false → blocked.
        select exists (
          select 1
            from public.mfa_verified_sessions
           where session_id = v_session_id
        ) into v_session_verified;
        if v_session_verified then
          v_mfa_verified := true;
        end if;
      end if;
    end if;
  exception when others then
    raise notice 'custom_access_token_hook: mfa_verified compute failed for %: %', v_user_id, sqlerrm;
    -- Leave v_mfa_verified=false (initialized at declaration).
    -- Explicit deny on compute failure — better than silently letting
    -- the claim be absent and relying on the coalesce default, which
    -- inverts between grace and post-grace.
    v_mfa_verified := false;
  end;

  v_claims := v_claims || jsonb_build_object('mfa_verified', v_mfa_verified);
  return jsonb_set(event, '{claims}', v_claims);

exception when others then
  -- Last-resort top-level catch. Write mfa_verified=false explicitly
  -- so post-grace behavior is deterministic.
  raise notice 'custom_access_token_hook: top-level exception for %: %', v_user_id, sqlerrm;
  begin
    return jsonb_set(
      event,
      '{claims}',
      coalesce(event -> 'claims', '{}'::jsonb) || jsonb_build_object('mfa_verified', false)
    );
  exception when others then
    -- If even jsonb_set blew up (malformed event payload), return event
    -- unchanged — RLS coalesce default during grace will allow; after
    -- tightening, the missing claim coalesces to false and denies.
    -- Either way the user can still sign in (auth flow isn't broken).
    return event;
  end;
end;
$$;

-- ── Grants for the new reads ──────────────────────────────────────────
-- supabase_auth_admin needs SELECT on accounts (skip_2fa path) and
-- mfa_verified_sessions (session-trust path). Phase A migration 0158
-- already granted some of these; CREATE OR REPLACE is idempotent.

grant select on public.accounts to supabase_auth_admin;
grant select on public.mfa_verified_sessions to supabase_auth_admin;

-- RLS reader policy for the hook's role on accounts. The accounts table
-- has strict RLS (accounts_self_select via auth.uid()); the hook runs
-- under supabase_auth_admin which doesn't have auth.uid() context, so it
-- needs an explicit reader policy.
drop policy if exists accounts_auth_hook_read on public.accounts;
create policy accounts_auth_hook_read on public.accounts
  as permissive for select to supabase_auth_admin using (true);

-- (mfa_verified_sessions already has its supabase_auth_admin policy from 0159)

comment on function public.custom_access_token_hook(jsonb) is
  'Audit 2026-05-22 Phase 2B — v2. Writes password_signin_proofs rows on '
  'authentication_method=password (Phase A preserved) AND injects the '
  'session-bound mfa_verified claim (Phase B). Defense: nested exception '
  'blocks ensure failures never block JWT issuance. Explicit mfa_verified=false '
  'on any failure path so post-grace behavior is deterministic.';

notify pgrst, 'reload schema';

insert into public.applied_migrations (version, description)
values (
  '0160',
  'Audit 2026-05-22 Phase 2B: custom_access_token_hook v2 — session-bound mfa_verified claim.'
)
on conflict (version) do nothing;
