-- ═══════════════════════════════════════════════════════════════════════════
-- 0018 — Scraper credentials table (multi-property scaffolding)
--
-- Today the Railway scraper reads CA_USERNAME / CA_PASSWORD / HOTELOPS_PROPERTY_ID
-- from env vars. That's fine for property #1; it locks us in to "one Railway
-- service per hotel" — a non-starter when sales pipeline gets to property #5.
--
-- This migration creates the storage layer for property-keyed credentials so
-- a future scraper refactor can:
--   1. Iterate every active row in scraper_credentials each tick.
--   2. Load that property's CA login + persistent Playwright storage state
--      from scraper_session (already keyed by property_id since 0011).
--   3. Run pulls per-property with isolated browser contexts.
--
-- Schema-first now, scraper refactor next. Today's behavior is unchanged —
-- the env-var path is still used. New properties are onboarded by inserting
-- a row here and (later) restarting the scraper.
--
-- SECURITY:
--   ca_password is stored in plaintext for now. Rotate to pgcrypto with a
--   server-side master key when we have >2 properties. Today's blast radius
--   is identical to keeping it in Railway env vars (the same service-role
--   key reads either). RLS is deny-all to anon/authenticated; service_role
--   only — same model as accounts and applied_migrations.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.scraper_credentials (
  property_id      uuid primary key references public.properties(id) on delete cascade,
  -- Choice Advantage. Other PMS types are a future migration.
  pms_type         text not null default 'choice_advantage' check (pms_type in ('choice_advantage')),
  ca_login_url     text not null default 'https://www.choiceadvantage.com/choicehotels/Welcome.init',
  ca_username      text not null,
  ca_password      text not null,
  -- Optional: per-property scraper toggles for staged rollout.
  is_active        boolean not null default true,
  -- For multi-instance scraping (when one Railway service polls many
  -- properties), we tag each credential with which scraper instance owns
  -- it. Default 'default' means "any scraper instance can pick this up";
  -- setting it to a specific id pins this property to one Railway deployment.
  scraper_instance text not null default 'default',
  -- Optional notes for ops ("started using new password 2026-04-29 after
  -- CA security audit"). Helps when debugging login failures.
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists scraper_credentials_active_idx
  on public.scraper_credentials (scraper_instance, is_active)
  where is_active = true;

-- Service-role only.
alter table public.scraper_credentials enable row level security;

drop policy if exists scraper_credentials_deny_browser on public.scraper_credentials;
create policy scraper_credentials_deny_browser on public.scraper_credentials
  for all
  to anon, authenticated
  using (false)
  with check (false);

comment on table public.scraper_credentials is
  'Per-property PMS scraper credentials. Service-role only. Loaded by the Railway scraper to support multi-property polling without per-property Railway services.';
comment on column public.scraper_credentials.scraper_instance is
  'Tag identifying which Railway scraper instance owns this property. Default ''default''. Use specific ids to pin a property to a particular scraper deployment for staged rollouts or geo-distributed scrapers.';
comment on column public.scraper_credentials.is_active is
  'Soft toggle. Set false to pause polling for a property without deleting credentials. Indexed-where-true so the scraper''s "load active properties" query stays fast.';

-- updated_at trigger (mirrors the pattern in 0001).
create or replace function public.touch_scraper_credentials_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists scraper_credentials_touch_updated_at on public.scraper_credentials;
create trigger scraper_credentials_touch_updated_at
  before update on public.scraper_credentials
  for each row
  execute function public.touch_scraper_credentials_updated_at();

insert into public.applied_migrations (version, description)
values ('0018', 'Scraper credentials table (multi-property scaffolding)')
on conflict (version) do nothing;
