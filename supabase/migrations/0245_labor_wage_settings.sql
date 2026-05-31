-- Migration 0245: Labor wage settings — backs the Labor Cost % widget.
-- ════════════════════════════════════════════════════════════════════════════
-- Stores the hourly wages used to cost the published schedule into a live
-- "labor cost as a % of revenue" tile on the owner Dashboard. Two scopes:
--
--   • scope='role'   — a per-department DEFAULT wage (one of the 4 schedule
--                      departments: housekeeping / front_desk / maintenance /
--                      other). Applies to anyone in that department who has no
--                      personal override.
--   • scope='person' — an OPTIONAL per-staff override that beats the role
--                      default for that one person.
--
-- Resolution order at cost time (see src/lib/labor-cost.ts resolveWageCents):
--   per-person override → role default → existing staff.hourly_wage → benchmark
--   (DEFAULT_HOURLY_WAGE_CENTS). staff.hourly_wage is intentionally kept as the
--   third fallback so the existing wage data keeps working; nothing here
--   deletes or migrates it.
--
-- SECURITY: wages are sensitive pay data — the most sensitive surface after
-- the finance ledger. This table is SERVICE-ROLE-ONLY: RLS enabled with NO
-- browser-readable policy (deny-all for anon + authenticated). Every read and
-- write goes through /api/settings/wages and /api/dashboard/labor-cost, which
-- use supabaseAdmin behind requireSession + a management role gate
-- (admin / owner / general_manager) + userHasPropertyAccess. There is
-- intentionally NO anon/authenticated read path, so a non-manager can never
-- pull another person's wage even with a valid session, and the
-- RLS-empty-state bug class cannot apply. Mirrors migration 0237 (financials).
--
-- Money is stored as INTEGER CENTS (hourly_wage_cents) — no floats, matching
-- the financials convention.
-- ════════════════════════════════════════════════════════════════════════════

set search_path = public, pg_catalog;
set local lock_timeout = '10s';

-- @rls: service-role-only — sensitive pay data; all access via
--   /api/settings/wages + /api/dashboard/labor-cost (supabaseAdmin behind
--   requireSession + management role gate). No anon/authenticated read path.
create table if not exists public.labor_wage_settings (
  id                 uuid primary key default gen_random_uuid(),
  property_id        uuid not null references public.properties(id) on delete cascade,

  -- 'role'  → a department default; 'person' → a single-staff override.
  scope              text not null check (scope in ('role', 'person')),

  -- Set when scope='role'. One of the 4 scheduled_shifts departments.
  role               text check (role in ('housekeeping', 'front_desk', 'maintenance', 'other')),

  -- Set when scope='person'. Cascade-deletes the override if the staff row goes.
  staff_id           uuid references public.staff(id) on delete cascade,

  -- Hourly wage in integer cents. Bounded: > $0 and <= $2,000/hr (a sanity
  -- ceiling that still comfortably covers any real hotel role; blocks a
  -- fat-fingered "150000" meaning $1,500 from landing as $1,500/hr unnoticed
  -- while leaving room for genuine salaried-equivalent rates).
  hourly_wage_cents  integer not null check (hourly_wage_cents > 0 and hourly_wage_cents <= 200000),

  updated_by         uuid,   -- auth uid of the manager who last saved (snapshot, no FK)

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- Scope/shape consistency: a role default carries a role and no staff_id; a
  -- person override carries a staff_id and no role. Keeps the two scopes from
  -- ever colliding in the resolver.
  constraint labor_wage_settings_scope_shape check (
    (scope = 'role'   and role is not null and staff_id is null)
    or
    (scope = 'person' and staff_id is not null and role is null)
  )
);

-- One row per (property, scope, role-or-*, staff-or-zero). The coalesce keys
-- let a single unique index cover both scopes: role rows key on the role with
-- a zero staff_id sentinel; person rows key on the staff_id with a '*' role
-- sentinel. Matches the upsert/replace logic in /api/settings/wages.
create unique index if not exists labor_wage_settings_unique
  on public.labor_wage_settings (
    property_id,
    scope,
    coalesce(role, '*'),
    coalesce(staff_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

-- Read path is always "all wage settings for this property" (the resolver and
-- the settings page both load the full set), so a plain property_id index is
-- the only one needed.
create index if not exists labor_wage_settings_property_idx
  on public.labor_wage_settings (property_id, scope);

drop trigger if exists labor_wage_settings_touch on public.labor_wage_settings;
create trigger labor_wage_settings_touch
  before update on public.labor_wage_settings
  for each row execute function public.touch_updated_at();

-- ── RLS: enable, NO browser policy (service-role-only / deny-all) ────────────
-- supabaseAdmin (server) bypasses RLS for the /api paths. With RLS on and zero
-- permissive policies, anon + authenticated browser roles are denied every row
-- — the strongest cross-tenant posture for sensitive pay data.
alter table public.labor_wage_settings enable row level security;

-- Belt-and-braces: revoke any default table grants from the browser roles so
-- access depends solely on RLS (which denies) + service-role (which bypasses).
revoke all on public.labor_wage_settings from anon, authenticated;

-- PostgREST caches the schema; force a reload so the new table is queryable.
notify pgrst, 'reload schema';

-- Self-register so the doctor's applied-migrations check + the
-- migration-bookkeeping drift test see this version.
insert into public.applied_migrations (version, description)
values ('0245', 'labor_wage_settings: per-role default + per-person override hourly wages (cents) — service-role-only, backs the Labor Cost % widget')
on conflict (version) do nothing;
