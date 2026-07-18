-- 0319 — on-demand subscription-audit request flag.
--
-- The Money tab's "Check my subscriptions" button (owner ask 2026-07-18)
-- can't read the founder's Gmail from the web app — the audit runs as a
-- scheduled Claude session on his Mac. The button just stamps this column;
-- the daily scheduled task sweeps receipts whenever it's set (or on its
-- weekly Monday run) and clears it afterwards.

alter table public.app_settings
  add column if not exists subscription_audit_requested_at timestamptz;

insert into public.applied_migrations (version, description)
values ('0319', 'app_settings.subscription_audit_requested_at: Money-tab check-my-subscriptions button flag')
on conflict (version) do nothing;
