-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0034: Self-service signup + billing + per-property service config
--
-- Three concerns landing in one migration because they're tightly coupled
-- by the signup flow:
--
--   1. subscription_status, trial_ends_at, stripe_customer_id,
--      stripe_subscription_id — wire Stripe into properties so we can
--      gate access on subscription state. Trial properties work fully
--      for 14 days; after that the dashboard nudges them to add a card,
--      and the cua-service worker stops processing their onboarding
--      jobs (existing properties keep working — we don't churn data).
--
--   2. services_enabled — JSONB toggle map. Some hotels (extended-stay,
--      Residence Inn, Candlewood, Staybridge) don't have daily
--      housekeeping. Without per-property toggles, our dashboard
--      assumes daily HK and turns away ~30% of prospects.
--
--   3. property_kind — limited-service / extended-stay / boutique.
--      Coarse categorization that drives default services_enabled,
--      onboarding wizard copy, and reporting templates. We could
--      derive this from PMS type but better to make it explicit.
--
-- Re-runnable: every column add is `if not exists`. Existing properties
-- get sensible defaults (status='active', services_enabled with everything
-- on, property_kind='limited_service' to match Comfort Suites Beaumont).
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Subscription columns ────────────────────────────────────────────
alter table public.properties
  add column if not exists subscription_status     text not null default 'trial'
    check (subscription_status in ('trial', 'active', 'past_due', 'cancelled', 'incomplete')),
  add column if not exists trial_ends_at           timestamptz,
  add column if not exists stripe_customer_id      text,
  add column if not exists stripe_subscription_id  text;

-- Existing properties (Comfort Suites Beaumont) are grandfathered into
-- 'active' status — they pre-date the billing system, we don't yank
-- them off the system because of a schema change.
update public.properties
set subscription_status = 'active'
where created_at < now() - interval '7 days'
  and subscription_status = 'trial';

create index if not exists properties_subscription_status_idx
  on public.properties (subscription_status)
  where subscription_status in ('trial', 'past_due');

create index if not exists properties_stripe_customer_idx
  on public.properties (stripe_customer_id)
  where stripe_customer_id is not null;

-- Trial-end check: if a property is in 'trial' status and trial_ends_at
-- has passed, the application layer treats it as 'past_due'. We don't
-- enforce in SQL because we want grace periods for support escalation,
-- but the column exists for the cron job that flips statuses.

comment on column public.properties.subscription_status is
  'Lifecycle: trial → active (after Stripe checkout) → past_due (failed payment) → cancelled. trial_ends_at marks the auto-flip from trial to past_due when no card is on file.';

comment on column public.properties.stripe_customer_id is
  'Stripe customer object id (cus_xxx). Null until the GM goes through checkout. One customer per property — even if the same person owns multiple properties, each is billed separately for clean per-property cancellation.';

-- ─── 2. services_enabled ────────────────────────────────────────────────
-- JSONB shape:
--   { housekeeping: bool, laundry: bool, maintenance: bool,
--     deep_cleaning: bool, public_areas: bool, inventory: bool,
--     equipment: bool }
--
-- Every existing feature gets a key here. The dashboard hides nav items
-- whose key is false. Stripe subscription tier could in the future
-- gate which services are toggleable; for v0 all are toggleable.

alter table public.properties
  add column if not exists services_enabled jsonb not null default jsonb_build_object(
    'housekeeping',  true,
    'laundry',       true,
    'maintenance',   true,
    'deep_cleaning', true,
    'public_areas',  true,
    'inventory',     true,
    'equipment',     true
  );

comment on column public.properties.services_enabled is
  'Per-property feature toggles. False keys hide the corresponding nav tab in the dashboard. Set during onboarding from the questionnaire (extended-stay properties typically have housekeeping=false).';

-- ─── 3. property_kind ───────────────────────────────────────────────────
alter table public.properties
  add column if not exists property_kind text not null default 'limited_service'
    check (property_kind in ('limited_service', 'extended_stay', 'full_service', 'boutique', 'other'));

comment on column public.properties.property_kind is
  'Coarse property type. Drives default services_enabled values and onboarding wizard copy. Doesn''t affect billing (that''s subscription_status only).';

-- ─── 4. Self-signup flag ────────────────────────────────────────────────
-- Track which properties came in through self-signup vs admin-provisioned
-- (the legacy path). Useful for cohort analysis ("how do self-signups
-- retain vs admin-onboarded?") and for the support tooling to know which
-- ones might need extra hand-holding.

alter table public.properties
  add column if not exists onboarding_source text not null default 'admin'
    check (onboarding_source in ('admin', 'self_signup', 'sales_assisted', 'migration'));

comment on column public.properties.onboarding_source is
  'How this property got into the system. Admin = pre-provisioned by Reeyen. Self-signup = filled out the public /signup form. Sales-assisted = onboarded by a salesperson over a call. Migration = imported from another system.';

-- ─── Record migration ───────────────────────────────────────────────────
insert into public.applied_migrations (version, description)
values ('0034', 'Self-service signup + Stripe billing + services_enabled')
on conflict (version) do nothing;
