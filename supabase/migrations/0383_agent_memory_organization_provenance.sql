-- 0383_agent_memory_organization_provenance.sql
--
-- Property memory is authored while a hotel belongs to one management
-- company. Preserve that tenant provenance so a later hotel transfer cannot
-- expose the former company's notes, people, vendors, or policy exceptions to
-- the acquiring company's portfolio chat. The ordinary single-hotel memory
-- behavior is unchanged; this column is enforced at the portfolio overlay.

begin;

alter table public.agent_memory
  add column if not exists authoring_organization_id uuid
    references public.organizations(id) on delete set null;

-- Existing memory predates immutable authoring provenance. It MUST remain
-- NULL: the hotel's company at deployment time does not prove which company
-- authored an older vendor/person/policy note. In particular, relabeling a
-- pre-transfer note with the acquiring company would be a cross-tenant leak.
-- NULL rows keep their ordinary single-hotel behavior but are excluded from
-- every company overlay until a current-company manager reviews/re-authors
-- them through a provenance-aware write.

create or replace function public._staxis_stamp_agent_memory_organization()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_organization_id uuid;
begin
  if tg_op = 'UPDATE' and new.property_id = old.property_id then
    -- Provenance is immutable even to service-role callers. Corrections update
    -- the same memory row and remain a revision by its original tenant.
    new.authoring_organization_id := old.authoring_organization_id;
    return new;
  end if;

  select relationship.organization_id
  into v_organization_id
  from public._staxis_current_primary_property_relationships() relationship
  where relationship.property_id = new.property_id
    and relationship.active_primary_count = 1
  limit 1;

  new.authoring_organization_id := v_organization_id;
  return new;
end
$$;

drop trigger if exists agent_memory_stamp_authoring_organization on public.agent_memory;
create trigger agent_memory_stamp_authoring_organization
  before insert or update of property_id, authoring_organization_id
  on public.agent_memory
  for each row execute function public._staxis_stamp_agent_memory_organization();

create index if not exists agent_memory_portfolio_knowledge_idx
  on public.agent_memory(authoring_organization_id, property_id, updated_at desc)
  where scope = 'property' and is_active and review_state = 'confirmed';

-- One bounded, exact-set projection for portfolio orchestration. This avoids a
-- 1-query-per-hotel fanout and revalidates the company's current relationship
-- to every requested hotel inside the same database statement that reads the
-- knowledge. It returns at most p_limit rows; callers request 1001 and abstain
-- from knowledge when the 1000-row contract would be exceeded.
create or replace function public.staxis_portfolio_property_knowledge(
  p_organization_id uuid,
  p_property_ids uuid[],
  p_as_of timestamptz,
  p_limit integer default 1001
)
returns setof public.agent_memory
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_organization_id is null
     or p_property_ids is null
     or cardinality(p_property_ids) < 1
     or cardinality(p_property_ids) > 250
     or p_limit < 1
     or p_limit > 1001
  then
    raise exception 'invalid bounded portfolio knowledge request';
  end if;
  if cardinality(p_property_ids) <> (
    select count(distinct requested.property_id)
    from unnest(p_property_ids) requested(property_id)
  ) then
    raise exception 'portfolio knowledge property ids must be unique';
  end if;
  if exists (
    select 1
    from unnest(p_property_ids) requested(property_id)
    where not exists (
      select 1
      from public._staxis_current_primary_property_relationships() relationship
      where relationship.organization_id = p_organization_id
        and relationship.property_id = requested.property_id
        and relationship.active_primary_count = 1
    )
  ) then
    raise exception 'portfolio knowledge scope is not current for this organization';
  end if;

  return query
  select memory.*
  from public.agent_memory memory
  where memory.property_id = any(p_property_ids)
    and memory.authoring_organization_id = p_organization_id
    and memory.scope = 'property'
    and memory.subject_account_id is null
    and memory.is_active
    and memory.review_state = 'confirmed'
    and (memory.expires_at is null or memory.expires_at > p_as_of)
  order by memory.property_id, memory.updated_at desc, memory.id
  limit p_limit;
end
$$;

comment on column public.agent_memory.authoring_organization_id is
  'Immutable management-company provenance stamped when memory is authored after 0383. Pre-0383 rows remain NULL because current ownership cannot prove historical authorship. Portfolio/company reads require an exact match to the freshly authorized organization. Added 0383.';

revoke all on function public._staxis_stamp_agent_memory_organization()
  from public, anon, authenticated;
revoke all on function public.staxis_portfolio_property_knowledge(uuid, uuid[], timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.staxis_portfolio_property_knowledge(uuid, uuid[], timestamptz, integer)
  to service_role;

insert into public.applied_migrations(version, description)
values (
  '0383',
  'Immutable authoring-company provenance for new property memory; unprovable pre-migration rows remain NULL and company overlays exclude former-company notes after transfer.'
)
on conflict (version) do nothing;

commit;
