-- ═══════════════════════════════════════════════════════════════════════════
-- 0370 — Make the tenant key travel with the link, and make a hat land only on
--        somebody who already belongs to the company.
--
-- Three findings from the walls/injection red-team pass, all of the same shape:
-- a rule the code follows carefully that the DATABASE does not know about.
--
-- ── 1. A LINK THAT FORGETS WHICH HOTEL IT IS IN ────────────────────────────
-- `finding_actions.finding_id` (0363), `work_orders.preventive_task_id` (0366)
-- and `agent_knowledge_questions.equipment_id` (0368) each carry a tenant key
-- of their own AND a foreign key to a row that carries a DIFFERENT tenant key,
-- and nothing checks that the two agree. The FK says "some findings row
-- exists"; it never says "…at THIS hotel".
--
-- That is theoretical on three of these tables, which are service-role-only.
-- It is not theoretical on `work_orders`: that table grants DML to
-- `authenticated`, so a signed-in user at hotel A could write a work order in
-- hotel A pointing at hotel B's upkeep schedule — and closing it would stamp
-- hotel B's schedule as done, through the 0366 trigger, from outside hotel B.
-- The wall would have been crossed by a write that never mentioned hotel B.
--
-- The fix is a COMPOSITE foreign key: `(child.property_id, child.parent_id)`
-- references `(parent.property_id, parent.id)`. Postgres then refuses the
-- mismatch itself, on every path, forever — no trigger to be dropped, no
-- application filter to be forgotten, and it costs nothing at read time.
-- Composite FKs need a matching unique key on the parent, which section 1a
-- adds; those are also useful indexes for exactly the joins these links imply.
--
-- Six links are repaired, not the three the review named. The other three
-- (`work_orders.equipment_id`, `preventive_tasks.equipment_id`,
-- `agent_knowledge_questions.finding_id`) are the identical mistake against the
-- identical parents, need no additional unique keys, and leaving a known hole
-- open because nobody had probed it yet is how the first three got here.
--
-- The single-column FKs are kept alongside. They are redundant for integrity
-- and they are NOT redundant for `on delete` behaviour on rows whose parent
-- link is nullable: dropping them would change what happens when a parent is
-- deleted. Two constraints, each doing its own job.
--
-- ── 2. A HAT COULD LAND ON A STRANGER ──────────────────────────────────────
-- `staxis_set_membership_hat` validated the TARGET only as "an active account".
-- Not a member of this company, not invited to it, not even excluded if they
-- were a Staxis administrator — while the INVITATION path four hundred lines
-- below it checks all three. So an owner or VP holding a valid session could
-- attach a job at their company to any account id in the product, including one
-- belonging to a different company's staff, and that account would silently
-- gain access to their hotels and appear on their team lists.
--
-- Two rules are added, and the grant matrix `_staxis_can_set_membership_hat`
-- enforces is untouched — every one of its refusals still refuses:
--
--   (a) THE TARGET MUST ALREADY BELONG HERE. A membership row in this
--       organization (a hat, or a plain 0325 employment record), or an
--       invitation addressed to them in either invitation table. A Staxis
--       administrator acting is exempt, because bootstrapping a company before
--       it has any members is precisely what an administrator is for — the same
--       exemption the authority check already makes at its top.
--
--       ONE BEHAVIOUR CHANGES for a legitimate flow, deliberately: an owner or
--       VP can no longer hand a job at their company straight to somebody who
--       works for a DIFFERENT company. That was possible, and it read as
--       "one GM runs hotels for two groups" — but it is also exactly the shape
--       of the hole, since the id is unbounded and the target is never told.
--       Invite them, then give them the second job.
--
--   (b) NOBODY MAY ATTACH A JOB TO SOMEONE ABOVE THEM. The authority check asks
--       only "may you GRANT this job?", never "may you touch THIS PERSON?", so
--       a GM could put a housekeeping hat on the company's owner. Stated
--       generally: if the target already holds a job in this company that the
--       actor could not have granted, the actor may not add to that person at
--       all. That single rule gives a GM no reach over a GM/finance/VP/owner, a
--       VP none over a VP or an owner, and leaves an owner and an administrator
--       able to do everything they could before.
--
-- Staxis admins are also refused as TARGETS, matching
-- `staxis_accept_organization_invitation` and the 0325 guard trigger.
--
-- ── 3. A SCHEDULE NAME WITH NO CEILING ─────────────────────────────────────
-- `preventive_tasks.name` had no length limit on the column, in the form, or at
-- the prompt boundary. It is quoted six times into every card the preventive
-- detector writes, and those cards go to the nightly judge in one batched model
-- call, so one pasted document in that text box is a truncated batch and
-- somebody else's spend cap. 120 characters — the same limit `equipment.name`
-- already has in the API and in 0368's CHECK, because they are the same kind of
-- thing and two limits for one kind of thing is a limit somebody picks wrong.
--
-- VERIFIED AGAINST PRODUCTION BEFORE WRITING: zero rows violate any constraint
-- below (six cross-tenant link checks, both name checks — all returned 0).
--
-- Manual prod apply (project_migration_application_manual.md). Idempotent.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1a. Unique keys the composite FKs reference ────────────────────────────
-- `(property_id, id)` rather than `(id, property_id)`: `id` is already unique on
-- its own, so the extra index earns its keep only if the tenant key leads —
-- which makes it usable for "everything of this kind at this hotel" scans too.
create unique index if not exists findings_property_id_uq
  on public.findings (property_id, id);
