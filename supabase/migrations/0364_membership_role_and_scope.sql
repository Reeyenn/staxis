-- 0364_membership_role_and_scope.sql
--
-- THE COMPANY SPINE: a person's job is attached to a person + a scope, not to
-- the person.
--
-- Until now an account had exactly ONE global `accounts.role` plus a flat
-- `accounts.property_access` array. That shape cannot describe a management
-- company: Maria is the GM of Beaumont AND oversees Lufkin/Tyler/Waco; one GM
-- can run two hotels; a finance person sees money at all twenty hotels and
-- nothing else. This migration moves the job onto `organization_memberships`,
-- where each row is ONE HAT — one job, worn over one scope.
--
--   membership_scope = 'company'   -> the hat covers every hotel the company
--                                     operates, INCLUDING hotels added later.
--                                     Coverage is resolved at read time from
--                                     organization_property_relationships, so
--                                     nothing has to be re-stamped when the
--                                     company buys hotel #21.
--   membership_scope = 'property'  -> the hat covers exactly the hotels listed
--                                     in covered_property_ids.
--   membership_scope IS NULL       -> a pre-0364 employment record. Untouched,
--                                     unchanged, and still the row the Company
--                                     Hub grant model in 0325 hangs off.
--
-- ZERO REGRESSION IS THE POINT. Every existing single-hotel account keeps
-- resolving exactly as it does today:
--   * legacy rows keep membership_scope/staxis_role/covered_property_ids NULL
--     and are the only rows the pre-existing one-current-membership unique
--     index applies to (it is re-created below with `staxis_role is null`);
--   * hat rows are FORBIDDEN inside the hidden `single_hotel` compatibility
--     anchors, so every legacy reconcile path in 0325 provably cannot see one;
--   * the role resolver in src/lib/company/access.ts falls back to
--     accounts.role whenever no hat covers the hotel.
--
-- Security model — identical posture to 0325:
--   * deny-all RLS for anon/authenticated; service_role gets SELECT only
--   * every write goes through a SECURITY DEFINER RPC that re-checks the
--     actor's authority inside the same transaction, under the same
--     per-organization advisory lock 0325 uses
--   * the existing audit + epoch trigger on organization_memberships already
--     covers hat rows: no new audit surface, no new way to write unaudited
--
-- @rls: service-role-only — hat rows are authorization facts and are never
-- browser-readable. All reads flow through Next API routes using supabaseAdmin.

-- ─── The two role vocabularies ─────────────────────────────────────────────
--
-- Company-scope hats:  owner | vp | finance
-- Property-scope hats: general_manager | front_desk | housekeeping | maintenance
--
-- The property vocabulary is deliberately the SAME strings as accounts.role so
-- a resolved hat drops into every existing capability check without a mapping
-- table. The two company-only words (vp, finance) do not exist in
-- accounts.role; src/lib/company/roles.ts owns their degradation to a legacy
-- role, and that degradation is least-privilege by construction.

alter table public.organization_memberships
  add column if not exists membership_scope text;
alter table public.organization_memberships
  add column if not exists staxis_role text;
alter table public.organization_memberships
  add column if not exists covered_property_ids uuid[];

comment on column public.organization_memberships.membership_scope is
  'NULL = pre-0364 employment record. company = covers every hotel the org operates, now and later. property = covers exactly covered_property_ids.';
comment on column public.organization_memberships.staxis_role is
  'The hat. NULL for legacy rows. company scope: owner|vp|finance. property scope: general_manager|front_desk|housekeeping|maintenance.';
comment on column public.organization_memberships.covered_property_ids is
  'Property-scope hats only. NULL for company scope (coverage is derived) and for legacy rows.';

alter table public.organization_memberships
  drop constraint if exists organization_memberships_hat_shape_check;
alter table public.organization_memberships
  add constraint organization_memberships_hat_shape_check check (
    -- Legacy employment record: all three columns absent, together.
    (membership_scope is null and staxis_role is null and covered_property_ids is null)
    -- Company hat: coverage is derived, never stored.
    or (membership_scope = 'company'
        and staxis_role in ('owner', 'vp', 'finance')
        and covered_property_ids is null)
    -- Property hat: an explicit, non-empty, null-free list of hotels.
    or (membership_scope = 'property'
        and staxis_role in ('general_manager', 'front_desk', 'housekeeping', 'maintenance')
        and covered_property_ids is not null
        and array_length(covered_property_ids, 1) >= 1
        and array_position(covered_property_ids, null) is null)
  );

