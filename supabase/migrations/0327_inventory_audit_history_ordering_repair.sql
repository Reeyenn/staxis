-- 0327: repair same-timestamp inventory audit baseline ordering.
--
-- Migration 0326 intentionally gave its historical backfill chronological
-- sequence values.  Legacy inventory rows without created_at borrow the
-- timestamp of their earliest retained evidence.  The original dedupe-key tie
-- break could put count/delivery/archive evidence below that inferred baseline
-- in the descending History feed.  Reuse the existing sequence slots and
-- stable-partition only affected property/timestamp groups so no audit event or
-- sequence value is created, removed, or rewritten outside the ordering key.

begin;

do $$
declare
  v_trigger_state text;
begin
  if to_regclass('public.inventory_audit_events') is null
     or to_regclass('public.inventory_audit_event_sequence') is null
     or to_regprocedure('public.staxis_list_inventory_audit_events(uuid,bigint,integer,boolean)') is null
  then
    raise exception 'inventory audit ordering repair requires migration 0326';
  end if;

  select t.tgenabled::text
  into v_trigger_state
  from pg_trigger t
  where t.tgrelid = 'public.inventory_audit_events'::regclass
    and t.tgname = 'inventory_audit_events_immutable'
    and not t.tgisinternal;

  if v_trigger_state is distinct from 'O' then
    raise exception 'inventory audit immutable trigger must be enabled before ordering repair (state=%)',
      coalesce(v_trigger_state, 'missing');
  end if;

  if exists (
    select 1 from public.inventory_audit_events where sequence <= 0
  ) then
    raise exception 'inventory audit ordering repair requires positive sequence values';
  end if;
end
$$;

-- Block appends and reads while sequence slots are temporarily negative.  The
-- lock also makes the trigger disable/update/restore section atomic to callers.
lock table public.inventory_audit_events in access exclusive mode;

create temporary table staxis_inventory_audit_sequence_repair (
  id           uuid primary key,
  old_sequence bigint not null unique,
  new_sequence bigint not null unique
) on commit drop;

insert into staxis_inventory_audit_sequence_repair(id, old_sequence, new_sequence)
with affected_groups as (
  select distinct e.property_id, e.occurred_at
  from public.inventory_audit_events e
  where e.action = 'item.created'
    and e.source_table = 'inventory'
    and e.details @> '{"baseline":true,"inferredOccurredAt":true}'::jsonb
), ranked_events as (
  select
    e.id,
    e.property_id,
    e.occurred_at,
    e.sequence as old_sequence,
    row_number() over (
      partition by e.property_id, e.occurred_at
      order by
        case
          when e.action = 'item.created'
            and e.source_table = 'inventory'
            and e.details @> '{"baseline":true,"inferredOccurredAt":true}'::jsonb
          then 0
          else 1
        end,
        e.sequence
    ) as slot
  from public.inventory_audit_events e
  join affected_groups g
    on g.property_id = e.property_id
   and g.occurred_at = e.occurred_at
), ranked_slots as (
  select
    e.property_id,
    e.occurred_at,
    e.sequence as new_sequence,
    row_number() over (
      partition by e.property_id, e.occurred_at
      order by e.sequence
    ) as slot
  from public.inventory_audit_events e
  join affected_groups g
    on g.property_id = e.property_id
   and g.occurred_at = e.occurred_at
)
select r.id, r.old_sequence, s.new_sequence
from ranked_events r
join ranked_slots s
  on s.property_id = r.property_id
 and s.occurred_at = r.occurred_at
 and s.slot = r.slot
where r.old_sequence <> s.new_sequence;

-- The unique sequence constraint is immediate.  Move the affected rows through
-- a disjoint negative range before assigning their repaired positive slots.
alter table public.inventory_audit_events
  disable trigger inventory_audit_events_immutable;

update public.inventory_audit_events e
set sequence = -r.old_sequence
from staxis_inventory_audit_sequence_repair r
where e.id = r.id;

update public.inventory_audit_events e
set sequence = r.new_sequence
from staxis_inventory_audit_sequence_repair r
where e.id = r.id;

alter table public.inventory_audit_events
  enable trigger inventory_audit_events_immutable;

do $$
declare
  v_trigger_state text;
begin
  select t.tgenabled::text
  into v_trigger_state
  from pg_trigger t
  where t.tgrelid = 'public.inventory_audit_events'::regclass
    and t.tgname = 'inventory_audit_events_immutable'
    and not t.tgisinternal;

  if v_trigger_state is distinct from 'O' then
    raise exception 'inventory audit immutable trigger was not restored after ordering repair (state=%)',
      coalesce(v_trigger_state, 'missing');
  end if;

  if exists (
    select 1 from public.inventory_audit_events where sequence <= 0
  ) then
    raise exception 'inventory audit ordering repair left a temporary sequence value';
  end if;

  if exists (
    select 1
    from public.inventory_audit_events baseline
    join public.inventory_audit_events evidence
      on evidence.property_id = baseline.property_id
     and evidence.occurred_at = baseline.occurred_at
    where baseline.action = 'item.created'
      and baseline.source_table = 'inventory'
      and baseline.details @> '{"baseline":true,"inferredOccurredAt":true}'::jsonb
      and not (
        evidence.action = 'item.created'
        and evidence.source_table = 'inventory'
        and evidence.details @> '{"baseline":true,"inferredOccurredAt":true}'::jsonb
      )
      and evidence.sequence < baseline.sequence
  ) then
    raise exception 'inventory audit inferred baseline still sorts above same-timestamp evidence';
  end if;
end
$$;

insert into public.applied_migrations(version, description)
values ('0327', 'repair inferred inventory baseline sequence ordering without changing audit evidence')
on conflict (version) do nothing;

notify pgrst, 'reload schema';
commit;