create unique index if not exists preventive_tasks_property_id_uq
  on public.preventive_tasks (property_id, id);
create unique index if not exists equipment_property_id_uq
  on public.equipment (property_id, id);

-- ── 1b. The composite foreign keys ─────────────────────────────────────────
--
-- `on delete` is chosen to MATCH the single-column FK already on each column,
-- so the pair never disagrees about what happens when a parent goes away:
--   finding_actions.finding_id            cascade   (0363)
--   work_orders.preventive_task_id        set null  (0366)
--   work_orders.equipment_id              set null  (0249)
--   preventive_tasks.equipment_id         set null  (0249)
--   agent_knowledge_questions.finding_id  set null  (0362)
--   agent_knowledge_questions.equipment_id set null (0368)
--
-- A composite SET NULL nulls BOTH columns of the referencing pair, which would
-- null `property_id` — a NOT NULL tenant key — and error. So the nullable links
-- use ON DELETE NO ACTION here and keep their cascade behaviour on the
-- single-column FK, which is the constraint that actually fires on a parent
-- delete. The composite one exists to refuse a bad INSERT/UPDATE, and it does
-- that regardless of its delete rule.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'finding_actions_finding_same_property_fk'
  ) then
    alter table public.finding_actions
      add constraint finding_actions_finding_same_property_fk
      foreign key (property_id, finding_id)
      references public.findings (property_id, id)
      on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'work_orders_preventive_task_same_property_fk'
  ) then
    alter table public.work_orders
      add constraint work_orders_preventive_task_same_property_fk
      foreign key (property_id, preventive_task_id)
      references public.preventive_tasks (property_id, id);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'work_orders_equipment_same_property_fk'
  ) then
    alter table public.work_orders
      add constraint work_orders_equipment_same_property_fk
      foreign key (property_id, equipment_id)
      references public.equipment (property_id, id);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'preventive_tasks_equipment_same_property_fk'
  ) then
    alter table public.preventive_tasks
      add constraint preventive_tasks_equipment_same_property_fk
      foreign key (property_id, equipment_id)
      references public.equipment (property_id, id);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'agent_knowledge_questions_finding_same_property_fk'
  ) then
    alter table public.agent_knowledge_questions
      add constraint agent_knowledge_questions_finding_same_property_fk
      foreign key (property_id, finding_id)
      references public.findings (property_id, id);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'agent_knowledge_questions_equipment_same_property_fk'
  ) then
    alter table public.agent_knowledge_questions
      add constraint agent_knowledge_questions_equipment_same_property_fk
      foreign key (property_id, equipment_id)
      references public.equipment (property_id, id);
  end if;
end $$;

comment on constraint work_orders_preventive_task_same_property_fk on public.work_orders is
  'The upkeep schedule a ticket came from must belong to the SAME hotel as the ticket. work_orders grants DML to authenticated, so without this a signed-in user at hotel A could point a ticket at hotel B''s schedule and stamp it done through the 0366 close trigger. Added 0370.';

