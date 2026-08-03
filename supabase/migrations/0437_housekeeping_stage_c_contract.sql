-- 0437: Cleaning Stage C contract and teardown.
--
-- Stage B (0434-0436) is the approved live canonical application boundary:
-- room_work owns Staxis workflow, room_work_plan_v1 is the manager read model,
-- pms_housekeeping_assignments remains the report-owned PMS fact source, and
-- canonical RPCs own plan, assignment, component, and inspection writes.
--
-- This migration is the destructive contract boundary. It takes an explicit
-- final snapshot of the compatibility-window pair while both legacy tables
-- are locked, reconciles legacy rows only when their last write is newer than
-- the canonical row, preserves canonical writes on ties/newer timestamps,
-- proves the task/assignment/history/property invariants, then drops the
-- physical cleaning_tasks and hk_assignments tables. No reverse sync, trigger
-- redirect, writable view, or second writable source is installed.
--
-- The cleaning_tasks name is retained only for one repository consumer that
-- still performs a read-only portfolio summary. Its UNION ALL shape is an
-- intentional PostgreSQL non-updatable-view barrier. hk_assignments has no
-- retained runtime consumer and is removed without a compatibility relation.
--
-- Rollback/remediation: this migration is not reversible by SQL rollback after
-- commit. Before production apply, take the approved database backup/snapshot
-- and retain the 0434-0436 artifacts. If a post-cutover invariant fails,
-- restore the snapshot (or restore the two legacy tables from the exported
-- final snapshot), keep Stage C unapplied, and forward-remediate the exact
-- failing property/task/history rows before retrying 0437. Reapplying 0434-
-- 0436 after a restored snapshot reinstalls the compatibility window; do not
-- recreate a writable view or manually add reverse-sync triggers.

begin;

-- The contract must run while the physical pair still exists. A rerun after
-- retirement fails loudly with an actionable message instead of pretending a
-- destructive rollback happened.
do $$
declare
  v_cleaning_kind "char";
  v_assignment_kind "char";
begin
  if current_setting('staxis.housekeeping_stage_c_freeze', true) is distinct from 'approved' then
    raise exception
      '0437 preflight: freeze gate is not approved. Freeze all old deployments and legacy writes, set staxis.housekeeping_stage_c_freeze=approved, then retry Stage C.';
  end if;

  if nullif(btrim(current_setting('staxis.housekeeping_stage_c_operator', true)), '') is null then
    raise exception
      '0437 preflight: operator evidence is missing. Set staxis.housekeeping_stage_c_operator to the named release operator before retrying Stage C.';
  end if;

  if (
    select count(*)
      from public.applied_migrations
     where version in ('0434', '0435', '0436')
  ) <> 3 then
    raise exception
      '0437 preflight: approved Cleaning Stages A/B (0434-0436) are not all recorded as applied; no destructive work was attempted';
  end if;

  select c.relkind
    into v_cleaning_kind
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = 'cleaning_tasks';
  select c.relkind
    into v_assignment_kind
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = 'hk_assignments';

  if v_cleaning_kind is distinct from 'r' or v_assignment_kind is distinct from 'r' then
    raise exception
      '0437 preflight: expected physical cleaning_tasks/hk_assignments tables; current relkinds are cleaning_tasks=%, hk_assignments=%. Restore the approved pre-0437 snapshot and forward-remediate before retrying Stage C.',
      coalesce(v_cleaning_kind::text, 'absent'),
      coalesce(v_assignment_kind::text, 'absent');
  end if;

  if to_regclass('public.room_work') is null
     or to_regclass('public.pms_housekeeping_assignments') is null
     or to_regclass('public.activity_log') is null then
    raise exception
      '0437 preflight: room_work, pms_housekeeping_assignments, and activity_log are required before destructive housekeeping retirement';
  end if;

  if to_regclass('public.room_work_plan_v1') is null
     or (select c.relkind
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public'
            and c.relname = 'room_work_plan_v1') is distinct from 'v' then
    raise exception
      '0437 preflight: canonical room_work_plan_v1 view is missing; an in-flight old deployment is not eligible for retirement';
  end if;

  if to_regprocedure('public.write_room_work_atomic(uuid,date,text,jsonb,text,boolean)') is null
     or to_regprocedure('public.upsert_room_work_plan(uuid,jsonb)') is null
     or to_regprocedure('public.touch_room_work_plan(uuid,date,text[])') is null
     or to_regprocedure('public.assign_room_work_atomic(uuid,uuid,uuid,uuid,text,integer,numeric,boolean,text)') is null
     or to_regprocedure('public.reset_room_work_assignments(uuid,date,uuid)') is null
     or to_regprocedure('public.complete_inspection_atomic_canonical(uuid,uuid,text,jsonb,jsonb,text,boolean,text,timestamptz,text)') is null then
    raise exception
      '0437 preflight: one or more canonical Stage B write/inspection operations are missing; an in-flight old deployment is not eligible for retirement';
  end if;
end;
$$;

-- The operator/freeze gate above is intentionally explicit because SQL
-- catalogs cannot see an old binary that is still draining outside the
-- database. The migration is only eligible after the release controller has
-- stopped old jobs, set both session evidence values, and verified the exact
-- Stage B SHA. This table makes that decision durable after the transaction.
create table if not exists public.housekeeping_stage_c_cutover_evidence (
  id                                  uuid primary key default gen_random_uuid(),
  run_id                              uuid not null unique,
  migration_version                   text not null default '0437',
  started_at                          timestamptz not null,
  cutover_at                          timestamptz not null,
  operator_name                       text not null,
  session_user_name                   text not null,
  legacy_cleaning_tasks_count         bigint not null,
  legacy_cleaning_tasks_hash          text not null,
  legacy_hk_assignments_count         bigint not null,
  legacy_hk_assignments_hash          text not null,
  room_work_count_before              bigint not null,
  room_work_count_after               bigint not null,
  room_work_hash_before               text not null,
  room_work_hash_after                text not null,
  pms_assignments_count_before        bigint not null,
  pms_assignments_count_after         bigint not null,
  pms_assignments_hash_before         text not null,
  pms_assignments_hash_after          text not null,
  inspections_count_before            bigint not null,
  inspections_count_after             bigint not null,
  inspections_hash_before             text not null,
  inspections_hash_after              text not null,
  assignment_history_receipts_after   bigint not null,
  active_assignment_receipts_after    bigint not null,
  activity_log_count_before           bigint not null,
  activity_log_count_after            bigint not null,
  activity_log_hash_before            text not null,
  activity_log_hash_after             text not null,
  physical_legacy_tables_dropped      boolean not null,
  compatibility_projection            text not null,
  rollback_policy                     text not null,
  remediation_procedure               text not null
);

alter table public.housekeeping_stage_c_cutover_evidence enable row level security;
revoke all on public.housekeeping_stage_c_cutover_evidence from public, anon, authenticated;
grant select on public.housekeeping_stage_c_cutover_evidence to service_role;
drop policy if exists housekeeping_stage_c_cutover_evidence_deny_all on public.housekeeping_stage_c_cutover_evidence;
create policy housekeeping_stage_c_cutover_evidence_deny_all
  on public.housekeeping_stage_c_cutover_evidence
  for all to anon, authenticated using (false) with check (false);
