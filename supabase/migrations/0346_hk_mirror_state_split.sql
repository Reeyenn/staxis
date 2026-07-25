-- ═══════════════════════════════════════════════════════════════════════════
-- 0346 — A wall between "what the PMS told us" and "what Staxis knows"
-- ═══════════════════════════════════════════════════════════════════════════
-- pms_housekeeping_assignments carries 49 columns. Five of them are what a PMS
-- report prints (date, room_number, housekeeper_name, cleaning_type,
-- dnd_active). The other 29 are Staxis-owned working state a housekeeper
-- builds up over a shift: pause accounting, checklist progress, exception
-- notes, rush flags, manager/housekeeper notes, inspection marks.
--
-- Today nothing protects the second group from the first. The ingest writer
-- validates rows against the descriptor in pms_table_schemas, and its
-- off-descriptor branch only LOGS A WARNING for an unexpected key — its
-- comment claiming "Supabase strips unknown columns" is false for columns that
-- physically exist. The instant a knowledge file learns a PMS column called
-- `status` or `notes`, a report arriving mid-clean silently overwrites a
-- housekeeper's in-progress work. The only thing standing between that and
-- production is that the descriptor happens to list five columns.
--
-- This migration replaces "happens to" with "cannot", two ways:
--
--   1. STRUCTURAL. App-owned state moves to a new table, public.room_work.
--      After this, the ingest cannot clobber checklist progress because that
--      column does not exist on the table the ingest writes.
--
--   2. PRIVILEGE. Both writers authenticate as the same Postgres role
--      (service_role — supabaseAdmin and cua-service/src/supabase.ts), so
--      column GRANTs cannot separate them. Instead INSERT/UPDATE/DELETE on the
--      mirror is REVOKEd from service_role entirely and the only write path is
--      SECURITY DEFINER public.staxis_apply_hk_mirror(), which names the mirror
--      columns and nothing else. Same mechanism as 0286 (staxis_receive_po_lines),
--      0330 (staff write gate), 0332 (staff column privileges).
--
-- ── The dual-write problem, and how it is resolved ──────────────────────────
-- cleaning_type and dnd_active are written by BOTH sides today: the PMS report
-- prints them, AND the manager writes them from the Rooms board (tile-cycle →
-- cleaning_type, the DND toggle → dnd_active, both via applyRoomUpdate in
-- src/lib/pms-rooms-writes.ts), AND staxis_seed_shift_assignments seeds an
-- app-derived cleaning_type from the shift plan. A naive split that left them
-- mirror-only would give the manager board permission-denied on every tile tap.
--
-- They are therefore TWINNED: the mirror keeps the PMS-reported value, and
-- room_work gains an app-owned override of each. Merge precedence, applied
-- identically everywhere (see src/lib/pms-rooms-server.ts mergeAssignment):
--
--     effective = coalesce(room_work.<col>, pms_housekeeping_assignments.<col>)
--
-- "The manager's explicit action beats the report; absent an action, the
-- report stands." A NULL in room_work means "Staxis has no opinion", which is
-- why the app writes false rather than NULL when a manager clears DND.
--
-- ── Housekeeper identity ────────────────────────────────────────────────────
-- The mirror keeps housekeeper_name (a string the PMS printed). room_work gains
-- assigned_staff_id, a real FK to staff, plus assigned_source recording which
-- rule produced the link. Resolution precedence at read time:
--
--     assigned_staff_id  →  else name-match on housekeeper_name (today's rule)
--
-- The fallback is what keeps the PUBLIC housekeeper SMS-link page working on
-- day one, before any room_work assignment exists.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ─── 0. Resolve the orphan that blocks the foreign key ───────────────────────
-- Verified live: exactly one assignment row (property c7ec4be3…, 2026-06-24,
-- room 214) has a room_number with no matching pms_rooms_inventory row. The FK
-- below cannot be created while it exists.
--
-- Resolution is ADDITIVE — materialize the missing inventory row rather than
-- delete the assignment. Deleting would silently destroy a real housekeeping
-- record to satisfy a constraint, which is exactly backwards. Logged either
-- way so the count is visible in the apply output.

do $$
declare
  v_orphans bigint;
begin
  insert into public.pms_rooms_inventory (property_id, room_number, room_type)
  select distinct a.property_id, a.room_number, null::text
    from public.pms_housekeeping_assignments a
   where not exists (
     select 1 from public.pms_rooms_inventory i
      where i.property_id = a.property_id and i.room_number = a.room_number
   )
  on conflict (property_id, room_number) do nothing;
  get diagnostics v_orphans = row_count;
  raise notice '0346: materialized % missing pms_rooms_inventory row(s) for orphaned assignments', v_orphans;
end $$;

-- ─── 1. public.room_work — everything Staxis owns about a room's day ─────────
-- @rls: service-role-only — the app reads and writes via /api/* with
-- supabaseAdmin; the housekeeper page NEVER touches it from the browser
-- (that is the RLS silent-empty-state bug class). Deny-all-browser policy below.
create table if not exists public.room_work (
  property_id                  uuid    not null,
  date                         date    not null,
  room_number                  text    not null,

  -- Lifecycle. 'refused' / 'skipped' are carried over verbatim from the
  -- mirror's CHECK: they read like PMS-reported values but no PMS-reported
  -- housekeeping status is expected today, and narrowing an enum during a
  -- table split would be a silent behaviour change. If a PMS ever does report
  -- a housekeeping status, it needs its OWN column on the mirror — not a
  -- second writer on this one.
  status                       text    default 'not_started',
  started_at                   timestamptz,
  completed_at                 timestamptz,
  time_spent_minutes           integer,

  -- Pause accounting.
  is_paused                    boolean not null default false,
  paused_at                    timestamptz,
  total_paused_seconds         integer not null default 0,

  -- Checklist.
  checklist_template_id        uuid,
  checklist_progress           text[]  not null default '{}'::text[],

  -- Exceptions (DND / no service required / do-later / sleep-out / skipped).
  exception_type               text,
  exception_note               text,
  exception_at                 timestamptz,

  -- Notes.
  manager_notes                text,
  manager_notes_at             timestamptz,
  manager_notes_by_account_id  uuid,
  housekeeper_note             text,
  housekeeper_note_at          timestamptz,

  -- Rush.
  is_rush                      boolean not null default false,
  rush_due_by                  timestamptz,
  rush_set_at                  timestamptz,
  rush_set_by                  uuid,
  rush_requested_by_account_id uuid,
  rush_duration_label          text,

  -- Inspection.
  marked_for_inspection_at     timestamptz,
  inspected_by                 text,
  inspected_at                 timestamptz,

  -- Misc working state.
  issue_note                   text,
  help_requested               boolean not null default false,
  dnd_note                     text,

  -- App-owned twins of the two dual-written mirror columns. NULL means "Staxis
  -- has no opinion, use what the PMS said" — see the precedence rule in the
  -- header. The app writes `false`, never NULL, to mean "explicitly off".
  cleaning_type                text,
  dnd_active                   boolean,

  -- Identity, not a matching name string.
  assigned_staff_id            uuid,
  assigned_source              text,

  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),

  constraint room_work_pkey primary key (property_id, date, room_number),

  -- Every row of housekeeping work belongs to a room this property has.
  constraint room_work_room_fk
    foreign key (property_id, room_number)
    references public.pms_rooms_inventory (property_id, room_number)
    on delete cascade,

  -- An assigned housekeeper is a real staff member AT THIS HOTEL. The
  -- composite form (using the existing staff_id_property_id_key) makes
  -- cross-property assignment structurally impossible, not merely unlikely.
  constraint room_work_staff_fk
    foreign key (assigned_staff_id, property_id)
    references public.staff (id, property_id)
    on delete set null,

  -- Carried over verbatim from pms_housekeeping_assignments.
  constraint room_work_status_chk
    check (status = any (array['not_started', 'in_progress', 'completed', 'refused', 'skipped'])),
  constraint room_work_exception_type_chk
    check (exception_type is null
           or exception_type = any (array['dnd', 'nsr', 'dla', 'sleep_out', 'skipped'])),
  constraint room_work_time_spent_chk
    check (time_spent_minutes is null or time_spent_minutes >= 0),
  constraint room_work_cleaning_type_chk
    check (cleaning_type is null
           or cleaning_type = any (array['departure', 'stayover', 'deep', 'refresh', 'inspection', 'arrival'])),

  -- Every assignment records HOW it was resolved. Required whenever there is
  -- an assignment to explain; forbidden when there isn't, so the column can
  -- never carry a stale provenance for a cleared assignment.
  -- `assigned_source is not null` is load-bearing, not redundant: without it
  -- the second branch evaluates to NULL for a null source (NULL = ANY(...) is
  -- NULL, not false), NULL is not false, and a CHECK treats NULL as satisfied —
  -- so an assignment with no provenance would sail straight through.
  constraint room_work_assigned_source_chk
    check (
      (assigned_staff_id is null and assigned_source is null)
      or (assigned_staff_id is not null
          and assigned_source is not null
          and assigned_source = any (array['manager', 'alias_exact', 'alias_first_name', 'pms_import']))
    )
);

comment on table public.room_work is
  'Staxis-owned housekeeping working state, one row per (property, date, room). The other half of the 0346 split: pms_housekeeping_assignments is the read-only mirror of what the PMS reported, this is what our own app knows. The ingest physically cannot write here. Created 0346.';
comment on column public.room_work.cleaning_type is
  'App-set override of pms_housekeeping_assignments.cleaning_type (manager tile-cycle, shift-plan seed). NULL = no app opinion; readers use coalesce(room_work, mirror). Created 0346.';
comment on column public.room_work.dnd_active is
  'App-set override of pms_housekeeping_assignments.dnd_active (manager DND toggle, housekeeper DND exception). NULL = no app opinion; readers use coalesce(room_work, mirror). Explicitly-off is written as false, not NULL. Created 0346.';
comment on column public.room_work.assigned_staff_id is
  'The housekeeper assigned to this room, by identity. Composite FK to staff (id, property_id) so a cross-hotel assignment cannot be stored. NULL falls back to name-matching the mirror''s housekeeper_name at read time. Created 0346.';
comment on column public.room_work.assigned_source is
  'Which rule produced assigned_staff_id: manager | alias_exact | alias_first_name | pms_import. Every assignment carries its receipt. Created 0346.';

-- @query: src/lib/pms-rooms-server.ts mergePmsRoomsForDate + mergePmsRoomsForStaff — room_work for a property over a date window
create index if not exists room_work_property_date_idx
  on public.room_work (property_id, date desc);
-- @query: src/lib/pms-rooms-server.ts mergePmsRoomsForStaff — the PUBLIC housekeeper SMS link filters a date window to one staff member
create index if not exists room_work_assigned_staff_idx
  on public.room_work (property_id, assigned_staff_id, date desc)
  where assigned_staff_id is not null;

alter table public.room_work enable row level security;
revoke all on public.room_work from public, anon, authenticated;
grant select, insert, update, delete on public.room_work to service_role;

drop policy if exists room_work_deny_all_browser on public.room_work;
create policy room_work_deny_all_browser
  on public.room_work for all to anon, authenticated
  using (false) with check (false);
comment on policy room_work_deny_all_browser on public.room_work is
  'Service-role only. The housekeeper page is PUBLIC and unauthenticated — it reads and writes exclusively through /api/housekeeper/* with supabaseAdmin. A browser-side read here would return 200 OK with [] and render an empty shift. Created 0346.';

drop trigger if exists set_updated_at on public.room_work;
create trigger set_updated_at
  before update on public.room_work
  for each row execute function public._pms_set_updated_at();

-- ─── 2. Backfill from the mirror ─────────────────────────────────────────────
-- Every existing assignment row becomes a room_work row carrying its app state.
-- cleaning_type/dnd_active are copied as the app-side value too: today the app
-- is the only writer of those in practice (the CUA housekeeping feed has never
-- run against this property), so treating the current values as app-owned
-- preserves exactly what the board shows right now.

insert into public.room_work (
  property_id, date, room_number,
  status, started_at, completed_at, time_spent_minutes,
  is_paused, paused_at, total_paused_seconds,
  checklist_template_id, checklist_progress,
  exception_type, exception_note, exception_at,
  manager_notes, manager_notes_at, manager_notes_by_account_id,
  housekeeper_note, housekeeper_note_at,
  is_rush, rush_due_by, rush_set_at, rush_set_by,
  rush_requested_by_account_id, rush_duration_label,
  marked_for_inspection_at, inspected_by, inspected_at,
  issue_note, help_requested, dnd_note,
  cleaning_type, dnd_active,
  created_at, updated_at
)
select
  a.property_id, a.date, a.room_number,
  coalesce(a.status, 'not_started'), a.started_at, a.completed_at, a.time_spent_minutes,
  a.is_paused, a.paused_at, a.total_paused_seconds,
  a.checklist_template_id, a.checklist_progress,
  a.exception_type, a.exception_note, a.exception_at,
  a.manager_notes, a.manager_notes_at, a.manager_notes_by_account_id,
  a.housekeeper_note, a.housekeeper_note_at,
  a.is_rush, a.rush_due_by, a.rush_set_at, a.rush_set_by,
  a.rush_requested_by_account_id, a.rush_duration_label,
  a.marked_for_inspection_at, a.inspected_by, a.inspected_at,
  a.issue_note, a.help_requested, a.dnd_note,
  a.cleaning_type, a.dnd_active,
  a.created_at, a.updated_at
from public.pms_housekeeping_assignments a
on conflict (property_id, date, room_number) do nothing;

-- Materialize assigned_staff_id from the mirror's housekeeper_name where the
-- name matches EXACTLY ONE staff member at this property (source
-- 'pms_import'). An ambiguous name is deliberately left NULL — the read-time
-- fallback still resolves it with the same collision-aware first-name rule the
-- app uses today, and guessing here would fabricate provenance.
update public.room_work w
   set assigned_staff_id = m.staff_id,
       assigned_source   = 'pms_import'
  from (
    -- (array_agg(...))[1], not min(): Postgres has no min() aggregate for
    -- uuid. The HAVING below means there is exactly one row anyway.
    select a.property_id, a.date, a.room_number, (array_agg(s.id))[1] as staff_id
      from public.pms_housekeeping_assignments a
      join public.staff s
        on s.property_id = a.property_id
       and lower(btrim(s.name)) = lower(btrim(a.housekeeper_name))
     where a.housekeeper_name is not null and btrim(a.housekeeper_name) <> ''
     group by a.property_id, a.date, a.room_number
    having count(*) = 1
  ) m
 where w.property_id = m.property_id
   and w.date = m.date
   and w.room_number = m.room_number
   and w.assigned_staff_id is null;

do $$
declare
  v_mirror bigint;
  v_work   bigint;
  v_linked bigint;
begin
  select count(*) into v_mirror from public.pms_housekeeping_assignments;
  select count(*) into v_work   from public.room_work;
  select count(*) into v_linked from public.room_work where assigned_staff_id is not null;
  raise notice '0346 backfill: % mirror rows -> % room_work rows (% with a resolved staff id)',
    v_mirror, v_work, v_linked;
  if v_work < v_mirror then
    raise exception '0346: room_work (%) has fewer rows than pms_housekeeping_assignments (%) — backfill lost data',
      v_work, v_mirror;
  end if;
end $$;

-- ─── 3. Strip the app-owned columns off the mirror ───────────────────────────
-- THIS is the enforcement. After this the ingest cannot clobber a housekeeper's
-- in-progress clean, because the column is not on the table it writes.
-- cleaning_type and dnd_active deliberately REMAIN (the PMS reports them; the
-- app's opinion lives on room_work).

alter table public.pms_housekeeping_assignments
  drop column if exists status,
  drop column if exists started_at,
  drop column if exists completed_at,
  drop column if exists time_spent_minutes,
  drop column if exists is_paused,
  drop column if exists paused_at,
  drop column if exists total_paused_seconds,
  drop column if exists checklist_template_id,
  drop column if exists checklist_progress,
  drop column if exists exception_type,
  drop column if exists exception_note,
  drop column if exists exception_at,
  drop column if exists manager_notes,
  drop column if exists manager_notes_at,
  drop column if exists manager_notes_by_account_id,
  drop column if exists housekeeper_note,
  drop column if exists housekeeper_note_at,
  drop column if exists is_rush,
  drop column if exists rush_due_by,
  drop column if exists rush_set_at,
  drop column if exists rush_set_by,
  drop column if exists rush_requested_by_account_id,
  drop column if exists rush_duration_label,
  drop column if exists marked_for_inspection_at,
  drop column if exists inspected_by,
  drop column if exists inspected_at,
  drop column if exists issue_note,
  drop column if exists help_requested,
  drop column if exists dnd_note;

comment on table public.pms_housekeeping_assignments is
  'READ-ONLY MIRROR of what the PMS housekeeping report says: who it lists, what kind of clean, DND, approvals, scheduled time. Staxis-owned working state lives in public.room_work (0346). service_role holds SELECT only — writes go through staxis_apply_hk_mirror().';

-- ─── 4. Close the reverse direction ──────────────────────────────────────────
-- Both writers authenticate as service_role, so GRANTs cannot tell the ingest
-- apart from the app. Revoke write on the mirror from service_role outright and
-- funnel the ingest through a SECURITY DEFINER function that names ONLY the
-- mirror columns. An extra key in the payload is ignored rather than written —
-- there is no column list for it to reach.

create or replace function public.staxis_apply_hk_mirror(
  p_property_id uuid,
  p_rows        jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_written integer := 0;
begin
  if p_property_id is null then
    raise exception 'staxis_apply_hk_mirror: p_property_id is required'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'staxis_apply_hk_mirror: p_rows must be a jsonb array'
      using errcode = 'invalid_parameter_value';
  end if;

  with incoming as (
    select
      (e->>'date')::date                      as date,
      btrim(e->>'room_number')                as room_number,
      nullif(e->>'housekeeper_name', '')      as housekeeper_name,
      nullif(e->>'cleaning_type', '')         as cleaning_type,
      (e->>'scheduled_time')::timestamptz     as scheduled_time,
      nullif(e->>'refused_reason', '')        as refused_reason,
      (e->>'late_checkout_approved')::boolean as late_checkout_approved,
      (e->>'late_checkout_until')::time       as late_checkout_until,
      (e->>'early_checkin_approved')::boolean as early_checkin_approved,
      (e->>'early_checkin_from')::time        as early_checkin_from,
      (e->>'dnd_active')::boolean             as dnd_active,
      (e->>'dnd_until')::time                 as dnd_until,
      nullif(e->>'service_requested', '')     as service_requested,
      nullif(e->>'notes', '')                 as notes,
      e->'raw'                                as raw
    from jsonb_array_elements(p_rows) e
  ),
  usable as (
    select * from incoming where date is not null and room_number is not null and room_number <> ''
  ),
  written as (
    insert into public.pms_housekeeping_assignments (
      property_id, date, room_number,
      housekeeper_name, cleaning_type, scheduled_time, refused_reason,
      late_checkout_approved, late_checkout_until,
      early_checkin_approved, early_checkin_from,
      dnd_active, dnd_until, service_requested, notes, raw, last_synced_at
    )
    select
      p_property_id, u.date, u.room_number,
      u.housekeeper_name, u.cleaning_type, u.scheduled_time, u.refused_reason,
      u.late_checkout_approved, u.late_checkout_until,
      u.early_checkin_approved, u.early_checkin_from,
      u.dnd_active, u.dnd_until, u.service_requested, u.notes, u.raw, now()
    from usable u
    on conflict (property_id, date, room_number) do update set
      housekeeper_name       = excluded.housekeeper_name,
      cleaning_type          = excluded.cleaning_type,
      scheduled_time         = excluded.scheduled_time,
      refused_reason         = excluded.refused_reason,
      late_checkout_approved = excluded.late_checkout_approved,
      late_checkout_until    = excluded.late_checkout_until,
      early_checkin_approved = excluded.early_checkin_approved,
      early_checkin_from     = excluded.early_checkin_from,
      dnd_active             = excluded.dnd_active,
      dnd_until              = excluded.dnd_until,
      service_requested      = excluded.service_requested,
      notes                  = excluded.notes,
      raw                    = excluded.raw,
      last_synced_at         = now()
    returning 1
  )
  select count(*) into v_written from written;

  return v_written;
end $$;

comment on function public.staxis_apply_hk_mirror(uuid, jsonb) is
  'The ONLY write path into pms_housekeeping_assignments (0346). Names the 15 PMS-reported columns explicitly, so a knowledge file that learns a column called status or notes has nowhere to put it. service_role holds SELECT on the table and EXECUTE on this.';

revoke all on function public.staxis_apply_hk_mirror(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.staxis_apply_hk_mirror(uuid, jsonb) to service_role;

revoke insert, update, delete on public.pms_housekeeping_assignments from service_role;
grant select on public.pms_housekeeping_assignments to service_role;

-- Descriptor flag the generic writer branches on.
alter table public.pms_table_schemas
  add column if not exists write_via_rpc text;
comment on column public.pms_table_schemas.write_via_rpc is
  'When set, the generic writer calls this SECURITY DEFINER function instead of upserting the table directly — required for tables whose direct writes are revoked from service_role. Added 0346.';

update public.pms_table_schemas
   set write_via_rpc = 'staxis_apply_hk_mirror'
 where table_name = 'pms_housekeeping_assignments';

-- ─── 5. Repoint the two SQL functions that write housekeeping state ──────────

-- complete_inspection_atomic: the inspection side-effect is app state, so it
-- moves to room_work wholesale. Identical signature + return type so callers
-- (src/lib/inspections/correction-loop.ts) are untouched.
-- Guarded on the table still existing: this function RETURNS public.inspections,
-- so a from-scratch replay that has not created that table yet (or an install
-- where inspections was retired) would abort the whole migration on a function
-- definition that has nothing to act on. Same latent hazard 0271 carries.
do $ins$
begin
  if to_regclass('public.inspections') is null then
    raise notice '0346: public.inspections absent — skipping complete_inspection_atomic repoint';
    return;
  end if;
  execute $ddl$
create or replace function public.complete_inspection_atomic(
  p_inspection_id              uuid,
  p_property_id                uuid,
  p_result                     text,
  p_failed_items               jsonb,
  p_passed_items               jsonb,
  p_notes                      text,
  p_escalated                  boolean,
  p_escalation_reason          text,
  p_correction_notice_sent_at  timestamptz,
  p_correction_note            text
)
returns public.inspections
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_row    public.inspections;
  v_count  integer;
begin
  if p_result not in ('pass','fail') then
    raise exception 'E_BAD_RESULT: p_result must be pass or fail, got %', p_result
      using errcode = 'check_violation';
  end if;

  select * into v_row from public.inspections where id = p_inspection_id for update;
  if not found then
    raise exception 'E_NOT_FOUND: inspection % not found', p_inspection_id
      using errcode = 'no_data_found';
  end if;
  if v_row.property_id is distinct from p_property_id then
    raise exception 'E_NOT_FOUND: inspection % does not belong to property %', p_inspection_id, p_property_id
      using errcode = 'no_data_found';
  end if;
  if v_row.result <> 'in_progress' then
    raise exception 'E_ALREADY_FINALIZED: inspection % already %', p_inspection_id, v_row.result
      using errcode = 'invalid_parameter_value';
  end if;

  update public.inspections
     set result                    = p_result,
         failed_items              = coalesce(p_failed_items, '[]'::jsonb),
         passed_items              = coalesce(p_passed_items, '[]'::jsonb),
         notes                     = p_notes,
         escalated                 = coalesce(p_escalated, false),
         escalation_reason         = p_escalation_reason,
         correction_notice_sent_at = p_correction_notice_sent_at,
         completed_at              = now()
   where id = p_inspection_id
   returning * into v_row;

  -- Room side-effect → room_work (0346: this is app state, not PMS state).
  -- Target the latest work row ON OR BEFORE the inspection's own date so a
  -- pre-loaded FUTURE plan can never be mutated by today's inspection.
  if v_row.room_number is not null then
    if p_result = 'pass' then
      update public.room_work w
         set status       = 'completed',
             completed_at = coalesce(w.completed_at, now()),
             inspected_at = now()
       where w.property_id = p_property_id
         and w.room_number = v_row.room_number
         and w.date = (
           select max(date) from public.room_work
            where property_id = p_property_id and room_number = v_row.room_number
              and date <= coalesce((v_row.started_at)::date, current_date)
         );
    else
      update public.room_work w
         set status       = 'not_started',
             completed_at = null,
             inspected_at = null,
             issue_note   = p_correction_note
       where w.property_id = p_property_id
         and w.room_number = v_row.room_number
         and w.date = (
           select max(date) from public.room_work
            where property_id = p_property_id and room_number = v_row.room_number
              and date <= coalesce((v_row.started_at)::date, current_date)
         );
    end if;
  end if;

  if v_row.cleaning_task_id is not null then
    if p_result = 'pass' then
      update public.cleaning_tasks
         set status = 'inspected_pass', inspected_at = now()
       where id = v_row.cleaning_task_id and property_id = p_property_id;
    else
      update public.cleaning_tasks
         set status = 'correction_pending', priority = 'high', notes = p_correction_note
       where id = v_row.cleaning_task_id and property_id = p_property_id;
    end if;
    get diagnostics v_count = row_count;
    if v_count <> 1 then
      raise exception 'E_TASK_PROPERTY_MISMATCH: cleaning_task % does not belong to property % (rows affected: %)',
        v_row.cleaning_task_id, p_property_id, v_count
        using errcode = 'no_data_found';
    end if;
  end if;

  if v_row.parent_inspection_id is not null then
    update public.inspections
       set recheck_inspection_id = v_row.id
     where id = v_row.parent_inspection_id and property_id = p_property_id;
  end if;

  return v_row;
end;
$function$
  $ddl$;
  execute 'revoke all on function public.complete_inspection_atomic(uuid, uuid, text, jsonb, jsonb, text, boolean, text, timestamptz, text) from public, anon, authenticated';
  execute 'grant execute on function public.complete_inspection_atomic(uuid, uuid, text, jsonb, jsonb, text, boolean, text, timestamptz, text) to service_role';
end $ins$;

-- staxis_seed_shift_assignments: the shift plan is a Staxis decision, so all
-- three of its housekeeping writes move to room_work. The assignment is now
-- stored by staff id (assigned_source='manager' — a human built this shift
-- plan) instead of a name string, and the app-derived cleaning_type lands on
-- room_work's app-side column, where it takes precedence over the mirror.
create or replace function public.staxis_seed_shift_assignments(
  p_property uuid,
  p_date date,
  p_plan_rooms jsonb,
  p_assignments jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_created       integer := 0;
  v_updated       integer := 0;
  v_cleared       integer := 0;
  v_room_map      jsonb;
  v_room_assigns  jsonb;
  v_staff_names   jsonb;
  v_crew          uuid[];
begin
  select coalesce(jsonb_object_agg(
           room_number,
           jsonb_build_object('staff_id', e->>'staff_id', 'staff_name', e->>'staff_name')
         ), '{}'::jsonb)
    into v_room_map
  from jsonb_array_elements(coalesce(p_assignments, '[]'::jsonb)) e,
       jsonb_array_elements_text(coalesce(e->'rooms', '[]'::jsonb)) room_number;

  -- 1. Insert work rows that don't exist yet for (property, date).
  --    Rooms with no inventory row are skipped rather than failing the whole
  --    seed on the FK — a shift plan naming an unknown room is a data problem
  --    for that room, not a reason to lose the shift.
  with want as (
    select
      n.number,
      nullif(v_room_map->n.number->>'staff_id', '')::uuid as staff_id,
      case
        when exists (
          select 1 from jsonb_array_elements(coalesce(p_plan_rooms, '[]'::jsonb)) p
          where p->>'number' = n.number and p->>'stay_type' = 'Stay'
        ) then 'stayover'
        else 'departure'
      end as cleaning_type
    from jsonb_object_keys(v_room_map) as n(number)
  ),
  inserted as (
    insert into public.room_work
      (property_id, date, room_number, assigned_staff_id, assigned_source, cleaning_type, status)
    select p_property, p_date, w.number,
           s.id,
           case when s.id is null then null else 'manager' end,
           w.cleaning_type, 'not_started'
    from want w
    left join public.staff s on s.id = w.staff_id and s.property_id = p_property
    where exists (
      select 1 from public.pms_rooms_inventory i
       where i.property_id = p_property and i.room_number = w.number
    )
      and not exists (
      select 1 from public.room_work a
      where a.property_id = p_property and a.date = p_date and a.room_number = w.number
    )
    returning 1
  )
  select count(*) into v_created from inserted;

  -- 2. Update existing rows whose housekeeper changed (preserve cleaning_type/status).
  with want as (
    select n.number, nullif(v_room_map->n.number->>'staff_id', '')::uuid as staff_id
    from jsonb_object_keys(v_room_map) as n(number)
  ),
  updated as (
    update public.room_work a
    set assigned_staff_id = s.id,
        assigned_source   = case when s.id is null then null else 'manager' end
    from want w
    left join public.staff s on s.id = w.staff_id and s.property_id = p_property
    where a.property_id = p_property
      and a.date = p_date
      and a.room_number = w.number
      and a.assigned_staff_id is distinct from s.id
    returning 1
  )
  select count(*) into v_updated from updated;

  -- 3. Clear the housekeeper on work rows no longer in the map.
  with cleared as (
    update public.room_work a
    set assigned_staff_id = null, assigned_source = null
    where a.property_id = p_property
      and a.date = p_date
      and a.assigned_staff_id is not null
      and not (v_room_map ? a.room_number)
    returning 1
  )
  select count(*) into v_cleared from cleared;

  -- 4-6. schedule_assignments rebuild — unchanged from 0271.
  select coalesce(jsonb_object_agg((p_date::text || '_' || k), v_room_map->k->>'staff_id'), '{}'::jsonb)
    into v_room_assigns
  from jsonb_object_keys(v_room_map) as k;

  select coalesce(jsonb_object_agg(e->>'staff_id', e->>'staff_name'), '{}'::jsonb)
    into v_staff_names
  from jsonb_array_elements(coalesce(p_assignments, '[]'::jsonb)) e;

  select coalesce(array_agg((e->>'staff_id')::uuid), '{}'::uuid[])
    into v_crew
  from jsonb_array_elements(coalesce(p_assignments, '[]'::jsonb)) e;

  insert into public.schedule_assignments
    (property_id, date, room_assignments, crew, staff_names, updated_at)
  values
    (p_property, p_date, v_room_assigns, v_crew, v_staff_names, now())
  on conflict (property_id, date) do update
    set room_assignments = excluded.room_assignments,
        crew             = excluded.crew,
        staff_names      = excluded.staff_names,
        updated_at       = excluded.updated_at;

  return jsonb_build_object(
    'created_count', v_created,
    'updated_count', v_updated,
    'cleared_count', v_cleared
  );
end;
$function$;

revoke all on function public.staxis_seed_shift_assignments(uuid, date, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.staxis_seed_shift_assignments(uuid, date, jsonb, jsonb) to service_role;

-- ─── 6. today_room_work_v1 — housekeeper now comes from identity ─────────────
-- Same signature and output columns; only the `housekeeper` source changes.
-- Precedence matches the TypeScript merge: an explicit room_work assignment
-- wins, and the mirror's printed name is the fallback.
--
-- NOTE (pre-existing, deliberately NOT widened here): 0224 granted EXECUTE on
-- this function to anon, so anyone holding the public anon key and a
-- property_id can read per-room housekeeping data past the deny-all policies.
-- That is a real hole and it is flagged for a security workstream; this
-- migration neither widens nor fixes it, because changing who may execute the
-- function is a different decision from where it reads.
CREATE OR REPLACE FUNCTION public.today_room_work_v1(
  p_property_id uuid,
  p_date date
)
RETURNS TABLE (
  room_number   text,
  stay_type     text,
  housekeeper   text,
  stayover_day  int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH latest_status AS (
    SELECT DISTINCT ON (room_number) room_number, status
    FROM public.pms_room_status_log
    WHERE property_id = p_property_id
    ORDER BY room_number, changed_at DESC
  ),
  today_res AS (
    SELECT
      r.room_number,
      CASE
        WHEN r.departure_date = p_date THEN 'C/O'
        WHEN r.arrival_date <= p_date AND r.departure_date > p_date THEN 'Stay'
        ELSE NULL
      END                                        AS stay_type,
      GREATEST(1, (p_date - r.arrival_date) + 1) AS stayover_day
    FROM public.pms_reservations r
    WHERE r.property_id = p_property_id
      AND r.arrival_date <= p_date
      AND r.departure_date >= p_date
  ),
  -- Both halves are filtered to (property, date) BEFORE the full outer join,
  -- so the join is over one property-day, not the whole table.
  today_work AS (
    SELECT room_number, assigned_staff_id
    FROM public.room_work
    WHERE property_id = p_property_id AND date = p_date
  ),
  today_mirror AS (
    SELECT room_number, housekeeper_name
    FROM public.pms_housekeeping_assignments
    WHERE property_id = p_property_id AND date = p_date
  ),
  today_assign AS (
    SELECT
      coalesce(w.room_number, a.room_number) AS room_number,
      coalesce(s.name, a.housekeeper_name)   AS housekeeper
    FROM today_work w
    FULL OUTER JOIN today_mirror a ON a.room_number = w.room_number
    LEFT JOIN public.staff s
      ON s.id = w.assigned_staff_id AND s.property_id = p_property_id
  )
  SELECT ls.room_number, tr.stay_type, ta.housekeeper, tr.stayover_day
  FROM latest_status ls
  LEFT JOIN today_res    tr ON tr.room_number = ls.room_number
  LEFT JOIN today_assign ta ON ta.room_number = ls.room_number
  ORDER BY ls.room_number;
$$;

COMMENT ON FUNCTION public.today_room_work_v1(uuid, date) IS
  'Plan v4 bridge — one row per known room with stay_type, housekeeper, and stayover day-of-stay. 0346: housekeeper resolves from room_work.assigned_staff_id -> staff.name, falling back to the PMS mirror''s printed housekeeper_name.';

insert into public.applied_migrations (version, description)
values (
  '0346',
  'Split pms_housekeeping_assignments into a read-only PMS mirror + app-owned public.room_work; revoke mirror writes from service_role behind staxis_apply_hk_mirror(); repoint complete_inspection_atomic, staxis_seed_shift_assignments and today_room_work_v1'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
