-- ═══════════════════════════════════════════════════════════════════════════
-- Staxis / HotelOps AI — Cross-department Activity Log (Migration 0228)
--
-- A unified "everything that happened" timeline for the property. Every
-- meaningful event written by any other table (cleanings, inspections,
-- callouts, work orders, room status changes, role changes, etc.) is
-- mirrored into `activity_log` so the manager-facing Settings → Activity
-- Log page can show a single searchable / filterable / exportable view.
--
-- Population strategy: Option A (database triggers).
--   - Chose triggers over app-level recorders because the existing event
--     write paths are spread across many files (sick-callout/service.ts
--     alone has 9 .from('callout_events') sites). Trigger-based capture
--     is atomic with the source insert and impossible to skip.
--   - Trigger functions are SECURITY DEFINER so they can write into the
--     service-role-only activity_log even when the source insert ran as
--     an authenticated user. search_path is pinned per the existing
--     audit-security-definer-search-path lint.
--   - Plain-English `description` is pre-rendered in the trigger using
--     SQL format() so reads + export stay fast. The full event payload
--     also lands in `metadata` jsonb for forensic queries + future
--     re-rendering in Spanish.
--
-- Backfill: last 90 days of the existing event tables are seeded so the
-- page has data on day one. Backfill is idempotent via a deterministic
-- (event_type, source_event_id, occurred_at) partial unique index.
--
-- Extensibility: new event sources (housekeeping_notices, staff_breaks,
-- inventory_movements, message threads, front-desk events) plug in by
-- (a) defining their event_type values + (b) attaching a trigger using
-- the same _activity_log_write() helper. No schema changes needed.
--
-- Manual prod apply: per project_migration_application_manual.md.
-- Idempotent: create-if-not-exists everywhere. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- 1. activity_log table
-- ───────────────────────────────────────────────────────────────────────────
-- @rls: service-role-only — all UI access mediated by /api/settings/activity-log/* via supabaseAdmin (matches pms_* + cleaning_tasks + hk_assignments + inspections + callout_events).
create table if not exists public.activity_log (
  id                uuid primary key default gen_random_uuid(),
  property_id       uuid not null references public.properties(id) on delete cascade,
  occurred_at       timestamptz not null default now(),

  -- Coarse bucket for the filter pills.
  event_category    text not null
                    check (event_category in (
                      'housekeeping',
                      'maintenance',
                      'staff',
                      'system',
                      'messages',
                      'inventory',
                      'front_desk'
                    )),
  -- Fine-grained event id, e.g. 'cleaning_started', 'inspection_failed',
  -- 'role_changed', 'work_order_resolved'. Free text so new sources can
  -- add types without a schema change.
  event_type        text not null,

  -- Who did it. account_id is null when the actor is a system component
  -- (cron, CUA worker, rules engine). name + role are snapshotted at
  -- write time so the display survives account renames / deletions.
  actor_account_id  uuid,
  actor_name        text,
  actor_role        text,

  -- What it happened to (room, task, work order, user, etc.).
  target_type       text,
  target_id         text,
  target_label      text,

  -- Pre-rendered plain-English sentence shown in the timeline list and
  -- exports. Renderers live in the trigger functions below; the same
  -- template logic is mirrored in src/lib/activity-log/renderer.ts for
  -- Spanish or richer rendering on read.
  description       text not null,

  -- Which system component produced the event.
  source            text not null default 'system'
                    check (source in (
                      'housekeeper_app',
                      'manager_dashboard',
                      'admin_dashboard',
                      'cron',
                      'cua_worker',
                      'rules_engine',
                      'pms_sync',
                      'system',
                      'sms',
                      'voice'
                    )),

  -- Foreign reference to the originating row in its source table. Lets
  -- the side panel jump back to the live record + makes backfill
  -- idempotent via the unique partial index below.
  source_event_id   uuid,

  -- Full structured payload of the event for forensics + later
  -- re-rendering. Never displayed by default — collapsed under a
  -- "raw event" disclosure in the side panel.
  metadata          jsonb not null default '{}'::jsonb,

  created_at        timestamptz not null default now()
);

comment on table public.activity_log is
  'Cross-department audit + activity timeline. One row per meaningful event from any source table (housekeeping, maintenance, staff, system). Populated by AFTER INSERT/UPDATE triggers on each source. Service-role-only. Created 0215.';
comment on column public.activity_log.occurred_at is
  'When the underlying event happened (e.g., cleaning_task.started_at). Distinct from created_at, which is when this audit row was inserted.';
comment on column public.activity_log.description is
  'Pre-rendered English sentence. Triggers compose this; a TS renderer in src/lib/activity-log/renderer.ts can re-render in Spanish from metadata.';
comment on column public.activity_log.source_event_id is
  'ID of the originating row in its source table (e.g., cleaning_tasks.id). Used for backfill idempotency + the side-panel deep link.';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Indexes — every read path the Settings page query supports
-- ───────────────────────────────────────────────────────────────────────────

-- Primary timeline: latest events for a property.
create index if not exists activity_log_property_time_idx
  on public.activity_log (property_id, occurred_at desc);

-- Category filter pills.
create index if not exists activity_log_property_cat_time_idx
  on public.activity_log (property_id, event_category, occurred_at desc);

-- "Everything Maria did today" — by-actor filter.
create index if not exists activity_log_property_actor_time_idx
  on public.activity_log (property_id, actor_account_id, occurred_at desc)
  where actor_account_id is not null;

-- "Everything that happened to room 305" — by-target filter.
create index if not exists activity_log_property_target_time_idx
  on public.activity_log (property_id, target_type, target_id, occurred_at desc)
  where target_id is not null;

-- Source filter (app vs cron vs cua vs rules).
create index if not exists activity_log_property_source_time_idx
  on public.activity_log (property_id, source, occurred_at desc);

-- Backfill dedupe: a (property_id, event_type, source_event_id,
-- occurred_at) tuple uniquely identifies a backfilled row, so
-- re-running the backfill block in this migration is a no-op.
--
-- property_id must be part of the key because the accounts trigger
-- fans out one activity_log row per property in property_access[] —
-- without property_id, those rows would all share the same
-- (event_type=user_created, source_event_id=accounts.id, occurred_at)
-- and ON CONFLICT DO NOTHING would silently drop all but the first.
-- (Codex adversarial review #3.)
create unique index if not exists activity_log_source_event_unique_idx
  on public.activity_log (property_id, event_type, source_event_id, occurred_at)
  where source_event_id is not null;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. RLS — service-role only, matches pms_* + cleaning_tasks pattern
-- ───────────────────────────────────────────────────────────────────────────
alter table public.activity_log enable row level security;
revoke all on public.activity_log from public, anon, authenticated;
grant select, insert, update, delete on public.activity_log to service_role;

drop policy if exists activity_log_deny_all on public.activity_log;
create policy activity_log_deny_all on public.activity_log
  for all to anon, authenticated using (false) with check (false);
comment on policy activity_log_deny_all on public.activity_log is
  'Service-role only. UI reads/writes through /api/settings/activity-log/* with supabaseAdmin. Created 0215.';

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Helper: resolve actor name + role from staff_id or auth.users uid
-- ───────────────────────────────────────────────────────────────────────────
-- Looks up display values for the actor at write time so the activity row
-- doesn't depend on staff/accounts rows surviving. Returns 'System' / null
-- when neither id is provided.
create or replace function public._activity_log_resolve_actor(
  p_staff_id   uuid,
  p_user_id    uuid
) returns table (
  account_id   uuid,
  actor_name   text,
  actor_role   text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if p_user_id is not null then
    return query
      select a.id, a.display_name, a.role
        from public.accounts a
        where a.data_user_id = p_user_id
        limit 1;
    if found then return; end if;
  end if;

  if p_staff_id is not null then
    return query
      select null::uuid, s.name, s.department
        from public.staff s
        where s.id = p_staff_id
        limit 1;
    if found then return; end if;
  end if;

  return query select null::uuid, 'System'::text, null::text;
end;
$$;

comment on function public._activity_log_resolve_actor(uuid, uuid) is
  'Snapshot the actor display name + role from staff or accounts at write time. Used by every activity_log trigger. Created 0215.';

-- SECURITY DEFINER lockdown: revoke the default PUBLIC EXECUTE so only
-- the service_role + the trigger-internal call path can invoke it.
-- Without this, any anon/authenticated caller could RPC this helper to
-- read staff/accounts rows across properties (Codex review #1).
revoke execute on function public._activity_log_resolve_actor(uuid, uuid) from public, anon, authenticated;
grant execute on function public._activity_log_resolve_actor(uuid, uuid) to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Helper: thin wrapper that triggers call to insert one activity row.
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public._activity_log_write(
  p_property_id       uuid,
  p_occurred_at       timestamptz,
  p_event_category    text,
  p_event_type        text,
  p_actor_staff_id    uuid,
  p_actor_user_id     uuid,
  p_target_type       text,
  p_target_id         text,
  p_target_label      text,
  p_description       text,
  p_source            text,
  p_source_event_id   uuid,
  p_metadata          jsonb
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_account_id  uuid;
  v_actor_name  text;
  v_actor_role  text;
begin
  if p_property_id is null then
    return;
  end if;

  -- Audit-logging must never break the underlying op. If anything in
  -- this body throws (e.g., a stale schema cache + new event_type
  -- failing a CHECK constraint, an out-of-disk Postgres error, etc.),
  -- swallow the error and let the source insert/update succeed. The
  -- worst case is a lost log entry — the source state stays consistent.
  begin
    select account_id, actor_name, actor_role
      into v_account_id, v_actor_name, v_actor_role
      from public._activity_log_resolve_actor(p_actor_staff_id, p_actor_user_id);

    insert into public.activity_log (
      property_id, occurred_at, event_category, event_type,
      actor_account_id, actor_name, actor_role,
      target_type, target_id, target_label,
      description, source, source_event_id, metadata
    ) values (
      p_property_id,
      coalesce(p_occurred_at, now()),
      p_event_category,
      p_event_type,
      v_account_id,
      coalesce(v_actor_name, 'System'),
      v_actor_role,
      p_target_type,
      p_target_id,
      p_target_label,
      p_description,
      coalesce(p_source, 'system'),
      p_source_event_id,
      coalesce(p_metadata, '{}'::jsonb)
    )
    on conflict (property_id, event_type, source_event_id, occurred_at)
      where source_event_id is not null
      do nothing;
  exception when others then
    -- Log to Postgres' notice channel so the doctor can spot a pattern.
    raise warning 'activity_log write failed: %', SQLERRM;
  end;
end;
$$;

comment on function public._activity_log_write(
  uuid, timestamptz, text, text, uuid, uuid, text, text, text, text, text, uuid, jsonb
) is 'Trigger helper — inserts one activity_log row with pre-resolved actor display. ON CONFLICT no-ops the backfill dedupe. Created 0215.';

-- SECURITY DEFINER lockdown: without this, an anon/authenticated caller
-- could RPC the writer and forge cross-property audit rows. (Codex
-- adversarial review #1.) Only the service role + trigger-internal call
-- path may invoke; triggers run AS the function owner so they ignore
-- this grant.
revoke execute on function public._activity_log_write(
  uuid, timestamptz, text, text, uuid, uuid, text, text, text, text, text, uuid, jsonb
) from public, anon, authenticated;
grant execute on function public._activity_log_write(
  uuid, timestamptz, text, text, uuid, uuid, text, text, text, text, text, uuid, jsonb
) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. TRIGGER FUNCTIONS — one per source table
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 6a. cleaning_events ────────────────────────────────────────────────────
-- A row is inserted when a housekeeper taps Done. Status decided at insert.
create or replace function public._activity_log_on_cleaning_event_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_desc text;
  v_type text;
begin
  v_type := case new.status
              when 'flagged'   then 'cleaning_flagged'
              when 'discarded' then 'cleaning_discarded'
              else                  'cleaning_completed'
            end;
  v_desc := case new.status
              when 'flagged'   then format('%s flagged a long clean on room %s (%s min)', coalesce(new.staff_name,'A housekeeper'), new.room_number, round(new.duration_minutes))
              when 'discarded' then format('%s tapped Done on room %s but it was discarded as too short (%s min)', coalesce(new.staff_name,'A housekeeper'), new.room_number, round(new.duration_minutes))
              else                  format('%s finished cleaning room %s (%s min)', coalesce(new.staff_name,'A housekeeper'), new.room_number, round(new.duration_minutes))
            end;

  perform public._activity_log_write(
    new.property_id,
    new.completed_at,
    'housekeeping',
    v_type,
    new.staff_id,
    null,
    'room',
    new.room_number,
    'Room ' || new.room_number,
    v_desc,
    'housekeeper_app',
    new.id,
    jsonb_build_object(
      'date', new.date,
      'room_type', new.room_type,
      'stayover_day', new.stayover_day,
      'staff_id', new.staff_id,
      'staff_name', new.staff_name,
      'started_at', new.started_at,
      'completed_at', new.completed_at,
      'duration_minutes', new.duration_minutes,
      'status', new.status,
      'flag_reason', new.flag_reason
    )
  );
  return new;
end;
$$;

-- Flagged → approved / rejected: review decisions.
create or replace function public._activity_log_on_cleaning_event_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_desc text;
  v_type text;
begin
  if old.status = new.status then
    return new;
  end if;
  if new.status not in ('approved','rejected') then
    return new;
  end if;

  v_type := 'cleaning_review_' || new.status;
  v_desc := case new.status
              when 'approved' then format('A flagged clean on room %s was approved by review', new.room_number)
              else                 format('A flagged clean on room %s was thrown out by review', new.room_number)
            end;

  perform public._activity_log_write(
    new.property_id,
    new.reviewed_at,
    'housekeeping',
    v_type,
    null,
    new.reviewed_by,
    'room',
    new.room_number,
    'Room ' || new.room_number,
    v_desc,
    'manager_dashboard',
    new.id,
    jsonb_build_object(
      'date', new.date,
      'staff_id', new.staff_id,
      'staff_name', new.staff_name,
      'duration_minutes', new.duration_minutes,
      'old_status', old.status,
      'new_status', new.status,
      'reviewed_by', new.reviewed_by
    )
  );
  return new;
end;
$$;

drop trigger if exists trg_activity_log_cleaning_event_ins on public.cleaning_events;
create trigger trg_activity_log_cleaning_event_ins
  after insert on public.cleaning_events
  for each row execute function public._activity_log_on_cleaning_event_insert();

drop trigger if exists trg_activity_log_cleaning_event_upd on public.cleaning_events;
create trigger trg_activity_log_cleaning_event_upd
  after update of status on public.cleaning_events
  for each row execute function public._activity_log_on_cleaning_event_update();

-- ── 6b. cleaning_tasks ─────────────────────────────────────────────────────
-- INSERT = task created by the rules engine.
create or replace function public._activity_log_on_cleaning_task_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._activity_log_write(
    new.property_id,
    new.created_at,
    'housekeeping',
    'cleaning_task_created',
    null,
    null,
    'cleaning_task',
    new.id::text,
    'Room ' || new.room_number || ' — ' || new.cleaning_type,
    format('Cleaning task created for room %s (%s, priority %s)', new.room_number, new.cleaning_type, new.priority),
    'rules_engine',
    new.id,
    jsonb_build_object(
      'room_number', new.room_number,
      'business_date', new.business_date,
      'cleaning_type', new.cleaning_type,
      'priority', new.priority,
      'due_by', new.due_by,
      'estimated_minutes', new.estimated_minutes,
      'requires_inspection', new.requires_inspection,
      'status', new.status,
      'rules_fired', new.rules_fired
    )
  );
  return new;
end;
$$;

-- UPDATE of status: started, completed, deferred, cancelled, etc.
-- Only writes a row when the status actually changes.
create or replace function public._activity_log_on_cleaning_task_status_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_desc text;
  v_type text;
  v_when timestamptz;
begin
  if old.status is not distinct from new.status then
    return new;
  end if;

  v_type := 'cleaning_task_' || new.status;
  v_when := case new.status
              when 'in_progress'         then new.started_at
              when 'paused'              then new.paused_at
              when 'completed'           then new.completed_at
              when 'inspected_pass'      then new.inspected_at
              when 'inspected_fail'      then new.inspected_at
              else                            new.updated_at
            end;

  v_desc := case new.status
              when 'ready_now'           then format('Room %s is ready to clean now', new.room_number)
              when 'in_progress'         then format('Cleaning started on room %s', new.room_number)
              when 'paused'              then format('Cleaning paused on room %s', new.room_number)
              when 'completed'           then format('Cleaning finished on room %s', new.room_number)
              when 'inspection_pending'  then format('Room %s is waiting on inspection', new.room_number)
              when 'inspected_pass'      then format('Room %s passed inspection', new.room_number)
              when 'inspected_fail'      then format('Room %s failed inspection', new.room_number)
              when 'correction_pending'  then format('Room %s sent back for corrections', new.room_number)
              when 'correction_complete' then format('Corrections finished on room %s', new.room_number)
              when 'deferred'            then format('Cleaning on room %s was deferred', new.room_number)
              when 'skipped'             then format('Cleaning on room %s was skipped', new.room_number)
              when 'cancelled'           then format('Cleaning task for room %s was cancelled', new.room_number)
              when 'superseded'          then format('Cleaning task for room %s was superseded by a new task', new.room_number)
              else                            format('Cleaning task for room %s changed status to %s', new.room_number, new.status)
            end;

  perform public._activity_log_write(
    new.property_id,
    coalesce(v_when, new.updated_at),
    'housekeeping',
    v_type,
    new.assignee_id,
    null,
    'cleaning_task',
    new.id::text,
    'Room ' || new.room_number,
    v_desc,
    case when new.assignee_id is not null then 'housekeeper_app' else 'rules_engine' end,
    new.id,
    jsonb_build_object(
      'room_number', new.room_number,
      'business_date', new.business_date,
      'cleaning_type', new.cleaning_type,
      'old_status', old.status,
      'new_status', new.status,
      'assignee_id', new.assignee_id
    )
  );
  return new;
end;
$$;

drop trigger if exists trg_activity_log_cleaning_task_ins on public.cleaning_tasks;
create trigger trg_activity_log_cleaning_task_ins
  after insert on public.cleaning_tasks
  for each row execute function public._activity_log_on_cleaning_task_insert();

drop trigger if exists trg_activity_log_cleaning_task_upd on public.cleaning_tasks;
create trigger trg_activity_log_cleaning_task_upd
  after update of status on public.cleaning_tasks
  for each row execute function public._activity_log_on_cleaning_task_status_update();

-- ── 6c. hk_assignments ─────────────────────────────────────────────────────
-- INSERT = housekeeper assigned to a task. UPDATE that deactivates =
-- reassignment (the row is superseded by a new is_active=true row).
create or replace function public._activity_log_on_hk_assignment_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room   text;
  v_name   text;
  v_label  text;
  v_desc   text;
begin
  if new.is_active is not true then
    return new;
  end if;

  select t.room_number into v_room
    from public.cleaning_tasks t
    where t.id = new.cleaning_task_id
    limit 1;

  select s.name into v_name
    from public.staff s
    where s.id = new.housekeeper_id
    limit 1;

  v_label := coalesce('Room ' || v_room, 'Cleaning task');
  v_desc := case new.assigned_by
              when 'auto'      then format('Auto-assigned %s to %s', coalesce(v_name,'a housekeeper'), v_label)
              when 'rebalance' then format('Reassigned %s to %s after sick callout rebalance', coalesce(v_name,'a housekeeper'), v_label)
              else                  format('Assigned %s to %s', coalesce(v_name,'a housekeeper'), v_label)
            end;

  perform public._activity_log_write(
    new.property_id,
    new.assigned_at,
    'housekeeping',
    'assignment_created',
    new.housekeeper_id,
    new.assigned_by_user_id,
    'cleaning_task',
    new.cleaning_task_id::text,
    v_label,
    v_desc,
    case new.assigned_by
      when 'auto'      then 'rules_engine'
      when 'rebalance' then 'rules_engine'
      else                  'manager_dashboard'
    end,
    new.id,
    jsonb_build_object(
      'cleaning_task_id', new.cleaning_task_id,
      'housekeeper_id', new.housekeeper_id,
      'housekeeper_name', v_name,
      'room_number', v_room,
      'assigned_by', new.assigned_by,
      'queue_order', new.queue_order,
      'reason', new.reason,
      'score', new.score
    )
  );
  return new;
end;
$$;

create or replace function public._activity_log_on_hk_assignment_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room   text;
  v_name   text;
  v_label  text;
begin
  -- We care about deactivation events. Activation events are covered by
  -- the INSERT trigger (a new is_active=true row is inserted to replace
  -- a deactivated one).
  if not (old.is_active and not new.is_active) then
    return new;
  end if;

  select t.room_number into v_room
    from public.cleaning_tasks t
    where t.id = new.cleaning_task_id
    limit 1;
  select s.name into v_name
    from public.staff s
    where s.id = new.housekeeper_id
    limit 1;
  v_label := coalesce('Room ' || v_room, 'Cleaning task');

  perform public._activity_log_write(
    new.property_id,
    new.updated_at,
    'housekeeping',
    'assignment_deactivated',
    new.housekeeper_id,
    new.assigned_by_user_id,
    'cleaning_task',
    new.cleaning_task_id::text,
    v_label,
    format('Unassigned %s from %s', coalesce(v_name,'a housekeeper'), v_label),
    'manager_dashboard',
    new.id,
    jsonb_build_object(
      'cleaning_task_id', new.cleaning_task_id,
      'housekeeper_id', new.housekeeper_id,
      'housekeeper_name', v_name,
      'room_number', v_room,
      'reason', new.reason
    )
  );
  return new;
end;
$$;

drop trigger if exists trg_activity_log_hk_assignment_ins on public.hk_assignments;
create trigger trg_activity_log_hk_assignment_ins
  after insert on public.hk_assignments
  for each row execute function public._activity_log_on_hk_assignment_insert();

drop trigger if exists trg_activity_log_hk_assignment_upd on public.hk_assignments;
create trigger trg_activity_log_hk_assignment_upd
  after update of is_active on public.hk_assignments
  for each row execute function public._activity_log_on_hk_assignment_update();

-- ── 6d. inspections ────────────────────────────────────────────────────────
create or replace function public._activity_log_on_inspection_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._activity_log_write(
    new.property_id,
    new.started_at,
    'housekeeping',
    'inspection_started',
    new.inspector_staff_id,
    null,
    'room',
    new.room_number,
    'Room ' || new.room_number,
    format('Inspection started on room %s', new.room_number),
    'manager_dashboard',
    new.id,
    jsonb_build_object(
      'room_number', new.room_number,
      'cleaning_task_id', new.cleaning_task_id,
      'inspector_staff_id', new.inspector_staff_id,
      'housekeeper_staff_id', new.housekeeper_staff_id,
      'checklist_id', new.checklist_id
    )
  );
  return new;
end;
$$;

-- UPDATE of result: pass / fail / cancelled.
create or replace function public._activity_log_on_inspection_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_desc       text;
  v_type       text;
  v_fail_count integer;
begin
  if old.result is not distinct from new.result then
    return new;
  end if;
  if new.result = 'in_progress' then
    return new;
  end if;

  v_type := 'inspection_' || new.result;
  if new.result = 'fail' then
    v_fail_count := jsonb_array_length(coalesce(new.failed_items,'[]'::jsonb));
    v_desc := format('Room %s failed inspection — %s issue%s flagged', new.room_number, v_fail_count, case when v_fail_count = 1 then '' else 's' end);
    if new.escalated then
      v_desc := v_desc || ' (escalated)';
    end if;
  elsif new.result = 'pass' then
    v_desc := format('Room %s passed inspection', new.room_number);
  else
    v_desc := format('Inspection on room %s was cancelled', new.room_number);
  end if;

  perform public._activity_log_write(
    new.property_id,
    coalesce(new.completed_at, new.updated_at),
    'housekeeping',
    v_type,
    new.inspector_staff_id,
    null,
    'room',
    new.room_number,
    'Room ' || new.room_number,
    v_desc,
    'manager_dashboard',
    new.id,
    jsonb_build_object(
      'room_number', new.room_number,
      'cleaning_task_id', new.cleaning_task_id,
      'inspector_staff_id', new.inspector_staff_id,
      'housekeeper_staff_id', new.housekeeper_staff_id,
      'old_result', old.result,
      'new_result', new.result,
      'failed_items', new.failed_items,
      'escalated', new.escalated
    )
  );
  return new;
end;
$$;

drop trigger if exists trg_activity_log_inspection_ins on public.inspections;
create trigger trg_activity_log_inspection_ins
  after insert on public.inspections
  for each row execute function public._activity_log_on_inspection_insert();

drop trigger if exists trg_activity_log_inspection_upd on public.inspections;
create trigger trg_activity_log_inspection_upd
  after update of result on public.inspections
  for each row execute function public._activity_log_on_inspection_update();

-- ── 6e. callout_events ─────────────────────────────────────────────────────
create or replace function public._activity_log_on_callout_event_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text;
begin
  select s.name into v_name from public.staff s where s.id = new.staff_id limit 1;

  perform public._activity_log_write(
    new.property_id,
    new.reported_at,
    'staff',
    'callout_reported',
    new.staff_id,
    new.reported_by_user_id,
    'staff',
    new.staff_id::text,
    coalesce(v_name, 'A staff member'),
    format('%s called out%s%s', coalesce(v_name,'A staff member'),
           case when new.reason is not null then format(' (%s)', new.reason) else '' end,
           case new.reported_by
             when 'self'    then ''
             when 'manager' then ' — marked by manager'
             when 'sms'     then ' — by SMS'
             else ''
           end),
    case new.reported_by when 'sms' then 'sms' when 'manager' then 'manager_dashboard' else 'housekeeper_app' end,
    new.id,
    jsonb_build_object(
      'staff_id', new.staff_id,
      'staff_name', v_name,
      'business_date', new.business_date,
      'reported_by', new.reported_by,
      'reported_by_user_id', new.reported_by_user_id,
      'reason', new.reason,
      'note', new.note,
      'leave_timing', new.leave_timing
    )
  );
  return new;
end;
$$;

-- UPDATE: status flips to 'reverted'.
create or replace function public._activity_log_on_callout_event_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text;
begin
  if old.status is not distinct from new.status then
    return new;
  end if;
  if new.status <> 'reverted' then
    return new;
  end if;
  select s.name into v_name from public.staff s where s.id = new.staff_id limit 1;

  perform public._activity_log_write(
    new.property_id,
    coalesce(new.reverted_at, new.updated_at),
    'staff',
    'callout_reverted',
    new.staff_id,
    new.reverted_by_user_id,
    'staff',
    new.staff_id::text,
    coalesce(v_name, 'A staff member'),
    format('Sick callout for %s was reverted%s', coalesce(v_name,'a staff member'),
           case when new.revert_reason is not null then ' — ' || new.revert_reason else '' end),
    case when new.reverted_by_user_id is not null then 'manager_dashboard' else 'housekeeper_app' end,
    new.id,
    jsonb_build_object(
      'staff_id', new.staff_id,
      'staff_name', v_name,
      'business_date', new.business_date,
      'reverted_by_user_id', new.reverted_by_user_id,
      'reverted_by_staff_id', new.reverted_by_staff_id,
      'revert_reason', new.revert_reason,
      'revert_outcome', new.revert_outcome
    )
  );
  return new;
end;
$$;

drop trigger if exists trg_activity_log_callout_event_ins on public.callout_events;
create trigger trg_activity_log_callout_event_ins
  after insert on public.callout_events
  for each row execute function public._activity_log_on_callout_event_insert();

drop trigger if exists trg_activity_log_callout_event_upd on public.callout_events;
create trigger trg_activity_log_callout_event_upd
  after update of status on public.callout_events
  for each row execute function public._activity_log_on_callout_event_update();

-- ── 6f. pms_work_orders_v2 ─────────────────────────────────────────────────
-- CUA pulls work orders from the PMS. INSERT = new ticket appeared.
-- UPDATE of status = ticket resolved / progressed.
create or replace function public._activity_log_on_work_order_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_label text;
  v_desc  text;
begin
  v_label := coalesce('Room ' || new.room_number, coalesce(new.area, 'Work order'));
  v_desc := format('Work order created on %s — %s (priority %s)', v_label, coalesce(new.category,'other'), new.priority);

  perform public._activity_log_write(
    new.property_id,
    coalesce(new.reported_at, new.created_at, now()),
    'maintenance',
    'work_order_created',
    null,
    null,
    'work_order',
    coalesce(new.pms_work_order_id, new.id::text),
    v_label,
    v_desc,
    'pms_sync',
    new.id,
    jsonb_build_object(
      'pms_work_order_id', new.pms_work_order_id,
      'room_number', new.room_number,
      'area', new.area,
      'category', new.category,
      'priority', new.priority,
      'status', new.status,
      'description', new.description,
      'reported_by', new.reported_by,
      'assigned_to', new.assigned_to,
      'out_of_order', new.out_of_order
    )
  );
  return new;
end;
$$;

create or replace function public._activity_log_on_work_order_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_label text;
  v_desc  text;
  v_type  text;
begin
  if old.status is not distinct from new.status then
    return new;
  end if;

  v_label := coalesce('Room ' || new.room_number, coalesce(new.area, 'Work order'));
  v_type := 'work_order_' || new.status;
  v_desc := case new.status
              when 'in_progress' then format('Work order on %s is now in progress', v_label)
              when 'closed'      then format('Work order on %s was closed', v_label)
              when 'deferred'    then format('Work order on %s was deferred', v_label)
              when 'resolved'    then format('Work order on %s was resolved', v_label)
              when 'open'        then format('Work order on %s was reopened', v_label)
              else                    format('Work order on %s changed status to %s', v_label, new.status)
            end;

  perform public._activity_log_write(
    new.property_id,
    coalesce(new.resolved_at, new.completed_at, new.started_at, new.updated_at, now()),
    'maintenance',
    v_type,
    null,
    null,
    'work_order',
    coalesce(new.pms_work_order_id, new.id::text),
    v_label,
    v_desc,
    'pms_sync',
    new.id,
    jsonb_build_object(
      'pms_work_order_id', new.pms_work_order_id,
      'room_number', new.room_number,
      'old_status', old.status,
      'new_status', new.status,
      'category', new.category,
      'priority', new.priority,
      'assigned_to', new.assigned_to
    )
  );
  return new;
end;
$$;

drop trigger if exists trg_activity_log_work_order_ins on public.pms_work_orders_v2;
create trigger trg_activity_log_work_order_ins
  after insert on public.pms_work_orders_v2
  for each row execute function public._activity_log_on_work_order_insert();

drop trigger if exists trg_activity_log_work_order_upd on public.pms_work_orders_v2;
create trigger trg_activity_log_work_order_upd
  after update of status on public.pms_work_orders_v2
  for each row execute function public._activity_log_on_work_order_update();

-- ── 6g. pms_room_status_log ────────────────────────────────────────────────
-- Append-only. Insert-only trigger covers all room status transitions.
create or replace function public._activity_log_on_room_status_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_source text;
begin
  v_source := case new.source
                when 'cua'       then 'pms_sync'
                when 'manual'    then 'manager_dashboard'
                when 'scheduled' then 'cron'
                when 'workflow'  then 'cua_worker'
                else                  'system'
              end;

  perform public._activity_log_write(
    new.property_id,
    new.changed_at,
    'system',
    'room_status_changed',
    null,
    null,
    'room',
    new.room_number,
    'Room ' || new.room_number,
    format('Room %s is now %s', new.room_number, replace(new.status,'_',' ')),
    v_source,
    new.id,
    jsonb_build_object(
      'room_number', new.room_number,
      'status', new.status,
      'changed_by', new.changed_by,
      'source', new.source,
      'notes', new.notes
    )
  );
  return new;
end;
$$;

drop trigger if exists trg_activity_log_room_status_ins on public.pms_room_status_log;
create trigger trg_activity_log_room_status_ins
  after insert on public.pms_room_status_log
  for each row execute function public._activity_log_on_room_status_insert();

-- ── 6h. accounts ───────────────────────────────────────────────────────────
-- INSERT = new user invited / signed up. UPDATE of role = role change.
create or replace function public._activity_log_on_account_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_property_id uuid;
begin
  -- accounts.property_access is an array; we log one row per property
  -- the new account can touch so the timeline filters correctly per hotel.
  if new.property_access is null or array_length(new.property_access, 1) is null then
    return new;
  end if;

  foreach v_property_id in array new.property_access loop
    perform public._activity_log_write(
      v_property_id,
      new.created_at,
      'staff',
      'user_created',
      null,
      new.data_user_id,
      'user',
      new.id::text,
      new.display_name,
      format('User %s was added with role %s', new.display_name, new.role),
      'admin_dashboard',
      new.id,
      jsonb_build_object(
        'account_id', new.id,
        'username', new.username,
        'display_name', new.display_name,
        'role', new.role
      )
    );
  end loop;
  return new;
end;
$$;

create or replace function public._activity_log_on_account_role_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_property_id uuid;
begin
  if old.role is not distinct from new.role then
    return new;
  end if;
  if new.property_access is null or array_length(new.property_access, 1) is null then
    return new;
  end if;

  foreach v_property_id in array new.property_access loop
    perform public._activity_log_write(
      v_property_id,
      new.updated_at,
      'staff',
      'role_changed',
      null,
      new.data_user_id,
      'user',
      new.id::text,
      new.display_name,
      format('User %s — role changed from %s to %s', new.display_name, old.role, new.role),
      'admin_dashboard',
      new.id,
      jsonb_build_object(
        'account_id', new.id,
        'display_name', new.display_name,
        'old_role', old.role,
        'new_role', new.role
      )
    );
  end loop;
  return new;
end;
$$;

drop trigger if exists trg_activity_log_account_ins on public.accounts;
create trigger trg_activity_log_account_ins
  after insert on public.accounts
  for each row execute function public._activity_log_on_account_insert();

drop trigger if exists trg_activity_log_account_role_upd on public.accounts;
create trigger trg_activity_log_account_role_upd
  after update of role on public.accounts
  for each row execute function public._activity_log_on_account_role_update();

-- ── 6i. role_changes (migration 0220) ──────────────────────────────────────
-- The Users & Roles page writes an explicit row per role change. Our
-- accounts.role UPDATE trigger above also fires, but role_changes carries
-- richer metadata (who clicked, change_kind, reason) so we log from here
-- too. The two streams dedupe naturally because each row has its own id
-- and occurred_at.
create or replace function public._activity_log_on_role_change_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_target_name text;
  v_actor_uid   uuid;
begin
  select a.display_name into v_target_name
    from public.accounts a where a.id = new.account_id limit 1;

  -- Map the changer's account.id back to auth.users.id so the actor
  -- resolver can attribute via accounts.data_user_id.
  if new.changed_by_account_id is not null then
    select a.data_user_id into v_actor_uid
      from public.accounts a where a.id = new.changed_by_account_id limit 1;
  end if;

  perform public._activity_log_write(
    new.property_id,
    new.changed_at,
    'staff',
    'role_' || new.change_kind,
    null,
    v_actor_uid,
    'user',
    new.account_id::text,
    coalesce(v_target_name, 'A user'),
    case new.change_kind
      when 'role_change'         then format('Role for %s changed from %s to %s', coalesce(v_target_name,'a user'), coalesce(new.old_role,'(none)'), new.new_role)
      when 'deactivate'          then format('%s was deactivated', coalesce(v_target_name,'A user'))
      when 'reactivate'          then format('%s was reactivated', coalesce(v_target_name,'A user'))
      when 'transfer_ownership'  then format('Ownership transferred to %s', coalesce(v_target_name,'a user'))
      else                            format('Role change recorded for %s', coalesce(v_target_name,'a user'))
    end,
    'admin_dashboard',
    new.id,
    jsonb_build_object(
      'account_id', new.account_id,
      'target_name', v_target_name,
      'changed_by_account_id', new.changed_by_account_id,
      'old_role', new.old_role,
      'new_role', new.new_role,
      'change_kind', new.change_kind,
      'reason', new.reason
    )
  );
  return new;
end;
$$;

drop trigger if exists trg_activity_log_role_change_ins on public.role_changes;
create trigger trg_activity_log_role_change_ins
  after insert on public.role_changes
  for each row execute function public._activity_log_on_role_change_insert();

-- ── 6j. staff_breaks (migration 0222) ──────────────────────────────────────
-- INSERT = break started. UPDATE setting ended_at = break ended.
create or replace function public._activity_log_on_staff_break_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text;
begin
  select s.name into v_name from public.staff s where s.id = new.staff_id limit 1;
  perform public._activity_log_write(
    new.property_id,
    new.started_at,
    'staff',
    'break_started',
    new.staff_id,
    null,
    'staff',
    new.staff_id::text,
    coalesce(v_name, 'A staff member'),
    format('%s started a %s break', coalesce(v_name,'A staff member'), new.break_type),
    'housekeeper_app',
    new.id,
    jsonb_build_object(
      'staff_id', new.staff_id,
      'staff_name', v_name,
      'business_date', new.business_date,
      'break_type', new.break_type,
      'started_at', new.started_at
    )
  );
  return new;
end;
$$;

create or replace function public._activity_log_on_staff_break_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text;
  v_min  integer;
begin
  -- Only fire when ended_at flips from NULL to a value (the "break done"
  -- event). Other updates (e.g., correcting the timestamp) don't get a
  -- new activity row.
  if old.ended_at is not null or new.ended_at is null then
    return new;
  end if;
  select s.name into v_name from public.staff s where s.id = new.staff_id limit 1;
  v_min := greatest(0, round(extract(epoch from (new.ended_at - new.started_at)) / 60.0)::int);
  perform public._activity_log_write(
    new.property_id,
    new.ended_at,
    'staff',
    'break_ended',
    new.staff_id,
    null,
    'staff',
    new.staff_id::text,
    coalesce(v_name, 'A staff member'),
    format('%s finished a %s break (%s min)', coalesce(v_name,'A staff member'), new.break_type, v_min),
    'housekeeper_app',
    new.id,
    jsonb_build_object(
      'staff_id', new.staff_id,
      'staff_name', v_name,
      'business_date', new.business_date,
      'break_type', new.break_type,
      'duration_minutes', v_min
    )
  );
  return new;
end;
$$;

drop trigger if exists trg_activity_log_staff_break_ins on public.staff_breaks;
create trigger trg_activity_log_staff_break_ins
  after insert on public.staff_breaks
  for each row execute function public._activity_log_on_staff_break_insert();

drop trigger if exists trg_activity_log_staff_break_upd on public.staff_breaks;
create trigger trg_activity_log_staff_break_upd
  after update of ended_at on public.staff_breaks
  for each row execute function public._activity_log_on_staff_break_update();

-- ── 6k. room_pause_events (migration 0222) ─────────────────────────────────
-- Housekeeper taps Pause/Resume mid-clean.
create or replace function public._activity_log_on_room_pause_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text;
  v_room text;
begin
  select s.name into v_name from public.staff s where s.id = new.staff_id limit 1;
  select r.number into v_room from public.rooms r where r.id = new.room_id limit 1;
  perform public._activity_log_write(
    new.property_id,
    new.paused_at,
    'housekeeping',
    'cleaning_paused_room',
    new.staff_id,
    null,
    'room',
    coalesce(v_room, new.room_id::text),
    coalesce('Room ' || v_room, 'Room'),
    format('%s paused cleaning on room %s%s',
           coalesce(v_name,'A housekeeper'),
           coalesce(v_room,'?'),
           case when new.reason is not null then ' — ' || new.reason else '' end),
    'housekeeper_app',
    new.id,
    jsonb_build_object(
      'staff_id', new.staff_id,
      'staff_name', v_name,
      'room_id', new.room_id,
      'room_number', v_room,
      'business_date', new.business_date,
      'reason', new.reason
    )
  );
  return new;
end;
$$;

create or replace function public._activity_log_on_room_pause_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text;
  v_room text;
begin
  if old.resumed_at is not null or new.resumed_at is null then
    return new;
  end if;
  select s.name into v_name from public.staff s where s.id = new.staff_id limit 1;
  select r.number into v_room from public.rooms r where r.id = new.room_id limit 1;
  perform public._activity_log_write(
    new.property_id,
    new.resumed_at,
    'housekeeping',
    'cleaning_resumed_room',
    new.staff_id,
    null,
    'room',
    coalesce(v_room, new.room_id::text),
    coalesce('Room ' || v_room, 'Room'),
    format('%s resumed cleaning on room %s', coalesce(v_name,'A housekeeper'), coalesce(v_room,'?')),
    'housekeeper_app',
    new.id,
    jsonb_build_object(
      'staff_id', new.staff_id,
      'staff_name', v_name,
      'room_id', new.room_id,
      'room_number', v_room
    )
  );
  return new;
end;
$$;

drop trigger if exists trg_activity_log_room_pause_ins on public.room_pause_events;
create trigger trg_activity_log_room_pause_ins
  after insert on public.room_pause_events
  for each row execute function public._activity_log_on_room_pause_insert();

drop trigger if exists trg_activity_log_room_pause_upd on public.room_pause_events;
create trigger trg_activity_log_room_pause_upd
  after update of resumed_at on public.room_pause_events
  for each row execute function public._activity_log_on_room_pause_update();

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. Backfill — last 90 days of source events
--    Idempotent via the (event_type, source_event_id, occurred_at) unique
--    partial index. Pre-rendered descriptions match what new-write triggers
--    produce so the timeline looks consistent for backfilled vs live rows.
-- ═══════════════════════════════════════════════════════════════════════════

-- 7a. cleaning_events
insert into public.activity_log (
  property_id, occurred_at, event_category, event_type,
  actor_account_id, actor_name, actor_role,
  target_type, target_id, target_label,
  description, source, source_event_id, metadata
)
select
  ce.property_id,
  ce.completed_at,
  'housekeeping',
  case ce.status
    when 'flagged'   then 'cleaning_flagged'
    when 'discarded' then 'cleaning_discarded'
    else                  'cleaning_completed'
  end,
  null,
  coalesce(ce.staff_name, 'A housekeeper'),
  null,
  'room',
  ce.room_number,
  'Room ' || ce.room_number,
  case ce.status
    when 'flagged'   then format('%s flagged a long clean on room %s (%s min)', coalesce(ce.staff_name,'A housekeeper'), ce.room_number, round(ce.duration_minutes))
    when 'discarded' then format('%s tapped Done on room %s but it was discarded as too short (%s min)', coalesce(ce.staff_name,'A housekeeper'), ce.room_number, round(ce.duration_minutes))
    else                  format('%s finished cleaning room %s (%s min)', coalesce(ce.staff_name,'A housekeeper'), ce.room_number, round(ce.duration_minutes))
  end,
  'housekeeper_app',
  ce.id,
  jsonb_build_object(
    'date', ce.date,
    'room_type', ce.room_type,
    'duration_minutes', ce.duration_minutes,
    'status', ce.status,
    'staff_id', ce.staff_id,
    'staff_name', ce.staff_name,
    'started_at', ce.started_at,
    'completed_at', ce.completed_at
  )
from public.cleaning_events ce
where ce.completed_at >= now() - interval '90 days'
on conflict (property_id, event_type, source_event_id, occurred_at)
  where source_event_id is not null
  do nothing;

-- 7b. cleaning_tasks — created + current-status row
insert into public.activity_log (
  property_id, occurred_at, event_category, event_type,
  actor_name, target_type, target_id, target_label,
  description, source, source_event_id, metadata
)
select
  t.property_id,
  t.created_at,
  'housekeeping',
  'cleaning_task_created',
  'System',
  'cleaning_task',
  t.id::text,
  'Room ' || t.room_number || ' — ' || t.cleaning_type,
  format('Cleaning task created for room %s (%s, priority %s)', t.room_number, t.cleaning_type, t.priority),
  'rules_engine',
  t.id,
  jsonb_build_object(
    'room_number', t.room_number,
    'business_date', t.business_date,
    'cleaning_type', t.cleaning_type,
    'priority', t.priority,
    'estimated_minutes', t.estimated_minutes,
    'status', t.status
  )
from public.cleaning_tasks t
where t.created_at >= now() - interval '90 days'
on conflict (property_id, event_type, source_event_id, occurred_at)
  where source_event_id is not null
  do nothing;

-- 7c. inspections — started + outcome
insert into public.activity_log (
  property_id, occurred_at, event_category, event_type,
  actor_name, target_type, target_id, target_label,
  description, source, source_event_id, metadata
)
select
  i.property_id,
  i.started_at,
  'housekeeping',
  'inspection_started',
  coalesce((select s.name from public.staff s where s.id = i.inspector_staff_id), 'System'),
  'room',
  i.room_number,
  'Room ' || i.room_number,
  format('Inspection started on room %s', i.room_number),
  'manager_dashboard',
  i.id,
  jsonb_build_object(
    'room_number', i.room_number,
    'inspector_staff_id', i.inspector_staff_id,
    'housekeeper_staff_id', i.housekeeper_staff_id
  )
from public.inspections i
where i.started_at >= now() - interval '90 days'
on conflict (property_id, event_type, source_event_id, occurred_at)
  where source_event_id is not null
  do nothing;

insert into public.activity_log (
  property_id, occurred_at, event_category, event_type,
  actor_name, target_type, target_id, target_label,
  description, source, source_event_id, metadata
)
select
  i.property_id,
  coalesce(i.completed_at, i.updated_at),
  'housekeeping',
  'inspection_' || i.result,
  coalesce((select s.name from public.staff s where s.id = i.inspector_staff_id), 'System'),
  'room',
  i.room_number,
  'Room ' || i.room_number,
  case i.result
    when 'fail'      then format('Room %s failed inspection — %s issue%s flagged', i.room_number,
                                  jsonb_array_length(coalesce(i.failed_items,'[]'::jsonb)),
                                  case when jsonb_array_length(coalesce(i.failed_items,'[]'::jsonb)) = 1 then '' else 's' end)
    when 'pass'      then format('Room %s passed inspection', i.room_number)
    when 'cancelled' then format('Inspection on room %s was cancelled', i.room_number)
    else                  format('Inspection on room %s: %s', i.room_number, i.result)
  end,
  'manager_dashboard',
  i.id,
  jsonb_build_object(
    'room_number', i.room_number,
    'result', i.result,
    'failed_items', i.failed_items,
    'escalated', i.escalated
  )
from public.inspections i
where i.started_at >= now() - interval '90 days'
  and i.result in ('pass','fail','cancelled')
on conflict (property_id, event_type, source_event_id, occurred_at)
  where source_event_id is not null
  do nothing;

-- 7d. callout_events — reported + reverted
insert into public.activity_log (
  property_id, occurred_at, event_category, event_type,
  actor_name, target_type, target_id, target_label,
  description, source, source_event_id, metadata
)
select
  c.property_id,
  c.reported_at,
  'staff',
  'callout_reported',
  coalesce((select s.name from public.staff s where s.id = c.staff_id), 'A staff member'),
  'staff',
  c.staff_id::text,
  coalesce((select s.name from public.staff s where s.id = c.staff_id), 'A staff member'),
  format('%s called out%s%s',
         coalesce((select s.name from public.staff s where s.id = c.staff_id), 'A staff member'),
         case when c.reason is not null then format(' (%s)', c.reason) else '' end,
         case c.reported_by when 'manager' then ' — marked by manager' when 'sms' then ' — by SMS' else '' end),
  case c.reported_by when 'sms' then 'sms' when 'manager' then 'manager_dashboard' else 'housekeeper_app' end,
  c.id,
  jsonb_build_object(
    'staff_id', c.staff_id,
    'business_date', c.business_date,
    'reported_by', c.reported_by,
    'reason', c.reason
  )
from public.callout_events c
where c.reported_at >= now() - interval '90 days'
on conflict (property_id, event_type, source_event_id, occurred_at)
  where source_event_id is not null
  do nothing;

insert into public.activity_log (
  property_id, occurred_at, event_category, event_type,
  actor_name, target_type, target_id, target_label,
  description, source, source_event_id, metadata
)
select
  c.property_id,
  c.reverted_at,
  'staff',
  'callout_reverted',
  coalesce((select s.name from public.staff s where s.id = c.staff_id), 'A staff member'),
  'staff',
  c.staff_id::text,
  coalesce((select s.name from public.staff s where s.id = c.staff_id), 'A staff member'),
  format('Sick callout for %s was reverted%s',
         coalesce((select s.name from public.staff s where s.id = c.staff_id), 'a staff member'),
         case when c.revert_reason is not null then ' — ' || c.revert_reason else '' end),
  case when c.reverted_by_user_id is not null then 'manager_dashboard' else 'housekeeper_app' end,
  c.id,
  jsonb_build_object('staff_id', c.staff_id, 'business_date', c.business_date)
from public.callout_events c
where c.status = 'reverted'
  and c.reverted_at is not null
  and c.reverted_at >= now() - interval '90 days'
on conflict (property_id, event_type, source_event_id, occurred_at)
  where source_event_id is not null
  do nothing;

-- 7e. pms_work_orders_v2 — created + current status
insert into public.activity_log (
  property_id, occurred_at, event_category, event_type,
  actor_name, target_type, target_id, target_label,
  description, source, source_event_id, metadata
)
select
  w.property_id,
  coalesce(w.reported_at, w.created_at),
  'maintenance',
  'work_order_created',
  'PMS',
  'work_order',
  coalesce(w.pms_work_order_id, w.id::text),
  coalesce('Room ' || w.room_number, w.area, 'Work order'),
  format('Work order created on %s — %s (priority %s)',
         coalesce('Room ' || w.room_number, w.area, 'Work order'),
         coalesce(w.category,'other'),
         w.priority),
  'pms_sync',
  w.id,
  jsonb_build_object(
    'pms_work_order_id', w.pms_work_order_id,
    'room_number', w.room_number,
    'category', w.category,
    'priority', w.priority,
    'status', w.status
  )
from public.pms_work_orders_v2 w
where coalesce(w.reported_at, w.created_at) >= now() - interval '90 days'
on conflict (property_id, event_type, source_event_id, occurred_at)
  where source_event_id is not null
  do nothing;

-- 7f. pms_room_status_log
insert into public.activity_log (
  property_id, occurred_at, event_category, event_type,
  actor_name, target_type, target_id, target_label,
  description, source, source_event_id, metadata
)
select
  r.property_id,
  r.changed_at,
  'system',
  'room_status_changed',
  'PMS',
  'room',
  r.room_number,
  'Room ' || r.room_number,
  format('Room %s is now %s', r.room_number, replace(r.status,'_',' ')),
  case r.source when 'cua' then 'pms_sync' when 'manual' then 'manager_dashboard' when 'scheduled' then 'cron' when 'workflow' then 'cua_worker' else 'system' end,
  r.id,
  jsonb_build_object('room_number', r.room_number, 'status', r.status, 'source', r.source)
from public.pms_room_status_log r
where r.changed_at >= now() - interval '90 days'
on conflict (property_id, event_type, source_event_id, occurred_at)
  where source_event_id is not null
  do nothing;

-- 7g. role_changes (post-rebase: added when 0220 landed)
insert into public.activity_log (
  property_id, occurred_at, event_category, event_type,
  actor_name, target_type, target_id, target_label,
  description, source, source_event_id, metadata
)
select
  rc.property_id,
  rc.changed_at,
  'staff',
  'role_' || rc.change_kind,
  coalesce((select a.display_name from public.accounts a where a.id = rc.changed_by_account_id), 'System'),
  'user',
  rc.account_id::text,
  coalesce((select a.display_name from public.accounts a where a.id = rc.account_id), 'A user'),
  case rc.change_kind
    when 'role_change'         then format('Role for %s changed from %s to %s',
                                            coalesce((select a.display_name from public.accounts a where a.id = rc.account_id),'a user'),
                                            coalesce(rc.old_role,'(none)'), rc.new_role)
    when 'deactivate'          then format('%s was deactivated',
                                            coalesce((select a.display_name from public.accounts a where a.id = rc.account_id),'A user'))
    when 'reactivate'          then format('%s was reactivated',
                                            coalesce((select a.display_name from public.accounts a where a.id = rc.account_id),'A user'))
    when 'transfer_ownership'  then format('Ownership transferred to %s',
                                            coalesce((select a.display_name from public.accounts a where a.id = rc.account_id),'a user'))
    else                            format('Role change recorded for %s',
                                            coalesce((select a.display_name from public.accounts a where a.id = rc.account_id),'a user'))
  end,
  'admin_dashboard',
  rc.id,
  jsonb_build_object('old_role', rc.old_role, 'new_role', rc.new_role, 'change_kind', rc.change_kind)
from public.role_changes rc
where rc.changed_at >= now() - interval '90 days'
on conflict (property_id, event_type, source_event_id, occurred_at)
  where source_event_id is not null
  do nothing;

-- 7h. staff_breaks — started + ended (if ended_at is set)
insert into public.activity_log (
  property_id, occurred_at, event_category, event_type,
  actor_name, target_type, target_id, target_label,
  description, source, source_event_id, metadata
)
select
  sb.property_id,
  sb.started_at,
  'staff',
  'break_started',
  coalesce((select s.name from public.staff s where s.id = sb.staff_id), 'A staff member'),
  'staff',
  sb.staff_id::text,
  coalesce((select s.name from public.staff s where s.id = sb.staff_id), 'A staff member'),
  format('%s started a %s break',
         coalesce((select s.name from public.staff s where s.id = sb.staff_id), 'A staff member'),
         sb.break_type),
  'housekeeper_app',
  sb.id,
  jsonb_build_object('break_type', sb.break_type, 'business_date', sb.business_date)
from public.staff_breaks sb
where sb.started_at >= now() - interval '90 days'
on conflict (property_id, event_type, source_event_id, occurred_at)
  where source_event_id is not null
  do nothing;

insert into public.activity_log (
  property_id, occurred_at, event_category, event_type,
  actor_name, target_type, target_id, target_label,
  description, source, source_event_id, metadata
)
select
  sb.property_id,
  sb.ended_at,
  'staff',
  'break_ended',
  coalesce((select s.name from public.staff s where s.id = sb.staff_id), 'A staff member'),
  'staff',
  sb.staff_id::text,
  coalesce((select s.name from public.staff s where s.id = sb.staff_id), 'A staff member'),
  format('%s finished a %s break (%s min)',
         coalesce((select s.name from public.staff s where s.id = sb.staff_id), 'A staff member'),
         sb.break_type,
         greatest(0, round(extract(epoch from (sb.ended_at - sb.started_at)) / 60.0)::int)),
  'housekeeper_app',
  sb.id,
  jsonb_build_object('break_type', sb.break_type, 'business_date', sb.business_date)
from public.staff_breaks sb
where sb.ended_at is not null
  and sb.ended_at >= now() - interval '90 days'
on conflict (property_id, event_type, source_event_id, occurred_at)
  where source_event_id is not null
  do nothing;

-- 7i. room_pause_events — paused + resumed (if resumed_at is set)
insert into public.activity_log (
  property_id, occurred_at, event_category, event_type,
  actor_name, target_type, target_id, target_label,
  description, source, source_event_id, metadata
)
select
  rpe.property_id,
  rpe.paused_at,
  'housekeeping',
  'cleaning_paused_room',
  coalesce((select s.name from public.staff s where s.id = rpe.staff_id), 'A housekeeper'),
  'room',
  coalesce((select r.number from public.rooms r where r.id = rpe.room_id), rpe.room_id::text),
  coalesce('Room ' || (select r.number from public.rooms r where r.id = rpe.room_id), 'Room'),
  format('%s paused cleaning on room %s%s',
         coalesce((select s.name from public.staff s where s.id = rpe.staff_id), 'A housekeeper'),
         coalesce((select r.number from public.rooms r where r.id = rpe.room_id), '?'),
         case when rpe.reason is not null then ' — ' || rpe.reason else '' end),
  'housekeeper_app',
  rpe.id,
  jsonb_build_object('room_id', rpe.room_id, 'reason', rpe.reason, 'business_date', rpe.business_date)
from public.room_pause_events rpe
where rpe.paused_at >= now() - interval '90 days'
on conflict (property_id, event_type, source_event_id, occurred_at)
  where source_event_id is not null
  do nothing;

insert into public.activity_log (
  property_id, occurred_at, event_category, event_type,
  actor_name, target_type, target_id, target_label,
  description, source, source_event_id, metadata
)
select
  rpe.property_id,
  rpe.resumed_at,
  'housekeeping',
  'cleaning_resumed_room',
  coalesce((select s.name from public.staff s where s.id = rpe.staff_id), 'A housekeeper'),
  'room',
  coalesce((select r.number from public.rooms r where r.id = rpe.room_id), rpe.room_id::text),
  coalesce('Room ' || (select r.number from public.rooms r where r.id = rpe.room_id), 'Room'),
  format('%s resumed cleaning on room %s',
         coalesce((select s.name from public.staff s where s.id = rpe.staff_id), 'A housekeeper'),
         coalesce((select r.number from public.rooms r where r.id = rpe.room_id), '?')),
  'housekeeper_app',
  rpe.id,
  jsonb_build_object('room_id', rpe.room_id, 'business_date', rpe.business_date)
from public.room_pause_events rpe
where rpe.resumed_at is not null
  and rpe.resumed_at >= now() - interval '90 days'
on conflict (property_id, event_type, source_event_id, occurred_at)
  where source_event_id is not null
  do nothing;

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. PostgREST schema reload — so the API sees the new table immediately.
-- ═══════════════════════════════════════════════════════════════════════════
notify pgrst, 'reload schema';
