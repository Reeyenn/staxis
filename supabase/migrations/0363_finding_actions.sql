-- ═══════════════════════════════════════════════════════════════════════════
-- 0363 — The hands: a finding that Staxis can fix arrives with the fix attached.
--
-- WHAT THIS IS
-- The findings ledger (0360-0362) can say "room 214 has had four work orders in
-- thirty days". It cannot DO anything about it. This table is the one tap that
-- closes that gap: an action, chosen and parameterised by CODE at the moment
-- the card is written, sitting frozen until a manager approves it.
--
-- THE FOUR PROMISES, AND WHERE EACH ONE LIVES
--
--   1. FROZEN AT PROPOSAL TIME. What runs is exactly what was shown. There is
--      no model call at execution and no improvisation: `params` is written
--      once, when the card is created, and the immutability trigger below
--      REFUSES any update that touches it. `params_fingerprint` is computed by
--      the database from those params, so "was this the plan the manager saw?"
--      is a diff, not a matter of trust.
--
--   2. RE-VERIFIED AT THE TAP, INSIDE THE TRANSACTION. Age is a proxy;
--      changed-ness is the thing. `staxis_execute_finding_action` re-derives
--      the finding's receipt against live rows in the SAME transaction that
--      would do the work, and DECLINES — recording exactly what moved — when
--      the facts no longer hold. "The AI declined and explained" is a good day;
--      "the AI did something wrong" is not.
--
--   3. EVERY ACTION IS UNDOABLE. `undo` is written at execution time, from what
--      actually happened, and `staxis_undo_finding_action` reverses it. An
--      action kind with no real undo does not belong in the catalog.
--
--   4. A DOUBLE TAP IS ONE ACTION. Two guarantees, both in Postgres, neither of
--      them politeness: `finding_actions_idempotency_uq` means one proposal per
--      (finding, exact plan), and the execute function takes `FOR UPDATE` on
--      the row and refuses to leave the 'proposed' state twice. The second tap
--      gets the FIRST tap's receipt back, not a second work order.
--
-- WHY NOT agent_pending_actions (the "extend before you add" justification)
-- Same reason findings themselves are not in it (INV-FIND-3, INV-25).
-- `agent_pending_actions.conversation_id` and `.account_id` are NOT NULL with
-- ON DELETE CASCADE and its rows carry a ~10-minute TTL, because it is the
-- copilot's in-chat proposal queue: you asked a question, it proposed, you say
-- yes within the minute. A proactive proposal has no conversation and no
-- author, is offered to whoever opens the app tomorrow morning, and must still
-- be there next week. Putting one there would mean every offered fix vanished
-- when a chat was archived or an employee was offboarded. Nothing else fits
-- either: `findings` is the PROBLEM, and a problem is not a plan; `work_orders`
-- is the outcome, not the offer; `agent_decisions` records what the copilot
-- already did, has no proposed/undone lifecycle, and is immutable by design.
--
-- WHY THE WORK HAPPENS IN plpgsql AND NOT IN TYPESCRIPT
-- PostgREST has no transactions. Verify-then-write from the app is two round
-- trips with a window in between, and "the work order was created but the
-- receipt write failed" is exactly the half-done state a manager can never
-- reconcile. Both functions below do verify + write + receipt in ONE
-- transaction, and the execute path wraps the write in a plpgsql exception
-- block — a subtransaction — so a failed write rolls back completely while the
-- 'failed' state and its reason still land. Failure is recorded, never partial.
--
-- ACCESS MODEL — SERVICE-ROLE ONLY, mirroring findings (0360). anon and
-- authenticated are deny-all; the functions are SECURITY DEFINER and take the
-- hotel id as an argument, which every call site derives from the manager gate
-- (loadManagerCaller + managerManagesHotel), never from the request body alone.
--
-- NOT APPLIED automatically — migrations are applied by hand (CLAUDE.md). The
-- table is inert until the UI ships, so deploy order is safe either way.
-- Idempotent.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. finding_actions ─────────────────────────────────────────────────────
-- @rls: service-role-only — proposed by the nightly findings runner, executed
-- by a manager through /api/findings/actions. No anon path, no browser path.
create table if not exists public.finding_actions (
  id                    uuid primary key default gen_random_uuid(),

  -- Tenancy. Cascades with the hotel, like everything else in this layer.
  property_id           uuid not null references public.properties(id) on delete cascade,

  -- The problem this is the answer to. Cascades: an offer to fix something
  -- that no longer exists as a finding is an orphan, not history.
  finding_id            uuid not null references public.findings(id) on delete cascade,

  -- Which entry in the action catalog (src/lib/findings/actions/catalog).
  -- Deliberately a CHECK over a closed list rather than free text: an action
  -- kind the execute function has no branch for must be impossible to store,
  -- not merely unlikely, or a typo becomes a card with a button that does
  -- nothing.
  action_kind           text not null check (action_kind in (
                          'create_work_order',
                          'raise_inventory_reorder_point'
                        )),

  -- ── the frozen plan ──────────────────────────────────────────────────────
  -- Exactly what will be done, written when the card is created, in the shape
  -- the executing branch reads. IMMUTABLE after insert (trigger below).
  params                jsonb not null,
  -- Digest of `params`, computed BY THE DATABASE on insert. The app never
  -- supplies it, so a fingerprint can never disagree with the plan it is
  -- supposed to fingerprint.
  params_fingerprint    text not null default '',

  -- ── what must still be true at the tap ───────────────────────────────────
  -- The finding's receipt, in machine form. Re-derived inside the execute
  -- transaction and compared against this. Also immutable.
  verify                jsonb not null default '{}'::jsonb,

  -- proposed          offered on the card, nothing has happened
  -- superseded        a later run offered a DIFFERENT plan for the same
  --                   problem, so this offer is no longer the one on the card.
  --                   Kept rather than deleted: an offer nobody tapped is still
  --                   a record of what Staxis was willing to do that night.
  -- executed          the work was done; `receipt` says what, `undo` says how
  --                   to reverse it
  -- declined_changed  the manager tapped, but the facts had moved — nothing was
  --                   done and `changed_facts` says what moved
  -- undone            it was executed and then reversed
  -- failed            the write itself failed; `failure_reason` says how, and
  --                   the subtransaction guarantees nothing partial survived
  state                 text not null default 'proposed' check (state in (
                          'proposed','superseded','executed','declined_changed','undone','failed'
                        )),

  -- ── the receipt ──────────────────────────────────────────────────────────
  -- What was actually created or changed: { table, id, label, … }. Written by
  -- the execute function from the rows it actually touched, never from the
  -- plan — a receipt copied from the intention would agree with itself forever.
  receipt               jsonb,
  created_object_table  text,
  created_object_id     uuid,

  -- How to reverse it, recorded at execution time from what happened.
  undo                  jsonb,

  -- What moved between the proposal and the tap. Only ever set alongside
  -- state='declined_changed'; it is what the card shows instead of a receipt.
  changed_facts         jsonb,

  failure_reason        text check (failure_reason is null or char_length(failure_reason) <= 400),

  -- ── idempotency ──────────────────────────────────────────────────────────
  -- '<finding_id>:<params_fingerprint>' — one proposal per (problem, exact
  -- plan). A nightly re-find of the same problem cannot stack a second offer of
  -- the same fix, and a retried write cannot become two. UNIQUE, because a
  -- double tap being one action is a guarantee, not an intention.
  idempotency_key       text not null,

  -- ── who, and when ────────────────────────────────────────────────────────
  proposed_at           timestamptz not null default now(),
  decided_at            timestamptz,
  -- SET NULL: the record that a fix was approved outlives the approver's
  -- account, exactly as INV-25 requires of the decision corpus.
  decided_by            uuid references public.accounts(id) on delete set null,
  undone_at             timestamptz,
  undone_by             uuid references public.accounts(id) on delete set null,

  -- ── did the fix hold? ────────────────────────────────────────────────────
  -- Same vocabulary as agent_decisions (0350) on purpose: one word for one
  -- concept across the whole app, so the probe layer INV-28 defers can read
  -- both corpora with one set of rules. `outcome_due_at` is the scheduling half
  -- 0350 did not need — it is set at execution time from the catalog entry's
  -- declared window, and it is what a future probe cron selects on.
  outcome_kind          text check (outcome_kind is null or outcome_kind in (
                          'stood','reverted','superseded','not_observable','unknown'
                        )),
  outcome_due_at        timestamptz,
  outcome_observed_at   timestamptz,
  outcome_facts         jsonb,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- ── state coherence ──────────────────────────────────────────────────────
  -- Each terminal state must carry the thing that state MEANS. Without these a
  -- row could claim 'executed' with no receipt, and the card would offer an
  -- Undo button for something nobody can describe.
  constraint finding_actions_state_coherent check (
    (state in ('proposed','superseded')
      and receipt is null and undo is null and changed_facts is null
      and undone_at is null)
    or (state = 'executed'
      and receipt is not null and undo is not null and decided_at is not null
      and undone_at is null)
    or (state = 'declined_changed'
      and changed_facts is not null and decided_at is not null
      and receipt is null and undone_at is null)
    or (state = 'undone'
      and receipt is not null and undo is not null
      and decided_at is not null and undone_at is not null)
    or (state = 'failed'
      and failure_reason is not null and decided_at is not null
      and receipt is null and undone_at is null)
  ),

  -- Time only moves forward.
  constraint finding_actions_decided_after_proposed check (
    decided_at is null or decided_at >= proposed_at
  ),
  constraint finding_actions_undone_after_decided check (
    undone_at is null or (decided_at is not null and undone_at >= decided_at)
  )
);