comment on table public.housekeeping_stage_c_cutover_evidence is
  'Durable Cleaning Stage C cutover evidence. One row records the frozen legacy snapshots, canonical/PMS/inspection counts and hashes, operator evidence, destructive inventory, and the named freeze-and-forward remediation procedure. Service-role-only.';

create temporary table phase5_stage_c_baseline_evidence
on commit drop
as
select
  gen_random_uuid() as run_id,
  clock_timestamp() as started_at,
  coalesce(nullif(btrim(current_setting('staxis.housekeeping_stage_c_operator', true)), ''), current_user) as operator_name,
  session_user as session_user_name,
  (select count(*) from public.room_work) as room_work_count_before,
  md5(coalesce((select string_agg(to_jsonb(w)::text, '|' order by w.property_id, w.date, w.room_number)
                  from public.room_work w), '')) as room_work_hash_before,
  (select count(*) from public.pms_housekeeping_assignments) as pms_assignments_count_before,
  md5(coalesce((select string_agg(to_jsonb(a)::text, '|' order by a.property_id, a.date, a.room_number)
                  from public.pms_housekeeping_assignments a), '')) as pms_assignments_hash_before,
  (select count(*) from public.inspections) as inspections_count_before,
  md5(coalesce((select string_agg(to_jsonb(i)::text, '|' order by i.property_id, i.started_at, i.id)
                  from public.inspections i), '')) as inspections_hash_before,
  (select count(*) from public.activity_log) as activity_log_count_before,
  md5(coalesce((select string_agg(to_jsonb(l)::text, '|' order by l.property_id, l.occurred_at, l.id)
                  from public.activity_log l), '')) as activity_log_hash_before;

-- Catalog and parity preflight. Every check is before the first compatibility
-- lock and every failure aborts the surrounding transaction, so a bad mapping
-- cannot leave half of the legacy pair retired.
do $$
declare
  v_count bigint;
  v_names text;
begin
  if exists (
    select 1
      from pg_trigger t
     where t.tgrelid in ('public.cleaning_tasks'::regclass, 'public.hk_assignments'::regclass)
       and not t.tgisinternal
       and t.tgname not in (
         'set_updated_at',
         'trg_legacy_cleaning_task_to_room_work',
         'trg_legacy_hk_assignment_to_room_work',
         'trg_activity_log_cleaning_task_ins',
         'trg_activity_log_cleaning_task_upd',
         'trg_activity_log_hk_assignment_ins',
         'trg_activity_log_hk_assignment_upd'
       )
  ) then
    select string_agg(t.tgname, ', ' order by t.tgname)
      into v_names
      from pg_trigger t
     where t.tgrelid in ('public.cleaning_tasks'::regclass, 'public.hk_assignments'::regclass)
       and not t.tgisinternal
       and t.tgname not in (
         'set_updated_at',
         'trg_legacy_cleaning_task_to_room_work',
         'trg_legacy_hk_assignment_to_room_work',
         'trg_activity_log_cleaning_task_ins',
         'trg_activity_log_cleaning_task_upd',
         'trg_activity_log_hk_assignment_ins',
         'trg_activity_log_hk_assignment_upd'
       );
    raise exception
      '0437 preflight: unexpected legacy relation trigger(s) % indicate an in-flight old writer; freeze/remediate before retirement',
      v_names;
  end if;

  -- A function body can retain a dynamic SQL reader even when it has no
  -- obvious INSERT/UPDATE/DELETE token. Only the known Stage A bridge/audit
  -- functions and the two old RPCs may mention the pair here; every one of
  -- those allowed seams is dropped below before the physical relations go.
  if exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind in ('f', 'p')
       and pg_get_functiondef(p.oid) ~* '\m(cleaning_tasks|hk_assignments)\M'
       and p.proname not in (
         '_legacy_cleaning_task_to_room_work',
         '_legacy_hk_assignment_to_room_work',
         '_activity_log_on_cleaning_task_insert',
         '_activity_log_on_cleaning_task_status_update',
         '_activity_log_on_hk_assignment_insert',
         '_activity_log_on_hk_assignment_update',
         'complete_inspection_atomic',
         'reassign_cleaning_task'
       )
  ) then
    select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text)
      into v_names
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind in ('f', 'p')
       and pg_get_functiondef(p.oid) ~* '\m(cleaning_tasks|hk_assignments)\M'
       and p.proname not in (
         '_legacy_cleaning_task_to_room_work',
         '_legacy_hk_assignment_to_room_work',
         '_activity_log_on_cleaning_task_insert',
         '_activity_log_on_cleaning_task_status_update',
         '_activity_log_on_hk_assignment_insert',
         '_activity_log_on_hk_assignment_update',
         'complete_inspection_atomic',
         'reassign_cleaning_task'
       );
    raise exception
      '0437 preflight: unexpected executable legacy reader/writer function(s) % remain; old deployments are not fenced',
      v_names;
  end if;

  if exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind = 'f'
       and pg_get_functiondef(p.oid) ~* '(insert\s+into|update\s+public\.|delete\s+from)\s+public\.(cleaning_tasks|hk_assignments)'
       and p.proname not in (
         '_legacy_cleaning_task_to_room_work',
         '_legacy_hk_assignment_to_room_work',
         '_activity_log_on_cleaning_task_insert',
         '_activity_log_on_cleaning_task_status_update',
         '_activity_log_on_hk_assignment_insert',
         '_activity_log_on_hk_assignment_update',
         'complete_inspection_atomic',
         'reassign_cleaning_task'
       )
  ) then
    select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text)
      into v_names
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind = 'f'
       and pg_get_functiondef(p.oid) ~* '(insert\s+into|update\s+public\.|delete\s+from)\s+public\.(cleaning_tasks|hk_assignments)'
       and p.proname not in (
         '_legacy_cleaning_task_to_room_work',
         '_legacy_hk_assignment_to_room_work',
         '_activity_log_on_cleaning_task_insert',
         '_activity_log_on_cleaning_task_status_update',
         '_activity_log_on_hk_assignment_insert',
         '_activity_log_on_hk_assignment_update',
         'complete_inspection_atomic',
         'reassign_cleaning_task'
       );
    raise exception
      '0437 preflight: unexpected executable legacy writer function(s) % remain; old deployments are not fenced',
      v_names;
  end if;

  select count(*)
    into v_count
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'pms_housekeeping_assignments'
     and column_name = 'ingest_run_id'
     and is_nullable = 'NO';
  if v_count <> 1 then
    raise exception
      '0437 preflight: PMS assignment report receipt protection is missing; pms_housekeeping_assignments.ingest_run_id must remain NOT NULL';
  end if;

  -- Every historical inspection linked to an old task must resolve to the
  -- same canonical property/room. A null cleaning_task_id is allowed for a
  -- room-only inspection; it remains protected by its inspections row/hash.
  select count(*)
    into v_count
    from public.inspections i
   where i.cleaning_task_id is not null
     and not exists (
       select 1
         from public.room_work w
        where w.property_id = i.property_id
          and (w.legacy_task_id = i.cleaning_task_id or w.id = i.cleaning_task_id)
          and w.room_number = i.room_number
     );
  if v_count > 0 then
    raise exception
      '0437 preflight: % inspection row(s) have a missing, cross-property, or room-mismatched canonical task mapping; no destructive work was attempted',
      v_count;
  end if;

  -- No room_work legacy link may point outside the frozen task snapshot. This
  -- closes the inverse mapping gap that a one-sided task check would miss.
  select count(*)
    into v_count
    from public.room_work w
   where w.legacy_task_id is not null
     and not exists (
       select 1
         from public.cleaning_tasks t
        where t.id = w.legacy_task_id
          and t.property_id = w.property_id
          and t.business_date = w.date
          and t.room_number = w.room_number
     );
  if v_count > 0 then
    raise exception
      '0437 preflight: % canonical row(s) have a missing or cross-property frozen cleaning task mapping; no destructive work was attempted',
      v_count;
  end if;

  -- The report-owned PMS source is intentionally allowed to be PMS-only in
  -- the canonical full-outer read model, but its rows must remain structurally
  -- valid and its unique property/date/room contract must be present.
  select count(*)
    into v_count
    from public.pms_housekeeping_assignments a
   where a.property_id is null or a.date is null or a.room_number is null;
  if v_count > 0 then
    raise exception
      '0437 preflight: % PMS assignment row(s) are missing property/date/room identity; PMS truth cannot be preserved safely',
      v_count;
  end if;
