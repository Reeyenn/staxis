-- ═══════════════════════════════════════════════════════════════════════════
-- 0355 — Split housekeeping into what the PMS said and what Staxis knows.
--
-- THE PROBLEM
-- pms_housekeeping_assignments has two owners and one row. Five columns are a
-- mirror of the PMS housekeeping report (housekeeper_name, cleaning_type,
-- dnd_active, scheduled_time, notes). Twenty-nine are Staxis's own workflow
-- state that no PMS has ever heard of: pause accounting, checklist progress,
-- rush flags, manager and housekeeper notes, inspection marks, help-requested.
-- Nothing separates them. The only thing standing between an arriving report
-- and a housekeeper's in-progress clean is that the ingest descriptor happens
-- to list five column names.
--
-- IT IS ALREADY BROKEN, IN THE OTHER DIRECTION.
-- 0341 made ingest_run_id NOT NULL on every pms_* write target — "there is no
-- number in the system without a receipt". Correct for report data. But the
-- app writes this table too, and a housekeeper tapping Start has no report to
-- cite. Every app-side upsert on this table now has to invent a receipt or
-- fail the NOT NULL. That is not a bug in 0341; it is the two-owners problem
-- announcing itself. A table cannot be both "only report data lives here" and
-- "the housekeeper's tap lives here".
--
-- THE FIX
-- Move the twenty-nine Staxis-owned columns to their own table, room_work.
-- After this migration the ingest physically cannot overwrite them, because
-- they are not on the table it writes. And the app stops writing the mirror
-- entirely, so the NOT NULL receipt on the mirror becomes exactly what it was
-- meant to be: proof that a report produced that row.
--
-- No REVOKE, no SECURITY DEFINER write gate. Both writers authenticate as
-- service_role, so grants cannot tell them apart — but they do not need to
-- once the columns live on different tables. The app→mirror direction is
-- already sealed by the NOT NULL ingest_run_id described above: an app write
-- to the mirror cannot succeed without a report receipt it does not have.
-- That is a stronger and cheaper wall than a function nobody would remember
-- to route through.
--
-- WHAT DOES NOT CHANGE
--   • Nothing writes back to the PMS. room_work is Staxis-owned, read by
--     Staxis, and never pushed anywhere.
--   • No one's job gains a step. Housekeepers tap the same buttons; managers
--     see the same board. This is entirely underneath.
--
-- TWO PLACES WHERE BOTH SIDES HAVE AN OPINION, AND WHO WINS
--   • Assignment. The mirror keeps housekeeper_name (a name string the PMS
--     printed). room_work gains assigned_staff_id — a real foreign key to a
--     real person. A manager or agent assignment writes assigned_staff_id;
--     readers use it when set and fall back to resolving the PMS name.
--     The person Staxis was told about by a human beats a name typed into
--     another system.
--   • Do-not-disturb. The mirror keeps dnd_active (what the PMS report said).
--     room_work gains a NULLABLE dnd_active: NULL means "Staxis has no
--     opinion", true/false means a housekeeper told us. Readers coalesce
--     app-then-mirror, so the person standing at the door wins.
--
-- WHY NOW
-- Verified in production 2026-07-25: 33 assignment rows, 40 inventory rows,
-- 4 properties, all of them test properties. This is a rewrite of a nearly
-- empty table today and a migration with real hotel history in three months.
--
-- APPLY ORDER: after 0354. Idempotent; safe to re-run.
-- DESTRUCTIVE: drops 29 columns from pms_housekeeping_assignments after
-- copying them. The preflight aborts if the copy would not be complete.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ─────────────────────────────────────────────────────────────────────────
-- Preflight — every assumption this migration was written against, re-checked
-- at apply time. Migrations here are applied by hand, sometimes weeks after
-- they are written.
-- ─────────────────────────────────────────────────────────────────────────
do $$
declare
  moved  text[] := array[
    'status', 'started_at', 'completed_at', 'time_spent_minutes',
    'is_paused', 'paused_at', 'total_paused_seconds',
    'checklist_template_id', 'checklist_progress',
    'exception_type', 'exception_note', 'exception_at',
    'manager_notes', 'manager_notes_at', 'manager_notes_by_account_id',
    'housekeeper_note', 'housekeeper_note_at',
    'is_rush', 'rush_due_by', 'rush_set_at', 'rush_set_by',
    'rush_requested_by_account_id', 'rush_duration_label',
    'marked_for_inspection_at', 'inspected_by', 'inspected_at',
    'issue_note', 'help_requested', 'dnd_note'
  ];
  found int;
  n     bigint;