-- ═══ ONE TAP IS ONE ACTION ═══
-- The database, not the button's disabled attribute. Two requests carrying the
-- same plan for the same problem cannot both insert; the loser gets 23505 and
-- the app treats it as "already proposed", which is the truth.
create unique index if not exists finding_actions_idempotency_uq
  on public.finding_actions (idempotency_key);

-- At most ONE live offer per problem. A finding whose action is still waiting
-- must not accumulate a second, different offer on tomorrow's run — the card
-- has one button, and a second row would mean the button is ambiguous about
-- what it does. Executed/undone/failed/declined rows sit outside it so the
-- history stays whole and a later, genuinely different plan can be offered.
create unique index if not exists finding_actions_one_open_per_finding_uq
  on public.finding_actions (finding_id)
  where state = 'proposed';

-- The card read: "what is being offered on this hotel's findings right now".
create index if not exists finding_actions_property_state_idx
  on public.finding_actions (property_id, state, proposed_at desc);

-- Drives the future outcome-probe cron: executed rows past their window with
-- no verdict yet. Mirrors agent_decisions_outcome_pending_idx (0350).
create index if not exists finding_actions_outcome_pending_idx
  on public.finding_actions (outcome_due_at)
  where state = 'executed' and outcome_kind is null;

comment on table public.finding_actions is
  'The hands: one row per fix Staxis offered on a finding. params is frozen at proposal time and immutable, so what runs is what was shown; staxis_execute_finding_action re-verifies the finding receipt inside the same transaction that does the work and declines when the facts moved; every kind carries a real undo. Service-role-only. Added 0363.';