end;
$$;

-- Freeze the compatibility window before taking the final deterministic
-- snapshot. The pair is locked in dependency order and remains locked until
-- both physical relations are dropped below.
lock table public.cleaning_tasks in access exclusive mode;
lock table public.hk_assignments in access exclusive mode;

create temporary table phase5_stage_c_cleaning_tasks
on commit drop
as
select * from public.cleaning_tasks;

create temporary table phase5_stage_c_hk_assignments
on commit drop
as
select * from public.hk_assignments;

-- Keep the exact compatibility-window rows available for final proofs after
-- the physical pair is dropped. This is transaction-local evidence only; the
-- production rollback artifact is the approved pre-apply database snapshot.
do $$
declare
  v_count bigint;
begin
  select count(*)
    into v_count
    from phase5_stage_c_cleaning_tasks t
   where not exists (
     select 1
       from public.room_work w
      where w.legacy_task_id = t.id
        and w.property_id = t.property_id
        and w.date = t.business_date
        and w.room_number = t.room_number
   );
  if v_count > 0 then
    raise exception
      '0437 preflight: % cleaning_tasks row(s) have no same-property canonical room_work owner; restore/forward-remediate instead of dropping the pair',
      v_count;
  end if;

  select count(*)
    into v_count
    from phase5_stage_c_hk_assignments a
    left join phase5_stage_c_cleaning_tasks t
      on t.id = a.cleaning_task_id
     and t.property_id = a.property_id
    left join public.room_work w
      on w.legacy_task_id = a.cleaning_task_id
     and w.property_id = a.property_id
   where t.id is null
      or w.id is null
      or t.business_date is null
      or t.room_number is null
      or w.date is distinct from t.business_date
      or w.room_number is distinct from t.room_number;
  if v_count > 0 then
    raise exception
      '0437 preflight: % hk_assignments row(s) have no same-property canonical room_work owner; assignment history would be lost',
      v_count;
  end if;

  select count(*)
    into v_count
    from (
      select t.property_id, t.dedupe_key
        from phase5_stage_c_cleaning_tasks t
       group by t.property_id, t.dedupe_key
      having count(*) > 1
    ) conflicts;
  if v_count > 0 then
    raise exception
      '0437 preflight: % compatibility-window cleaning_tasks dedupe group(s) are ambiguous',
      v_count;
  end if;
end;
$$;

-- A late old-window write is reconciled only when its table timestamp is at
-- least as new as the canonical row. A canonical write that is newer wins;
-- an equal timestamp is deterministically assigned to the compatibility row.
-- The bridge normally keeps these values equal, so this is a final gap-closing
-- operation rather than a second synchronization path.
create temporary table phase5_stage_c_plan_reconciliation
on commit drop
as
select
  t.id as legacy_task_id,
  w.id as work_id,
  case
    when w.plan_cleaning_type is null or t.updated_at >= w.updated_at
      then 'legacy_compatibility'
    else 'canonical_room_work'
  end as winner
from phase5_stage_c_cleaning_tasks t
join public.room_work w
  on w.legacy_task_id = t.id
 and w.property_id = t.property_id
 and w.date = t.business_date
 and w.room_number = t.room_number;

do $$
declare
  v_count bigint;
begin
  select count(*)
    into v_count
    from phase5_stage_c_plan_reconciliation r
    join phase5_stage_c_cleaning_tasks t on t.id = r.legacy_task_id
    join public.room_work w on w.id = r.work_id
   where r.winner = 'legacy_compatibility'
     and exists (
       select 1
         from public.room_work other
        where other.property_id = w.property_id
          and other.plan_dedupe_key = t.dedupe_key
          and other.id <> w.id
     );
  if v_count > 0 then
    raise exception
      '0437 preflight: % late compatibility plan write(s) would collide with a canonical dedupe key',
      v_count;
  end if;
end;
$$;

update public.room_work w
   set plan_dedupe_key = t.dedupe_key,
       plan_cleaning_type = t.cleaning_type,
       plan_priority = t.priority,
       plan_due_by = t.due_by,
       plan_estimated_minutes = t.estimated_minutes,
       plan_requires_inspection = t.requires_inspection,
       plan_extras = t.extras,
       plan_notes = t.notes,
       plan_rules_fired = t.rules_fired,
       plan_rule_inputs = t.rule_inputs,
       plan_status = t.status,
       plan_source_pms_reservation_id = t.source_pms_reservation_id,
       plan_source_engine_run_id = t.source_engine_run_id,
       plan_source_property_timezone = t.source_property_timezone,
       plan_scheduled_at = t.scheduled_at,
       plan_last_evaluated_at = t.last_evaluated_at,
       started_at = coalesce(w.started_at, t.started_at),
       paused_at = coalesce(w.paused_at, t.paused_at),
       completed_at = coalesce(w.completed_at, t.completed_at),
       inspected_at = coalesce(w.inspected_at, t.inspected_at),
       is_paused = case
         when w.status in ('in_progress', 'completed', 'refused', 'skipped') then w.is_paused
         when t.status = 'paused' then true
         else w.is_paused
       end
  from phase5_stage_c_plan_reconciliation r
  join phase5_stage_c_cleaning_tasks t on t.id = r.legacy_task_id
 where w.id = r.work_id
   and r.winner = 'legacy_compatibility'
   and (
     w.plan_dedupe_key is distinct from t.dedupe_key
     or w.plan_cleaning_type is distinct from t.cleaning_type
     or w.plan_priority is distinct from t.priority
     or w.plan_due_by is distinct from t.due_by
     or w.plan_estimated_minutes is distinct from t.estimated_minutes
     or w.plan_requires_inspection is distinct from t.requires_inspection
     or w.plan_extras is distinct from t.extras
     or w.plan_notes is distinct from t.notes
     or w.plan_rules_fired is distinct from t.rules_fired
     or w.plan_rule_inputs is distinct from t.rule_inputs
     or w.plan_status is distinct from t.status
     or w.plan_source_pms_reservation_id is distinct from t.source_pms_reservation_id
     or w.plan_source_engine_run_id is distinct from t.source_engine_run_id
     or w.plan_source_property_timezone is distinct from t.source_property_timezone
     or w.plan_scheduled_at is distinct from t.scheduled_at
     or w.plan_last_evaluated_at is distinct from t.last_evaluated_at
     or (w.started_at is null and t.started_at is not null)
     or (w.paused_at is null and t.paused_at is not null)
     or (w.completed_at is null and t.completed_at is not null)
     or (w.inspected_at is null and t.inspected_at is not null)
     or (t.status = 'paused' and w.is_paused is distinct from true)
   );

