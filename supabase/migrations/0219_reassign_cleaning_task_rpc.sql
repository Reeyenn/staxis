-- ═══════════════════════════════════════════════════════════════════════════
-- 0219 — reassign_cleaning_task: atomic RPC for manager-initiated cleaning-
--                                task reassignments.
--
-- Why this exists:
--   Migration 0211 introduced hk_assignments with one is_active=true row
--   per (cleaning_task_id) enforced by a partial unique index. The
--   manager-facing /api/housekeeping/reassign route originally did three
--   separate statements: deactivate-old, insert-new, update-cache. With
--   no transaction, a failure between steps could leave the task with
--   no active assignment OR a stale cleaning_tasks.assignee_id.
--
--   Codex post-merge adversarial review flagged this (1 Critical security
--   gap + 1 Major atomicity issue). The route now calls this RPC, which
--   wraps the whole flow in a SECURITY DEFINER plpgsql function running
--   under a single implicit transaction.
--
-- Signature:
--   reassign_cleaning_task(
--     p_property_id        uuid,
--     p_task_id            uuid,
--     p_to_housekeeper_id  uuid,
--     p_assigned_by_user   uuid,
--     p_reason             text
--   ) returns table (
--     task_id           uuid,
--     assignee_id       uuid,
--     noop              boolean
--   )
--
-- Behaviour:
--   - Locks the cleaning_tasks row (FOR UPDATE) so concurrent reassigns
--     serialize.
--   - Verifies the task belongs to p_property_id.
--   - Verifies the destination HK belongs to p_property_id, is in
--     housekeeping, and is active.
--   - Verifies the task is in a reassignable status (scheduled,
--     ready_now, deferred).
--   - If the task is already assigned to p_to_housekeeper_id, returns
--     noop=true (zero churn — no audit row created).
--   - Flips is_active=false on the prior active assignment.
--   - Inserts a new is_active=true row with assigned_by='manual'.
--   - Updates cleaning_tasks.assignee_id.
--   All four steps in one transaction. Atomic.
--
-- Security:
--   SECURITY DEFINER with `set search_path = public, pg_temp` (per the
--   audit-security-definer-search-path lint check). Granted to
--   service_role only — the /api/housekeeping/reassign route is the
--   only caller. Browser/anon callers get nothing.
--
-- Idempotency: re-running with the same (task, target) returns noop=true
-- without writing. Safe to retry.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.reassign_cleaning_task(
  p_property_id        uuid,
  p_task_id            uuid,
  p_to_housekeeper_id  uuid,
  p_assigned_by_user   uuid,
  p_reason             text
)
returns table (
  task_id     uuid,
  assignee_id uuid,
  noop        boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_task_status        text;
  v_task_property_id   uuid;
  v_current_assignee   uuid;
  v_hk_property_id     uuid;
  v_hk_department      text;
  v_hk_is_active       boolean;
begin
  -- 1. Lock + verify the task. SELECT FOR UPDATE so concurrent
  --    reassigns of the same task serialize cleanly.
  select t.status, t.property_id, t.assignee_id
    into v_task_status, v_task_property_id, v_current_assignee
    from public.cleaning_tasks t
   where t.id = p_task_id
     for update;

  if not found then
    raise exception 'task not found' using errcode = 'P0002';
  end if;
  if v_task_property_id <> p_property_id then
    raise exception 'task does not belong to property' using errcode = 'P0001';
  end if;
  if v_task_status not in ('scheduled', 'ready_now', 'deferred') then
    raise exception 'task not reassignable in status %', v_task_status using errcode = 'P0001';
  end if;

  -- 2. No-op fast path. Already assigned to the requested HK; return
  --    without touching any audit row.
  if v_current_assignee is not null and v_current_assignee = p_to_housekeeper_id then
    return query select p_task_id, p_to_housekeeper_id, true;
    return;
  end if;

  -- 3. Verify destination HK belongs to property + housekeeping + active.
  select s.property_id, s.department, coalesce(s.is_active, true)
    into v_hk_property_id, v_hk_department, v_hk_is_active
    from public.staff s
   where s.id = p_to_housekeeper_id;

  if not found then
    raise exception 'housekeeper not found' using errcode = 'P0002';
  end if;
  if v_hk_property_id <> p_property_id then
    raise exception 'housekeeper not at property' using errcode = 'P0001';
  end if;
  if v_hk_department is distinct from 'housekeeping' then
    raise exception 'target is not housekeeping' using errcode = 'P0001';
  end if;
  if v_hk_is_active = false then
    raise exception 'housekeeper inactive' using errcode = 'P0001';
  end if;

  -- 4. Deactivate the prior active row, scoped by property + task. The
  --    property_id predicate is defense-in-depth — the FK + task lookup
  --    above already pin the right tenant.
  update public.hk_assignments
     set is_active = false
   where cleaning_task_id = p_task_id
     and is_active = true
     and property_id = p_property_id;

  -- 5. Insert the new active row. The partial unique index guarantees
  --    only one is_active=true per task at any moment.
  insert into public.hk_assignments (
    property_id, cleaning_task_id, housekeeper_id, queue_order,
    is_active, assigned_at, assigned_by, assigned_by_user_id, reason, score
  ) values (
    p_property_id, p_task_id, p_to_housekeeper_id, 0,
    true, now(), 'manual', p_assigned_by_user, p_reason, null
  );

  -- 6. Cache the assignee on cleaning_tasks. Scoped by property_id as
  --    well as id (defense in depth).
  update public.cleaning_tasks
     set assignee_id = p_to_housekeeper_id
   where id = p_task_id
     and property_id = p_property_id;

  return query select p_task_id, p_to_housekeeper_id, false;
end;
$$;

comment on function public.reassign_cleaning_task is
  'Atomic manager reassignment of a cleaning_task. Locks the task row, '
  'verifies tenant + HK eligibility, deactivates the prior active '
  'hk_assignments row, inserts the new one, and updates the '
  'cleaning_tasks.assignee_id cache — all in one transaction. '
  'Service-role only. Added 0219 in response to Codex post-merge sweep.';

-- Lock down. Only the service-role client (used by /api/housekeeping/reassign)
-- should call this. Anon/authenticated/public roles are rejected by the
-- grants below in addition to the table-level RLS on the underlying tables.
revoke all on function public.reassign_cleaning_task(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.reassign_cleaning_task(uuid, uuid, uuid, uuid, text) to service_role;

insert into public.applied_migrations (version, description)
values (
  '0219',
  'reassign_cleaning_task RPC: atomic manager reassignment in one transaction. Codex post-merge sweep follow-up.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