comment on column public.finding_actions.params is
  'The frozen plan — exactly what will be done, written when the card was created. IMMUTABLE after insert (staxis_finding_actions_frozen). There is no model call at execution time; this column IS the decision.';

comment on column public.finding_actions.params_fingerprint is
  'Digest of params, computed by the database on insert. Lets "was this the plan the manager approved?" be answered by comparison rather than by trust.';

comment on column public.finding_actions.verify is
  'The finding receipt in machine form. Re-derived against live rows inside the execute transaction; a mismatch declines the action and records what moved in changed_facts.';

comment on column public.finding_actions.idempotency_key is
  '<finding_id>:<params_fingerprint>. UNIQUE — one proposal per problem per exact plan, so a double tap and a retried write are both one action.';

comment on column public.finding_actions.undo is
  'How to reverse what was actually done, written at execution time from the rows that were touched. An action kind without a real undo does not belong in the catalog.';

comment on column public.finding_actions.outcome_due_at is
  'When to go back and ask whether the fix held. Set at execution from the catalog entry declared window; read by the future outcome probe (INV-28).';

-- ── 2. The freeze: params, verify and identity are historical fact ─────────
-- Modelled on staxis_agent_decisions_immutable (0350). A proposal that could be
-- edited after the card was rendered would make "what ran is what was shown" a
-- claim rather than a property, and the failure would be invisible: the manager
-- taps the button they read, and something else happens.
create or replace function public.staxis_finding_actions_frozen()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    -- The app never supplies the fingerprint, so it cannot disagree with the
    -- plan. jsonb's own text form is canonical (keys sorted, whitespace
    -- normalised), which is what makes this stable across writers.
    --
    -- pg_catalog.sha256(bytea), NOT pgcrypto's digest(). pgcrypto lives in the
    -- `extensions` schema on Supabase, which is deliberately NOT on this
    -- function's pinned search_path — and pinning search_path is a hard rule
    -- here (audit-security-definer-search-path). digest() therefore resolves
    -- locally and fails in production, which is exactly what it did on the
    -- first live run. sha256() is core since Postgres 11 and needs no
    -- extension anywhere.
    new.params_fingerprint := encode(sha256(convert_to(new.params::text, 'UTF8')), 'hex');
    new.idempotency_key := new.finding_id::text || ':' || new.params_fingerprint;
    return new;
  end if;

  if new.params is distinct from old.params
     or new.verify is distinct from old.verify
     or new.action_kind is distinct from old.action_kind
     or new.finding_id is distinct from old.finding_id
     or new.property_id is distinct from old.property_id
     or new.params_fingerprint is distinct from old.params_fingerprint
     or new.idempotency_key is distinct from old.idempotency_key
     or new.proposed_at is distinct from old.proposed_at then
    raise exception
      'finding_actions: the frozen proposal is immutable (params, verify, action_kind, finding_id, property_id, fingerprint, key, proposed_at). What runs must be what was shown.'
      using errcode = 'check_violation';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists staxis_finding_actions_frozen_tg on public.finding_actions;