-- Merge every legacy assignment receipt into the append-only canonical audit
-- array before choosing the final current assignment. `@>` compares the full
-- receipt payload while allowing canonical event metadata to remain attached.
with legacy_receipts as (
  select
    w.id as work_id,
    a.id as assignment_id,
    a.created_at as sort_created,
    jsonb_build_object(
      'id', a.id,
      'property_id', a.property_id,
      'cleaning_task_id', a.cleaning_task_id,
      'housekeeper_id', a.housekeeper_id,
      'queue_order', a.queue_order,
      'is_active', a.is_active,
      'assigned_at', a.assigned_at,
      'assigned_by', a.assigned_by,
      'assigned_source', case when a.assigned_by = 'auto' then 'auto' else 'manager' end,
      'assigned_by_user_id', a.assigned_by_user_id,
      'reason', a.reason,
      'score', a.score,
      'created_at', a.created_at,
      'updated_at', a.updated_at,
      'event', 'stage_c_reconciled_hk_assignment'
    ) as snapshot
  from phase5_stage_c_hk_assignments a
  join phase5_stage_c_cleaning_tasks t
    on t.id = a.cleaning_task_id
   and t.property_id = a.property_id
  join public.room_work w
    on w.legacy_task_id = t.id
   and w.property_id = t.property_id
   and w.date = t.business_date
   and w.room_number = t.room_number
), append_by_work as (
  select
    w.id as work_id,
    coalesce(
      jsonb_agg(r.snapshot order by r.sort_created, r.assignment_id),
      '[]'::jsonb
    ) as appended
  from public.room_work w
  join legacy_receipts r on r.work_id = w.id
  where not exists (
    select 1
      from jsonb_array_elements(coalesce(w.assignment_history, '[]'::jsonb)) h
     where h->>'id' = r.assignment_id::text
       and h @> r.snapshot
  )
  group by w.id
)
update public.room_work w
   set assignment_history = w.assignment_history || a.appended
  from append_by_work a
 where w.id = a.work_id
   and a.appended <> '[]'::jsonb;

-- Canonical writers already create a receipt. If a compatibility-era row was
-- repaired by a cache-only path and has current assignment columns without a
-- matching receipt, materialize one deterministic receipt before applying the
-- winner ordering; otherwise the assignment would survive without audit truth.
update public.room_work w
   set assignment_history = w.assignment_history || jsonb_build_array(
     jsonb_build_object(
       'id', gen_random_uuid(),
       'property_id', w.property_id,
       'cleaning_task_id', coalesce(w.legacy_task_id, w.id),
       'housekeeper_id', w.assigned_staff_id,
       'queue_order', w.assignment_queue_order,
       'is_active', true,
       'assigned_at', w.assignment_assigned_at,
       'assigned_by', coalesce(w.assignment_assigned_by, 'room_work'),
       'assigned_source', w.assigned_source,
       'assigned_by_user_id', w.assignment_assigned_by_user_id,
       'reason', w.assignment_reason,
       'score', w.assignment_score,
       'created_at', coalesce(w.created_at, now()),
       'updated_at', coalesce(w.updated_at, now()),
       'event', 'stage_c_reconciled_room_work'
     )
   )
 where w.assigned_staff_id is not null
   and not exists (
     select 1
       from (
         select h.snapshot,
                h.position,
                row_number() over (
                  partition by h.snapshot->>'id'
                  order by h.position desc
                ) as latest_position
           from jsonb_array_elements(coalesce(w.assignment_history, '[]'::jsonb))
             with ordinality h(snapshot, position)
       ) latest
      where latest.latest_position = 1
        and coalesce((latest.snapshot->>'is_active')::boolean, false)
        and latest.snapshot->>'property_id' = w.property_id::text
        and latest.snapshot->>'cleaning_task_id' = coalesce(w.legacy_task_id, w.id)::text
        and latest.snapshot->>'housekeeper_id' = w.assigned_staff_id::text
   );

create temporary table phase5_stage_c_active_legacy_assignments
on commit drop
as
select distinct on (a.cleaning_task_id)
  a.cleaning_task_id,
  a.property_id,
  a.housekeeper_id,
  a.id as assignment_id,
  greatest(a.updated_at, a.assigned_at) as changed_at,
  jsonb_build_object(
    'id', a.id,
    'property_id', a.property_id,
    'cleaning_task_id', a.cleaning_task_id,
    'housekeeper_id', a.housekeeper_id,
    'queue_order', a.queue_order,
    'is_active', true,
    'assigned_at', a.assigned_at,
    'assigned_by', a.assigned_by,
    'assigned_source', case when a.assigned_by = 'auto' then 'auto' else 'manager' end,
    'assigned_by_user_id', a.assigned_by_user_id,
    'reason', a.reason,
    'score', a.score,
    'created_at', a.created_at,
    'updated_at', a.updated_at,
    'event', 'stage_c_reconciled_active_hk_assignment'
  ) as snapshot
from phase5_stage_c_hk_assignments a
order by a.cleaning_task_id, greatest(a.updated_at, a.assigned_at) desc, a.created_at desc, a.id desc;

