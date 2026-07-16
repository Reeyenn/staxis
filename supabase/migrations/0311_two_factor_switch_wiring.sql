-- 0311 — Wire the global human-2FA switch (app_settings.two_factor_enabled,
-- migration 0310) into the two Postgres-side enforcement points:
--
--   • public.mfa_verified_or_grace()      — the helper every gated RLS policy
--     calls (~76 policies). Switch OFF → returns TRUE for every session, so
--     data loads with zero blank pages and no JWT refresh needed.
--   • public.custom_access_token_hook()   — the JWT-claim minter. Switch OFF →
--     every user session gets mfa_verified=true, so Door B (server-side claim
--     reads) and any freshly-minted token agree with Door A (RLS).
--
-- Switch ON (the default) must be BYTE-IDENTICAL in behavior to today's live
-- prod. Both live definitions were read back from prod via
-- pg_get_functiondef() on 2026-07-15 before authoring this file:
--
--   • custom_access_token_hook — live body matches migration 0163 exactly.
--   • mfa_verified_or_grace    — live body is the GRACE version:
--         coalesce((auth.jwt() ->> 'mfa_verified')::boolean, TRUE)
--     NOT migration 0162's tightened coalesce-false version. The
--     applied_migrations table confirms why: 0162 was NEVER applied to prod
--     (no tracker row), and 0166 (the renumbered 0159, applied 08:32 UTC,
--     after 0163 at 07:36) re-created the grace-true helper. The grace
--     default is currently LOAD-BEARING: a returning user on a trusted
--     device signs straight in (check-trust cookie path) without writing a
--     mfa_verified_sessions row, so their JWT carries NO mfa_verified claim —
--     under coalesce-false all their RLS reads would deny (blank app).
--
-- This migration therefore preserves the live coalesce-TRUE default when the
-- switch is ON. Re-tightening the grace default is a separate decision with
-- its own rollout (it needs check-trust to start writing per-session
-- verification first) and is deliberately NOT bundled into this migration.
--
-- FAIL-SAFE DIRECTION (both functions): public.staxis_2fa_enabled() (0310)
-- returns TRUE on a missing row and is only consulted with "not ...", so a
-- broken/missing switch always resolves to "2FA on / today's behavior".
--   • In the hook, a thrown staxis_2fa_enabled() is caught by the existing
--     Phase-B exception handler → v_mfa_verified stays false → no claim
--     emitted (enforce).
--   • In mfa_verified_or_grace(), a thrown staxis_2fa_enabled() propagates
--     and the policy check errors — the query fails closed rather than
--     silently opening the gate.
--
-- This switch has NOTHING to do with the PMS/CUA robot's own MFA
-- (paused_mfa / awaiting_2fa / mfa-resume / pms-auth-code) — untouched.

-- ── 1. mfa_verified_or_grace() ─────────────────────────────────────────
--
-- Signature, language, volatility, and security mode identical to the live
-- function. The ONLY change: when the global switch is OFF, short-circuit to
-- TRUE before consulting the JWT claim. When ON, the expression reduces to
-- the live body exactly (false OR <live expression>).

create or replace function public.mfa_verified_or_grace()
returns boolean
language sql
stable
security invoker
as $$
  -- Global human-2FA switch OFF → every session passes. Otherwise the live
  -- (grace) default: mfa_verified claim from the JWT, TRUE when missing.
  select (not public.staxis_2fa_enabled())
      or coalesce((auth.jwt() ->> 'mfa_verified')::boolean, true);
$$;

comment on function public.mfa_verified_or_grace() is
  'Phase 2B helper + global 2FA switch (0311). Returns TRUE when the global '
  'human-2FA switch (app_settings.two_factor_enabled, 0310) is OFF; '
  'otherwise returns the mfa_verified JWT claim with the live grace default '
  '(TRUE when the claim is missing — verified against prod 2026-07-15; '
  'migration 0162''s tightened default was never applied, 0166 re-created '
  'the grace version). All ~76 gated policies call this.';

-- ── 2. custom_access_token_hook(event jsonb) ───────────────────────────
--
-- Full 0163 body reproduced verbatim (verified byte-equivalent to live prod
-- via pg_get_functiondef on 2026-07-15). The ONLY change is the new
-- `elsif not public.staxis_2fa_enabled()` branch inside the Phase-B compute
-- block: switch OFF → mfa_verified=true for every real user session,
-- skipping the skip_2fa/session-row checks; switch ON → the existing logic
-- runs unchanged. All nested exception guards and the emit-only-when-true
-- behavior are preserved.

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
    elsif not public.staxis_2fa_enabled() then
      -- 0311: global human-2FA switch is OFF → every real user session is
      -- mfa_verified. The v_user_id null-guard above still runs first so
      -- anon/service mints are untouched. If staxis_2fa_enabled() ever
      -- throws, the exception handler below leaves v_mfa_verified=false —
      -- the claim is not emitted and 2FA stays enforced (fail-safe).
      v_mfa_verified := true;
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
  'Audit 2026-05-22 Phase 2B + hotfix 0163 + global 2FA switch 0311. Writes '
  'password_signin_proofs on method=password (Phase A). Computes '
  'session-bound mfa_verified (Phase B): when the global human-2FA switch '
  '(app_settings.two_factor_enabled, 0310) is OFF the claim is true for '
  'every real user session; when ON the 0163 skip_2fa/session-row logic '
  'runs unchanged. Emits the claim ONLY when true. Failure paths leave the '
  'claim missing (fail-safe: enforce).';

notify pgrst, 'reload schema';

insert into public.applied_migrations (version, description)
values (
  '0311',
  'Wire the global 2FA switch into mfa_verified_or_grace() (short-circuit TRUE when off; live grace default preserved when on) and custom_access_token_hook (mfa_verified=true for all user sessions when off; 0163 logic unchanged when on).'
)
on conflict (version) do nothing;