create trigger staxis_finding_actions_frozen_tg
  before insert or update on public.finding_actions
  for each row execute function public.staxis_finding_actions_frozen();

-- ── 3. Execute — verify and write, in one transaction ──────────────────────
--
-- Returns a jsonb envelope rather than raising, because every outcome below is
-- a real answer the card has to render:
--   { ok:true,  code:'executed',          receipt, outcome_due_at }
--   { ok:true,  code:'already_executed',  receipt }          ← the second tap
--   { ok:false, code:'declined_changed',  changed }
--   { ok:false, code:'failed',            error }
--   { ok:false, code:'not_found' | 'tampered' | 'already_<state>' }
create or replace function public.staxis_execute_finding_action(
  p_action_id   uuid,
  p_property_id uuid,
  p_account_id  uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a            public.finding_actions;
  v_now        timestamptz := now();
  v_changed    jsonb;
  v_receipt    jsonb;
  v_undo       jsonb;
  v_table      text;
  v_object_id  uuid;
  v_due        timestamptz;
  v_err        text;
  v_room       text;
  v_window     integer;
  v_expected   numeric;
  v_actual     numeric;
  v_item       public.inventory;
begin
  -- FOR UPDATE is the serialiser. Two taps arriving together queue here; the
  -- second one reads the row the first one already moved out of 'proposed'.
  select * into a
    from public.finding_actions
   where id = p_action_id
     and property_id = p_property_id
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  if a.state <> 'proposed' then
    -- A replay is answered with the FIRST tap's outcome. Not an error: the
    -- manager asked for one work order and there is exactly one work order.
    return jsonb_build_object(
      'ok', a.state = 'executed',
      'code', case when a.state = 'executed' then 'already_executed'
                   else 'already_' || a.state end,
      'state', a.state,
      'receipt', a.receipt,
      'changed', a.changed_facts
    );
  end if;

  -- Belt to the immutability trigger's braces: if the trigger were ever
  -- dropped, a tampered plan still cannot execute.
  if a.params_fingerprint is distinct from encode(sha256(convert_to(a.params::text, 'UTF8')), 'hex') then
    return jsonb_build_object('ok', false, 'code', 'tampered');
  end if;

  -- ═══ RE-VERIFY, against live rows, in this transaction ═══
  -- Not "is the finding fresh" — freshness is a proxy. The question is whether
  -- the specific facts the proposal rests on are still the facts.
  if a.action_kind = 'create_work_order' then
    v_room     := a.verify ->> 'location';
    v_window   := coalesce((a.verify ->> 'window_days')::int, 30);
    v_expected := coalesce((a.verify ->> 'open_work_orders')::numeric, 0);

    select count(*)::numeric into v_actual
      from public.work_orders w
     where w.property_id = a.property_id
       and w.room_number = v_room
       and coalesce(w.status, 'submitted') <> 'resolved'
       and w.created_at >= v_now - make_interval(days => v_window);

    if v_actual < v_expected then
      v_changed := jsonb_build_object(
        'field', 'open_work_orders',
        'was',   v_expected,
        'now',   v_actual,
        'subject', v_room,
        'why', 'work orders on this location have been closed since Staxis offered this'
      );
    end if;

  elsif a.action_kind = 'raise_inventory_reorder_point' then
    select * into v_item
      from public.inventory
     where id = (a.verify ->> 'item_id')::uuid
       and property_id = a.property_id;

    if not found then
      v_changed := jsonb_build_object(
        'field', 'item', 'was', a.verify ->> 'item_name', 'now', null,
        'subject', a.verify ->> 'item_name',
        'why', 'that item is no longer on this hotel''s inventory list'
      );
    elsif v_item.archived_at is not null then
      v_changed := jsonb_build_object(
        'field', 'item', 'was', a.verify ->> 'item_name', 'now', 'archived',
        'subject', a.verify ->> 'item_name',
        'why', 'that item has been archived since Staxis offered this'
      );
    elsif coalesce(v_item.reorder_at, -1) is distinct from coalesce((a.verify ->> 'reorder_at')::numeric, -1) then
      v_changed := jsonb_build_object(
        'field', 'reorder_at',
        'was',   (a.verify ->> 'reorder_at')::numeric,
        'now',   v_item.reorder_at,
        'subject', a.verify ->> 'item_name',
        'why', 'somebody has already changed this reorder point'
      );
    end if;

  else
    -- Unreachable while the CHECK and this function agree. Kept so that
    -- disagreeing is a refusal rather than a silent no-op.
    return jsonb_build_object('ok', false, 'code', 'unknown_kind', 'kind', a.action_kind);
  end if;

  if v_changed is not null then
    update public.finding_actions
       set state = 'declined_changed',
           changed_facts = v_changed,
           decided_at = v_now,
           decided_by = p_account_id
     where id = a.id;
    return jsonb_build_object('ok', false, 'code', 'declined_changed', 'changed', v_changed);
  end if;

  -- ═══ DO THE WORK ═══
  -- Inside a plpgsql exception block, which is a SUBTRANSACTION: anything
  -- written in here is rolled back on failure, while the 'failed' row written
  -- by the handler belongs to the outer transaction and survives. That is what
  -- makes "failed, and nothing half-happened" a property rather than a hope.
  begin
    if a.action_kind = 'create_work_order' then
      insert into public.work_orders (
        property_id, room_number, description, severity, status,
        source, submitted_by_name, submitter_role
      ) values (
        a.property_id,
        a.params ->> 'location',
        a.params ->> 'description',
        a.params ->> 'severity',
        'submitted',
        'staxis_finding',
        coalesce(a.params ->> 'submitted_by_name', 'Staxis'),
        a.params ->> 'submitter_role'
      )
      returning id into v_object_id;

      v_table   := 'work_orders';
      v_receipt := jsonb_build_object(
        'table', 'work_orders',
        'id', v_object_id,
        'kind', 'created',
        'label', a.params ->> 'description',
        'where', a.params ->> 'location'
      );
      -- Undo removes the row Staxis itself created, and ONLY while it is still
      -- exactly as created. Marking it 'resolved' instead would put a job
      -- nobody did into the hotel's completed maintenance history, which is a
      -- worse lie than the card ever told. The full record of what was created
      -- survives here, in `receipt`, either way.
      v_undo := jsonb_build_object(
        'kind', 'remove_created_row', 'table', 'work_orders', 'id', v_object_id
      );

    else
      update public.inventory
         set reorder_at = (a.params ->> 'to_reorder_at')::numeric,
             updated_at = v_now
       where id = (a.params ->> 'item_id')::uuid
         and property_id = a.property_id
      returning id into v_object_id;

      if v_object_id is null then
        raise exception 'inventory row disappeared between verification and write';
      end if;

      v_table   := 'inventory';
      v_receipt := jsonb_build_object(
        'table', 'inventory',
        'id', v_object_id,
        'kind', 'changed',
        'label', a.params ->> 'item_name',
        'column', 'reorder_at',
        'from', (a.params ->> 'from_reorder_at')::numeric,
        'to',   (a.params ->> 'to_reorder_at')::numeric
      );
      v_undo := jsonb_build_object(
        'kind', 'restore_previous_value', 'table', 'inventory',
        'id', v_object_id, 'column', 'reorder_at',
        'value', (a.params ->> 'from_reorder_at')::numeric
      );
    end if;

  exception when others then
    v_err := left(coalesce(sqlerrm, 'unknown error'), 400);
    update public.finding_actions
       set state = 'failed',
           failure_reason = v_err,
           decided_at = v_now,
           decided_by = p_account_id
     where id = a.id;
    return jsonb_build_object('ok', false, 'code', 'failed', 'error', v_err);
  end;

  v_due := v_now + make_interval(days => greatest(1, coalesce((a.params ->> 'outcome_check_days')::int, 7)));

  update public.finding_actions
     set state = 'executed',
         receipt = v_receipt,
         undo = v_undo,
         created_object_table = v_table,
         created_object_id = v_object_id,
         decided_at = v_now,
         decided_by = p_account_id,
         outcome_due_at = v_due
   where id = a.id;

  return jsonb_build_object(
    'ok', true, 'code', 'executed', 'receipt', v_receipt, 'outcome_due_at', v_due
  );
end;
$$;

-- ── 4. Undo — reverse it, or refuse and say why ────────────────────────────
--
--   { ok:true,  code:'undone' | 'already_undone', receipt }
--   { ok:false, code:'undo_refused_touched', why }   ← a human has been at it
--   { ok:false, code:'not_found' | 'not_undoable' | 'failed' }
create or replace function public.staxis_undo_finding_action(
  p_action_id   uuid,
  p_property_id uuid,
  p_account_id  uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a       public.finding_actions;
  v_now   timestamptz := now();
  v_wo    public.work_orders;
  v_item  public.inventory;
  v_err   text;
begin
  select * into a
    from public.finding_actions
   where id = p_action_id
     and property_id = p_property_id
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  if a.state = 'undone' then
    return jsonb_build_object('ok', true, 'code', 'already_undone', 'receipt', a.receipt);
  end if;

  if a.state <> 'executed' then
    return jsonb_build_object('ok', false, 'code', 'not_undoable', 'state', a.state);
  end if;

  begin
    if a.undo ->> 'kind' = 'remove_created_row' then
      select * into v_wo
        from public.work_orders
       where id = (a.undo ->> 'id')::uuid
         and property_id = a.property_id
       for update;

      if found then
        -- Somebody has worked on it. Staxis undoes its own suggestion; it does
        -- not erase a human's work, and saying so is better than either
        -- silently refusing or silently deleting.
        if coalesce(v_wo.status, 'submitted') <> 'submitted'
           or v_wo.completion_note is not null
           or v_wo.completion_photo_path is not null
           or v_wo.completed_by_name is not null
           or v_wo.repair_cost is not null
           or v_wo.assigned_to is not null
           or v_wo.resolved_at is not null then
          return jsonb_build_object(
            'ok', false, 'code', 'undo_refused_touched',
            'why', 'somebody has already started on that work order, so Staxis will not remove it'
          );
        end if;
        delete from public.work_orders where id = v_wo.id;
      end if;
      -- Already gone: the undo's goal is already true. Fall through and record
      -- the state, so a card cannot be left offering an Undo forever.

    elsif a.undo ->> 'kind' = 'restore_previous_value' then
      select * into v_item
        from public.inventory
       where id = (a.undo ->> 'id')::uuid
         and property_id = a.property_id
       for update;

      if not found then
        return jsonb_build_object(
          'ok', false, 'code', 'undo_refused_touched',
          'why', 'that item is no longer on this hotel''s inventory list'
        );
      end if;

      if coalesce(v_item.reorder_at, -1) is distinct from coalesce((a.receipt ->> 'to')::numeric, -1) then
        return jsonb_build_object(
          'ok', false, 'code', 'undo_refused_touched',
          'why', 'somebody has changed that reorder point since, so Staxis will not overwrite it'
        );
      end if;

      update public.inventory
         set reorder_at = (a.undo ->> 'value')::numeric,
             updated_at = v_now
       where id = v_item.id;

    else
      return jsonb_build_object('ok', false, 'code', 'not_undoable', 'state', a.state);
    end if;

  exception when others then
    v_err := left(coalesce(sqlerrm, 'unknown error'), 400);
    -- The state stays 'executed': the work really was done and really is still
    -- there. Only the reversal failed, and the card must keep offering it.
    update public.finding_actions
       set failure_reason = v_err
     where id = a.id;
    return jsonb_build_object('ok', false, 'code', 'failed', 'error', v_err);
  end;

  update public.finding_actions
     set state = 'undone',
         undone_at = v_now,
         undone_by = p_account_id,
         -- The fix was reversed. That IS the outcome, and recording it here
         -- means the probe layer never has to ask about a row it already knows
         -- the answer for.
         outcome_kind = 'reverted',
         outcome_observed_at = v_now
   where id = a.id;

  return jsonb_build_object('ok', true, 'code', 'undone', 'receipt', a.receipt);
end;
$$;

-- ── 5. RLS — service-role only; anon + authenticated deny-all ──────────────
alter table public.finding_actions enable row level security;
revoke all on public.finding_actions from public, anon, authenticated;
grant select, insert, update, delete on public.finding_actions to service_role;
drop policy if exists finding_actions_deny_all on public.finding_actions;
create policy finding_actions_deny_all on public.finding_actions
  for all to anon, authenticated using (false) with check (false);

-- The functions are SECURITY DEFINER and take the hotel as an argument. Only
-- the service role may call them; the manager gate lives in the API route that
-- decides which hotel id is legitimate for this session.
revoke all on function public.staxis_execute_finding_action(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.staxis_undo_finding_action(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.staxis_execute_finding_action(uuid, uuid, uuid) to service_role;
grant execute on function public.staxis_undo_finding_action(uuid, uuid, uuid) to service_role;

-- ── 6. Bookkeeping + schema reload ─────────────────────────────────────────
insert into public.applied_migrations (version, description)
values (
  '0363',
  'finding_actions: the hands. One row per fix Staxis offered on a finding. params frozen at proposal time and immutable (staxis_finding_actions_frozen), so what runs is what was shown; staxis_execute_finding_action re-verifies the finding receipt against live rows inside the same transaction that does the work and declines with changed_facts when they moved; the write sits in a plpgsql subtransaction so a failure records state=failed with nothing partial; staxis_undo_finding_action reverses it and refuses when a human has touched the result. finding_actions_idempotency_uq + FOR UPDATE make a double tap exactly one action. Service-role-only (deny-all anon+authenticated).'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
