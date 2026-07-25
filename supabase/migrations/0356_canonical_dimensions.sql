-- ═══════════════════════════════════════════════════════════════════════════
-- 0356 — Two small dictionaries so the same thing stops having many names.
--
-- THE PROBLEM
-- Two kinds of value arrive from the PMS as bare text and are matched by
-- string comparison forever after:
--
--   1. People. A housekeeping report prints "MARIA GARCIA"; the staff table
--      says "Maria  Garcia". Two different normalizeName() implementations
--      exist in the codebase (src/lib/pms-rooms-server.ts strips diacritics,
--      src/lib/inventory-match.ts strips punctuation) and they disagree. When
--      they disagree, a housekeeper's rooms silently belong to nobody.
--   2. Categories. channel_name, room_type and rate_plan are free text. Every
--      spelling of "Booking.com" is a separate revenue line.
--
-- THE FIX
-- Two dictionaries, both allowed to be EMPTY on day one and to fill as data
-- arrives. Neither changes any behaviour by existing.
--
--   • staff_aliases — a name string seen for this hotel, optionally linked to
--     a staff member. staff_id NULL means "we have seen this name and do not
--     know who it is yet". One table, two states, no separate candidates
--     table. Normalization is a GENERATED column, so the database defines it
--     once and the two divergent TypeScript versions stop being able to drift.
--   • pms_dimension_values — one row per distinct raw value per dimension.
--     ONE table for all three dimensions rather than channels + channel_aliases
--     + room_classes, deliberately. canonical_code stays NULL until somebody
--     says what the value means, and every reader uses
--     coalesce(canonical_code, raw_value) so an unmapped value degrades to
--     exactly today's behaviour instead of disappearing from a report.
--
-- WHY BOTH START EMPTY
-- There is no ingest running today and no report has ever been read. Filling
-- these tables with guesses would be inventing history. They fill from real
-- events: an alias is recorded when a human assigns a room to a person, and a
-- dimension value is recorded when a report actually prints one.
--
-- NOT IN THE KNOWLEDGE FILE, for staff. pms_knowledge_files is per-PMS-family
-- and shared across every hotel on that family; staff names are per-hotel.
-- Dimension maps are a reasonable candidate for family-level promotion later,
-- but that must mint a NEW signed knowledge-file version through the existing
-- promotion flow — an in-place UPDATE would invalidate the signature.
--
-- APPLY ORDER: after 0355. Idempotent; safe to re-run. Non-destructive.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.staff'::regclass
       and contype  = 'u'
       and pg_get_constraintdef(oid) = 'UNIQUE (id, property_id)'
  ) then
    raise exception
      '0356 preflight: staff has no UNIQUE (id, property_id) — an alias could then point at another hotel''s staff member';
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────
-- staff_aliases — every name string this hotel has been called by.
--
-- @rls: service-role-only — written and read exclusively by /api routes using
-- supabaseAdmin, including the public unauthenticated housekeeper link. Same
-- posture as room_work (0355) and pms_* (0202).
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.staff_aliases (
  id            uuid        primary key default gen_random_uuid(),
  property_id   uuid        not null references public.properties(id) on delete cascade,

  -- NULL = "seen, not yet identified". The composite FK is what makes it
  -- impossible for one hotel's alias to resolve to another hotel's staff.
  staff_id      uuid,

  alias_raw     text        not null,
  -- The single definition of "same name". Computed by the database so the two
  -- divergent TypeScript implementations cannot drift apart again.
  alias_norm    text        generated always as (
                              lower(btrim(regexp_replace(alias_raw, '\s+', ' ', 'g')))
                            ) stored,

  source        text        not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  seen_count    integer     not null default 1,

  constraint staff_aliases_norm_unique unique (property_id, alias_norm),
  constraint staff_aliases_source_chk
    check (source = any (array['pms_import', 'manager', 'auto_exact', 'auto_first_name'])),
  constraint staff_aliases_seen_count_chk check (seen_count >= 0),
  constraint staff_aliases_staff_fk
    foreign key (staff_id, property_id)
    references public.staff (id, property_id)
    on delete set null (staff_id)
);

comment on table public.staff_aliases is
  'One row per distinct name string seen for a hotel''s staff. staff_id NULL = seen but not yet identified. alias_norm is GENERATED, so "same name" is defined once, in the database. Starts empty and fills as real assignments happen. Created 0356.';
comment on column public.staff_aliases.alias_norm is
  'lower + trim + collapse whitespace on alias_raw. The one definition of name equality; UNIQUE (property_id, alias_norm) enforces one meaning per spelling. Added 0356.';
comment on column public.staff_aliases.source is
  'How this alias got here: manager (a human linked it), pms_import (a report printed it), auto_exact / auto_first_name (matched by the resolver). Added 0356.';

