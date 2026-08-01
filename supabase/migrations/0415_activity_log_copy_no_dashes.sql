-- ═══════════════════════════════════════════════════════════════════════════
-- 0415 — Activity Log copy: no em dashes.
--
-- WHY THIS EXISTS
-- Migration 0228 pre-renders the plain-English sentence for every activity
-- row inside its trigger functions (`activity_log.description`) and the
-- short label beside it (`activity_log.target_label`). Seven of those
-- templates joined two clauses with an em dash. On 2026-07-28 the founder
-- ruled em dashes out of ALL user-facing copy: use a period, a comma, or a
-- colon. 0228 predates that ruling by three months, so its sentences were
-- never checked against it, and Settings -> Activity Log is a user-facing
-- surface: a manager reads these strings verbatim in the timeline, the side
-- panel, and the CSV / XLSX / PDF export.
--
-- Every dashed template here is a "clause, clause" join, so the replacement
-- is a comma:
--   "Room 305 failed inspection — 3 issues flagged"
--     -> "Room 305 failed inspection, 3 issues flagged"
--   "Maria called out (sick) — marked by manager"
--     -> "Maria called out (sick), marked by manager"
--
-- SCOPE — what this migration does NOT touch
--   * The one-time 90-day BACKFILL block in 0228 (section 7). It already ran
--     in production; re-running it is neither needed nor safe to assume
--     idempotent against three months of drift. The rows it wrote are fixed
--     by the UPDATE pass at the bottom of this file instead.
--   * `_activity_log_on_room_pause_insert()` — 0228 line 1317 also carried a
--     dash, but migration 0272 DROPPED that function together with
--     `room_pause_events` and the legacy `rooms` table it read from.
--     Recreating it here would resurrect a dead function pointing at tables
--     that no longer exist. Deliberately skipped.
--
-- WHAT IT DOES
--   1. CREATE OR REPLACE the six live trigger functions whose templates
--      carried a dash. Bodies are copied verbatim from 0228 — only the copy
--      changes. Existing triggers keep pointing at these names, so no
--      trigger is dropped or recreated, and CREATE OR REPLACE preserves the
--      existing grants.
--   2. One-time cleanup of rows already stored with a dash (both the live
--      trigger writes since 0228 and the 90-day backfill).
--
-- A second belt exists on the read side: src/lib/activity-log/pure.ts runs
-- every row's description + target_label through `withoutEmDash` in
-- queryActivityLog / getActivityEvent, so even a future SQL regression can
-- never render a dash in the browser.
--
-- Manual prod apply: per project_migration_application_manual.md.
-- Idempotent: CREATE OR REPLACE + character-guarded UPDATEs. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- 1. cleaning_tasks INSERT — target_label, now "Room 305, stayover".
-- ───────────────────────────────────────────────────────────────────────────
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
    'Room ' || new.room_number || ', ' || new.cleaning_type,
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

-- ───────────────────────────────────────────────────────────────────────────
-- 2. inspections UPDATE — "Room 305 failed inspection, 3 issues flagged".
-- ───────────────────────────────────────────────────────────────────────────
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
    v_desc := format('Room %s failed inspection, %s issue%s flagged', new.room_number, v_fail_count, case when v_fail_count = 1 then '' else 's' end);
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

-- ───────────────────────────────────────────────────────────────────────────
-- 3. callout_events INSERT — "Maria called out (sick), marked by manager".
-- ───────────────────────────────────────────────────────────────────────────
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
             when 'manager' then ', marked by manager'
             when 'sms'     then ', by SMS'
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

-- ───────────────────────────────────────────────────────────────────────────
-- 4. callout_events UPDATE — "Sick callout for Maria was reverted, <reason>".
-- ───────────────────────────────────────────────────────────────────────────
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
           case when new.revert_reason is not null then ', ' || new.revert_reason else '' end),
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

-- ───────────────────────────────────────────────────────────────────────────
-- 5. pms_work_orders_v2 INSERT — "Work order created on Room 305, plumbing
--    (priority high)".
-- ───────────────────────────────────────────────────────────────────────────
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
  v_desc := format('Work order created on %s, %s (priority %s)', v_label, coalesce(new.category,'other'), new.priority);

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

-- ───────────────────────────────────────────────────────────────────────────
-- 6. accounts role UPDATE — "User Maria, role changed from staff to manager".
-- ───────────────────────────────────────────────────────────────────────────
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
      format('User %s, role changed from %s to %s', new.display_name, old.role, new.role),
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

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. One-time cleanup of rows already written with a dash.
--
--    Covers both sources of dashed history: the live trigger writes between
--    0228 and this migration, and 0228's own 90-day backfill (which this
--    file deliberately does not re-run).
--
--    Two passes per column. The first turns the padded join " — " into a
--    comma + space, which is the exact shape every 0228 template produced.
--    The second is a fallback for any unpadded dash that reached the column
--    from a free-text source field (a callout revert_reason or a cleaning
--    type typed by a human). Each pass is guarded on the character, so once
--    it has run the WHERE clause matches nothing and re-running is a no-op.
-- ═══════════════════════════════════════════════════════════════════════════

update public.activity_log
   set description = replace(description, ' — ', ', ')
 where description like '% — %';

update public.activity_log
   set description = replace(description, '—', ',')
 where description like '%—%';

update public.activity_log
   set target_label = replace(target_label, ' — ', ', ')
 where target_label like '% — %';

update public.activity_log
   set target_label = replace(target_label, '—', ',')
 where target_label like '%—%';

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. Bookkeeping.
-- ═══════════════════════════════════════════════════════════════════════════
insert into public.applied_migrations (version, description)
values (
  '0415',
  'Activity Log copy ruling (2026-07-28): replace the em dash with a comma in the six live 0228 trigger templates (cleaning_task_insert target_label, inspection_update, callout_event_insert, callout_event_update, work_order_insert, account_role_update) and clean the dash out of already-stored description + target_label rows. Skips _activity_log_on_room_pause_insert, dropped by 0272.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
