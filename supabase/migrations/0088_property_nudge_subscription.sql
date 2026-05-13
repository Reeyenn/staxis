-- Migration 0087: per-property nudge subscription
--
-- Adversarial review (2026-05-13) finding A-H9: getNudgeRecipients in
-- src/lib/agent/nudges.ts:135-147 includes any account with property_access
-- containing the wildcard '*' (i.e. admins). Today only Reeyen is an admin
-- — the next support-team hire instantly receives every property's nudge ×
-- every category × every 5-min cron tick. With 50 properties that's
-- ~144,000 nudges/day per admin.
--
-- Two-pronged fix (TS side handled in nudges.ts):
--   1. Drop admins from the cron-driven fan-out entirely. Admins can use
--      a future "all properties" admin view but don't get default
--      subscription.
--   2. Add per-property opt-in/opt-out via this column. Default null = use
--      the existing fallback (owners + GMs of the property).

alter table public.properties
  add column if not exists nudge_subscription jsonb;

comment on column public.properties.nudge_subscription is
  'Per-property nudge recipient override. Shape: { enabled: boolean, recipient_account_ids: uuid[] }. NULL = fall back to owners + general_managers with property_access. enabled=false silences all nudges for the property. Codex adversarial review 2026-05-13 (A-H9).';

-- Helpful index for the (rare) case where ops wants to find properties
-- that have explicitly opted out.
create index if not exists properties_nudge_disabled_idx
  on public.properties (id)
  where (nudge_subscription ->> 'enabled')::boolean is false;

insert into public.applied_migrations (version, description)
values ('0088', 'Codex review: per-property nudge subscription column (A-H9)')
on conflict (version) do nothing;
