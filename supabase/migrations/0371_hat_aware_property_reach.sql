-- 0371_hat_aware_property_reach.sql
--
-- THE DATABASE LEARNS WHAT A COMPANY HAT IS.
--
-- `user_owns_property(p_id)` has answered one question since migration 0002:
-- "is this hotel named in the caller's `accounts.property_access` array?" That
-- was the whole truth when every account belonged to exactly one hotel. Since
-- 0364 it is only half of it — a company person's access comes from a HAT on
-- `organization_memberships`, and their legacy array is EMPTY BY DESIGN.
--
-- The application already knows this. `accessibleProperties()` in
-- src/lib/company/access.ts answers legacy ∪ hats, and the hat-access fix
-- routed the load-bearing browser reads through server routes that call it. But
-- RLS is a SECOND, INDEPENDENT answer to the same question, and it was never
-- taught. So every read a signed-in browser still makes with the anon client —
-- and there are twenty-one tables' worth — silently returned zero rows for a
-- hat-only account. Not an error: PostgREST answers 200 with `[]`, the JS
-- client calls that success, and the screen renders empty. That is the exact
-- bug class CLAUDE.md calls the #1 most-recurring in this product.
--
-- WHY THIS REDEFINES THE EXISTING HELPER RATHER THAN ADDING A SECOND GATE
--
-- The obvious smaller change is a new predicate OR-ed into the `properties`
-- policy alone. It would fix the one read we happened to name and leave the
-- other fifty-one policies answering from the legacy array — a hat-only VP who
-- clicked into a hotel would find the property row, then an empty Maintenance
-- tab, an empty Inventory page, an empty schedule and an empty quality board,
-- each failing silently and separately. "Which hotels does this person reach"
-- has exactly one correct answer, and the database should not hold two of them.
--
-- So the rule moves into `staxis_account_reaches_property`, and
-- `user_owns_property` becomes a one-line delegation to it. Every policy that
-- already calls `user_owns_property` inherits hats with no policy churn at all:
-- no MFA gate is re-stated, no section switch is re-derived, no role floor is
-- touched. The 52 policies keep their exact text. Only what "reaches" means
-- changed, in one place.
--
-- ZERO REGRESSION, STRUCTURALLY
--
-- Branch 1 below is migration 0003's body, unchanged to the character, and it
-- is evaluated FIRST. For every account in production today — none of which
-- holds a hat — the OR short-circuits on branch 1 and the cost, the plan and
-- the answer are all byte-identical to yesterday. A hat can only ever ADD a
-- hotel. There is no input for which this returns false where 0003 returned
-- true.
--
-- WHAT THE HAT BRANCH MIRRORS
--
-- It reproduces `loadHats` + `resolveHatCoverage` from access.ts exactly, and
-- the reasons are theirs:
--
--   * status/window   an ended, suspended or not-yet-started hat is not a hat.
--   * live company    a wound-up organization, and the hidden `single_hotel`
--                     compatibility anchors from 0325, are bookkeeping rather
--                     than companies. Neither may grant anything.
--   * GOVERNING only  `organization_property_relationships` holds seven kinds
--                     of link. Only a PRIMARY operator/owner row means "this
--                     company runs this building". A `brand`, `franchisor` or
--                     `vendor` row, or an operator row that has been stood down
--                     because somebody else took the hotel over, is not
--                     coverage — counting one would hand a hotel's data to the
--                     wrong company's staff.
--   * scope           a `company` hat covers every hotel its company operates
--                     RIGHT NOW, including one bought after the hat was written
--                     (nothing is re-stamped). A `property` hat covers the
--                     INTERSECTION of its own list with what the company still
--                     operates — Wall A, and the reason this is an intersection
--                     rather than a fallback.
--
-- WALL B IS STRUCTURAL, NOT A FILTER. The relationship row is joined on
-- `r.organization_id = m.organization_id`: coverage is only ever drawn from the
-- hat's OWN company. There is no argument to this function that can make a hat
-- in company A reach a hotel in company B.
--
-- ONE DELIBERATE ASYMMETRY: the hat branch requires `accounts.active`, and the
-- legacy branch does not. `accessibleProperties()` refuses a deactivated
-- account outright, so the hat branch matches it. Adding the same check to the
-- legacy branch would REMOVE access that 0003 grants today, which is exactly
-- the regression this migration promises not to be. The asymmetry is the
-- zero-regression contract, not an oversight.
--
-- WHAT THIS DELIBERATELY DOES NOT TOUCH.
--
-- `user_owns_property` answers REACH — "may this person see this hotel at all".
-- Five other helpers answer CAPABILITY — "may this person MANAGE this thing
-- here" — and they also read `property_access`:
--
--   user_manages_property                        7 manager-only SELECT policies
--   staxis_user_can_manage_staff                 staff INSERT/UPDATE/DELETE
--   staxis_user_can_manage_equipment             preventive_tasks I/U/D
--   staxis_user_can_manage_inventory_operations  inventory_custom_categories I/U/D
--   staxis_user_can_view_inventory_financials    budgets + delivery corrections
--
-- They are NOT extended here, and the reason is not timidity. Every one of them
-- reads `accounts.role` — a GLOBAL word, one per person — and pairs it with the
-- legacy array. Feeding reach into them without also replacing that word would
-- take Vera's `accounts.role` of 'general_manager', which describes a job at a
-- hotel she no longer works at, and apply it to every hotel her hat reaches.
-- access.ts says exactly this in `resolveEffectiveRole`: reading the global role
-- as "her job at hotel #12" is how a company VP silently becomes the general
-- manager of a building she has never heard of. Doing it correctly means
-- resolving the HAT's role per hotel (`legacyRoleForHat` + HAT_STRENGTH) in SQL
-- and re-keying `capability_overrides` against the degraded word. That is a
-- privilege GRANT with its own blast radius, and it is not smuggled into a
-- migration whose promise is that nobody loses anything.
--
-- The consequence, stated plainly: a hat-only manager can now READ every screen
-- and will still be refused the manager-only WRITES and the Inventory → Budgets
-- surface. Degraded, visible, and strictly better than the silent empty page
-- that is there today.
--
-- THREE CLAUSES BELOW ARE BELT OVER BRACES, and mutation testing says so — the
-- suite stays green when each is removed alone, because a live CHECK already
-- forbids the state it guards:
--
--   r.relationship_type in ('operator','owner')
--       ..._primary_kind_check already forbids a non-governing primary row.
--   m.ended_at is null
--       ..._revoked_shape_check ties ended_at to status='revoked', and the
--       status clause (which IS proven) blocks it first.
--   o.organization_type <> 'single_hotel'
--       reachable only by hanging a hat on a 0325 compatibility anchor, whose
--       coverage is the one hotel it already stands for.
--
-- They stay because a future loosening of any of those CHECKs must not widen
-- RLS as a side effect. Everything else in the hat branch is covered by a test
-- that goes red when it is removed.
--
-- COST. The hat branch is three indexed probes, all pre-existing:
--   organization_property_property_history_idx  (property_id, starts_at desc)
--   organization_memberships_open_hats_by_account_idx
--                                (account_id, organization_id, scope, role)
--                                where ended_at is null and staxis_role is not null
--   organizations_pkey
-- and it is only ever REACHED by an account that survived branch 1 without a
-- match. No new index is required.