-- ── 2. Who a hat may be put on ─────────────────────────────────────────────
--
-- Signature, argument order and return value are unchanged, so every caller —
-- the /api/auth/team/hats route, grantInvitedHat, and the test fixtures — is
-- unaffected except where it was doing one of the two things now refused.
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
  v_actor_is_staxis_admin boolean;
  v_target_email text;
  v_existing record;
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

  -- A Staxis administrator is a separate realm and never wears a customer hat.
  -- The 0325 guard trigger refuses the row and
  -- `staxis_accept_organization_invitation` refuses the invitation; this says
  -- the same thing at the third door, in the same words.
  if exists (
    select 1 from public.accounts a where a.id = p_account_id and a.role = 'admin'
  ) then
    raise exception 'Staxis administrators cannot hold a customer organization job'
      using errcode = '42501';
  end if;

  select coalesce(a.role = 'admin', false) into v_actor_is_staxis_admin
  from public.accounts a where a.id = p_actor_account_id;

  select lower(u.email) into v_target_email
  from public.accounts a
  join auth.users u on u.id = a.data_user_id
  where a.id = p_account_id;

  -- (a) The target must already belong to this company. An administrator
  --     bootstrapping a company is exempt — before the first hat exists there
  --     is nobody to be a member, which is the whole reason that door is open.
  --
  --     THREE DOORS COUNT, because the product has three and refusing one of
  --     them would strand a real new hire at the login screen:
  --       * a membership row here (a hat, or a plain 0325 employment record);
  --       * an `account_invites` row — the Staxis-native invitation, which is
  --         what /api/auth/accept-invite consumes and then mints the hat from.
  --         Deliberately NOT filtered on `accepted_at`: that flow CLAIMS the
  --         invite atomically before minting, so at this point it is always
  --         already accepted. Revoking one deletes the row;
  --       * an `organization_invitations` row that was not revoked.
  --
  --     What none of the three admits is the case this closes: an account id
  --     the company has never had any relationship with at all.
  if not coalesce(v_actor_is_staxis_admin, false)
     and not exists (
       select 1 from public.organization_memberships m
       where m.organization_id = p_organization_id
         and m.account_id = p_account_id
         and m.ended_at is null
     )
     and not exists (
       select 1 from public.account_invites i
       where i.organization_id = p_organization_id
         and v_target_email is not null
         and lower(i.email) = v_target_email
     )
     and not exists (
       select 1 from public.organization_invitations i
       where i.organization_id = p_organization_id
         and v_target_email is not null
         and lower(i.email) = v_target_email
         and i.status <> 'revoked'
     ) then
    raise exception 'that person has no job or invitation at this company — invite them first'
      using errcode = '42501';
  end if;

  -- (b) Nobody may attach a job to somebody who already outranks them here.
  --     Asked as "could you have granted the job they already hold?", so the
  --     rule needs no second ranking table to drift out of step with
  --     `_staxis_can_set_membership_hat`.
  if not coalesce(v_actor_is_staxis_admin, false) then
    for v_existing in
      select m.membership_scope, m.staxis_role, m.covered_property_ids
      from public.organization_memberships m
      where m.organization_id = p_organization_id
        and m.account_id = p_account_id
        and m.status = 'active'
        and m.ended_at is null
        and m.staxis_role is not null
    loop
      if not public._staxis_can_set_membership_hat(
        p_actor_account_id, p_organization_id,
        v_existing.membership_scope, v_existing.staxis_role, v_existing.covered_property_ids
      ) then
        raise exception 'that person holds a job you could not have given them'
          using errcode = '42501';
      end if;
    end loop;
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

-- ── 3. A ceiling on a schedule's name ──────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'preventive_tasks_name_len_ck'
  ) then
    alter table public.preventive_tasks
      add constraint preventive_tasks_name_len_ck
      check (char_length(btrim(name)) between 1 and 120);
  end if;
end $$;

comment on constraint preventive_tasks_name_len_ck on public.preventive_tasks is
  'Same 120 characters as equipment.name (0368, and the equipment API validator). The name is quoted six times into every card the preventive detector writes and travels to the nightly judge inside one batched model call, so an unbounded name is somebody else''s spend cap. Added 0370.';

-- ── 4. Bookkeeping + schema reload ─────────────────────────────────────────
insert into public.applied_migrations (version, description)
values (
  '0370',
  'Tenant pairing + hat targets + a name ceiling. (1) Six links that carried their own property_id alongside an FK to a row with a different property_id now have COMPOSITE foreign keys pairing the two: finding_actions.finding_id, work_orders.preventive_task_id, work_orders.equipment_id, preventive_tasks.equipment_id, agent_knowledge_questions.finding_id, agent_knowledge_questions.equipment_id — backed by new unique keys findings/preventive_tasks/equipment (property_id, id). work_orders grants authenticated DML, so that one was reachable from a browser. (2) staxis_set_membership_hat now requires the TARGET to already hold a membership or invitation at the organization (Staxis-admin actors exempt, for bootstrap), refuses a Staxis administrator as a target, and refuses anyone attaching a job to a person who already holds a job the actor could not have granted. The grant matrix in _staxis_can_set_membership_hat is unchanged. (3) CHECK preventive_tasks_name_len_ck bounds the schedule name to 1..120 characters. Verified against production before writing: zero existing rows violate any of these. RLS unchanged throughout.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
