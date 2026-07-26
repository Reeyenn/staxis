-- ═══════════════════════════════════════════════════════════════════════════
-- 0369 — The hands, three ways they quietly stopped working.
--
-- All three came out of an adversarial review of the money-and-actions layer,
-- and all three are the same shape: a rule that reads correctly, holds for the
-- first tap, and is wrong on the second day.
--
-- ── 1. THE COUNTING WINDOW SLID AWAY FROM THE FROZEN PLAN ──────────────────
-- `staxis_execute_finding_action` re-derives the finding's receipt inside the
-- transaction that would do the work, and declines when the facts moved. For a
-- repeat-location offer the fact is "this many work orders at this place are
-- still open". The frozen `verify` carried the COUNT and the WINDOW WIDTH, and
-- the function then rebuilt the window from `now()`:
--
--     w.created_at >= now() - make_interval(days => window_days)
--
-- So the window slid. A card offered on the 1st, tapped on the 6th, counted a
-- DIFFERENT thirty days: five days of tickets fell off the back, the count came
-- in lower than the frozen one, and the manager was told
--
--     "Staxis did not do it: work orders on this location have been closed
--      since Staxis offered this."
--
-- Nobody had closed anything. The tickets simply got older. That sentence is
-- the product's own voice claiming a fact about the hotel that is not true, on
-- the one screen whose entire value is that its numbers can be checked — and it
-- refused a fix the manager had just asked for.
--
-- The window is now anchored to `a.proposed_at`, which is immutable (0363's
-- freeze trigger) and IS the moment the card was written. Nothing else changes:
-- the count can still only fall by a ticket actually being closed, which is the
-- honest question the re-verification was always meant to ask. A standing offer
-- re-found nightly keeps its original `proposed_at`, so its window widens rather
-- than sliding — and a wider window can only ADD live tickets, which is the safe
-- direction: it declines less often, never more wrongly.
--
-- ── 2. ONE DECLINE DISARMED A FIX FOREVER ──────────────────────────────────
-- `idempotency_key` was `<finding_id>:<params_fingerprint>` — one proposal per
-- problem per exact plan, for all time. Correct for a double tap; wrong for a
-- SECOND OFFER. When an offer declines (the facts moved) or fails (the write
-- broke), the app now re-arms on the next run with `verify` recomputed from
-- tonight's facts — but the re-armed row carried the identical plan, so the
-- unique index refused it and the card silently never grew its button back.
--
-- The key now covers the FACTS as well as the PLAN:
-- `<finding_id>:<params_fingerprint>:<verify_fingerprint>`. A retry of the same
-- offer on the same facts is still one row — so "nothing has changed since we
-- declined" cannot become a second card, and the manager is not asked twice
-- about a question whose answer would be the same. An offer resting on facts
-- that have MOVED is a genuinely different offer and gets its own row.
--
-- Old rows keep their old keys and cannot collide with new ones (a two-part key
-- is never a three-part key). `params_fingerprint` itself is unchanged, so the
-- tamper check in execute compares exactly what it always did.
--
-- ── 3. SUPERSEDE-THEN-INSERT WAS TWO ROUND TRIPS ───────────────────────────
-- PostgREST has no transactions, so the app marked the old offer `superseded`
-- and then inserted the new one. A failure in between left the finding with no
-- live offer at all: the card lost its button, and the next run — seeing no open
-- row and an unchanged problem — had no reason to think anything was wrong.
-- `staxis_replace_finding_action` does both in one statement, or neither.
--
-- ACCESS MODEL — unchanged. finding_actions stays deny-all to anon and
-- authenticated; the new function is SECURITY DEFINER, takes the hotel id as an
-- argument, filters on it, and is granted to service_role only. Every call site
-- derives the hotel from the manager gate or from the per-hotel runner.
--
-- NOT APPLIED automatically — migrations are applied by hand (CLAUDE.md).
-- Idempotent; safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. The freeze, with the facts in the key ───────────────────────────────
-- Replaces 0363's function. Identical in every other respect: the app still
-- never supplies a fingerprint, jsonb's own canonical text form is still what is
-- digested, and pg_catalog.sha256 is still used rather than pgcrypto's digest()
-- (pgcrypto lives in the `extensions` schema on Supabase, which is deliberately
-- not on this function's pinned search_path — that mistake broke the first live
-- run).
create or replace function public.staxis_finding_actions_frozen()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_verify_fingerprint text;
begin
  if tg_op = 'INSERT' then
    new.params_fingerprint := encode(sha256(convert_to(new.params::text, 'UTF8')), 'hex');
    -- The facts the offer rests on, digested alongside the plan. Two offers with
    -- the same plan and different facts are two offers; with the same facts they
    -- are one, however many times a run repeats.
    v_verify_fingerprint :=
      encode(sha256(convert_to(coalesce(new.verify, '{}'::jsonb)::text, 'UTF8')), 'hex');
    new.idempotency_key :=
      new.finding_id::text || ':' || new.params_fingerprint || ':' || v_verify_fingerprint;
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