alter table public.staff_aliases enable row level security;

drop policy if exists "deny browser staff_aliases" on public.staff_aliases;
create policy "deny browser staff_aliases" on public.staff_aliases
  for all to anon, authenticated using (false) with check (false);

revoke all on public.staff_aliases from anon, authenticated;
grant select, insert, update, delete on public.staff_aliases to service_role;

-- @query: src/lib/pms-rooms-server.ts buildStaffLookup (alias-first resolution)
create index if not exists staff_aliases_property_staff_idx
  on public.staff_aliases (property_id, staff_id);

-- @query: src/app/api/admin/onboarding-detail/route.ts unresolved-alias count
create index if not exists staff_aliases_unresolved_idx
  on public.staff_aliases (property_id)
  where staff_id is null;

-- ─────────────────────────────────────────────────────────────────────────
-- pms_dimension_values — every distinct raw category value a report printed.
--
-- @rls: service-role-only — an observation log written by the report ingest
-- and read by server routes. Never touched from a browser.
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.pms_dimension_values (
  id             uuid        primary key default gen_random_uuid(),
  property_id    uuid        not null references public.properties(id) on delete cascade,

  -- Which PMS family printed it. Recorded per row so a family-level canonical
  -- map can later be promoted into pms_knowledge_files without guessing.
  pms_family     text,

  dimension      text        not null,
  raw_value      text        not null,
  value_norm     text        generated always as (
                               lower(btrim(regexp_replace(raw_value, '\s+', ' ', 'g')))
                             ) stored,

  -- NULL until somebody says what it means. Readers use
  -- coalesce(canonical_code, raw_value), so NULL costs nothing.
  canonical_code text,
  resolved_at    timestamptz,
  resolved_by    text,

  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  seen_count     integer     not null default 1,

  constraint pms_dimension_values_unique unique (property_id, dimension, value_norm),
  constraint pms_dimension_values_dimension_chk
    check (dimension = any (array['channel', 'room_class', 'rate_plan'])),
  constraint pms_dimension_values_seen_count_chk check (seen_count >= 0),
  constraint pms_dimension_values_resolved_chk
    check ((canonical_code is null) = (resolved_at is null))
);

comment on table public.pms_dimension_values is
  'Observation log of every distinct raw channel / room class / rate plan value a PMS report has printed for a property. canonical_code is NULL until someone maps it; readers coalesce(canonical_code, raw_value) so an unmapped value degrades to itself rather than vanishing. Starts empty. Created 0356.';
comment on column public.pms_dimension_values.canonical_code is
  'The agreed meaning of raw_value, or NULL for "nobody has said yet". Set together with resolved_at (CHECK). Added 0356.';
comment on column public.pms_dimension_values.pms_family is
  'The PMS family whose report printed this value. Lets a stable per-family map be promoted into a NEW signed pms_knowledge_files version later; never edit an active knowledge file in place, it is signed. Added 0356.';

alter table public.pms_dimension_values enable row level security;

drop policy if exists "deny browser pms_dimension_values" on public.pms_dimension_values;
create policy "deny browser pms_dimension_values" on public.pms_dimension_values
  for all to anon, authenticated using (false) with check (false);

revoke all on public.pms_dimension_values from anon, authenticated;
grant select, insert, update, delete on public.pms_dimension_values to service_role;

-- @query: src/lib/pms/dimension-values.ts recordDimensionValues (unresolved list)
create index if not exists pms_dimension_values_unresolved_idx
  on public.pms_dimension_values (property_id, dimension)
  where canonical_code is null;

-- Both tables are Staxis-owned dictionaries, not report data. They are
-- deliberately NOT registered in pms_table_schemas and carry no ingest_run_id:
-- a dictionary entry is an accumulated observation across many reports, so
-- stamping it with one report's receipt would be a false receipt.

do $$
begin
  if to_regclass('public.staff_aliases') is null
     or to_regclass('public.pms_dimension_values') is null then
    raise exception '0356 postflight: a dictionary table was not created';
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.staff_aliases'::regclass
       and conname = 'staff_aliases_staff_fk'
  ) then
    raise exception '0356 postflight: staff_aliases_staff_fk is missing — cross-hotel aliases would be possible';
  end if;
end $$;

insert into public.applied_migrations (version, description)
values (
  '0356',
  'Canonical dimensions: staff_aliases (name string -> staff member, GENERATED alias_norm so name equality is defined once in the database, composite FK blocks cross-hotel links) and pms_dimension_values (distinct raw channel / room_class / rate_plan values with a nullable canonical_code). Both service-role-only, both start empty and fill from real events.'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