begin
  if to_regclass('public.pms_housekeeping_assignments') is null then
    raise exception '0355 preflight: public.pms_housekeeping_assignments does not exist';
  end if;

  -- Already split? Then this is a re-run; the guard below lets it pass.
  if to_regclass('public.room_work') is null then
    select count(*) into found
      from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'pms_housekeeping_assignments'
       and column_name  = any (moved);
    if found <> array_length(moved, 1) then
      raise exception
        '0355 preflight: expected all % app-owned columns on pms_housekeeping_assignments, found %. The table has changed since this migration was written — re-derive the column list before running it.',
        array_length(moved, 1), found;
    end if;
  end if;

  -- The mirror must still be uniquely keyed the way room_work mirrors it.
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.pms_housekeeping_assignments'::regclass
       and contype  = 'u'
       and pg_get_constraintdef(oid) = 'UNIQUE (property_id, date, room_number)'
  ) then
    raise exception
      '0355 preflight: pms_housekeeping_assignments has no UNIQUE (property_id, date, room_number)';
  end if;

  -- staff must still carry the composite unique the assignment FK needs.
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.staff'::regclass
       and contype  = 'u'
       and pg_get_constraintdef(oid) = 'UNIQUE (id, property_id)'
  ) then
    raise exception
      '0355 preflight: staff has no UNIQUE (id, property_id) — the assignment FK cannot be created and cross-property assignment would stay possible';
  end if;

  -- Report the orphan situation rather than silently dropping rows in the
  -- backfill. 1 orphan verified in production 2026-07-25 (an assignment for a
  -- room number that is not in pms_rooms_inventory). room_work deliberately
  -- has NO foreign key to inventory — see the note on the CREATE below — so
  -- orphans carry over instead of being lost. This is a notice, not a failure.
  select count(*) into n
    from public.pms_housekeeping_assignments a
   where not exists (
     select 1 from public.pms_rooms_inventory i
      where i.property_id = a.property_id and i.room_number = a.room_number
   );
  if n > 0 then
    raise notice '0355: % assignment row(s) reference a room that is not in pms_rooms_inventory. They are carried into room_work as-is.', n;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────
-- Part A — room_work: everything Staxis knows about a room's work today.
--
-- NO FOREIGN KEY TO pms_rooms_inventory, deliberately. It is tempting: "every
-- row of work belongs to a room this hotel has" is a true invariant and the
-- database could enforce it. But inventory is written by the report ingest,
-- and room_work is written by a housekeeper standing in a doorway. If a report
-- is late, partial, or names a room slightly differently, that FK turns a
-- Start tap into a 500 and the housekeeper's tool breaks mid-shift.
-- Production already has one such orphan today. A dangling row is a reporting
-- nuisance; a broken button is someone's job. Recorded as a known,
-- unenforced invariant in src/lib/agent/INVARIANTS.md rather than pretended
-- away.
-- ─────────────────────────────────────────────────────────────────────────

