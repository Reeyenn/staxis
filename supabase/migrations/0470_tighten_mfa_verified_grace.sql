-- 0470 — close the second door: a session that never proved a second factor
-- must not satisfy the ~117 RLS policies that gate on it.
--
-- ⚠️  DO NOT APPLY THIS ON ITS OWN. Read the rollout section at the bottom.
--     Applying it before the check-trust code change is live, and before every
--     active session has refreshed once, signs returning users into a blank
--     app. It is deliberately shipped unapplied.
--
-- ── WHAT IS WRONG TODAY ────────────────────────────────────────────────────
--
-- `public.custom_access_token_hook` emits the `mfa_verified` claim ONLY when
-- it is true (migration 0163). `public.mfa_verified_or_grace()` then reads
-- that claim with a permissive default:
--
--     coalesce((auth.jwt() ->> 'mfa_verified')::boolean, true)
--
-- so a JWT with NO claim — which is exactly what a bare
-- `signInWithPassword` produces, OTP never completed — reads as verified.
-- Every policy calling this helper therefore lets that session through.
-- Verified against production on 2026-08-07:
--
--     set_config('request.jwt.claims',
--       '{"sub":"…","role":"authenticated"}', true);
--     select public.mfa_verified_or_grace();   -- → true
--
-- 117 policies across 50 tables call it, including `staff`,
-- `labor_wage_settings`, `financial_expenses`, `work_orders`,
-- `schedule_assignments`, `inventory*` and `properties`. The website layer
-- (`requireSession` → `validateDeviceTrust`) does block `/api/*` for such a
-- session, but PostgREST and Realtime are a SEPARATE origin the browser
-- already talks to with the public anon key, and there `mfa_verified_or_grace`
-- is the only gate.
--
-- Migration 0162 was written to close precisely this and never landed: it has
-- no `applied_migrations` row, and 0166 (renumbered from 0159, applied after
-- 0163) re-created the permissive version. 0311 then carried that version
-- forward when it wired in the global switch, and its header says why the
-- tightening was deferred: `check-trust` did not write a per-session
-- verification row, so a returning user on a trusted device had no claim and
-- tightening would have denied all their reads.
--
-- ── WHY IT IS SAFE NOW ─────────────────────────────────────────────────────
--
-- `POST /api/auth/check-trust` now writes the `mfa_verified_sessions` row for
-- the session it just accepted (see `bindSessionVerification` in that route).
-- That was the missing prerequisite. Once that code is live, every session
-- that gets past either door has a row, so the hook mints the claim on the
-- next token issuance and the permissive default has nothing left to protect.
--
-- The global human-2FA switch is untouched and still wins: when
-- `app_settings.two_factor_enabled` is false the helper still short-circuits
-- to true for everyone, exactly as 0311 defined. This migration only changes
-- what happens when the switch is ON and the claim is ABSENT.
--
-- ── ROLLOUT ORDER (all three steps, in order) ──────────────────────────────
--
--   1. Ship the `check-trust` change to production and confirm it is live.
--   2. Wait for one full access-token lifetime (Supabase default: 1 hour) so
--      every active session has refreshed at least once and carries the claim.
--      Confirm with:
--        select count(*) from public.mfa_verified_sessions;   -- should climb
--   3. Apply this migration, then `notify pgrst, 'reload schema';`
--
-- ROLLBACK is one statement — re-run 0311's body to restore
-- `coalesce(..., true)`. No policy needs re-altering either way, which is the
-- whole reason every gated policy calls this helper instead of inlining the
-- expression.

create or replace function public.mfa_verified_or_grace()
returns boolean
language sql
stable
security invoker
as $$
  -- Global human-2FA switch OFF → every session passes (0311, unchanged).
  -- Switch ON → the mfa_verified claim decides, and a MISSING claim now
  -- denies. The claim is minted only for a session with a row in
  -- mfa_verified_sessions (or a skip_2fa demo account), so a session built
  -- from a password alone no longer reaches the browser-facing tables.
  select (not public.staxis_2fa_enabled())
      or coalesce((auth.jwt() ->> 'mfa_verified')::boolean, false);
$$;

comment on function public.mfa_verified_or_grace() is
  'Phase 2B helper + global 2FA switch. Returns TRUE when the global human-2FA '
  'switch (app_settings.two_factor_enabled, 0310) is OFF; otherwise returns the '
  'mfa_verified JWT claim, defaulting to FALSE when the claim is missing '
  '(0469, auth sweep 2026-08-07 — 0162 never landed and 0166 re-created the '
  'permissive default). Requires /api/auth/check-trust to write '
  'mfa_verified_sessions rows, which it now does.';

notify pgrst, 'reload schema';

insert into public.applied_migrations (version, description)
values (
  '0469',
  'Auth sweep 2026-08-07: tighten mfa_verified_or_grace() so a missing claim denies. Apply only after the check-trust session-binding change is live and sessions have refreshed.'
)
on conflict (version) do nothing;
