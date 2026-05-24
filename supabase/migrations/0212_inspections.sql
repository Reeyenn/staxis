-- ═══════════════════════════════════════════════════════════════════════════
-- 0212 — inspections: housekeeping QA workflow + correction loop
--
-- Adds three tables and one staff column for the housekeeping inspections
-- workflow described in HOUSEKEEPING_FEATURES.md sections 9 and 11.
--
-- inspections
--   One row per inspection event. Pass / fail / cancelled. failed_items is
--   a jsonb array of {item_id, label, severity, photo_url, note} entries
--   recorded by the inspector. When the inspection fails, a correction
--   notice is surfaced to the original housekeeper (via the linked
--   cleaning_task and rooms.issue_note update). After she re-cleans,
--   the inspector can chain a re-check via recheck_inspection_id.
--   escalated=true after the third consecutive fail on the same room.
--
-- inspection_checklists
--   Configurable checklist templates. property_id NULL means a global
--   default any property can use. applies_to_cleaning_types and
--   applies_to_room_types are text arrays — empty array means "all".
--   The lib/inspections checklist-selector picks the most specific
--   active checklist that matches a given cleaning_type+room_type.
--
-- inspection_checklist_items
--   Per-checklist items. label + label_es for bilingual display.
--   severity_default sets the starting severity in the UI; the inspector
--   can override per fail. requires_photo_on_fail=true forces a photo
--   upload before the inspector can submit a fail for that item.
--
-- staff.can_inspect
--   Per-staff flag. The InspectorView component on /housekeeper/[id]
--   only renders for staff rows with can_inspect=true. Single column on
--   staff so the public housekeeper page can role-gate without joining
--   accounts (which uses auth-user identity, not staff identity).
--
-- Seed
--   Inserts one global default checklist ("Standard Departure Clean")
--   with a 15-item canonical list covering bathroom / bedroom / living
--   / kitchen / welcome categories. Properties can override with their
--   own checklist via the manager UI.
--
-- RLS posture
--   Service-role only — matches the rest of the new schema (pms_*,
--   cleaning_tasks). All UI reads/writes go through /api/* with
--   supabaseAdmin. Browser anon/authenticated roles are deny-all.
--
-- Manual prod apply per project_migration_application_manual.md.
-- Idempotent — safe to re-run; uses create-if-not-exists everywhere.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Add can_inspect to staff ────────────────────────────────────────────
alter table public.staff
  add column if not exists can_inspect boolean not null default false;
comment on column public.staff.can_inspect is
  'When true, the InspectorView on /housekeeper/[id] renders an inspection queue for this staff member. Set per-staff via the manager UI. Added 0212.';

-- ── 2. inspection_checklists ───────────────────────────────────────────────
-- @rls: service-role-only — all UI access mediated by /api/housekeeping/inspections/* via supabaseAdmin (matches pms_* and cleaning_tasks).
create table if not exists public.inspection_checklists (
  id                          uuid primary key default gen_random_uuid(),
  property_id                 uuid references public.properties(id) on delete cascade,

  name                        text not null,
  applies_to_cleaning_types   text[] not null default array[]::text[],
  applies_to_room_types       text[] not null default array[]::text[],

  is_active                   boolean not null default true,
  version                     integer not null default 1,

  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

comment on table public.inspection_checklists is
  'Templates for inspection checklists. property_id NULL means a global default available to every property. Created 0212.';
comment on column public.inspection_checklists.applies_to_cleaning_types is
  'Cleaning types this checklist matches (departure, stayover, refresh, deep, ...). Empty array means all types.';
comment on column public.inspection_checklists.applies_to_room_types is
  'Room types this checklist matches (suite, standard, ...). Empty array means all room types.';

create index if not exists inspection_checklists_property_idx
  on public.inspection_checklists (property_id, is_active);

-- ── 3. inspection_checklist_items ──────────────────────────────────────────
create table if not exists public.inspection_checklist_items (
  id                     uuid primary key default gen_random_uuid(),
  checklist_id           uuid not null references public.inspection_checklists(id) on delete cascade,

  category               text not null
                         check (category in ('bathroom','bedroom','living','kitchen','welcome','other')),
  label                  text not null,
  label_es               text,

  severity_default       text not null default 'minor'
                         check (severity_default in ('minor','major','critical')),
  requires_photo_on_fail boolean not null default false,

  order_index            integer not null default 0,

  created_at             timestamptz not null default now()
);

comment on table public.inspection_checklist_items is
  'Items within an inspection checklist. label_es is the Spanish translation shown when the inspector has lang=es. Created 0212.';

create index if not exists inspection_checklist_items_checklist_idx
  on public.inspection_checklist_items (checklist_id, order_index);

-- ── 4. inspections ─────────────────────────────────────────────────────────
-- @rls: service-role-only — all UI access mediated by /api/housekeeping/inspections/* via supabaseAdmin (matches pms_* and cleaning_tasks).
create table if not exists public.inspections (
  id                       uuid primary key default gen_random_uuid(),
  property_id              uuid not null references public.properties(id) on delete cascade,

  room_number              text not null,
  room_id                  uuid,
  cleaning_task_id         uuid,
  checklist_id             uuid references public.inspection_checklists(id) on delete set null,

  inspector_staff_id       uuid,
  housekeeper_staff_id     uuid,

  started_at               timestamptz not null default now(),
  completed_at             timestamptz,

  result                   text not null default 'in_progress'
                           check (result in ('in_progress','pass','fail','cancelled')),

  -- jsonb arrays of {item_id, label, severity, photo_url, note} (failed)
  -- and item_id strings (passed). Stored on the row for forensic history
  -- so the checklist can evolve without losing the snapshot.
  failed_items             jsonb not null default '[]'::jsonb,
  passed_items             jsonb not null default '[]'::jsonb,

  -- Correction chain. correction_notice_sent_at is the moment the
  -- housekeeper was notified (room.issue_note set). recheck_inspection_id
  -- chains to the next inspection in the loop.
  correction_notice_sent_at timestamptz,
  recheck_inspection_id    uuid references public.inspections(id) on delete set null,
  parent_inspection_id     uuid references public.inspections(id) on delete set null,

  notes                    text,
  escalated                boolean not null default false,
  escalation_reason        text,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

comment on table public.inspections is
  'One row per inspection event. result=pass marks the room ready; result=fail triggers a correction notice on the room. Re-inspections chain via recheck_inspection_id. Created 0212.';
comment on column public.inspections.failed_items is
  'jsonb array of {item_id, label, severity, photo_url, note}. severity in (minor,major,critical). photo_url is a Supabase Storage path.';
comment on column public.inspections.escalated is
  'Set true when this is the third consecutive fail on the same room (or via the configurable threshold). The manager sees these flagged red.';

create index if not exists inspections_property_room_idx
  on public.inspections (property_id, room_number, started_at desc);
create index if not exists inspections_property_result_idx
  on public.inspections (property_id, result, started_at desc);
create index if not exists inspections_inspector_idx
  on public.inspections (inspector_staff_id, started_at desc);
create index if not exists inspections_housekeeper_idx
  on public.inspections (housekeeper_staff_id, started_at desc);
create index if not exists inspections_cleaning_task_idx
  on public.inspections (cleaning_task_id);

-- ── 5. RLS — service role only, matches pms_* / cleaning_tasks ─────────────
alter table public.inspection_checklists       enable row level security;
alter table public.inspection_checklist_items  enable row level security;
alter table public.inspections                 enable row level security;

revoke all on public.inspection_checklists      from public, anon, authenticated;
revoke all on public.inspection_checklist_items from public, anon, authenticated;
revoke all on public.inspections                from public, anon, authenticated;

grant select, insert, update, delete on public.inspection_checklists      to service_role;
grant select, insert, update, delete on public.inspection_checklist_items to service_role;
grant select, insert, update, delete on public.inspections                to service_role;

drop policy if exists inspection_checklists_deny_all on public.inspection_checklists;
create policy inspection_checklists_deny_all on public.inspection_checklists
  for all to anon, authenticated using (false) with check (false);

drop policy if exists inspection_checklist_items_deny_all on public.inspection_checklist_items;
create policy inspection_checklist_items_deny_all on public.inspection_checklist_items
  for all to anon, authenticated using (false) with check (false);

drop policy if exists inspections_deny_all on public.inspections;
create policy inspections_deny_all on public.inspections
  for all to anon, authenticated using (false) with check (false);

-- updated_at trigger — reuses the _pms_set_updated_at function from 0202.
drop trigger if exists set_updated_at on public.inspection_checklists;
create trigger set_updated_at before update on public.inspection_checklists
  for each row execute function public._pms_set_updated_at();

drop trigger if exists set_updated_at on public.inspections;
create trigger set_updated_at before update on public.inspections
  for each row execute function public._pms_set_updated_at();

-- ── 6. Seed: standard departure checklist ──────────────────────────────────
-- Global (property_id NULL). Properties can override by creating their
-- own. 15 items covering the canonical room turnover.
do $$
declare
  v_checklist_id uuid;
begin
  -- Idempotent: only seed if no global standard departure checklist exists.
  select id into v_checklist_id
  from public.inspection_checklists
  where property_id is null
    and name = 'Standard Departure Clean'
  limit 1;

  if v_checklist_id is null then
    insert into public.inspection_checklists
      (property_id, name, applies_to_cleaning_types, applies_to_room_types, is_active, version)
    values
      (null, 'Standard Departure Clean', array['departure','departure_deep']::text[], array[]::text[], true, 1)
    returning id into v_checklist_id;

    insert into public.inspection_checklist_items
      (checklist_id, category, label, label_es, severity_default, requires_photo_on_fail, order_index)
    values
      (v_checklist_id, 'bedroom', 'Bed made with hospital corners',          'Cama hecha con esquinas hospitalarias',  'major',    false, 10),
      (v_checklist_id, 'bedroom', 'Linens fresh, no hair or stains',         'Sábanas limpias, sin pelo ni manchas',   'critical', true,  20),
      (v_checklist_id, 'bedroom', 'Pillows fluffed and centered',            'Almohadas mullidas y centradas',         'minor',    false, 30),
      (v_checklist_id, 'bedroom', 'Nightstands dusted and clear',            'Mesitas de noche limpias y despejadas',  'minor',    false, 40),
      (v_checklist_id, 'bathroom','Toilet clean inside and out',             'Inodoro limpio por dentro y por fuera',  'critical', true,  50),
      (v_checklist_id, 'bathroom','Shower / tub scrubbed, no soap scum',     'Ducha / tina restregada, sin jabón',     'critical', true,  60),
      (v_checklist_id, 'bathroom','Mirror polished, no streaks',             'Espejo pulido, sin rayas',               'major',    false, 70),
      (v_checklist_id, 'bathroom','Towels folded and stocked',               'Toallas dobladas y abastecidas',         'minor',    false, 80),
      (v_checklist_id, 'bathroom','Amenities stocked (soap, shampoo)',       'Amenidades abastecidas (jabón, champú)', 'major',    false, 90),
      (v_checklist_id, 'living',  'Floor vacuumed, no debris',               'Piso aspirado, sin escombros',           'major',    false, 100),
      (v_checklist_id, 'living',  'All trash removed',                       'Toda la basura retirada',                'critical', true,  110),
      (v_checklist_id, 'living',  'Surfaces dusted (TV, desk, lamps)',       'Superficies limpias (TV, escritorio)',   'minor',    false, 120),
      (v_checklist_id, 'kitchen', 'Coffee station stocked and clean',        'Estación de café abastecida y limpia',   'minor',    false, 130),
      (v_checklist_id, 'welcome', 'HVAC set to standard temp',               'Aire acondicionado a temperatura estándar','minor',  false, 140),
      (v_checklist_id, 'welcome', 'Room smells fresh',                       'La habitación huele a limpio',           'major',    false, 150);
  end if;
end $$;

-- ── 7. Storage bucket for inspection photos ────────────────────────────────
-- Bucket is private. Upload + read both go through /api/* with service-role
-- so the photos never leak via the anon client.
-- @storage: service-role-only — uploads via /api/(housekeeping|housekeeper)/inspections/upload-photo; reads via signed URLs minted server-side. Both routes validate pid+staffId+can_inspect (public) or session+property access (manager).
insert into storage.buckets (id, name, public)
values ('inspection-photos', 'inspection-photos', false)
on conflict (id) do nothing;

-- ── 8. Migration record ────────────────────────────────────────────────────
insert into public.applied_migrations (version, description)
values (
  '0212',
  'inspections: housekeeping QA workflow tables + standard departure checklist seed + inspection-photos storage bucket + staff.can_inspect column.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