create temporary table phase5_stage_c_assignment_reconciliation
on commit drop
as
with canonical_receipts as (
  select
    w.id as work_id,
    latest.snapshot,
    coalesce(
      (latest.snapshot->>'updated_at')::timestamptz,
      (latest.snapshot->>'assigned_at')::timestamptz,
      w.assignment_assigned_at
    ) as changed_at
  from public.room_work w
  left join lateral (
    select h.snapshot, h.position
      from (
        select h0.snapshot,
               h0.position,
               row_number() over (
                 partition by h0.snapshot->>'id'
                 order by h0.position desc
               ) as latest_position
          from jsonb_array_elements(coalesce(w.assignment_history, '[]'::jsonb))
            with ordinality h0(snapshot, position)
      ) h
     where h.latest_position = 1
       and coalesce((h.snapshot->>'is_active')::boolean, false)
       and h.snapshot->>'property_id' = w.property_id::text
       and h.snapshot->>'cleaning_task_id' = coalesce(w.legacy_task_id, w.id)::text
       and h.snapshot->>'housekeeper_id' = w.assigned_staff_id::text
     order by h.position desc
     limit 1
  ) latest on true
)
select
  w.id as work_id,
  w.property_id,
  w.legacy_task_id,
  w.assigned_staff_id as canonical_staff_id,
  c.snapshot as canonical_snapshot,
  c.changed_at as canonical_changed_at,
  l.assignment_id as legacy_assignment_id,
  l.housekeeper_id as legacy_staff_id,
  l.snapshot as legacy_snapshot,
  l.changed_at as legacy_changed_at,
  case
    when l.assignment_id is null then 'canonical_room_work'
    when w.assigned_staff_id is null then 'legacy_compatibility'
    when w.status in ('in_progress', 'completed', 'refused', 'skipped') then 'canonical_room_work'
    when l.changed_at > coalesce(c.changed_at, '-infinity'::timestamptz)
      then 'legacy_compatibility'
    else 'canonical_room_work'
  end as winner
from public.room_work w
left join phase5_stage_c_active_legacy_assignments l
  on l.cleaning_task_id = w.legacy_task_id
 and l.property_id = w.property_id
left join canonical_receipts c on c.work_id = w.id
where w.legacy_task_id is not null;

-- Apply an old-window active assignment only when its deterministic timestamp
-- wins. If canonical state wins over an active legacy row, append an explicit
-- inactive receipt so history does not retain two current assignments.
update public.room_work w
   set assignment_history =
         case
           when r.winner = 'legacy_compatibility'
            and r.canonical_snapshot is not null
            and r.canonical_snapshot->>'id' is distinct from r.legacy_assignment_id::text
             then w.assignment_history || jsonb_build_array(
               r.canonical_snapshot || jsonb_build_object(
                 'is_active', false,
                 'event', 'stage_c_superseded_by_compatibility_write',
                 'changed_at', now(),
                 'updated_at', now()
               )
             )
           else w.assignment_history
         end
         || case
           when r.winner = 'legacy_compatibility'
            and not exists (
              select 1
                from jsonb_array_elements(coalesce(w.assignment_history, '[]'::jsonb)) h
               where h->>'id' = r.legacy_assignment_id::text
                 and h @> r.legacy_snapshot
            )
             then jsonb_build_array(r.legacy_snapshot)
           when r.winner = 'canonical_room_work'
            and r.legacy_assignment_id is not null
            and r.canonical_snapshot is not null
            and r.canonical_snapshot->>'id' is distinct from r.legacy_assignment_id::text
            and exists (
              select 1
                from jsonb_array_elements(coalesce(w.assignment_history, '[]'::jsonb)) h
               where h->>'id' = r.legacy_assignment_id::text
                 and coalesce((h->>'is_active')::boolean, false)
            )
             then jsonb_build_array(
               r.legacy_snapshot || jsonb_build_object(
                 'is_active', false,
                 'event', 'stage_c_superseded_by_canonical_write',
                 'changed_at', now(),
                 'updated_at', now()
               )
             )
           else '[]'::jsonb
         end,
       assigned_staff_id = case when r.winner = 'legacy_compatibility' then r.legacy_staff_id else w.assigned_staff_id end,
       assigned_source = case
         when r.winner = 'legacy_compatibility' then
           case when r.legacy_snapshot->>'assigned_by' = 'auto' then 'auto' else 'manager' end
         else w.assigned_source
       end,
       assignment_queue_order = case when r.winner = 'legacy_compatibility' then (r.legacy_snapshot->>'queue_order')::integer else w.assignment_queue_order end,
       assignment_assigned_at = case when r.winner = 'legacy_compatibility' then (r.legacy_snapshot->>'assigned_at')::timestamptz else w.assignment_assigned_at end,
       assignment_assigned_by = case when r.winner = 'legacy_compatibility' then r.legacy_snapshot->>'assigned_by' else w.assignment_assigned_by end,
       assignment_assigned_by_user_id = case when r.winner = 'legacy_compatibility' then (r.legacy_snapshot->>'assigned_by_user_id')::uuid else w.assignment_assigned_by_user_id end,
       assignment_reason = case when r.winner = 'legacy_compatibility' then r.legacy_snapshot->>'reason' else w.assignment_reason end,
       assignment_score = case when r.winner = 'legacy_compatibility' then (r.legacy_snapshot->>'score')::numeric else w.assignment_score end
  from phase5_stage_c_assignment_reconciliation r
 where w.id = r.work_id;

-- Final invariant gate. It runs before the destructive DROP statements and
-- therefore aborts the entire transaction without changing production when a
-- row cannot be proven safe.
do $$
declare
  v_count bigint;
