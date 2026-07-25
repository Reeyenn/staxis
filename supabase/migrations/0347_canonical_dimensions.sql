-- ═══════════════════════════════════════════════════════════════════════════
-- 0347 — Stop matching people and booking sources by typed-out names
-- ═══════════════════════════════════════════════════════════════════════════
-- Two observation tables, both deliberately starting EMPTY. Neither changes
-- any behaviour on its own; they give the free-text strings that arrive from a
-- PMS report somewhere to be recorded and, later, resolved.
--
-- (i) public.staff_aliases — "this is what the PMS calls this person"
--
--     Name matching today happens in TypeScript, twice, DIFFERENTLY:
--     src/lib/pms-rooms-server.ts normalizeName() strips diacritics and keeps
--     punctuation; src/lib/inventory-match.ts normalizeName() strips
--     punctuation and keeps diacritics. Two functions with the same name and
--     different answers is a bug waiting for a name with an apostrophe.
--     alias_norm is a GENERATED column, so normalization has exactly one
--     definition and the database computes it.
--
--     staff_id NULL means "we have seen this name and nobody has said who it
--     is". That is a state of an alias, not a different kind of thing — hence
--     one table, not an aliases table plus a candidates table.
--
-- (ii) public.pms_dimension_values — "this is what the PMS calls this channel
--      / room class / rate plan"
--
--     ONE table for all three free-text dimensions rather than channels +
--     channel_aliases + room_classes. Every distinct raw value the ingest sees
--     gets recorded; canonical_code stays NULL until somebody maps it; and
--     every reader takes coalesce(canonical_code, raw_value), so an unmapped
--     value degrades to exactly today's behaviour instead of disappearing.
--     That last rule is code-level — SQL cannot express "the reader must not
--     drop unmapped rows" — and is the one thing here worth a unit test.
--
--     Where a stabilised map eventually lives: pms_knowledge_files.knowledge,
--     the existing per-family versioned surface (0201, signed since 0215), so
--     every hotel on that PMS family inherits it. NOTE for whoever builds that
--     promotion: the knowledge payload is SIGNED. An in-place UPDATE of an
--     active file invalidates its signature — the map has to be promoted as a
--     NEW version through the existing sign-and-promote flow.
--
--     Staff deliberately do NOT go in the knowledge file: staff names are
--     per-hotel, knowledge files are per-PMS-family.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ─── staff_aliases ───────────────────────────────────────────────────────────
-- @rls: service-role-only — resolved and written by /api/* routes with
-- supabaseAdmin and by the ingest. Never browser-readable (it maps a hotel's
-- staff to the names a third-party system prints). Deny-all policy below.
create table if not exists public.staff_aliases (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references public.properties(id) on delete cascade,
  -- NULL = "name seen, not yet mapped to anyone". One table, two states.
  staff_id      uuid,
  alias_raw     text not null,
  -- ONE definition of name normalization, computed by the database. Replaces
  -- two divergent TypeScript normalizeName() implementations.
  alias_norm    text generated always as (
                  lower(btrim(regexp_replace(alias_raw, '\s+', ' ', 'g')))
                ) stored,
  source        text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  seen_count    integer not null default 1,

  constraint staff_aliases_norm_unique unique (property_id, alias_norm),
  constraint staff_aliases_source_chk
    check (source = any (array['pms_import', 'manager', 'auto_exact', 'auto_first_name'])),
  constraint staff_aliases_seen_count_chk check (seen_count >= 0),
  -- Composite, not a plain staff_id FK: this makes it structurally impossible
  -- for one hotel's alias to point at another hotel's staff member. Uses the
  -- existing staff_id_property_id_key.
  constraint staff_aliases_staff_fk
    foreign key (staff_id, property_id)
    references public.staff (id, property_id)
    on delete set null
);

comment on table public.staff_aliases is
  'What a PMS calls a member of this hotel''s staff. staff_id NULL = seen but unmapped. alias_norm is GENERATED so name normalization has exactly one definition. Service-role only. Created 0347.';
comment on column public.staff_aliases.alias_norm is
  'GENERATED: lower(btrim(collapse-internal-whitespace(alias_raw))). The UNIQUE on (property_id, alias_norm) is what makes "one name string maps to at most one person" a fact rather than a convention. Created 0347.';

-- @query: the alias resolver in src/lib/pms-rooms-server.ts looks up an unresolved name for a property
create index if not exists staff_aliases_unmapped_idx
  on public.staff_aliases (property_id, last_seen_at desc)
  where staff_id is null;

-- ─── pms_dimension_values ────────────────────────────────────────────────────
-- @rls: service-role-only — written by the ingest, read by /api/* with
-- supabaseAdmin. Deny-all policy below.
create table if not exists public.pms_dimension_values (
  id             uuid primary key default gen_random_uuid(),
  property_id    uuid not null references public.properties(id) on delete cascade,
  pms_family     text not null,
  dimension      text not null,
  raw_value      text not null,
  value_norm     text generated always as (lower(btrim(raw_value))) stored,
  -- NULL until somebody says what this value means. Readers take
  -- coalesce(canonical_code, raw_value), so unmapped degrades to today.
  canonical_code text,
  resolved_at    timestamptz,
  resolved_by    text,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  seen_count     integer not null default 1,

  constraint pms_dimension_values_unique unique (property_id, dimension, value_norm),
  constraint pms_dimension_values_dimension_chk
    check (dimension = any (array['channel', 'room_class', 'rate_plan'])),
  constraint pms_dimension_values_seen_count_chk check (seen_count >= 0),
  -- A resolution has a time and an author, or it has not happened.
  constraint pms_dimension_values_resolution_chk
    check ((canonical_code is null and resolved_at is null and resolved_by is null)
           or (canonical_code is not null and resolved_at is not null))
);

comment on table public.pms_dimension_values is
  'Every distinct free-text channel / room class / rate plan value a PMS has printed for this property, and what it maps to. ONE table for three dimensions on purpose. canonical_code NULL = unmapped; readers use coalesce(canonical_code, raw_value) so an unmapped value degrades to itself rather than vanishing. Service-role only. Created 0347.';

-- @query: the admin "unmapped values" count reads unresolved values per property
create index if not exists pms_dimension_values_unresolved_idx
  on public.pms_dimension_values (property_id, dimension, last_seen_at desc)
  where canonical_code is null;

-- ─── RLS + grants + updated_at (same pattern as 0202 / 0276) ─────────────────
do $$
declare
  tbl text;
begin
  for tbl in select unnest(array['staff_aliases', 'pms_dimension_values'])
  loop
    execute format('alter table public.%I enable row level security', tbl);
    execute format('revoke all on public.%I from public, anon, authenticated', tbl);
    execute format('grant select, insert, update, delete on public.%I to service_role', tbl);
    execute format('drop policy if exists %I on public.%I', tbl || '_deny_all_browser', tbl);
    execute format(
      'create policy %I on public.%I for all to anon, authenticated using (false) with check (false)',
      tbl || '_deny_all_browser', tbl
    );
    execute format(
      'comment on policy %I on public.%I is %L',
      tbl || '_deny_all_browser', tbl,
      'Service-role only. Written by the ingest, read via /api/* with supabaseAdmin. Created 0347.'
    );
  end loop;
end $$;

insert into public.applied_migrations (version, description)
values (
  '0347',
  'Canonical dimensions: staff_aliases (identity for PMS-printed names, one GENERATED normalization) + pms_dimension_values (one observation log for channel / room_class / rate_plan)'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
