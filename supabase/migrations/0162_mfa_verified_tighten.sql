-- Phase 2B / Door B fix (audit 2026-05-22) — tighten the grace default.
--
-- Apply ~24h AFTER 0161 lands and the RLS sweep has been observed without
-- false-positive denials. Single-line CREATE OR REPLACE on the helper —
-- because every gated policy calls `public.mfa_verified_or_grace()`
-- instead of inlining the coalesce expression, this one change tightens
-- the default across all ~57 policies without re-ALTERing each one.
--
-- Before: coalesce((auth.jwt() ->> 'mfa_verified')::boolean, true)
-- After:  coalesce((auth.jwt() ->> 'mfa_verified')::boolean, false)
--
-- Semantic change:
-- - Legacy JWTs (issued before hook v2) lack the mfa_verified claim.
--   With grace=true they passed through. With grace=false they're
--   denied. By the time this migration applies (24h+ after 0161), all
--   active sessions have refreshed multiple times and carry the claim.
-- - JWTs with explicit mfa_verified=false (e.g., from a fresh
--   signInWithPassword with no matching mfa_verified_sessions row) are
--   denied either way. No behavior change for those.

create or replace function public.mfa_verified_or_grace()
returns boolean
language sql
stable
security invoker
as $$
  -- Grace ended. Missing claim now denies (default false).
  select coalesce((auth.jwt() ->> 'mfa_verified')::boolean, false);
$$;

comment on function public.mfa_verified_or_grace() is
  'Phase 2B helper (post-grace, audit 2026-05-22). Returns mfa_verified '
  'claim from the JWT, or FALSE if missing. All ~57 gated policies now '
  'deny by default for unverified sessions.';

notify pgrst, 'reload schema';

insert into public.applied_migrations (version, description)
values (
  '0162',
  'Audit 2026-05-22 Phase 2B: tighten mfa_verified_or_grace() to coalesce(..., false). Apply 24h after 0161.'
)
on conflict (version) do nothing;
