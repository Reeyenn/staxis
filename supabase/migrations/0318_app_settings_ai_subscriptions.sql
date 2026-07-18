-- 0318 — AI-subscription lines on the global app_settings singleton.
--
-- Backs the "Running Staxis" half of Mission Control's AI-spend screen
-- (owner ask 2026-07-18): the AI the founder pays for personally to build
-- and run the company — flat monthly subscriptions (Claude plan, Codex,
-- etc.), NOT metered API spend. These are numbers only the founder knows,
-- entered once in the UI and edited rarely, so they live as a jsonb list
-- on the existing service-role-only settings singleton (0310) rather than
-- their own table.
--
-- Shape: [{ "id": "sub_...", "name": "Claude Max", "monthlyUsd": 200 }, ...]
-- Written only via /api/admin/mission/ai-spend (requireAdmin + service role).

alter table public.app_settings
  add column if not exists ai_subscriptions jsonb not null default '[]'::jsonb;

insert into public.applied_migrations (version, description)
values ('0318', 'app_settings.ai_subscriptions: flat monthly AI-subscription lines for the Mission Control spend screen')
on conflict (version) do nothing;
