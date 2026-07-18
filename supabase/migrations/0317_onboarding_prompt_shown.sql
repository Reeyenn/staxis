-- 0317: onboarding_prompt_shown_at — the 9-step setup wizard auto-opens at most
-- ONCE per hotel. The login funnel (property-selector / home / dashboard) sends a
-- mid-onboarding owner/manager into the wizard only while this is null; the
-- resume route stamps it on the first entry, so every later login lands them in
-- the app instead of re-opening the wizard. Server-only (set by
-- /api/onboard/resume via supabaseAdmin); no RLS change — the existing
-- properties policies already cover this column.

alter table properties
  add column if not exists onboarding_prompt_shown_at timestamptz;

insert into public.applied_migrations (version, description)
values ('0317', 'properties.onboarding_prompt_shown_at — wizard auto-opens once per hotel')
on conflict (version) do nothing;