-- A hat is only meaningful for a REAL company. The hidden single_hotel anchors
-- created by 0325 mirror accounts.property_access one-for-one; letting a hat
-- land in one of them would put a second, competing answer inside every legacy
-- reconcile path. Enforced by trigger below (a CHECK cannot read another table).

-- ─── Uniqueness: one employment record, one hat per job+scope ──────────────
--
-- 0325's `organization_memberships_one_current_idx` says a person has at most
-- one open membership per organization. That statement is still true — of
-- EMPLOYMENT records. Multi-hat means several open rows, so the index is
-- re-created to see legacy rows only. Its meaning for every row that existed
-- before this migration is byte-identical.

drop index if exists public.organization_memberships_one_current_idx;
create unique index if not exists organization_memberships_one_current_idx
  on public.organization_memberships (organization_id, account_id)
  where ended_at is null and staxis_role is null;

-- One open hat per (person, company, scope, job). Wearing "GM" twice in the
-- same company is not two hats, it is one hat over more hotels — so a repeat
-- edits the covered list instead of stacking a second row.
create unique index if not exists organization_memberships_one_open_hat_idx
  on public.organization_memberships (organization_id, account_id, membership_scope, staxis_role)
  where ended_at is null and staxis_role is not null;

-- The resolver's hot path: "every hat this person is currently wearing".
create index if not exists organization_memberships_open_hats_by_account_idx
  on public.organization_memberships (account_id, organization_id, membership_scope, staxis_role)
  where ended_at is null and staxis_role is not null;

-- ─── Hat validity trigger ──────────────────────────────────────────────────

create or replace function public._staxis_validate_membership_hat()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_missing uuid;
begin
  if new.staxis_role is null then
    return new;
  end if;

  if exists (
    select 1 from public.organizations o
    where o.id = new.organization_id and o.organization_type = 'single_hotel'
  ) then
    raise exception 'a role/scope hat cannot be placed in a single-hotel compatibility anchor'
      using errcode = '42501';
  end if;

  if new.membership_scope = 'property' then
    select candidate into v_missing
    from unnest(new.covered_property_ids) as candidate
    where not exists (
      select 1 from public.organization_property_relationships r
      where r.organization_id = new.organization_id
        and r.property_id = candidate
        and r.starts_at <= now()
        and (r.ends_at is null or r.ends_at > now())
    )
    limit 1;
    if v_missing is not null then
      raise exception 'hotel % is not operated by this company' , v_missing
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public._staxis_validate_membership_hat()
  from public, anon, authenticated;

drop trigger if exists trg_organization_memberships_validate_hat
  on public.organization_memberships;
create trigger trg_organization_memberships_validate_hat
  before insert or update of membership_scope, staxis_role, covered_property_ids, organization_id
  on public.organization_memberships
  for each row execute function public._staxis_validate_membership_hat();

-- ─── Who may hand out a hat ────────────────────────────────────────────────
--
-- Mirrors canGrantHotelRole() in src/lib/roles.ts so a stale UI cannot widen
-- authority: a GM can staff their own hotels but cannot mint a peer GM, an
-- owner, or anything company-wide.

