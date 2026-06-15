-- 0281_capability_overrides.sql
-- feature/access-control — per-hotel capability restrictions (the central
-- access rulebook's storage).
--
-- Model: by DEFAULT every hotel role gets every hotel-facing capability at every
-- hotel (the defaults live in app code: src/lib/capabilities/registry.ts
-- ROLE_DEFAULTS). An admin RESTRICTS a (capability, role) pair at a specific
-- hotel from the Admin → Access tab, which writes ONE row here with
-- allowed = false. Turning the toggle back ON deletes the row. So:
--   * an EMPTY table  = everyone-everything-everywhere (the default posture)
--   * a row           = a single restriction for one role at one hotel
--
-- `capability` and `role` are validated in app code against CAPABILITY_KEYS /
-- HOTEL_ROLES (no DB enum — the registry is the single source of truth and may
-- grow without a DDL). Admin-only capabilities (access_admin,
-- manage_pms_coverage) are NEVER written here: the resolver hard-codes them to
-- admin-only and the toggle API rejects them, so no override can grant a
-- Staxis-internal capability to a hotel role.
--
-- @rls: SERVICE-ROLE-ONLY (deny-all-browser), exactly like mapper_takeover_
-- sessions (0278) / pms_knowledge_files (0201). The web app reads this table
-- only through /api/* routes that use supabaseAdmin (the override table feeds
-- both the server gates and, via GET /api/capabilities/overrides, the browser's
-- PropertyContext). The browser NEVER touches it directly — an anon read would
-- silently return [] under RLS and make every hotel look unrestricted.

create table if not exists public.capability_overrides (
  id          uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties(id) on delete cascade,

  -- Validated against CAPABILITY_KEYS in app code (no DB enum on purpose).
  capability  text not null,
  -- One of the 5 hotel roles (HOTEL_ROLES). admin / staff are never written.
  role        text not null,

  -- The restriction. In practice only `false` rows exist (a toggle-OFF); the
  -- resolver also handles `true` so it stays idempotent if one is ever written.
  allowed     boolean not null,

  updated_by  uuid references public.accounts(id) on delete set null,
  updated_at  timestamptz not null default now(),

  -- One verdict per (hotel, capability, role). The toggle API upserts on this.
  unique (property_id, capability, role)
);

-- The unique constraint's index is (property_id, capability, role) — its
-- leftmost prefix already serves the per-hotel "load all overrides for this
-- property" read, so no extra property_id index is needed.

-- ─── RLS: service-role-only (deny-all-browser) ──────────────────────────────
alter table public.capability_overrides enable row level security;
revoke all on public.capability_overrides from public, anon, authenticated;
grant select, insert, update, delete on public.capability_overrides to service_role;

drop policy if exists capability_overrides_deny_all_browser on public.capability_overrides;
create policy capability_overrides_deny_all_browser
  on public.capability_overrides
  for all
  to anon, authenticated
  using (false) with check (false);
comment on policy capability_overrides_deny_all_browser on public.capability_overrides is
  'Deny all browser access. Next API routes (supabaseAdmin) only; service_role bypasses RLS. An anon read would return [] under RLS and falsely show every hotel as unrestricted.';

-- ─── Track the migration ─────────────────────────────────────────────────
insert into public.applied_migrations (version, description)
values ('0281', 'feature/access-control: capability_overrides — per-hotel (capability, role) restrictions for the central access rulebook + Admin Access tab. Empty = everyone-everything. Service-role only.')
on conflict (version) do nothing;

notify pgrst, 'reload schema';