begin
  select count(*)
    into v_count
    from public.room_work w
   where w.id is distinct from public.housekeeping_plan_id(w.property_id, w.date, w.room_number);
  if v_count > 0 then
    raise exception '0437 invariant failure: % room_work identity row(s) do not match property/date/room', v_count;
  end if;

  select count(*)
    into v_count
    from phase5_stage_c_cleaning_tasks t
    left join public.room_work w
      on w.legacy_task_id = t.id
     and w.property_id = t.property_id
     and w.date = t.business_date
     and w.room_number = t.room_number
   where w.id is null;
  if v_count > 0 then
    raise exception '0437 invariant failure: % legacy task row(s) have no canonical owner', v_count;
  end if;

  select count(*)
    into v_count
    from (
      select w.property_id, w.plan_dedupe_key
        from public.room_work w
       where w.plan_dedupe_key is not null
       group by w.property_id, w.plan_dedupe_key
      having count(*) > 1
    ) conflicts;
  if v_count > 0 then
    raise exception '0437 invariant failure: canonical plan dedupe keys are not unique';
  end if;

  select count(*)
    into v_count
    from public.room_work w
    left join public.staff s on s.id = w.assigned_staff_id
   where w.assigned_staff_id is not null
     and (
       s.id is null
       or s.property_id is distinct from w.property_id
       or s.department is distinct from 'housekeeping'
       or coalesce(s.is_active, true) = false
     );
  if v_count > 0 then
    raise exception '0437 invariant failure: % current assignment row(s) cross a property or department boundary', v_count;
  end if;

  select count(*)
    into v_count
    from public.room_work w
    cross join lateral jsonb_array_elements(coalesce(w.assignment_history, '[]'::jsonb)) h
    left join public.staff s on s.id::text = h->>'housekeeper_id'
   where jsonb_typeof(h) is distinct from 'object'
      or h->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or h->>'property_id' is distinct from w.property_id::text
      or h->>'cleaning_task_id' is distinct from coalesce(w.legacy_task_id, w.id)::text
      or h->>'housekeeper_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or s.id is null
       or s.property_id is distinct from w.property_id
       or (h->>'id' is null)
       or (h->>'property_id' is null)
       or (h->>'cleaning_task_id' is null)
       or (h->>'housekeeper_id' is null)
       or not (h ? 'queue_order')
       or not (h ? 'assigned_at')
       or not (h ? 'assigned_by')
       or h->>'assigned_by' is null
       or h->>'assigned_by' not in ('auto', 'manual', 'rebalance', 'manager', 'pms_import', 'alias_exact', 'alias_first_name', 'room_work')
       or not (h ? 'assigned_by_user_id')
       or not (h ? 'reason')
       or not (h ? 'score')
       or not (h ? 'created_at')
       or not (h ? 'updated_at');
  if v_count > 0 then
    raise exception '0437 invariant failure: % assignment history receipt(s) are malformed, incomplete, or cross property', v_count;
  end if;

  select count(*)
    into v_count
    from phase5_stage_c_hk_assignments a
    left join public.room_work w
      on w.legacy_task_id = a.cleaning_task_id
     and w.property_id = a.property_id
   where w.id is null
      or not exists (
        select 1
          from jsonb_array_elements(coalesce(w.assignment_history, '[]'::jsonb)) h
         where h->>'id' = a.id::text
           and h->>'property_id' = a.property_id::text
      );
  if v_count > 0 then
    raise exception '0437 invariant failure: % compatibility assignment receipt(s) are absent from canonical history', v_count;
  end if;

  with latest_by_assignment as (
    select w.id as work_id,
           h.snapshot,
           h.position,
           row_number() over (
             partition by w.id, h.snapshot->>'id'
             order by h.position desc
           ) as latest_position
      from public.room_work w
      cross join lateral jsonb_array_elements(coalesce(w.assignment_history, '[]'::jsonb))
        with ordinality h(snapshot, position)
  ), latest_active as (
    select work_id, snapshot
      from latest_by_assignment
     where latest_position = 1
       and coalesce((snapshot->>'is_active')::boolean, false)
  ), active_counts as (
    select work_id, count(*) as active_count
      from latest_active
     group by work_id
  )
  select count(*) into v_count
    from active_counts
   where active_count > 1;
  if v_count > 0 then
    raise exception '0437 invariant failure: % room_work row(s) retain multiple active assignment receipts', v_count;
  end if;

  select count(*)
    into v_count
    from public.room_work w
   where w.assigned_staff_id is not null
     and not exists (
       select 1
         from (
           select h.snapshot,
                  h.position,
                  row_number() over (
                    partition by h.snapshot->>'id'
                    order by h.position desc
                  ) as latest_position
             from jsonb_array_elements(coalesce(w.assignment_history, '[]'::jsonb))
               with ordinality h(snapshot, position)
         ) latest
        where latest.latest_position = 1
          and coalesce((latest.snapshot->>'is_active')::boolean, false)
          and latest.snapshot->>'housekeeper_id' = w.assigned_staff_id::text
          and latest.snapshot->>'property_id' = w.property_id::text
          and latest.snapshot->>'cleaning_task_id' = coalesce(w.legacy_task_id, w.id)::text
     );
  if v_count > 0 then
    raise exception '0437 invariant failure: % current assignment row(s) have no matching active history receipt', v_count;
  end if;
end;
$$;

-- Remove every physical legacy writer and its audit triggers before dropping
-- the relations. Canonical RPCs below remain the sole write surface.
drop trigger if exists trg_legacy_cleaning_task_to_room_work on public.cleaning_tasks;
drop trigger if exists trg_legacy_hk_assignment_to_room_work on public.hk_assignments;
drop trigger if exists trg_activity_log_cleaning_task_ins on public.cleaning_tasks;
drop trigger if exists trg_activity_log_cleaning_task_upd on public.cleaning_tasks;
drop trigger if exists trg_activity_log_hk_assignment_ins on public.hk_assignments;
drop trigger if exists trg_activity_log_hk_assignment_upd on public.hk_assignments;
drop trigger if exists set_updated_at on public.cleaning_tasks;
drop trigger if exists set_updated_at on public.hk_assignments;

drop function if exists public._legacy_cleaning_task_to_room_work();
drop function if exists public._legacy_hk_assignment_to_room_work();
drop function if exists public._activity_log_on_cleaning_task_insert();
drop function if exists public._activity_log_on_cleaning_task_status_update();
drop function if exists public._activity_log_on_hk_assignment_insert();
drop function if exists public._activity_log_on_hk_assignment_update();
drop function if exists public.reassign_cleaning_task(uuid, uuid, uuid, uuid, text);
drop function if exists public.complete_inspection_atomic(uuid, uuid, text, jsonb, jsonb, text, boolean, text, timestamptz, text);

drop table public.hk_assignments;
drop table public.cleaning_tasks;

do $$
begin
  if to_regclass('public.hk_assignments') is not null then
    raise exception '0437 teardown failure: physical hk_assignments still exists';
  end if;
  if to_regclass('public.cleaning_tasks') is not null then
    raise exception '0437 teardown failure: physical cleaning_tasks still exists before projection install';
  end if;
  if to_regprocedure('public.reassign_cleaning_task(uuid,uuid,uuid,uuid,text)') is not null
     or to_regprocedure('public.complete_inspection_atomic(uuid,uuid,text,jsonb,jsonb,text,boolean,text,timestamptz,text)') is not null then
    raise exception '0437 teardown failure: an old cleaning RPC remains executable after legacy table drop';
  end if;
end;
$$;

-- One retained read-only compatibility name for portfolio-ui/server.ts. The
-- UNION ALL (with an empty arm) makes PostgreSQL reject INSERT/UPDATE/DELETE
-- rather than auto-updating room_work. No INSTEAD OF trigger is installed.
create view public.cleaning_tasks as
select
  coalesce(w.legacy_task_id, w.id) as id,
  w.property_id,
  w.room_number,
  w.date as business_date,
  w.plan_dedupe_key as dedupe_key,
  w.plan_cleaning_type as cleaning_type,
  coalesce(w.plan_priority, 'normal') as priority,
  w.plan_due_by as due_by,
  w.plan_estimated_minutes as estimated_minutes,
  coalesce(w.plan_requires_inspection, false) as requires_inspection,
  coalesce(w.plan_extras, '[]'::jsonb) as extras,
  w.plan_notes as notes,
  coalesce(w.plan_rules_fired, '[]'::jsonb) as rules_fired,
  w.plan_rule_inputs as rule_inputs,
  case
    when w.status = 'in_progress' and w.is_paused then 'paused'
    when w.status = 'in_progress' then 'in_progress'
    when w.status = 'completed' and w.plan_status in (
      'inspection_pending', 'inspected_pass', 'inspected_fail',
      'correction_pending', 'correction_complete', 'check_pending',
      'check_complete'
    ) then w.plan_status
    when w.status = 'completed' then 'completed'
    when w.status = 'skipped' and w.plan_status in ('cancelled', 'superseded') then w.plan_status
    when w.status = 'skipped' then 'skipped'
    when w.status = 'refused' then coalesce(w.plan_status, 'deferred')
    else coalesce(w.plan_status, 'scheduled')
  end as status,
  w.assigned_staff_id as assignee_id,
  w.plan_source_pms_reservation_id as source_pms_reservation_id,
  w.plan_source_engine_run_id as source_engine_run_id,
  w.plan_source_property_timezone as source_property_timezone,
  w.plan_scheduled_at as scheduled_at,
  w.started_at,
  w.paused_at,
  w.completed_at,
  w.inspected_at,
  coalesce(w.plan_last_evaluated_at, w.updated_at) as last_evaluated_at,
  coalesce(w.created_at, w.updated_at) as created_at,
  w.updated_at