create or replace function public._staxis_can_set_membership_hat(
  p_actor_account_id uuid,
  p_organization_id uuid,
  p_membership_scope text,
  p_staxis_role text,
  p_property_ids uuid[]
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_role text;
begin
  if p_actor_account_id is null or p_organization_id is null then
    return false;
  end if;

  select a.role into v_actor_role
  from public.accounts a
  where a.id = p_actor_account_id and a.active;
  if not found then
    return false;
  end if;

  -- Staxis administrators bootstrap a company before it has an owner.
  if v_actor_role = 'admin' then
    return true;
  end if;

  -- The 0325 Company Hub owner grant is the other bootstrap door: whoever the
  -- organization was created for can staff it before anyone wears a hat.
  if exists (
    select 1
    from public.organization_access_grants g
    join public.organization_memberships m
      on m.id = g.membership_id and m.organization_id = g.organization_id
    where g.organization_id = p_organization_id
      and m.account_id = p_actor_account_id
      and g.access_profile = 'organization_owner'
      and g.scope_type = 'organization'
      and g.status = 'active'
      and g.starts_at <= now()
      and (g.expires_at is null or g.expires_at > now())
      and m.status = 'active'
      and m.starts_at <= now()
      and m.ended_at is null
  ) then
    return true;
  end if;

  -- Company owner: anything inside their own company.
  if exists (
    select 1 from public.organization_memberships m
    where m.organization_id = p_organization_id
      and m.account_id = p_actor_account_id
      and m.status = 'active'
      and m.starts_at <= now()
      and m.ended_at is null
      and m.membership_scope = 'company'
      and m.staxis_role = 'owner'
  ) then
    return true;
  end if;

  -- Company VP: may staff hotels and hire finance, but cannot create a peer VP
  -- or an owner — those are company-authority tiers.
  if exists (
    select 1 from public.organization_memberships m
    where m.organization_id = p_organization_id
      and m.account_id = p_actor_account_id
      and m.status = 'active'
      and m.starts_at <= now()
      and m.ended_at is null
      and m.membership_scope = 'company'
      and m.staxis_role = 'vp'
  ) then
    return p_membership_scope = 'property'
      or (p_membership_scope = 'company' and p_staxis_role = 'finance');
  end if;

  -- GM: line staff, at hotels they already cover, and nowhere else.
  if p_membership_scope = 'property'
     and p_staxis_role in ('front_desk', 'housekeeping', 'maintenance')
     and p_property_ids is not null
     and exists (
       select 1 from public.organization_memberships m
       where m.organization_id = p_organization_id
         and m.account_id = p_actor_account_id
         and m.status = 'active'
         and m.starts_at <= now()
         and m.ended_at is null
         and m.membership_scope = 'property'
         and m.staxis_role = 'general_manager'
         and m.covered_property_ids @> p_property_ids
     ) then
    return true;
  end if;

  return false;
end;
$$;

revoke all on function public._staxis_can_set_membership_hat(uuid, uuid, text, text, uuid[])
  from public, anon, authenticated;
grant execute on function public._staxis_can_set_membership_hat(uuid, uuid, text, text, uuid[])
  to service_role;

-- ─── Put a hat on / take a hat off ─────────────────────────────────────────

-- `p_property_ids` is jsonb, not uuid[], on purpose: PostgREST hands a JSON
-- array straight through to a jsonb parameter, whereas a uuid[] parameter
-- depends on every client between here and the browser agreeing on Postgres
-- array-literal syntax. One less thing that can be subtly wrong per transport.
drop function if exists public.staxis_set_membership_hat(uuid, uuid, uuid, text, text, uuid[], text);
create or replace function public.staxis_set_membership_hat(
  p_actor_account_id uuid,
  p_organization_id uuid,
  p_account_id uuid,
  p_membership_scope text,
  p_staxis_role text,
  p_property_ids jsonb default null,
  p_job_title text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_membership_id uuid;
  v_job_category text;
  v_property_ids uuid[];
begin
  if p_membership_scope not in ('company', 'property') then
    raise exception 'membership scope must be company or property' using errcode = '22023';
  end if;

  if p_property_ids is not null and jsonb_typeof(p_property_ids) <> 'array' then
    raise exception 'the chosen hotels must be a list' using errcode = '22023';
  end if;
  if p_property_ids is not null then
    select array_agg(distinct (element #>> '{}')::uuid)
      into v_property_ids
      from jsonb_array_elements(p_property_ids) as element;
  end if;

  perform public._staxis_lock_organization(p_organization_id);

  if not public._staxis_can_set_membership_hat(
    p_actor_account_id, p_organization_id, p_membership_scope, p_staxis_role, v_property_ids
  ) then
    raise exception 'actor may not grant this job at this scope' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.accounts a where a.id = p_account_id and a.active
  ) then
    raise exception 'target account is not active' using errcode = '42501';
  end if;

  -- Descriptive only. Authority lives in staxis_role; job_category exists so
  -- the 0325 Company Hub directory keeps rendering a sensible label.
  v_job_category := case p_staxis_role
    when 'owner' then 'owner_principal'
    when 'vp' then 'regional_manager'
    when 'finance' then 'finance'
    when 'general_manager' then 'general_manager'
    else 'hotel_employee'
  end;

  select m.id into v_membership_id
  from public.organization_memberships m
  where m.organization_id = p_organization_id
    and m.account_id = p_account_id
    and m.membership_scope = p_membership_scope
    and m.staxis_role = p_staxis_role
    and m.ended_at is null
  for update;

  if v_membership_id is null then
    insert into public.organization_memberships (
      organization_id, account_id, job_category, job_title, status,
      membership_scope, staxis_role, covered_property_ids,
      created_by_account_id, updated_by_account_id
    ) values (
      p_organization_id, p_account_id, v_job_category, p_job_title, 'active',
      p_membership_scope, p_staxis_role,
      case when p_membership_scope = 'property' then v_property_ids else null end,
      p_actor_account_id, p_actor_account_id
    )
    returning id into v_membership_id;
  else
    -- Same job, same scope: this is the SAME hat over a different set of
    -- hotels, not a second hat.
    update public.organization_memberships m
       set covered_property_ids =
             case when p_membership_scope = 'property' then v_property_ids else null end,
           job_title = coalesce(p_job_title, m.job_title),
           updated_by_account_id = p_actor_account_id
     where m.id = v_membership_id;
  end if;

  return v_membership_id;
end;
$$;

revoke all on function public.staxis_set_membership_hat(uuid, uuid, uuid, text, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.staxis_set_membership_hat(uuid, uuid, uuid, text, text, jsonb, text)
  to service_role;

-- Removing a hat removes EXACTLY that hat. The person's other jobs, and their
-- legacy employment record, are untouched.
create or replace function public.staxis_end_membership_hat(
  p_actor_account_id uuid,
  p_membership_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hat public.organization_memberships%rowtype;
begin
  select m.organization_id into v_hat.organization_id
  from public.organization_memberships m
  where m.id = p_membership_id;
  if not found then
    return false;
  end if;

  perform public._staxis_lock_organization(v_hat.organization_id);

  select * into v_hat
  from public.organization_memberships m
  where m.id = p_membership_id and m.ended_at is null
  for update;
  if not found then
    return false;
  end if;

  if v_hat.staxis_role is null then
    raise exception 'staxis_end_membership_hat only ends role/scope hats'
      using errcode = '22023';
  end if;

  if not public._staxis_can_set_membership_hat(
    p_actor_account_id, v_hat.organization_id, v_hat.membership_scope,
    v_hat.staxis_role, v_hat.covered_property_ids
  ) then
    raise exception 'actor may not remove this job' using errcode = '42501';
  end if;

  update public.organization_memberships m
     set status = 'revoked',
         ended_at = clock_timestamp(),
         updated_by_account_id = p_actor_account_id
   where m.id = p_membership_id;

  return true;
end;
$$;

revoke all on function public.staxis_end_membership_hat(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.staxis_end_membership_hat(uuid, uuid)
  to service_role;

-- ─── The invitation carries the hat ────────────────────────────────────────
--
-- One invite system (0064 + 0315 era). Rather than a second invitation table
-- for company people, the existing `account_invites` row learns the scope it
-- was sent for. A NULL scope is a pre-0364 hotel invite and behaves exactly as
-- it always has.

alter table public.account_invites
  add column if not exists organization_id uuid references public.organizations(id) on delete cascade;
alter table public.account_invites
  add column if not exists membership_scope text;
alter table public.account_invites
  add column if not exists covered_property_ids uuid[];

-- vp and finance are company words that accounts.role has never had. The
-- invitation may carry them; acceptance degrades them to a legacy role for the
-- accounts row and puts the true word on the hat.
alter table public.account_invites
  drop constraint if exists account_invites_role_check;
do $migration$
declare
  constraint_name text;
begin
  for constraint_name in
    select c.conname from pg_constraint c
    where c.conrelid = 'public.account_invites'::regclass
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%role%general_manager%'
  loop
    execute format('alter table public.account_invites drop constraint %I', constraint_name);
  end loop;
end;
$migration$;
alter table public.account_invites
  add constraint account_invites_role_check check (
    role in (
      'owner', 'general_manager', 'front_desk', 'housekeeping', 'maintenance',
      'vp', 'finance'
    )
  );

alter table public.account_invites
  drop constraint if exists account_invites_hat_shape_check;
alter table public.account_invites
  add constraint account_invites_hat_shape_check check (
    (membership_scope is null and organization_id is null and covered_property_ids is null)
    or (membership_scope = 'company'
        and organization_id is not null
        and covered_property_ids is null
        and role in ('owner', 'vp', 'finance'))
    or (membership_scope = 'property'
        and organization_id is not null
        and covered_property_ids is not null
        and array_length(covered_property_ids, 1) >= 1
        and array_position(covered_property_ids, null) is null
        and role in ('general_manager', 'front_desk', 'housekeeping', 'maintenance'))
  );

create index if not exists account_invites_organization_idx
  on public.account_invites (organization_id)
  where organization_id is not null;

-- ─── Permissions / RLS — unchanged posture, restated for the new surface ───

alter table public.organization_memberships enable row level security;
revoke all on public.organization_memberships from public, anon, authenticated;
revoke all on public.organization_memberships from service_role;
grant select on public.organization_memberships to service_role;

drop policy if exists organization_memberships_deny_browser on public.organization_memberships;
create policy organization_memberships_deny_browser on public.organization_memberships
  for all to anon, authenticated using (false) with check (false);

-- ─── One repaired lookup in the 0325 acceptance RPC ────────────────────────
--
-- `staxis_accept_organization_invitation` finds "this person's membership in
-- this company" with a bare SELECT ... INTO, which in PL/pgSQL silently takes
-- the FIRST row. Before 0364 there could only ever be one. Now there can be
-- several, and picking a hat row would hang a Company Hub grant off a job
-- instead of off the employment record. The function below is byte-identical
-- to 0325's except for the two added lines marked `0364`.

create or replace function public.staxis_accept_organization_invitation(
  p_token_hash text,
  p_account_id uuid
)
returns table (membership_id uuid, grant_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invitation public.organization_invitations%rowtype;
  v_account_email text;
  v_account_role text;
  v_membership_id uuid;
  v_grant_id uuid;
begin
  select i.organization_id, i.invited_by_account_id
    into v_invitation.organization_id, v_invitation.invited_by_account_id
  from public.organization_invitations i
  where i.token_hash = lower(btrim(p_token_hash));
  if not found then
    raise exception 'invitation is invalid, expired, or already used'
      using errcode = '22023';
  end if;

  -- Account deactivation takes an account-row lock before the organization
  -- guard runs, so invitation acceptance uses the same account -> organization
  -- order. Lock both identities in UUID order to keep cross-invitation cases
  -- deterministic and ensure neither can be disabled mid-acceptance.
  perform 1
  from public.accounts locked_account
  where locked_account.id in (p_account_id, v_invitation.invited_by_account_id)
  order by locked_account.id
  for share;
  perform public._staxis_lock_organization(v_invitation.organization_id);
  select i.* into v_invitation
  from public.organization_invitations i
  where i.token_hash = lower(btrim(p_token_hash))
  for update;
  if v_invitation.status <> 'pending'
     or v_invitation.expires_at <= now() then
    raise exception 'invitation is invalid, expired, or already used'
      using errcode = '22023';
  end if;

  select lower(u.email), a.role into v_account_email, v_account_role
  from public.accounts a
  join auth.users u on u.id = a.data_user_id
  where a.id = p_account_id and a.active;
  if v_account_email is null or v_account_email <> v_invitation.email then
    raise exception 'invitation email does not match the authenticated account'
      using errcode = '42501';
  end if;
  if v_account_role = 'admin' then
    raise exception 'Staxis administrators cannot accept customer organization invitations'
      using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.organizations o
    where o.id = v_invitation.organization_id
      and o.status = 'active'
      and o.organization_type <> 'single_hotel'
  ) then
    raise exception 'invitation organization is not active' using errcode = '23514';
  end if;
  if v_invitation.scope_type = 'portfolio' and not exists (
    select 1 from public.portfolios p
    where p.id = v_invitation.portfolio_id and p.organization_id = v_invitation.organization_id
      and p.status = 'active'
  ) then
    raise exception 'invited portfolio is no longer active' using errcode = '23514';
  elsif v_invitation.scope_type = 'property' and not exists (
    select 1 from public.organization_property_relationships r
    where r.id = v_invitation.property_relationship_id
      and r.organization_id = v_invitation.organization_id
      and r.property_id = v_invitation.property_id
      and r.starts_at <= now() and (r.ends_at is null or r.ends_at > now())
  ) then
    raise exception 'invited property relationship is no longer active'
      using errcode = '23514';
  end if;

  -- Authority is evaluated again at acceptance, not frozen at send time. A
  -- revoked/demoted inviter or a scope that moved since the email was sent can
  -- never mint access from a stale invitation.
  if not (
    (
      v_invitation.scope_type = 'organization'
      and v_invitation.access_profile in ('organization_owner', 'organization_admin')
      and exists (
        select 1 from public.accounts bootstrap_sponsor
        where bootstrap_sponsor.id = v_invitation.invited_by_account_id
          and bootstrap_sponsor.role = 'admin'
          and bootstrap_sponsor.active
      )
    )
    or public._staxis_can_delegate_organization_access(
      v_invitation.invited_by_account_id,
      v_invitation.organization_id,
      v_invitation.access_profile,
      v_invitation.scope_type,
      v_invitation.portfolio_id,
      v_invitation.property_id
    )
  ) then
    raise exception 'inviter no longer has authority for this profile or scope'
      using errcode = '42501';
  end if;

  perform set_config('staxis.actor_account_id', p_account_id::text, true);
  select m.id into v_membership_id
  from public.organization_memberships m
  where m.organization_id = v_invitation.organization_id
    and m.account_id = p_account_id
    and m.ended_at is null
    -- 0364: never adopt a role/scope hat row as the person's employment record.
    and m.staxis_role is null
  for update;

  if v_membership_id is null then
    insert into public.organization_memberships (
      organization_id, account_id, job_category, job_title, status,
      created_by_account_id
    ) values (
      v_invitation.organization_id, p_account_id, v_invitation.job_category,
      v_invitation.job_title, 'active', v_invitation.invited_by_account_id
    ) returning id into v_membership_id;
  elsif not exists (
    select 1 from public.organization_memberships m
    where m.id = v_membership_id and m.status = 'active'
  ) then
    raise exception 'existing organization membership is suspended'
      using errcode = '42501';
  end if;

  update public.organization_access_grants expired_grant
     set status = 'revoked',
         revoked_at = clock_timestamp(),
         revoked_by_account_id = p_account_id,
         revocation_reason = 'Expired grant closed before invitation renewal',
         version = version + 1
   where expired_grant.membership_id = v_membership_id
     and expired_grant.access_profile = v_invitation.access_profile
     and expired_grant.scope_type = v_invitation.scope_type
     and expired_grant.portfolio_id is not distinct from v_invitation.portfolio_id
     and expired_grant.property_id is not distinct from v_invitation.property_id
     and expired_grant.status = 'active'
     and expired_grant.expires_at is not null
     and expired_grant.expires_at <= now();

  select g.id into v_grant_id
  from public.organization_access_grants g
  where g.membership_id = v_membership_id
    and g.access_profile = v_invitation.access_profile
    and g.scope_type = v_invitation.scope_type
    and g.portfolio_id is not distinct from v_invitation.portfolio_id
    and g.property_id is not distinct from v_invitation.property_id
    and g.property_relationship_id is not distinct from v_invitation.property_relationship_id
    and g.status = 'active'
  limit 1;

  if v_grant_id is null then
    insert into public.organization_access_grants (
      organization_id, membership_id, access_profile, scope_type,
      portfolio_id, property_relationship_id, property_id,
      expires_at, source, granted_by_account_id
    ) values (
      v_invitation.organization_id, v_membership_id,
      v_invitation.access_profile, v_invitation.scope_type,
      v_invitation.portfolio_id, v_invitation.property_relationship_id,
      v_invitation.property_id, v_invitation.grant_expires_at,
      'invitation', v_invitation.invited_by_account_id
    ) returning id into v_grant_id;
  else
    -- Accepting an invitation with the same profile/scope renews the existing
    -- fact to the invitation's explicit expiry instead of silently accepting
    -- the invite while leaving stale terms in force.
    update public.organization_access_grants g
       set starts_at = least(g.starts_at, clock_timestamp()),
           expires_at = v_invitation.grant_expires_at,
           source = 'invitation',
           granted_by_account_id = v_invitation.invited_by_account_id,
           version = g.version + 1
     where g.id = v_grant_id
       and (
         g.expires_at is distinct from v_invitation.grant_expires_at
         or g.source <> 'invitation'
         or g.granted_by_account_id is distinct from v_invitation.invited_by_account_id
         or g.starts_at > now()
       );
  end if;

  update public.organization_invitations
     set status = 'accepted', accepted_at = clock_timestamp(),
         accepted_by_membership_id = v_membership_id
   where id = v_invitation.id;

  return query select v_membership_id, v_grant_id;
end;
$$;

revoke all on function public.staxis_accept_organization_invitation(text, uuid)
  from public, anon, authenticated;
grant execute on function public.staxis_accept_organization_invitation(text, uuid)
  to service_role;

-- ─── One repaired ON CONFLICT in the 0325 legacy reconciler ───────────────
--
-- The reconciler that keeps every single-hotel account mirrored into the
-- shadow model UPSERTs its employment record using
-- `organization_memberships_one_current_idx` as the arbiter, named by predicate.
-- That index now excludes hat rows, so the predicate in the ON CONFLICT clause
-- has to say the same thing or Postgres cannot infer the index at all — which
-- would break every property and account INSERT in the product. Byte-identical
-- to 0325 except the two words marked `0364`.

create or replace function public._staxis_reconcile_legacy_organization_access(
  p_property_id uuid default null,
  p_actor_account_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_anchor record;
  v_delta integer;
  v_organizations integer := 0;
  v_relationships integer := 0;
  v_memberships integer := 0;
  v_grants integer := 0;
  v_staff_links integer := 0;
begin
  perform set_config(
    'staxis.actor_account_id',
    coalesce(p_actor_account_id::text, ''),
    true
  );

  insert into public.organizations (
    name, organization_type, status, legacy_property_id, created_by_account_id
  )
  select p.name, 'single_hotel', 'active', p.id, p_actor_account_id
  from public.properties p
  where p_property_id is null or p.id = p_property_id
  on conflict (legacy_property_id) do nothing;
  get diagnostics v_organizations = row_count;

  for v_anchor in
    select o.id as organization_id, o.legacy_property_id as property_id
    from public.organizations o
    where o.organization_type = 'single_hotel'
      and o.legacy_property_id is not null
      and (p_property_id is null or o.legacy_property_id = p_property_id)
    order by o.legacy_property_id
  loop
    perform 1 from public.properties p
      where p.id = v_anchor.property_id for update;
    perform public._staxis_lock_organization(v_anchor.organization_id);

    insert into public.organization_property_relationships (
      organization_id, property_id, relationship_type, is_primary_grouping,
      created_by_account_id, updated_by_account_id
    )
    select
      v_anchor.organization_id,
      v_anchor.property_id,
      'operator',
      not exists (
        select 1 from public.organization_property_relationships current_primary
        where current_primary.property_id = v_anchor.property_id
          and current_primary.is_primary_grouping
          and current_primary.ends_at is null
      ),
      p_actor_account_id,
      p_actor_account_id
    where not exists (
      select 1 from public.organization_property_relationships existing_anchor
      where existing_anchor.organization_id = v_anchor.organization_id
        and existing_anchor.property_id = v_anchor.property_id
        and existing_anchor.ends_at is null
    )
    on conflict do nothing;
    get diagnostics v_delta = row_count;
    v_relationships := v_relationships + v_delta;

    update public.organization_property_relationships anchor_relationship
       set is_primary_grouping = true,
           updated_by_account_id = p_actor_account_id
     where anchor_relationship.organization_id = v_anchor.organization_id
       and anchor_relationship.property_id = v_anchor.property_id
       and anchor_relationship.ends_at is null
       and not anchor_relationship.is_primary_grouping
       and not exists (
         select 1 from public.organization_property_relationships current_primary
         where current_primary.property_id = v_anchor.property_id
           and current_primary.is_primary_grouping
           and current_primary.ends_at is null
       );

    insert into public.organization_memberships (
      organization_id, account_id, job_category, job_title, status,
      created_by_account_id
    )
    select
      v_anchor.organization_id,
      a.id,
      case a.role
        when 'owner' then 'owner_principal'
        when 'general_manager' then 'general_manager'
        when 'front_desk' then 'hotel_employee'
        when 'housekeeping' then 'hotel_employee'
        when 'maintenance' then 'hotel_employee'
        else 'other'
      end,
      case a.role
        when 'owner' then 'Owner'
        when 'general_manager' then 'General Manager'
        when 'front_desk' then 'Front Desk'
        when 'housekeeping' then 'Housekeeping'
        when 'maintenance' then 'Maintenance'
        else 'Staff'
      end,
      'active',
      p_actor_account_id
    from public.accounts a
    where a.role <> 'admin'
      and v_anchor.property_id = any(coalesce(a.property_access, '{}'::uuid[]))
    -- 0364: the arbiter index now excludes role/scope hat rows, so this
    -- inference has to name the same predicate. The set of rows it can touch
    -- is byte-identical to before — hats did not exist when it was written.
    on conflict (organization_id, account_id)
      where ended_at is null and staxis_role is null do update
      set job_category = excluded.job_category,
          job_title = excluded.job_title,
          updated_by_account_id = coalesce(
            excluded.updated_by_account_id,
            organization_memberships.updated_by_account_id
          )
      -- A normalized suspension is an explicit customer-company decision.
      -- Legacy hotel reconciliation may refresh the descriptive fields of its
      -- own active membership, but must never resurrect a suspended member or
      -- overwrite metadata supplied by an invitation/request grant.
      where organization_memberships.status = 'active'
        and organization_memberships.ended_at is null
        and not exists (
          select 1
          from public.organization_access_grants explicit_grant
          where explicit_grant.membership_id = organization_memberships.id
            and explicit_grant.source <> 'legacy_backfill'
        )
        and (
          organization_memberships.job_category is distinct from excluded.job_category
          or organization_memberships.job_title is distinct from excluded.job_title
        );
    get diagnostics v_delta = row_count;
    v_memberships := v_memberships + v_delta;

    insert into public.organization_access_grants (
      organization_id, membership_id, access_profile, scope_type,
      property_relationship_id, property_id, source, granted_by_account_id
    )
    select
      m.organization_id,
      m.id,
      case a.role
        when 'owner' then 'organization_owner'
        when 'general_manager' then 'property_manager'
        else 'contributor'
      end,
      case when a.role = 'owner' then 'organization' else 'property' end,
      case when a.role = 'owner' then null else relationship.id end,
      case when a.role = 'owner' then null else relationship.property_id end,
      'legacy_backfill',
      p_actor_account_id
    from public.organization_memberships m
    join public.accounts a on a.id = m.account_id and a.role <> 'admin'
    join lateral (
      select r.id, r.property_id
      from public.organization_property_relationships r
      where r.organization_id = v_anchor.organization_id
        and r.property_id = v_anchor.property_id
        and r.starts_at <= now()
        and (r.ends_at is null or r.ends_at > now())
      order by r.is_primary_grouping desc, r.starts_at desc
      limit 1
    ) relationship on true
    where m.organization_id = v_anchor.organization_id
      and m.status = 'active'
      and m.ended_at is null
      and v_anchor.property_id = any(coalesce(a.property_access, '{}'::uuid[]))
    on conflict do nothing;
    get diagnostics v_delta = row_count;
    v_grants := v_grants + v_delta;

    with ranked_staff_links as (
      select a.id as account_id, s.property_id, s.id as staff_id,
             row_number() over (
               partition by s.id order by a.created_at, a.id
             ) as staff_rank
      from public.accounts a
      join public.staff s on s.id = a.staff_id
      where s.property_id = v_anchor.property_id
        and a.role <> 'admin'
        and v_anchor.property_id = any(coalesce(a.property_access, '{}'::uuid[]))
    )
    insert into public.account_property_staff_links (
      account_id, property_id, staff_id, source, linked_by_account_id
    )
    select account_id, property_id, staff_id, 'legacy_backfill', p_actor_account_id
    from ranked_staff_links
    where staff_rank = 1
    on conflict (account_id, property_id) do update
      set staff_id = excluded.staff_id,
          is_active = true,
          linked_by_account_id = coalesce(
            excluded.linked_by_account_id,
            account_property_staff_links.linked_by_account_id
          ),
          linked_at = case
            when account_property_staff_links.staff_id is distinct from excluded.staff_id
              then now()
            else account_property_staff_links.linked_at
          end,
          deactivated_at = null,
          deactivated_by_account_id = null
      where account_property_staff_links.source = 'legacy_backfill'
        and not exists (
        select 1
        from public.account_property_staff_links active_link
        where active_link.staff_id = excluded.staff_id
          and active_link.is_active
          and active_link.account_id <> excluded.account_id
      )
        and (
          not account_property_staff_links.is_active
          or account_property_staff_links.staff_id is distinct from excluded.staff_id
          or account_property_staff_links.deactivated_at is not null
          or account_property_staff_links.deactivated_by_account_id is not null
        );
    get diagnostics v_delta = row_count;
    v_staff_links := v_staff_links + v_delta;
  end loop;

  return jsonb_build_object(
    'organizations', v_organizations,
    'relationships', v_relationships,
    'memberships', v_memberships,
    'grants', v_grants,
    'staff_links', v_staff_links
  );
end;
$$;

revoke all on function public._staxis_reconcile_legacy_organization_access(uuid, uuid)
  from public, anon, authenticated;

insert into public.applied_migrations (version, description)
values ('0364', 'a person''s job attaches to a person + a scope, not to a person')
on conflict (version) do nothing;