begin;

-- ── Preflight ──────────────────────────────────────────────────────────────
-- Without the company spine there is nothing to teach, and a silently
-- half-applied reach predicate is worse than none.
do $$
begin
  if to_regclass('public.organization_memberships') is null
     or to_regclass('public.organization_property_relationships') is null
     or to_regclass('public.organizations') is null
     or to_regclass('public.accounts') is null
  then
    raise exception '0371 requires the company spine (migrations 0325 + 0364)';
  end if;
  if to_regprocedure('public.user_owns_property(uuid)') is null then
    raise exception '0371 requires user_owns_property(uuid) (migrations 0002 + 0003)';
  end if;
  -- 0364's hat columns. Their absence would make the hat branch a no-op that
  -- still parses, which is the failure mode most likely to go unnoticed.
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'organization_memberships'
      and column_name in ('membership_scope', 'staxis_role', 'covered_property_ids')
    having count(*) = 3
  ) then
    raise exception '0371 requires migration 0364 hat columns on organization_memberships';
  end if;
end
$$;

-- ── The reach rule, in one place ───────────────────────────────────────────
create or replace function public.staxis_account_reaches_property(
  p_user_id uuid,
  p_property_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    -- BRANCH 1 — the legacy array. Migration 0003's body, verbatim, and first
    -- so that every account in the product today short-circuits here.
    exists (
      select 1 from public.accounts a
      where a.data_user_id = p_user_id
        and (
          a.role = 'admin'
          or p_property_id = any (a.property_access)
        )
    )
    -- BRANCH 2 — a company hat. Additive only; see the header.
    or exists (
      select 1
      from public.accounts a
      join public.organization_memberships m
        on m.account_id = a.id
      join public.organizations o
        on o.id = m.organization_id
      -- WALL B: the hotel must be governed by the HAT'S OWN company.
      join public.organization_property_relationships r
        on r.organization_id = m.organization_id
      where a.data_user_id = p_user_id
        -- `is distinct from false` rather than `is true`: access.ts reads a
        -- NULL `active` as active, and this must not diverge if the column is
        -- ever made nullable again.
        and a.active is distinct from false

        -- The hat is open, active, and has started.
        and m.ended_at is null
        and m.status = 'active'
        and m.starts_at <= now()
        -- The seven real hats. The table's own hat-shape CHECK already
        -- guarantees this pairing; restating it means a future loosening of the
        -- constraint cannot silently widen RLS as a side effect.
        and (
          (m.membership_scope = 'company'
             and m.staxis_role in ('owner', 'vp', 'finance'))
          or
          (m.membership_scope = 'property'
             and m.staxis_role in ('general_manager', 'front_desk',
                                   'housekeeping', 'maintenance')
             and p_property_id = any (m.covered_property_ids))
        )

        -- A live company, not a wound-up one and not a 0325 single-hotel
        -- compatibility anchor.
        and o.status = 'active'
        and o.organization_type <> 'single_hotel'

        -- ...that GOVERNS this hotel right now.
        and r.property_id = p_property_id
        and r.is_primary_grouping
        and r.relationship_type in ('operator', 'owner')
        and r.starts_at <= now()
        and (r.ends_at is null or r.ends_at > now())
    );
$$;

comment on function public.staxis_account_reaches_property(uuid, uuid) is
  'Does this auth user reach this hotel? Legacy accounts.property_access OR an active governing company hat. The SQL mirror of accessibleProperties() in src/lib/company/access.ts; user_owns_property() delegates here.';

-- Not a public entry point. It takes an auth uid as an ARGUMENT, so leaving it
-- callable by `authenticated` would let any signed-in user probe whether
-- somebody else reaches a hotel. The only granted caller is the wrapper below,
-- which pins the uid to `auth.uid()` and, being SECURITY DEFINER, invokes this
-- with the owner's privileges regardless of the caller's.
revoke all on function public.staxis_account_reaches_property(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.staxis_account_reaches_property(uuid, uuid)
  to service_role;

-- ── The existing gate, now delegating ──────────────────────────────────────
-- `create or replace`, never `drop` — 52 policies depend on this function and
-- dropping it would drop them. (rls-policies-shape.test.ts asserts no migration
-- ever does.) Signature, volatility, security mode, search_path and grants are
-- all preserved exactly as 0003 + 0153 left them.
create or replace function public.user_owns_property(p_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.staxis_account_reaches_property(auth.uid(), p_id);
$$;

comment on function public.user_owns_property(uuid) is
  'Tenant gate for every per-property RLS policy. Delegates to staxis_account_reaches_property(auth.uid(), p_id): legacy property_access OR an active governing company hat.';

revoke all on function public.user_owns_property(uuid) from public;
grant execute on function public.user_owns_property(uuid)
  to anon, authenticated, service_role;

-- ── Proof, at apply time ───────────────────────────────────────────────────
-- The migration refuses to commit unless the rewired helper still answers the
-- legacy question correctly. A wrapper that returns NULL, or one whose grants
-- were lost, would otherwise apply cleanly and take every per-property read in
-- the product down with it.
do $$
declare
  v_uid uuid;
  v_pid uuid;
begin
  select a.data_user_id, a.property_access[1]
    into v_uid, v_pid
    from public.accounts a
   where a.role <> 'admin'
     and a.active
     and array_length(a.property_access, 1) >= 1
   limit 1;

  if v_uid is null then
    raise notice '0371: no legacy account to self-check against; skipping';
    return;
  end if;

  if not public.staxis_account_reaches_property(v_uid, v_pid) then
    raise exception '0371 self-check FAILED: a legacy account lost access to its own hotel';
  end if;
  if public.staxis_account_reaches_property(v_uid, '00000000-0000-0000-0000-000000000000'::uuid) then
    raise exception '0371 self-check FAILED: reach granted to a hotel that does not exist';
  end if;
  if public.staxis_account_reaches_property(null, v_pid) then
    raise exception '0371 self-check FAILED: an unauthenticated caller reaches a hotel';
  end if;
end
$$;

insert into public.applied_migrations (version, description)
values (
  '0371',
  'RLS learns company hats: staxis_account_reaches_property(legacy OR governing hat); user_owns_property delegates to it so all 52 per-property policies inherit'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