-- @rls: service-role-only — the housekeeper page is a public, unauthenticated
-- SMS link, so it must never touch this table from the browser. Every read and
-- write goes through /api/housekeeper/* and /api/housekeeping/* using
-- supabaseAdmin. Same posture as pms_* (0202) and cleaning_tasks (0210).
create table if not exists public.room_work (
  property_id                  uuid        not null references public.properties(id) on delete cascade,
  date                         date        not null,
  room_number                  text        not null,

  -- Who is doing it. A real person, by id — not a name that has to be spelled
  -- the same way in two systems. The composite FK makes assigning another
  -- hotel's housekeeper structurally impossible.
  assigned_staff_id            uuid,
  assigned_source              text,

  -- Lifecycle.
  status                       text        default 'not_started',
  started_at                   timestamptz,
  completed_at                 timestamptz,
  time_spent_minutes           integer,

  -- Pause accounting.
  is_paused                    boolean     not null default false,
  paused_at                    timestamptz,
  total_paused_seconds         integer     not null default 0,

  -- Checklist.
  checklist_template_id        uuid,
  checklist_progress           text[]      not null default '{}'::text[],

  -- Exceptions (dnd / nsr / dla / sleep_out / skipped).
  exception_type               text,
  exception_note               text,
  exception_at                 timestamptz,

  -- Do-not-disturb as observed by Staxis. NULL = we have no opinion, defer to
  -- the mirror's PMS-reported dnd_active.
  dnd_active                   boolean,
  dnd_note                     text,

  -- Notes.
  manager_notes                text,
  manager_notes_at             timestamptz,
  manager_notes_by_account_id  uuid,
  housekeeper_note             text,
  housekeeper_note_at          timestamptz,

  -- Rush.
  is_rush                      boolean     not null default false,
  rush_due_by                  timestamptz,
  rush_set_at                  timestamptz,
  rush_set_by                  uuid,
  rush_requested_by_account_id uuid,
  rush_duration_label          text,

  -- Inspection.
  marked_for_inspection_at     timestamptz,
  inspected_by                 text,
  inspected_at                 timestamptz,

  -- Ad-hoc.
  issue_note                   text,
  help_requested               boolean     not null default false,

  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),

  constraint room_work_pkey primary key (property_id, date, room_number),

  -- ON DELETE SET NULL is column-scoped: property_id is NOT NULL, so an
  -- unqualified SET NULL would try to null it too and make deleting a staff
  -- member fail. Deleting a housekeeper unassigns her rooms; it never deletes
  -- the record that the work happened.
  constraint room_work_staff_fk
    foreign key (assigned_staff_id, property_id)
    references public.staff (id, property_id)
    on delete set null (assigned_staff_id),

  -- Carried over verbatim from pms_housekeeping_assignments so the split
  -- changes where the data lives and nothing else.
  constraint room_work_status_chk
    check (status is null or status = any (array['not_started', 'in_progress', 'completed', 'refused', 'skipped'])),
  constraint room_work_exception_type_chk
    check (exception_type is null or exception_type = any (array['dnd', 'nsr', 'dla', 'sleep_out', 'skipped'])),
  constraint room_work_time_spent_chk
    check (time_spent_minutes is null or time_spent_minutes >= 0),

  -- Every assignment carries its receipt: if someone is assigned, we recorded
  -- how we decided that was the right person.
  --
  -- Written as two AND-ed clauses rather than the obvious OR of two branches:
  -- in the OR form, "assigned_staff_id is not null and assigned_source = any(…)"
  -- evaluates to NULL when assigned_source is NULL, and a CHECK accepts NULL.
  -- The constraint would silently allow the exact row it exists to forbid.
  constraint room_work_assigned_source_chk
    check (
      (assigned_source is null or assigned_source = any (array['manager', 'alias_exact', 'alias_first_name', 'pms_import']))
      and (assigned_staff_id is null or assigned_source is not null)
    )
);

comment on table public.room_work is
  'Everything Staxis owns about a room''s work on a date: lifecycle, pause accounting, checklist, exceptions, notes, rush, inspection, and the assigned staff member by id. Deliberately separate from pms_housekeeping_assignments, which mirrors what the PMS report said. The report ingest never writes this table; the app never writes the mirror. Created 0355.';
comment on column public.room_work.assigned_staff_id is
  'The housekeeper, by identity. Wins over the mirror''s housekeeper_name string when set. Composite FK to staff(id, property_id) makes cross-hotel assignment impossible. Added 0355.';
comment on column public.room_work.assigned_source is
  'How the assignment was decided: manager (a human said so), alias_exact / alias_first_name (a name match, recorded in staff_aliases), pms_import (the PMS report named them). Added 0355.';
comment on column public.room_work.dnd_active is
  'Do-not-disturb as observed by Staxis staff. NULL = no Staxis opinion; readers fall back to pms_housekeeping_assignments.dnd_active. Added 0355.';

alter table public.room_work enable row level security;

-- Deny-all for the browser roles, explicitly rather than by omission, so
-- someone reading the schema can see the decision. service_role bypasses RLS.
drop policy if exists "deny browser room_work" on public.room_work;
create policy "deny browser room_work" on public.room_work
  for all to anon, authenticated using (false) with check (false);

revoke all on public.room_work from anon, authenticated;
grant select, insert, update, delete on public.room_work to service_role;

drop trigger if exists set_updated_at on public.room_work;
create trigger set_updated_at
  before update on public.room_work
  for each row execute function public._pms_set_updated_at();

-- @query: src/lib/pms-rooms-server.ts mergePmsRoomsForDate / mergePmsRoomsForStaff
create index if not exists room_work_property_date_idx
  on public.room_work (property_id, date);

-- @query: src/lib/pms-rooms-server.ts mergePmsRoomsForStaff (filter to one housekeeper)
create index if not exists room_work_assigned_staff_idx
  on public.room_work (property_id, assigned_staff_id, date)
  where assigned_staff_id is not null;

-- ─────────────────────────────────────────────────────────────────────────
-- Part B — carry the work across.
--
-- assigned_staff_id is resolved from the mirror's housekeeper_name only when
-- the match is exact (case- and whitespace-insensitive) AND unambiguous. A
-- guess is not a receipt. Anything unresolved stays NULL, and the reader falls
-- back to the same name matching it does today — so nothing regresses.
-- ─────────────────────────────────────────────────────────────────────────
-- The whole block is skipped on a re-run: once Part D has dropped the source
-- columns there is nothing left to copy, and referencing them would be a
-- syntax error rather than a no-op. EXECUTE keeps the dropped names out of the
-- parser on the second pass.
do $$
declare
  src bigint;
  dst bigint;
  gap bigint;
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'pms_housekeeping_assignments'
       and column_name  = 'checklist_progress'
  ) then
    raise notice '0355: mirror columns already moved — skipping backfill (re-run)';
    return;
  end if;

  execute $q$
    insert into public.room_work (
      property_id, date, room_number,
      assigned_staff_id, assigned_source,
      status, started_at, completed_at, time_spent_minutes,
      is_paused, paused_at, total_paused_seconds,
      checklist_template_id, checklist_progress,
      exception_type, exception_note, exception_at,
      dnd_note,
      manager_notes, manager_notes_at, manager_notes_by_account_id,
      housekeeper_note, housekeeper_note_at,
      is_rush, rush_due_by, rush_set_at, rush_set_by,
      rush_requested_by_account_id, rush_duration_label,
      marked_for_inspection_at, inspected_by, inspected_at,
      issue_note, help_requested,
      created_at
    )
    select
      a.property_id, a.date, a.room_number,
      m.staff_id,
      case when m.staff_id is not null then 'alias_exact' end,
      a.status, a.started_at, a.completed_at, a.time_spent_minutes,
      a.is_paused, a.paused_at, a.total_paused_seconds,
      a.checklist_template_id, a.checklist_progress,
      a.exception_type, a.exception_note, a.exception_at,
      a.dnd_note,
      a.manager_notes, a.manager_notes_at, a.manager_notes_by_account_id,
      a.housekeeper_note, a.housekeeper_note_at,
      a.is_rush, a.rush_due_by, a.rush_set_at, a.rush_set_by,
      a.rush_requested_by_account_id, a.rush_duration_label,
      a.marked_for_inspection_at, a.inspected_by, a.inspected_at,
      a.issue_note, a.help_requested,
      a.created_at
    from public.pms_housekeeping_assignments a
    left join lateral (
      -- Exact AND unambiguous only: two staff sharing a normalized name
      -- resolve to neither, exactly like the collision-aware TypeScript
      -- lookup. A guess is not a receipt; unresolved stays NULL and the
      -- reader falls back to today's name matching.
      select case when count(*) = 1 then (array_agg(s.id))[1] end as staff_id
        from public.staff s
       where s.property_id = a.property_id
         and a.housekeeper_name is not null
         and lower(btrim(regexp_replace(s.name, '\s+', ' ', 'g')))
           = lower(btrim(regexp_replace(a.housekeeper_name, '\s+', ' ', 'g')))
    ) m on true
    on conflict (property_id, date, room_number) do nothing
  $q$;

  -- ── Prove the copy landed before destroying the source. ────────────────
  select count(*) into src from public.pms_housekeeping_assignments;
  select count(*) into dst from public.room_work;
  if dst < src then
    raise exception '0355: room_work has % row(s) but the mirror has % — the backfill lost rows, refusing to drop the columns', dst, src;
  end if;

  select count(*) into gap
    from public.pms_housekeeping_assignments a
    left join public.room_work w
      on w.property_id = a.property_id and w.date = a.date and w.room_number = a.room_number
   where w.property_id is null;
  if gap > 0 then
    raise exception '0355: % assignment row(s) have no room_work counterpart', gap;
  end if;

  -- Every non-trivial piece of work must have survived. A row that was
  -- in_progress on the mirror and not_started in room_work would mean a
  -- housekeeper's clean was quietly reset by this migration.
  execute $q$
    select count(*)
      from public.pms_housekeeping_assignments a
      join public.room_work w
        on w.property_id = a.property_id and w.date = a.date and w.room_number = a.room_number
     where a.status is distinct from w.status
        or a.started_at is distinct from w.started_at
        or a.completed_at is distinct from w.completed_at
        or a.checklist_progress is distinct from w.checklist_progress
        or a.total_paused_seconds is distinct from w.total_paused_seconds
  $q$ into gap;
  if gap > 0 then
    raise exception '0355: % row(s) disagree between the mirror and room_work after the copy', gap;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────
-- Part C — the wall. These columns stop existing on the table the ingest
-- writes, which is what makes "a report cannot overwrite a housekeeper" a
-- fact about the database rather than a promise about the code.
-- ─────────────────────────────────────────────────────────────────────────
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
  'The housekeeping section of the PMS report, mirrored. Report data only — Staxis workflow state moved to public.room_work in 0355. Every row carries a NOT NULL ingest_run_id, which is why the app cannot write here: a housekeeper''s tap has no report to cite.';
comment on column public.pms_housekeeping_assignments.housekeeper_name is
  'The housekeeper name as printed by the PMS. A string, not a link. room_work.assigned_staff_id is the authoritative assignment when set. Note 0355.';
comment on column public.pms_housekeeping_assignments.dnd_active is
  'Do-not-disturb as reported by the PMS. room_work.dnd_active overrides it when a Staxis user has said otherwise. Note 0355.';

-- The mirror descriptor still declared the moved columns to the writer.
update public.pms_table_schemas
   set columns = (
         select coalesce(jsonb_agg(c), '[]'::jsonb)
           from jsonb_array_elements(columns) c
          where c ->> 'name' not in (
            'status', 'started_at', 'completed_at', 'time_spent_minutes',
            'is_paused', 'paused_at', 'total_paused_seconds',
            'checklist_template_id', 'checklist_progress',
            'exception_type', 'exception_note', 'exception_at',
            'manager_notes', 'manager_notes_at', 'manager_notes_by_account_id',
            'housekeeper_note', 'housekeeper_note_at',
            'is_rush', 'rush_due_by', 'rush_set_at', 'rush_set_by',
            'rush_requested_by_account_id', 'rush_duration_label',
            'marked_for_inspection_at', 'inspected_by', 'inspected_at',
            'issue_note', 'help_requested', 'dnd_note'
          )
       ),
       notes = 'PMS-reported housekeeping plan only. Staxis workflow state lives in public.room_work (0355) and is never written from a report.',
       updated_at = now()
 where table_name = 'pms_housekeeping_assignments';

-- ─────────────────────────────────────────────────────────────────────────
-- Part D — repoint the two SQL functions that wrote the moved columns.
-- ─────────────────────────────────────────────────────────────────────────

-- staxis_seed_shift_assignments wrote housekeeper_name AND an app-derived
-- cleaning_type onto the mirror. Both are now forbidden: the app does not
-- write the mirror. It has had zero callers since the shift-confirmation
-- rewrite (verified across src/, scripts/ and cua-service/), so it is dropped
-- rather than ported to a table nothing would call it about.
drop function if exists public.staxis_seed_shift_assignments(uuid, date, jsonb, jsonb);

-- complete_inspection_atomic's room side-effect moves to room_work. It also
-- gains an upsert: today, passing an inspection on a room with no assignment
-- row silently updates nothing. The inspection is the evidence the room was
-- worked on, so it materializes the work row instead of losing the result.
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
  v_date   date;
begin
  if p_result not in ('pass','fail') then
    raise exception 'E_BAD_RESULT: p_result must be pass or fail, got %', p_result
      using errcode = 'check_violation';
  end if;

  select * into v_row
    from public.inspections
    where id = p_inspection_id
    for update;

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

  -- 1) Update the inspections row.
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

  -- 2) Work side-effect → room_work. Target the latest work or plan date ON
  --    OR BEFORE the inspection's own date, so a pre-loaded FUTURE plan can
  --    never be mutated by today's inspection.
  if v_row.room_number is not null then
    select max(d) into v_date from (
      select w.date as d from public.room_work w
       where w.property_id = p_property_id and w.room_number = v_row.room_number
         and w.date <= coalesce((v_row.started_at)::date, current_date)
      union all
      select a.date from public.pms_housekeeping_assignments a
       where a.property_id = p_property_id and a.room_number = v_row.room_number
         and a.date <= coalesce((v_row.started_at)::date, current_date)
    ) candidates;

    v_date := coalesce(v_date, (v_row.started_at)::date, current_date);

    if p_result = 'pass' then
      insert into public.room_work (property_id, date, room_number, status, completed_at, inspected_at)
      values (p_property_id, v_date, v_row.room_number, 'completed', now(), now())
      on conflict (property_id, date, room_number) do update
        set status       = 'completed',
            completed_at = coalesce(room_work.completed_at, now()),
            inspected_at = now();
    else  -- fail
      insert into public.room_work (property_id, date, room_number, status, completed_at, inspected_at, issue_note)
      values (p_property_id, v_date, v_row.room_number, 'not_started', null, null, p_correction_note)
      on conflict (property_id, date, room_number) do update
        set status       = 'not_started',
            completed_at = null,
            inspected_at = null,
            issue_note   = p_correction_note;
    end if;
  end if;

  -- 3) cleaning_tasks side-effect (unchanged).
  if v_row.cleaning_task_id is not null then
    if p_result = 'pass' then
      update public.cleaning_tasks
         set status        = 'inspected_pass',
             inspected_at  = now()
       where id          = v_row.cleaning_task_id
         and property_id = p_property_id;
    else  -- fail
      update public.cleaning_tasks
         set status   = 'correction_pending',
             priority = 'high',
             notes    = p_correction_note
       where id          = v_row.cleaning_task_id
         and property_id = p_property_id;
    end if;
    get diagnostics v_count = row_count;
    if v_count <> 1 then
      raise exception 'E_TASK_PROPERTY_MISMATCH: cleaning_task % does not belong to property % (rows affected: %)',
        v_row.cleaning_task_id, p_property_id, v_count
        using errcode = 'no_data_found';
    end if;
  end if;

  -- 4) Re-check parent link (unchanged).
  if v_row.parent_inspection_id is not null then
    update public.inspections
       set recheck_inspection_id = v_row.id
     where id          = v_row.parent_inspection_id
       and property_id = p_property_id;
  end if;

  return v_row;
end;
$function$;

revoke all on function public.complete_inspection_atomic(uuid, uuid, text, jsonb, jsonb, text, boolean, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.complete_inspection_atomic(uuid, uuid, text, jsonb, jsonb, text, boolean, text, timestamptz, text) to service_role;

-- today_room_work_v1 reported the housekeeper from the mirror's name string.
-- It now prefers the assigned person's real name when room_work has one, and
-- falls back to the PMS string otherwise. No new data class is exposed — the
-- function already returned a housekeeper name.
create or replace function public.today_room_work_v1(p_property_id uuid, p_date date)
returns table(room_number text, stay_type text, housekeeper text, stayover_day integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  with latest_status as (
    select distinct on (room_number)
      room_number, status
    from public.pms_room_status_log
    where property_id = p_property_id
    order by room_number, changed_at desc
  ),
  today_res as (
    select
      r.room_number,
      case
        when r.departure_date = p_date then 'C/O'
        when r.arrival_date <= p_date and r.departure_date > p_date then 'Stay'
        else null
      end                                        as stay_type,
      greatest(1, (p_date - r.arrival_date) + 1) as stayover_day
    from public.pms_reservations r
    where r.property_id = p_property_id
      and r.arrival_date <= p_date
      and r.departure_date >= p_date
  ),
  -- Each side is narrowed to this property and date BEFORE the join, so the
  -- full outer join runs over one day's rooms rather than the whole history of
  -- both tables.
  plan as (
    select a.room_number, a.housekeeper_name
      from public.pms_housekeeping_assignments a
     where a.property_id = p_property_id and a.date = p_date
  ),
  work as (
    select w.room_number, w.assigned_staff_id
      from public.room_work w
     where w.property_id = p_property_id and w.date = p_date
  ),
  today_assign as (
    select
      coalesce(w.room_number, p.room_number) as room_number,
      -- The person a human assigned beats the name the PMS printed.
      coalesce(s.name, p.housekeeper_name)   as housekeeper
    from plan p
    full outer join work w on w.room_number = p.room_number
    left join public.staff s
      on s.id = w.assigned_staff_id
     and s.property_id = p_property_id
  )
  select
    ls.room_number,
    tr.stay_type,
    ta.housekeeper,
    tr.stayover_day
  from latest_status ls
  left join today_res    tr on tr.room_number = ls.room_number
  left join today_assign ta on ta.room_number = ls.room_number
  order by ls.room_number;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- Postflight.
-- ─────────────────────────────────────────────────────────────────────────
do $$
declare
  leftover int;
begin
  select count(*) into leftover
    from information_schema.columns
   where table_schema = 'public'
     and table_name   = 'pms_housekeeping_assignments'
     and column_name in ('status', 'checklist_progress', 'manager_notes', 'is_rush',
                         'inspected_at', 'help_requested', 'total_paused_seconds');
  if leftover > 0 then
    raise exception '0355 postflight: % app-owned column(s) still on the mirror', leftover;
  end if;

  if to_regclass('public.room_work') is null then
    raise exception '0355 postflight: room_work was not created';
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.room_work'::regclass and conname = 'room_work_staff_fk'
  ) then
    raise exception '0355 postflight: room_work_staff_fk is missing — assignment would still be a name string';
  end if;

  if exists (select 1 from public.staxis_pms_registry_violations()) then
    raise exception '0355 postflight: pms_table_schemas disagrees with the physical schema';
  end if;
end $$;

insert into public.applied_migrations (version, description)
values (
  '0355',
  'Housekeeping mirror/state split: 29 Staxis-owned workflow columns moved off pms_housekeeping_assignments into the new service-role-only room_work table, keyed (property_id, date, room_number), with assigned_staff_id as a composite FK to staff(id, property_id) replacing name-string matching. The report ingest can no longer overwrite a housekeeper''s work because those columns no longer exist on the table it writes. complete_inspection_atomic repointed and upgraded to upsert; staxis_seed_shift_assignments dropped (zero callers, wrote the mirror); today_room_work_v1 now prefers the assigned person over the PMS name string.'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
