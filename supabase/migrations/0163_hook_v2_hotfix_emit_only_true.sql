-- Phase 2B hotfix (audit 2026-05-22, post-deploy Codex review finding #1).
--
-- Problem: hook v2 from migration 0160 unconditionally writes the
-- mfa_verified claim into the JWT — including writing it as `false` for
-- existing trusted users who don't yet have a mfa_verified_sessions row.
-- Migration 0161's RLS gate uses `coalesce((auth.jwt() ->> 'mfa_verified')::boolean, true)`
-- which only protects MISSING claims, not explicit-false claims. So
-- every legacy trusted user's NEXT token refresh produces a JWT with
-- mfa_verified=false → RLS denies their dashboard reads.
--
-- Fix: emit the claim ONLY when v_mfa_verified=true. Missing claim →
-- grace coalesce-true protects legacy sessions until they re-OTP. After
-- migration 0162 flips the helper to coalesce-false, missing claim
-- denies — same end-state, but the grace actually works during rollout.
--
-- Investor demo (test@staxis.local, skip_2fa=true) is unaffected:
-- still emits mfa_verified=true via the skip_2fa branch.
--
-- This migration is a CREATE OR REPLACE of the function from 0160. The
-- only behavior change is the final claim-emit block. Everything else
-- (proof writing, skip_2fa logic, session-id lookup) is preserved.

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
  v_user_id    := nullif(event ->> 'user_id', '')::uuid;
  v_method     := event ->> 'authentication_method';
  v_inner_claims := coalesce(event -> 'claims', '{}'::jsonb);
  v_session_id := nullif(v_inner_claims ->> 'session_id', '')::uuid;
  v_claims     := v_inner_claims;

  -- Phase A behavior preserved: write password proof when method='password'.
  if v_method = 'password' and v_user_id is not null then
    begin
      insert into public.password_signin_proofs (user_id, expires_at)
      values (v_user_id, now() + interval '10 minutes');
    exception when others then
      raise notice 'custom_access_token_hook: password proof insert failed for %: %', v_user_id, sqlerrm;
    end;
  end if;

  -- Phase B compute: determine if this session is mfa_verified.
  begin
    if v_user_id is null then
      null;  -- anon traffic / service-role mint
    else
      select a.skip_2fa, a.role
        into v_skip_2fa, v_role
        from public.accounts a
       where a.data_user_id = v_user_id
       limit 1;

      if v_skip_2fa is true and coalesce(v_role, '') <> 'admin' then
        v_mfa_verified := true;
      elsif v_session_id is not null then
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
    -- On failure, leave v_mfa_verified=false. The hotfix below means we
    -- WILL NOT emit a claim for the false case during the grace window,
    -- so legacy users are protected. After 0162 tightens coalesce to
    -- false, missing claim denies — failure mode is correctly fail-closed.
    v_mfa_verified := false;
  end;

  -- HOTFIX: emit the claim ONLY when true. Previously we always emitted
  -- (true or false), which broke the grace window for legacy users
  -- without mfa_verified_sessions rows. Now the JWT has the claim
  -- explicitly when we're confident the session is trusted, and
  -- otherwise omits it — letting `public.mfa_verified_or_grace()`'s
  -- coalesce default decide (true during grace, false post-0162).
  if v_mfa_verified then
    v_claims := v_claims || jsonb_build_object('mfa_verified', true);
  end if;

  return jsonb_set(event, '{claims}', v_claims);

exception when others then
  raise notice 'custom_access_token_hook: top-level exception for %: %', v_user_id, sqlerrm;
  -- Last-resort: return event unchanged. During grace, coalesce-true
  -- allows; after grace, coalesce-false denies. Fail-closed once
  -- migration 0162 lands.
  return event;
end;
$$;

comment on function public.custom_access_token_hook(jsonb) is
  'Audit 2026-05-22 Phase 2B + hotfix 0163. Writes password_signin_proofs '
  'on method=password (Phase A). Computes session-bound mfa_verified and '
  'emits claim=true ONLY when verified (Phase B + 0163 hotfix preserves '
  'grace for legacy sessions). Failure paths leave claim missing; '
  'coalesce default in mfa_verified_or_grace() decides (true grace / '
  'false post-tighten).';

notify pgrst, 'reload schema';

insert into public.applied_migrations (version, description)
values (
  '0163',
  'Audit 2026-05-22 hotfix: hook v2 emits mfa_verified claim only when true, preserves grace for legacy sessions (Codex review #1).'
)
on conflict (version) do nothing;