from public.room_work w
where w.plan_cleaning_type is not null
union all
select
  coalesce(w.legacy_task_id, w.id) as id,
  w.property_id,
  w.room_number,
  w.date as business_date,
  w.plan_dedupe_key as dedupe_key,
  w.plan_cleaning_type as cleaning_type,
  coalesce(w.plan_priority, 'normal') as priority,
  w.plan_due_by as due_by,
  w.plan_estimated_minutes as estimated_minutes,
  coalesce(w.plan_requires_inspection, false) as requires_inspection,
  coalesce(w.plan_extras, '[]'::jsonb) as extras,
  w.plan_notes as notes,
  coalesce(w.plan_rules_fired, '[]'::jsonb) as rules_fired,
  w.plan_rule_inputs as rule_inputs,
  case
    when w.status = 'in_progress' and w.is_paused then 'paused'
    when w.status = 'in_progress' then 'in_progress'
    when w.status = 'completed' and w.plan_status in (
      'inspection_pending', 'inspected_pass', 'inspected_fail',
      'correction_pending', 'correction_complete', 'check_pending',
      'check_complete'
    ) then w.plan_status
    when w.status = 'completed' then 'completed'
    when w.status = 'skipped' and w.plan_status in ('cancelled', 'superseded') then w.plan_status
    when w.status = 'skipped' then 'skipped'
    when w.status = 'refused' then coalesce(w.plan_status, 'deferred')
    else coalesce(w.plan_status, 'scheduled')
  end as status,
  w.assigned_staff_id as assignee_id,
  w.plan_source_pms_reservation_id as source_pms_reservation_id,
  w.plan_source_engine_run_id as source_engine_run_id,
  w.plan_source_property_timezone as source_property_timezone,
  w.plan_scheduled_at as scheduled_at,
  w.started_at,
  w.paused_at,
  w.completed_at,
  w.inspected_at,
  coalesce(w.plan_last_evaluated_at, w.updated_at) as last_evaluated_at,
  coalesce(w.created_at, w.updated_at) as created_at,
  w.updated_at
from public.room_work w
where false;

comment on view public.cleaning_tasks is
  'Read-only Stage C compatibility projection for the retained portfolio housekeeping summary. Canonical source is room_work; this UNION ALL view intentionally has no writable path.';
revoke all on public.cleaning_tasks from public, anon, authenticated;
grant select on public.cleaning_tasks to service_role;

-- Backfill the canonical audit seam for rows created by Stage B while its
-- room_work trigger was intentionally dormant. Existing legacy events dedupe
-- by source id, so old-window activity is preserved without duplication.
do $$
declare
  v_row record;
  v_target uuid;
  v_snapshot record;
  v_event_type text;
  v_occurred_at timestamptz;
  v_source text;
begin
  for v_row in
    select w.*
      from public.room_work w
     where w.plan_cleaning_type is not null
       and not exists (
         select 1
           from public.activity_log l
          where l.property_id = w.property_id
            and l.event_type = 'cleaning_task_created'
            and l.source_event_id = coalesce(w.legacy_task_id, w.id)
       )
  loop
    v_target := coalesce(v_row.legacy_task_id, v_row.id);
    perform public._activity_log_write(
      v_row.property_id,
      v_row.created_at,
      'housekeeping',
      'cleaning_task_created',
      null,
      null,
      'cleaning_task',
      v_target::text,
      'Room ' || v_row.room_number,
      format('Cleaning task created for room %s (%s, priority %s)', v_row.room_number, v_row.plan_cleaning_type, coalesce(v_row.plan_priority, 'normal')),
      'rules_engine',
      v_target,
      jsonb_build_object(
        'room_number', v_row.room_number,
        'business_date', v_row.date,
        'cleaning_type', v_row.plan_cleaning_type,
        'priority', v_row.plan_priority,
        'estimated_minutes', v_row.plan_estimated_minutes,
        'requires_inspection', v_row.plan_requires_inspection,
        'status', v_row.plan_status,
        'rules_fired', v_row.plan_rules_fired,
        'stage_c_backfill', true
      )
    );
  end loop;

  for v_snapshot in
    select
      w.property_id,
      w.room_number,
      h.snapshot,
      case
        when coalesce((h.snapshot->>'is_active')::boolean, false) then 'assignment_created'
        else 'assignment_deactivated'
      end as event_type,
      case
        when coalesce((h.snapshot->>'is_active')::boolean, false)
          then coalesce((h.snapshot->>'assigned_at')::timestamptz, (h.snapshot->>'updated_at')::timestamptz, w.updated_at)
        else coalesce((h.snapshot->>'updated_at')::timestamptz, (h.snapshot->>'changed_at')::timestamptz, w.updated_at)
      end as occurred_at
    from public.room_work w
    cross join lateral jsonb_array_elements(coalesce(w.assignment_history, '[]'::jsonb)) h(snapshot)
   where h.snapshot->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     and not exists (
       select 1
         from public.activity_log l
        where l.property_id = w.property_id
          and l.event_type = case
            when coalesce((h.snapshot->>'is_active')::boolean, false) then 'assignment_created'
            else 'assignment_deactivated'
          end
          and l.source_event_id = (h.snapshot->>'id')::uuid
     )
  loop
    v_event_type := v_snapshot.event_type;
    v_occurred_at := v_snapshot.occurred_at;
    v_source := case
      when v_snapshot.snapshot->>'assigned_by' in ('auto', 'rebalance') then 'rules_engine'
      else 'manager_dashboard'
    end;
    perform public._activity_log_write(
      v_snapshot.property_id,
      v_occurred_at,
      'housekeeping',
      v_event_type,
      (v_snapshot.snapshot->>'housekeeper_id')::uuid,
      nullif(v_snapshot.snapshot->>'assigned_by_user_id', '')::uuid,
      'cleaning_task',
      v_snapshot.snapshot->>'cleaning_task_id',
      'Room ' || v_snapshot.room_number,
      case
        when v_event_type = 'assignment_created' then format('Assigned a housekeeper to room %s', v_snapshot.room_number)
        else format('Unassigned a housekeeper from room %s', v_snapshot.room_number)
      end,
      v_source,
      (v_snapshot.snapshot->>'id')::uuid,
      v_snapshot.snapshot || jsonb_build_object('stage_c_backfill', true)
    );
  end loop;
end;
$$;