comment on column public.finding_actions.idempotency_key is
  '<finding_id>:<params_fingerprint>:<verify_fingerprint>. UNIQUE — one proposal per problem per exact plan ON THE SAME FACTS, so a double tap and a retried write are one action, while an offer re-armed after a decline (whose facts have by definition moved) gets its own row. Widened from the two-part key in 0369.';

-- ── 2. Execute, with the counting window anchored to the offer ─────────────
-- Replaces 0366's function. The ONLY change is the `created_at` floor in the
-- repeat-location branch: `a.proposed_at` instead of `now()`. Everything else —
-- the states, the preventive branch, the subtransaction, the receipt, the undo,
-- the idempotent second tap — is 0366 unchanged.
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
  v_counted_since timestamptz;
  v_expected   numeric;
  v_actual     numeric;
  v_item       public.inventory;
  v_task       public.preventive_tasks;
  v_task_id    uuid;
  v_frozen_done timestamptz;
begin
  select * into a
    from public.finding_actions
   where id = p_action_id
     and property_id = p_property_id
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  if a.state <> 'proposed' then
    return jsonb_build_object(
      'ok', a.state = 'executed',
      'code', case when a.state = 'executed' then 'already_executed'
                   else 'already_' || a.state end,
      'state', a.state,
      'receipt', a.receipt,
      'changed', a.changed_facts
    );
  end if;

  if a.params_fingerprint is distinct from encode(sha256(convert_to(a.params::text, 'UTF8')), 'hex') then
    return jsonb_build_object('ok', false, 'code', 'tampered');
  end if;

  -- ═══ RE-VERIFY, against live rows, in this transaction ═══
  if a.action_kind = 'create_work_order' then
    v_task_id := nullif(a.verify ->> 'preventive_task_id', '')::uuid;

    if v_task_id is not null then
      -- ── the preventive shape ──
      select * into v_task
        from public.preventive_tasks
       where id = v_task_id
         and property_id = a.property_id;

      if not found then
        v_changed := jsonb_build_object(
          'field', 'preventive_task',
          'was',   a.verify ->> 'task_name',
          'now',   null,
          'subject', a.verify ->> 'task_name',
          'why', 'that upkeep schedule is no longer on this hotel''s list'
        );
      else
        -- What the card rested on: the last-done date at proposal time. Any
        -- movement means somebody has serviced this since, and the ticket
        -- Staxis was about to write is for a job that is already finished.
        v_frozen_done := nullif(a.verify ->> 'last_completed_at', '')::timestamptz;

        if v_task.last_completed_at is distinct from v_frozen_done then
          v_changed := jsonb_build_object(
            'field', 'preventive_last_done',
            'was',   v_frozen_done,
            'now',   v_task.last_completed_at,
            'subject', v_task.name,
            'why', 'this upkeep task has been marked done since Staxis offered this'
          );
        end if;
      end if;

    else
      -- ── the repeat-location shape ──
      v_room     := a.verify ->> 'location';
      v_window   := coalesce((a.verify ->> 'window_days')::int, 30);
      v_expected := coalesce((a.verify ->> 'open_work_orders')::numeric, 0);

      -- ═══ THE WINDOW IS ANCHORED TO THE OFFER, NOT TO THE TAP ═══
      -- `a.proposed_at - window_days` is the exact stretch of time the card
      -- counted over, and `proposed_at` is immutable, so the set of tickets
      -- being re-counted is the set the manager was shown. Anchoring on now()
      -- instead — which is what this did until 0369 — let tickets age out of the
      -- back of the window and produce a decline that told the manager somebody
      -- had closed work orders nobody had touched.
      --
      -- `counted_since` in the frozen verify wins if a future detector wants to
      -- state the boundary explicitly rather than have it derived.
      v_counted_since := coalesce(
        nullif(a.verify ->> 'counted_since', '')::timestamptz,
        a.proposed_at - make_interval(days => v_window)
      );

      select count(*)::numeric into v_actual
        from public.work_orders w
       where w.property_id = a.property_id
         and w.room_number = v_room
         and coalesce(w.status, 'submitted') <> 'resolved'
         and w.created_at >= v_counted_since;

      if v_actual < v_expected then
        v_changed := jsonb_build_object(
          'field', 'open_work_orders',
          'was',   v_expected,
          'now',   v_actual,
          'subject', v_room,
          'why', 'work orders on this location have been closed since Staxis offered this'
        );
      end if;
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
  begin
    if a.action_kind = 'create_work_order' then
      insert into public.work_orders (
        property_id, room_number, description, severity, status,
        source, submitted_by_name, submitter_role, preventive_task_id
      ) values (
        a.property_id,
        a.params ->> 'location',
        a.params ->> 'description',
        a.params ->> 'severity',
        'submitted',
        'staxis_finding',
        coalesce(a.params ->> 'submitted_by_name', 'Staxis'),
        a.params ->> 'submitter_role',
        -- The link is frozen in the PLAN, not re-derived here: what runs is what
        -- was shown, and the schedule this ticket belongs to is part of that.
        nullif(a.params ->> 'preventive_task_id', '')::uuid
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

revoke all on function public.staxis_execute_finding_action(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.staxis_execute_finding_action(uuid, uuid, uuid) to service_role;

-- ── 3. Replace: supersede and offer, or neither ────────────────────────────
--
-- WHAT THIS DOES *NOT* DO, ON PURPOSE: decide. Whether a finding has already
-- been settled, and whether tonight's plan differs from the standing one, are
-- app questions answered in src/lib/findings/actions/store.ts against the
-- catalog. Re-deciding them here would be a second copy of that judgement in a
-- language where nobody would look for it. This function is the ATOMIC HALF and
-- nothing else: retire exactly the row the caller named, insert exactly the plan
-- the caller froze, in one transaction.
--
--   { ok:true,  code:'proposed', action_id }
--   { ok:false, code:'duplicate' }         this exact plan on these exact facts
--                                          already exists for this finding
--   { ok:false, code:'superseded_gone' }   the offer we were told to retire is
--                                          no longer open — somebody tapped it
--                                          while the run was in flight, and the
--                                          run stands down rather than racing a
--                                          manager's decision
--   { ok:false, code:'not_found' }         no such finding at this hotel
create or replace function public.staxis_replace_finding_action(
  p_property_id  uuid,
  p_finding_id   uuid,
  p_supersede_id uuid,
  p_action_kind  text,
  p_params       jsonb,
  p_verify       jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_action_id uuid;
  v_retired   uuid;
begin
  -- The tenant wall, stated once here as well as by the caller's accessor: a
  -- finding id from another hotel matches nothing and no row is written.
  perform 1
     from public.findings f
    where f.id = p_finding_id
      and f.property_id = p_property_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  begin
    if p_supersede_id is not null then
      update public.finding_actions
         set state = 'superseded'
       where id = p_supersede_id
         and property_id = p_property_id
         and finding_id = p_finding_id
         and state = 'proposed'
      returning id into v_retired;

      -- Nothing retired means the row left 'proposed' between the caller's read
      -- and this statement. Returning here leaves the world exactly as it was.
      if v_retired is null then
        return jsonb_build_object('ok', false, 'code', 'superseded_gone');
      end if;
    end if;

    insert into public.finding_actions (
      property_id, finding_id, action_kind, params, verify, state
    ) values (
      p_property_id, p_finding_id, p_action_kind, p_params,
      coalesce(p_verify, '{}'::jsonb), 'proposed'
    )
    returning id into v_action_id;

  exception when unique_violation then
    -- The supersede above rolls back with the insert — this block is one
    -- subtransaction — so a duplicate leaves the standing offer standing.
    return jsonb_build_object('ok', false, 'code', 'duplicate');
  end;

  return jsonb_build_object('ok', true, 'code', 'proposed', 'action_id', v_action_id);
end;
$$;

comment on function public.staxis_replace_finding_action is
  'Atomically retire a finding''s standing offer and freeze the next one. The two used to be separate PostgREST round trips with no transaction between them, so a failed insert left the card with no offer at all until the next night. Decides nothing — settled-ness and plan equality are the app''s call; this is the atomic write half. Added 0369.';

revoke all on function public.staxis_replace_finding_action(uuid, uuid, uuid, text, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.staxis_replace_finding_action(uuid, uuid, uuid, text, jsonb, jsonb)
  to service_role;

-- ── 4. Bookkeeping + schema reload ─────────────────────────────────────────
insert into public.applied_migrations (version, description)
values (
  '0369',
  'Three ways the hands stopped working on day two. (1) staxis_execute_finding_action anchored the repeat-location counting window to now() instead of the frozen offer, so tickets ageing out of a sliding 30-day window produced a decline telling the manager somebody had closed work orders nobody had touched; it now counts from a.proposed_at - window_days (immutable), or from an explicit verify.counted_since. (2) idempotency_key widened from <finding>:<params> to <finding>:<params>:<verify>, so a fix that declined or failed can be re-offered once the facts move, while a retry on identical facts is still one row — previously one decline disarmed a fix permanently. (3) staxis_replace_finding_action makes supersede-then-insert one transaction; two PostgREST round trips could leave a finding with no live offer and no way to notice.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
