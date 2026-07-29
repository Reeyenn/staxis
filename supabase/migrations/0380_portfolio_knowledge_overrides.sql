-- 0380_portfolio_knowledge_overrides.sql
-- Explicit provenance for the narrow case where a confirmed hotel fact
-- intentionally overrides one confirmed company rulebook fact. Similar text
-- never implies precedence; absent this link, the portfolio overlay reports a
-- conflict and abstains.

begin;

alter table public.agent_memory
  add column if not exists overrides_company_fact_id uuid
    references public.company_knowledge(id) on delete set null,
  add column if not exists override_organization_id uuid
    references public.organizations(id) on delete set null;

alter table public.agent_memory
  drop constraint if exists agent_memory_company_override_shape_ck;
alter table public.agent_memory
  add constraint agent_memory_company_override_shape_ck check (
    (overrides_company_fact_id is null and override_organization_id is null)
    or (
      overrides_company_fact_id is not null
      and override_organization_id is not null
      and scope = 'property'
      and subject_account_id is null
      and review_state = 'confirmed'
    )
  );

create or replace function public._staxis_validate_property_company_override()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.overrides_company_fact_id is null then return new; end if;
  if not exists (
    select 1
    from public.company_knowledge knowledge
    where knowledge.id = new.overrides_company_fact_id
      and knowledge.organization_id = new.override_organization_id
      and knowledge.is_active
      and knowledge.review_state = 'confirmed'
  ) then
    raise exception 'override target is not a current confirmed fact in that organization';
  end if;
  if not exists (
    select 1
    from public._staxis_current_primary_property_relationships() relationship
    where relationship.organization_id = new.override_organization_id
      and relationship.property_id = new.property_id
      and relationship.active_primary_count = 1
  ) then
    raise exception 'override organization is not the current primary owner/operator of this property';
  end if;
  return new;
end
$$;

drop trigger if exists agent_memory_validate_company_override on public.agent_memory;
create trigger agent_memory_validate_company_override
  before insert or update of overrides_company_fact_id, override_organization_id, property_id,
    scope, subject_account_id, review_state
  on public.agent_memory
  for each row execute function public._staxis_validate_property_company_override();

create index if not exists agent_memory_company_override_idx
  on public.agent_memory(override_organization_id, overrides_company_fact_id)
  where overrides_company_fact_id is not null and is_active;

comment on column public.agent_memory.overrides_company_fact_id is
  'Explicit, human-governed provenance link: this confirmed property fact overrides exactly this confirmed company fact. Text similarity never creates the link. Added 0380.';
comment on column public.agent_memory.override_organization_id is
  'Organization that owned the override decision. The read path requires it to equal the freshly authorized organization, so a hotel transfer cannot carry old-company precedence. Added 0380.';

revoke all on function public._staxis_validate_property_company_override() from public, anon, authenticated;

insert into public.applied_migrations(version, description)
values (
  '0380',
  'Explicit company-fact override provenance on confirmed property memory, with current primary owner/operator organization validation. No text-derived precedence.'
)
on conflict (version) do nothing;

commit;