-- The canonical component and audit functions were deliberately installed
-- dormant in 0435-0436. Stage C is the approved activation boundary.
drop trigger if exists room_work_complete_components on public.room_work;
create trigger room_work_complete_components
  after update of status on public.room_work
  for each row
  when (new.status = 'completed' and old.status is distinct from new.status)
  execute function public._room_work_complete_components();

drop trigger if exists trg_activity_log_room_work_change on public.room_work;
create trigger trg_activity_log_room_work_change
  after insert or update of status, plan_status, assigned_staff_id on public.room_work
  for each row
  execute function public._activity_log_on_room_work_change();

revoke all on function public._room_work_complete_components() from public, anon, authenticated;
revoke all on function public._activity_log_on_room_work_change() from public, anon, authenticated;
grant execute on function public._room_work_complete_components() to service_role;
grant execute on function public._activity_log_on_room_work_change() to service_role;

-- Preserve the report-owned PMS relation and inspection/photo/result truth as
-- an explicit post-drop gate, then write the durable operator evidence. The
-- hashes are deterministic row snapshots, not a substitute for the approved
-- production backup; they make a later replay auditable and comparable.
do $$
declare
  v_baseline record;
  v_pms_count bigint;
  v_pms_hash text;
  v_inspection_count bigint;
  v_inspection_hash text;
begin
  select * into v_baseline from phase5_stage_c_baseline_evidence limit 1;

  select count(*), md5(coalesce(string_agg(to_jsonb(a)::text, '|' order by a.property_id, a.date, a.room_number), ''))
    into v_pms_count, v_pms_hash
    from public.pms_housekeeping_assignments a;
  if v_pms_count is distinct from v_baseline.pms_assignments_count_before
     or v_pms_hash is distinct from v_baseline.pms_assignments_hash_before then
    raise exception
      '0437 invariant failure: pms_housekeeping_assignments count/hash changed during retirement; restore and forward-remediate instead of accepting the cutover';
  end if;

  select count(*), md5(coalesce(string_agg(to_jsonb(i)::text, '|' order by i.property_id, i.started_at, i.id), ''))
    into v_inspection_count, v_inspection_hash
    from public.inspections i;
  if v_inspection_count is distinct from v_baseline.inspections_count_before
     or v_inspection_hash is distinct from v_baseline.inspections_hash_before then
    raise exception
      '0437 invariant failure: inspections/photo/result source count/hash changed during retirement; restore and forward-remediate instead of accepting the cutover';
  end if;
end;
$$;

insert into public.housekeeping_stage_c_cutover_evidence (
  run_id,
  started_at,
  cutover_at,
  operator_name,
  session_user_name,
  legacy_cleaning_tasks_count,
  legacy_cleaning_tasks_hash,
  legacy_hk_assignments_count,
  legacy_hk_assignments_hash,
  room_work_count_before,
  room_work_count_after,
  room_work_hash_before,
  room_work_hash_after,
  pms_assignments_count_before,
  pms_assignments_count_after,
  pms_assignments_hash_before,
  pms_assignments_hash_after,
  inspections_count_before,
  inspections_count_after,
  inspections_hash_before,
  inspections_hash_after,
  assignment_history_receipts_after,
  active_assignment_receipts_after,
  activity_log_count_before,
  activity_log_count_after,
  activity_log_hash_before,
  activity_log_hash_after,
  physical_legacy_tables_dropped,
  compatibility_projection,
  rollback_policy,
  remediation_procedure
)
select
  b.run_id,
  b.started_at,
  clock_timestamp(),
  b.operator_name,
  b.session_user_name,
  (select count(*) from phase5_stage_c_cleaning_tasks),
  md5(coalesce((select string_agg(to_jsonb(t)::text, '|' order by t.id)
                  from phase5_stage_c_cleaning_tasks t), '')),
  (select count(*) from phase5_stage_c_hk_assignments),
  md5(coalesce((select string_agg(to_jsonb(a)::text, '|' order by a.id)
                  from phase5_stage_c_hk_assignments a), '')),
  b.room_work_count_before,
  (select count(*) from public.room_work),
  b.room_work_hash_before,
  md5(coalesce((select string_agg(to_jsonb(w)::text, '|' order by w.property_id, w.date, w.room_number)
                  from public.room_work w), '')),
  b.pms_assignments_count_before,
  (select count(*) from public.pms_housekeeping_assignments),
  b.pms_assignments_hash_before,
  md5(coalesce((select string_agg(to_jsonb(a)::text, '|' order by a.property_id, a.date, a.room_number)
                  from public.pms_housekeeping_assignments a), '')),
  b.inspections_count_before,
  (select count(*) from public.inspections),
  b.inspections_hash_before,
  md5(coalesce((select string_agg(to_jsonb(i)::text, '|' order by i.property_id, i.started_at, i.id)
                  from public.inspections i), '')),
  (select coalesce(sum(jsonb_array_length(coalesce(w.assignment_history, '[]'::jsonb))), 0)
     from public.room_work w),
  (select count(*) from public.room_work where assigned_staff_id is not null),
  b.activity_log_count_before,
  (select count(*) from public.activity_log),
  b.activity_log_hash_before,
  md5(coalesce((select string_agg(to_jsonb(l)::text, '|' order by l.property_id, l.occurred_at, l.id)
                  from public.activity_log l), '')),
  true,
  'cleaning_tasks: SELECT-only UNION ALL compatibility projection; hk_assignments: no retained relation',
  'OLD-APP-ROLLBACK-INVALID-AFTER-RETIREMENT: do not restore or run a pre-0437 app against the retired pair. Recovery requires the approved pre-0437 database snapshot or final export, followed by forward remediation.',
  'CLEANING_STAGE_C_FREEZE_AND_FORWARD_REMEDIATE_V1: freeze all old deployments and legacy writes; restore the approved pre-0437 snapshot or final export if needed; remediate exact property/date/room/task/history rows; replay canonical room_work and assignment_history; verify task/assignment/history/property/PMS/inspection invariants; rerun 0437. Never add reverse-sync triggers or a writable legacy view.'
from phase5_stage_c_baseline_evidence b;

do $$
declare
  v_count bigint;
  v_names text;
begin
  if exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind in ('f', 'p')
       and pg_get_functiondef(p.oid) ~* '\m(cleaning_tasks|hk_assignments)\M'
  ) then
    select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text)
      into v_names
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind in ('f', 'p')
       and pg_get_functiondef(p.oid) ~* '\m(cleaning_tasks|hk_assignments)\M';
    raise exception '0437 teardown failure: executable legacy reader/writer function(s) remain: %', v_names;
  end if;
end;
$$;

insert into public.applied_migrations (version, description)
values (
  '0437',
  'Cleaning Stage C contract: freeze-gated deterministic compatibility-window reconciliation, durable counts/hashes/operator evidence, canonical component/audit activation, physical cleaning_tasks and hk_assignments retirement, and a service-only non-updatable cleaning_tasks read projection. Old-app rollback is invalid after retirement; the named CLEANING_STAGE_C_FREEZE_AND_FORWARD_REMEDIATE_V1 procedure is required for recovery.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
