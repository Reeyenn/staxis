-- ═══════════════════════════════════════════════════════════════════════════
-- 0222 — Housekeeper mobile rebuild (piece A): workflow state machine,
--        checklists, exceptions, lunch breaks, rush + floor + manager notes.
--
-- Renumbered from 0214 → 0215 → 0222 across two rebases as parallel
-- branches (cua-vision Plan v8, voice issue reporting, reports engine,
-- inspections idempotency) all landed migrations in front of this one
-- while the housekeeper-mobile rebuild was in flight. 0222 is the next
-- free slot above main's 0221_inspections_seed_idempotency_and_unique.
--
-- Why this exists:
--   Piece A of the housekeeper mobile rebuild. The current page collapses
--   the whole clean into a single "Done" tap. Competitor parity work
--   (Optii / Flexkeeping / Alice) demands an explicit Start → Pause → Resume
--   → Done flow with per-cleaning-type checklists, five exception buttons
--   (DND / NSR / DLA / Sleep Out / Skipped), and lunch-break clock in/out.
--
-- What this migration changes:
--   A. rooms — adds workflow + exception + floor + manager-note + rush
--      columns. The existing is_dnd/dnd_note columns stay (for backward
--      compat with legacy DND-only writes) but new code writes through
--      exception_type='dnd' instead.
--   B. New table room_pause_events — audit of every Pause / Resume tap.
--   C. New table cleaning_checklist_templates — one row per
--      cleaning_type. property_id is nullable so a global default
--      ships with the migration; properties can override per-property
--      in a future branch.
--   D. New table cleaning_checklist_items — items inside a template,
--      grouped by area (bathroom/bedroom/etc.), with EN + ES text.
--   E. New table staff_breaks — lunch + short break clock in/out.
--   F. Default templates + items seeded for 5 cleaning types so the
--      housekeeper has something to check off the day this ships.
--
-- Tenant scoping:
--   property_id on every row. RLS: service-role only (matches existing
--   pms_* / cleaning_tasks posture). The housekeeper page reads/writes
--   through /api/housekeeper/* via supabaseAdmin.
--
-- Manual prod apply: per project_migration_application_manual.md.
-- Idempotent: create table if not exists + add column if not exists.
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── A. Extend rooms ─────────────────────────────────────────────────────

alter table public.rooms
  add column if not exists is_paused boolean default false,
  add column if not exists paused_at timestamptz,
  add column if not exists total_paused_seconds integer default 0,
  add column if not exists exception_type text,
  add column if not exists exception_note text,
  add column if not exists exception_at timestamptz,
  add column if not exists floor text,
  add column if not exists checklist_template_id uuid,
  add column if not exists checklist_progress jsonb default '[]'::jsonb,
  add column if not exists manager_notes text,
  add column if not exists is_rush boolean default false,
  add column if not exists rush_set_at timestamptz,
  add column if not exists rush_due_by timestamptz,
  add column if not exists rush_set_by uuid,
  add column if not exists marked_for_inspection_at timestamptz;

-- Allowed exception types — null means no exception. The names mirror
-- competitor PMS vocabulary so anyone moving from Optii recognizes them.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'rooms_exception_type_check'
      and conrelid = 'public.rooms'::regclass
  ) then
    alter table public.rooms
      add constraint rooms_exception_type_check
      check (
        exception_type is null
        or exception_type in ('dnd', 'nsr', 'dla', 'sleep_out', 'skipped')
      );
  end if;
end $$;

-- ─── B. room_pause_events ────────────────────────────────────────────────

create table if not exists public.room_pause_events (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid not null references public.properties(id) on delete cascade,
  room_id         uuid not null references public.rooms(id) on delete cascade,
  staff_id        uuid not null,
  business_date   date not null,
  paused_at       timestamptz not null,
  resumed_at      timestamptz,
  reason          text,
  created_at      timestamptz not null default now()
);

create index if not exists room_pause_events_room_idx
  on public.room_pause_events (room_id, paused_at desc);
create index if not exists room_pause_events_staff_date_idx
  on public.room_pause_events (property_id, staff_id, business_date);

alter table public.room_pause_events enable row level security;
revoke all on public.room_pause_events from public, anon, authenticated;
grant select, insert, update, delete on public.room_pause_events to service_role;
drop policy if exists room_pause_events_deny_all_browser on public.room_pause_events;
create policy room_pause_events_deny_all_browser on public.room_pause_events
  for all to anon, authenticated using (false) with check (false);

-- ─── C. cleaning_checklist_templates ─────────────────────────────────────

create table if not exists public.cleaning_checklist_templates (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid references public.properties(id) on delete cascade,
  cleaning_type   text not null
                  check (cleaning_type in (
                    'departure',
                    'stayover',
                    'deep',
                    'refresh',
                    'inspection'
                  )),
  name_en         text not null,
  name_es         text not null,
  is_default      boolean not null default false,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- One DEFAULT (property_id is null) per cleaning_type; one per-property
  -- override per cleaning_type. Enforced by two partial unique indexes.
  -- (Can't put a partial unique inside a single constraint clause in PG.)
  constraint cct_property_or_default
    check (property_id is not null or is_default = true)
);

create unique index if not exists cct_default_one_per_type_idx
  on public.cleaning_checklist_templates (cleaning_type)
  where property_id is null and is_default = true;

create unique index if not exists cct_property_one_per_type_idx
  on public.cleaning_checklist_templates (property_id, cleaning_type)
  where property_id is not null;

alter table public.cleaning_checklist_templates enable row level security;
revoke all on public.cleaning_checklist_templates from public, anon, authenticated;
grant select, insert, update, delete on public.cleaning_checklist_templates to service_role;
drop policy if exists cct_deny_all_browser on public.cleaning_checklist_templates;
create policy cct_deny_all_browser on public.cleaning_checklist_templates
  for all to anon, authenticated using (false) with check (false);

-- ─── D. cleaning_checklist_items ─────────────────────────────────────────

create table if not exists public.cleaning_checklist_items (
  id              uuid primary key default gen_random_uuid(),
  template_id     uuid not null references public.cleaning_checklist_templates(id) on delete cascade,
  area            text not null
                  check (area in (
                    'bathroom',
                    'bedroom',
                    'living',
                    'kitchen',
                    'entry',
                    'amenities',
                    'final'
                  )),
  item_en         text not null,
  item_es         text not null,
  sort_order      integer not null default 0,
  is_critical     boolean not null default false,
  created_at      timestamptz not null default now(),
  -- One item per (template, sort_order). Stable conflict target for the
  -- seed block at the bottom of this migration so re-running 0222 doesn't
  -- duplicate every default item (the unique generated-uuid PK alone made
  -- `on conflict do nothing` a no-op against itself).
  constraint cleaning_checklist_items_template_order_unique
    unique (template_id, sort_order)
);

create index if not exists cci_template_order_idx
  on public.cleaning_checklist_items (template_id, sort_order);

alter table public.cleaning_checklist_items enable row level security;
revoke all on public.cleaning_checklist_items from public, anon, authenticated;
grant select, insert, update, delete on public.cleaning_checklist_items to service_role;
drop policy if exists cci_deny_all_browser on public.cleaning_checklist_items;
create policy cci_deny_all_browser on public.cleaning_checklist_items
  for all to anon, authenticated using (false) with check (false);

-- ─── E. staff_breaks ─────────────────────────────────────────────────────

create table if not exists public.staff_breaks (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid not null references public.properties(id) on delete cascade,
  staff_id        uuid not null,
  business_date   date not null,
  break_type      text not null check (break_type in ('lunch', 'short')),
  started_at      timestamptz not null,
  ended_at        timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists staff_breaks_staff_date_idx
  on public.staff_breaks (property_id, staff_id, business_date);

-- Only one open (ended_at IS NULL) break per (staff, business_date) at a
-- time. Prevents accidental double-tap of "Start Lunch".
create unique index if not exists staff_breaks_one_open_idx
  on public.staff_breaks (property_id, staff_id, business_date)
  where ended_at is null;

alter table public.staff_breaks enable row level security;
revoke all on public.staff_breaks from public, anon, authenticated;
grant select, insert, update, delete on public.staff_breaks to service_role;
drop policy if exists staff_breaks_deny_all_browser on public.staff_breaks;
create policy staff_breaks_deny_all_browser on public.staff_breaks
  for all to anon, authenticated using (false) with check (false);

-- ─── F. Seed default checklists for the 5 cleaning types ─────────────────
--
-- DEPARTURE: full turnover, ~12 items
-- STAYOVER:  light service, ~6 items
-- DEEP:      everything in departure plus extras, ~16 items
-- REFRESH:   tiny touch-up, 4 items
-- INSPECTION: post-clean QA, 5 items
--
-- All seeded as global defaults (property_id IS NULL). Per-property
-- overrides come in a future branch.

do $$
declare
  v_departure_id  uuid;
  v_stayover_id   uuid;
  v_deep_id       uuid;
  v_refresh_id    uuid;
  v_inspection_id uuid;
begin
  -- DEPARTURE -------------------------------------------------------------
  insert into public.cleaning_checklist_templates
    (property_id, cleaning_type, name_en, name_es, is_default, is_active)
  values
    (null, 'departure', 'Departure clean', 'Limpieza de salida', true, true)
  on conflict do nothing;
  select id into v_departure_id
    from public.cleaning_checklist_templates
    where property_id is null and cleaning_type = 'departure' and is_default = true
    limit 1;
  if v_departure_id is not null then
    insert into public.cleaning_checklist_items
      (template_id, area, item_en, item_es, sort_order, is_critical)
    values
      (v_departure_id, 'bedroom',  'Strip linens',                 'Quitar la ropa de cama',         10, false),
      (v_departure_id, 'bedroom',  'Make the bed',                 'Hacer la cama',                  20, true),
      (v_departure_id, 'bedroom',  'Dust surfaces',                'Quitar el polvo',                30, false),
      (v_departure_id, 'bathroom', 'Clean toilet',                 'Limpiar el inodoro',             40, true),
      (v_departure_id, 'bathroom', 'Clean sink and counter',       'Limpiar el lavabo y mostrador',  50, true),
      (v_departure_id, 'bathroom', 'Clean tub or shower',          'Limpiar la tina o ducha',        60, true),
      (v_departure_id, 'bathroom', 'Clean mirror',                 'Limpiar el espejo',              70, false),
      (v_departure_id, 'bathroom', 'Replace towels',               'Reemplazar las toallas',         80, true),
      (v_departure_id, 'amenities','Restock toiletries',           'Reponer artículos de aseo',      90, false),
      (v_departure_id, 'amenities','Restock coffee and water',     'Reponer café y agua',           100, false),
      (v_departure_id, 'living',   'Vacuum floors',                'Aspirar los pisos',             110, true),
      (v_departure_id, 'living',   'Empty trash',                  'Vaciar la basura',              120, true),
      (v_departure_id, 'final',    'Check mini-fridge',            'Revisar el mini-bar',           130, false),
      (v_departure_id, 'final',    'Final walk-through',           'Inspección final',              140, true)
    on conflict on constraint cleaning_checklist_items_template_order_unique do nothing;
  end if;

  -- STAYOVER -------------------------------------------------------------
  insert into public.cleaning_checklist_templates
    (property_id, cleaning_type, name_en, name_es, is_default, is_active)
  values
    (null, 'stayover', 'Stayover refresh', 'Limpieza de estadía', true, true)
  on conflict do nothing;
  select id into v_stayover_id
    from public.cleaning_checklist_templates
    where property_id is null and cleaning_type = 'stayover' and is_default = true
    limit 1;
  if v_stayover_id is not null then
    insert into public.cleaning_checklist_items
      (template_id, area, item_en, item_es, sort_order, is_critical)
    values
      (v_stayover_id, 'bedroom',  'Make the bed',               'Hacer la cama',                10, true),
      (v_stayover_id, 'bathroom', 'Refresh towels',             'Cambiar las toallas',          20, true),
      (v_stayover_id, 'bathroom', 'Wipe sink and counter',      'Limpiar el lavabo',            30, false),
      (v_stayover_id, 'amenities','Restock toiletries as needed','Reponer artículos según necesidad', 40, false),
      (v_stayover_id, 'living',   'Empty trash',                'Vaciar la basura',             50, true),
      (v_stayover_id, 'living',   'Light vacuum',               'Aspirado ligero',              60, false)
    on conflict on constraint cleaning_checklist_items_template_order_unique do nothing;
  end if;

  -- DEEP -----------------------------------------------------------------
  insert into public.cleaning_checklist_templates
    (property_id, cleaning_type, name_en, name_es, is_default, is_active)
  values
    (null, 'deep', 'Deep clean', 'Limpieza profunda', true, true)
  on conflict do nothing;
  select id into v_deep_id
    from public.cleaning_checklist_templates
    where property_id is null and cleaning_type = 'deep' and is_default = true
    limit 1;
  if v_deep_id is not null then
    insert into public.cleaning_checklist_items
      (template_id, area, item_en, item_es, sort_order, is_critical)
    values
      (v_deep_id, 'bedroom',  'Strip linens and remake bed',           'Quitar y rehacer la cama',        10, true),
      (v_deep_id, 'bedroom',  'Move furniture and vacuum underneath',  'Mover muebles y aspirar debajo', 20, false),
      (v_deep_id, 'bedroom',  'Flip or rotate mattress',               'Voltear el colchón',              30, false),
      (v_deep_id, 'bedroom',  'Wipe all surfaces and lamps',           'Limpiar superficies y lámparas',  40, false),
      (v_deep_id, 'bathroom', 'Deep-clean toilet',                     'Limpieza profunda del inodoro',   50, true),
      (v_deep_id, 'bathroom', 'Descale shower head',                   'Descalcificar la ducha',          60, false),
      (v_deep_id, 'bathroom', 'Scrub grout and baseboards',            'Limpiar lechada y rodapiés',      70, false),
      (v_deep_id, 'bathroom', 'Polish mirror and fixtures',            'Pulir espejo y accesorios',       80, false),
      (v_deep_id, 'bathroom', 'Replace all towels',                    'Reemplazar todas las toallas',    90, true),
      (v_deep_id, 'amenities','Restock all amenities',                 'Reponer todos los amenities',    100, false),
      (v_deep_id, 'living',   'Wash interior windows',                 'Lavar ventanas interiores',      110, false),
      (v_deep_id, 'living',   'Vacuum and mop floors',                 'Aspirar y trapear los pisos',    120, true),
      (v_deep_id, 'living',   'Wipe air vents and ceiling fan',        'Limpiar ventilación',            130, false),
      (v_deep_id, 'living',   'Empty trash and replace liner',         'Vaciar basura y cambiar bolsa', 140, true),
      (v_deep_id, 'final',    'Test TV, lights, outlets',              'Probar TV, luces, enchufes',     150, false),
      (v_deep_id, 'final',    'Final walk-through',                    'Inspección final',               160, true)
    on conflict on constraint cleaning_checklist_items_template_order_unique do nothing;
  end if;

  -- REFRESH --------------------------------------------------------------
  insert into public.cleaning_checklist_templates
    (property_id, cleaning_type, name_en, name_es, is_default, is_active)
  values
    (null, 'refresh', 'Quick refresh', 'Retoque rápido', true, true)
  on conflict do nothing;
  select id into v_refresh_id
    from public.cleaning_checklist_templates
    where property_id is null and cleaning_type = 'refresh' and is_default = true
    limit 1;
  if v_refresh_id is not null then
    insert into public.cleaning_checklist_items
      (template_id, area, item_en, item_es, sort_order, is_critical)
    values
      (v_refresh_id, 'bedroom',  'Fluff pillows and straighten bed', 'Acomodar almohadas y cama', 10, false),
      (v_refresh_id, 'bathroom', 'Wipe sink',                        'Limpiar el lavabo',         20, false),
      (v_refresh_id, 'living',   'Empty trash if needed',            'Vaciar la basura si hace falta', 30, false),
      (v_refresh_id, 'final',    'Spray air freshener',              'Aromatizar el ambiente',    40, false)
    on conflict on constraint cleaning_checklist_items_template_order_unique do nothing;
  end if;

  -- INSPECTION -----------------------------------------------------------
  insert into public.cleaning_checklist_templates
    (property_id, cleaning_type, name_en, name_es, is_default, is_active)
  values
    (null, 'inspection', 'Post-clean inspection', 'Inspección posterior', true, true)
  on conflict do nothing;
  select id into v_inspection_id
    from public.cleaning_checklist_templates
    where property_id is null and cleaning_type = 'inspection' and is_default = true
    limit 1;
  if v_inspection_id is not null then
    insert into public.cleaning_checklist_items
      (template_id, area, item_en, item_es, sort_order, is_critical)
    values
      (v_inspection_id, 'bathroom', 'Bathroom is spotless',          'El baño está impecable',          10, true),
      (v_inspection_id, 'bedroom',  'Bed is properly made',          'La cama está bien hecha',         20, true),
      (v_inspection_id, 'amenities','All amenities present',         'Todos los amenities presentes',   30, true),
      (v_inspection_id, 'living',   'Floor is clean',                'El piso está limpio',             40, true),
      (v_inspection_id, 'final',    'Room ready for guest',          'Habitación lista para huésped',   50, true)
    on conflict on constraint cleaning_checklist_items_template_order_unique do nothing;
  end if;
end $$;

-- ─── G. Atomic checklist-toggle RPC ─────────────────────────────────────
--
-- Read-modify-write on rooms.checklist_progress (jsonb array) from the
-- API route was lossy under concurrent toggles: two devices toggling
-- different items at once each read the same prior array and wrote back
-- their own version, dropping the other device's update. The RPC below
-- does the update atomically in a single statement with the correct
-- concurrent semantics.
--
-- It also verifies the item belongs to the room's currently-active
-- checklist template — a forged or stale tap can't smuggle an item ID
-- from a different template into the progress array.
--
-- Returns the new checked count + whether the item was added or removed,
-- and a `template_mismatch` flag so the caller can surface a 409 if the
-- tap was stale.

create or replace function public.staxis_checklist_toggle(
  p_room_id uuid,
  p_item_id uuid,
  p_checked boolean
)
returns table (
  new_checked_count integer,
  is_checked boolean,
  template_mismatch boolean
)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_template_id uuid;
  v_item_template_id uuid;
  v_progress jsonb;
  v_already_present boolean;
begin
  -- Atomically lock the room row + read its template + current progress.
  select checklist_template_id, coalesce(checklist_progress, '[]'::jsonb)
    into v_template_id, v_progress
  from public.rooms
  where id = p_room_id
  for update;

  if not found then
    return query select 0, false, false;
    return;
  end if;

  select template_id into v_item_template_id
  from public.cleaning_checklist_items
  where id = p_item_id;

  if v_item_template_id is null or v_item_template_id is distinct from v_template_id then
    return query select coalesce(jsonb_array_length(v_progress), 0), false, true;
    return;
  end if;

  v_already_present := v_progress @> to_jsonb(p_item_id::text);

  if p_checked then
    if not v_already_present then
      v_progress := v_progress || to_jsonb(p_item_id::text);
    end if;
  else
    if v_already_present then
      -- Drop every matching entry (defensive against duplicate ids).
      v_progress := coalesce(
        (
          select jsonb_agg(elem)
          from jsonb_array_elements(v_progress) elem
          where elem <> to_jsonb(p_item_id::text)
        ),
        '[]'::jsonb
      );
    end if;
  end if;

  update public.rooms
     set checklist_progress = v_progress
   where id = p_room_id;

  return query select coalesce(jsonb_array_length(v_progress), 0), p_checked, false;
end;
$$;

revoke all on function public.staxis_checklist_toggle(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.staxis_checklist_toggle(uuid, uuid, boolean) to service_role;

comment on function public.staxis_checklist_toggle(uuid, uuid, boolean) is
  'Atomic toggle of an item ID in rooms.checklist_progress. Locks the room row, verifies the item belongs to the room''s current template, and updates the jsonb array without read-modify-write loss. Added 0222.';

-- ─── Track the migration ─────────────────────────────────────────────────

insert into public.applied_migrations (version, description)
values (
  '0222',
  'Housekeeper mobile rebuild A: workflow state machine on rooms (paused/exception/checklist), room_pause_events, cleaning_checklist_templates + items (seeded 5 defaults), staff_breaks, atomic checklist-toggle RPC, rush + floor + manager_notes on rooms.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
