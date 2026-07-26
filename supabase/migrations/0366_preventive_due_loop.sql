-- ═══════════════════════════════════════════════════════════════════════════
-- 0366 — Preventive maintenance: the hotel tells Staxis once, Staxis counts
--        forward forever, and closing the loop is structural rather than
--        remembered.
--
-- WHAT THIS IS
-- `preventive_tasks` has existed since 0001: a name, an area, a cadence in days
-- and a last-done date. The Maintenance → Preventive tab has been writing to it
-- since the June redesign, and one hotel has seven live rows in it today. What
-- it has never had is a VOICE — nothing counted forward off those dates and
-- said "the water heater flush is due" anywhere a manager would see it without
-- opening that tab and reading the Overdue band on purpose.
--
-- This migration is the three things that gap needs, and NOT a second table.
--
-- ═══ WHY THERE IS NO NEW `pm_schedules` TABLE ═══
-- The obvious build for "preventive maintenance" is a fresh schedule table with
-- property/name/interval/last_done. That table already exists, is already wired
-- to a working entry screen, and already has this hotel's real data in it.
-- Adding a second one would have given the hotel TWO upkeep lists that disagree
-- with each other — the seven rows the manager already typed sitting in the old
-- one, a new empty screen next to it — and the first symptom would have been a
-- due card for a task somebody had already marked done in the other list.
-- CLAUDE.md's rule is "extend before you add"; this is the case it is about.
--
-- ── 1. `called_at` — the resting state ────────────────────────────────────
-- The founder's loop has two buttons on a due card. "Done" restarts the clock,
-- which `last_completed_at` already models. "Somebody's been called" is the
-- other half and had nowhere to live: it means the physical work is arranged
-- but not finished, so the card should go quiet AND come back to ask. That is a
-- third state — not due, not done — and it needs its own column because
-- inferring it from anything else would be a guess.
--
-- ── 2. `work_orders.preventive_task_id` — the loop closure ────────────────
-- A due card offers to put the job on the maintenance board. When somebody then
-- CLOSES that work order, the preventive task is, in fact, done — and a system
-- that made the manager say so twice would be a system that lies about its own
-- dates the first time they forget. The link column plus the trigger below make
-- that automatic wherever the close happens: the board, an API, a backfill.
-- Doing it in the app instead would mean every present and future close path
-- had to remember, and the one that forgot would fail silently.
--
-- ── 3. The verify branch for a preventive offer ───────────────────────────
-- `staxis_execute_finding_action` (0363) re-derives a finding's receipt inside
-- the transaction that would do the work and declines when the facts moved. For
-- a repeat-work-order offer the fact is "these tickets are still open". For a
-- preventive offer it is "this task is still due, and nobody has marked it done
-- since Staxis offered". Without the second branch, a manager who marked the
-- flush done on Monday could tap Tuesday's stale card and get a work order for
-- a job that is finished — the exact class of thing the re-verification exists
-- to refuse.
--
-- ACCESS MODEL — UNCHANGED, DELIBERATELY.
-- `preventive_tasks` is not deny-all like `findings` is: it carries four RLS
-- policies (0001 + 0131 + the equipment-manage set) and the Preventive tab reads
-- it through the browser client with a realtime subscription. That is correct
-- and is NOT the RLS bug class — Maintenance is a signed-in manager section, not
-- a publicly-linkable page, so `authenticated` is a real role here and
-- `user_owns_property` is a real wall. Making this table deny-all to match the
-- findings layer would have broken the live tab for no security gain. The new
-- columns inherit those policies; grants are table-level, so they need no
-- re-grant. Everything the findings layer itself does to this table goes through
-- service-role behind loadManagerCaller + managerManagesHotel.
--
-- NOT APPLIED automatically — migrations are applied by hand (CLAUDE.md).
-- Idempotent; safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. The resting state ───────────────────────────────────────────────────
alter table public.preventive_tasks
  add column if not exists called_at timestamptz,
  add column if not exists called_by text;

comment on column public.preventive_tasks.called_at is
  'Somebody has been called about this overdue task but the work has not happened yet. Set by the "Somebody has been called" button on a due card; CLEARED whenever last_completed_at moves forward. While it is set and recent, the pm_due detector stays quiet; once the follow-up window has passed, the card comes back asking whether the work happened. Added 0366.';

comment on column public.preventive_tasks.called_by is
  'Display name of whoever said somebody had been called. Free text, same convention as last_completed_by.';

-- A called_at in the future would make the follow-up never fire and the card
-- never come back — a task that has been silenced forever by a typo. The
-- database refuses it rather than leaving a silent hole in the loop.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'preventive_tasks_called_at_not_future'
  ) then
    alter table public.preventive_tasks
      add constraint preventive_tasks_called_at_not_future
      check (called_at is null or called_at <= now() + interval '1 day') not valid;
  end if;
end $$;

-- ── 2. The link that closes the loop ───────────────────────────────────────
-- ON DELETE SET NULL, not CASCADE: deleting an upkeep schedule must never
-- delete maintenance the hotel actually performed. The ticket outlives the
-- schedule that prompted it, exactly as `work_orders.equipment_id` (0249) does.
alter table public.work_orders
  add column if not exists preventive_task_id uuid
    references public.preventive_tasks(id) on delete set null;

comment on column public.work_orders.preventive_task_id is
  'The upkeep schedule this ticket came from, when Staxis created it from a due card. Closing the ticket stamps that schedule as done (staxis_preventive_task_closed_by_work_order). Null on every ordinary work order. Added 0366.';

create index if not exists work_orders_preventive_task_idx
  on public.work_orders (preventive_task_id)
  where preventive_task_id is not null;

-- ── 3. Closing the ticket IS doing the job ─────────────────────────────────
--
-- MONOTONIC, ON PURPOSE. The guard is `last_completed_at is null or
-- last_completed_at < v_done_at`, so this can only ever move the date FORWARD.
-- Both orderings of the two honest paths therefore end in the same place: a
-- manager who taps "Done" on the card and then closes the ticket a day later
-- keeps the later date, and a manager who closes the ticket first and taps
-- nothing keeps the ticket's. Without the guard, closing a stale ticket months
-- afterwards would silently drag a current schedule's last-done backwards and
-- make a task that is up to date report as overdue.
--
-- `called_at` is cleared in the same statement: the work happened, so there is
-- nothing left to follow up about, and a stale called_at would suppress the
-- NEXT cycle's due card.
create or replace function public.staxis_preventive_task_closed_by_work_order()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_done_at timestamptz;
begin
  -- Only the transition INTO resolved, and only for a ticket that came from a
  -- schedule. Re-saving an already-closed ticket must not re-stamp anything.
  if new.preventive_task_id is null then
    return new;
  end if;
  if coalesce(new.status, 'submitted') <> 'resolved' then
    return new;
  end if;
  if tg_op = 'UPDATE' and coalesce(old.status, 'submitted') = 'resolved' then
    return new;
  end if;

  v_done_at := coalesce(new.resolved_at, now());

  update public.preventive_tasks t
     set last_completed_at = v_done_at,
         last_completed_by = coalesce(
           nullif(btrim(coalesce(new.completed_by_name, '')), ''),
           'Work order closed'
         ),
         called_at = null,
         called_by = null
   where t.id = new.preventive_task_id
     and t.property_id = new.property_id
     and (t.last_completed_at is null or t.last_completed_at < v_done_at);

  return new;
end;
$$;

drop trigger if exists staxis_preventive_task_closed_tg on public.work_orders;
create trigger staxis_preventive_task_closed_tg
  after insert or update of status, resolved_at, preventive_task_id
  on public.work_orders
  for each row execute function public.staxis_preventive_task_closed_by_work_order();

-- ── 4. Marking an upkeep task done clears the follow-up ────────────────────
-- The other direction of the same fact. "Done today" on the Preventive tab
-- writes last_completed_at through the browser client and knows nothing about
-- called_at; leaving the flag set there would suppress the next cycle's card.
-- Enforced here rather than in the tab so every writer inherits it — the tab,
-- the API route, a backfill, psql.
create or replace function public.staxis_preventive_task_done_clears_called()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.last_completed_at is distinct from old.last_completed_at
     and new.last_completed_at is not null
     and (old.last_completed_at is null or new.last_completed_at > old.last_completed_at)
     and new.called_at is not distinct from old.called_at then
    new.called_at := null;
    new.called_by := null;
  end if;
  return new;
end;
$$;

drop trigger if exists staxis_preventive_task_done_clears_called_tg on public.preventive_tasks;
create trigger staxis_preventive_task_done_clears_called_tg
  before update of last_completed_at on public.preventive_tasks
  for each row execute function public.staxis_preventive_task_done_clears_called();

-- ── 5. The preventive branch of execute ────────────────────────────────────
--
-- Replaces 0363's function. The create_work_order path now has TWO shapes of
-- verify, told apart by whether the frozen `verify` names a preventive task:
--
--   repeat-location  the tickets that made this a pattern are still open
--   preventive       the schedule still exists and nobody has marked it done
--                    since Staxis offered
--
-- Everything else about the function is 0363 unchanged — same states, same
-- subtransaction, same receipt, same idempotency, same undo shape. The insert
-- gains one column.
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
      -- ── the repeat-location shape (0363, unchanged) ──
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

-- ── 6. Bookkeeping + schema reload ─────────────────────────────────────────
insert into public.applied_migrations (version, description)
values (
  '0366',
  'Preventive maintenance loop. EXTENDS preventive_tasks (0001) rather than adding a second schedule table: called_at/called_by carry the "somebody has been called" resting state that sits between due and done. work_orders.preventive_task_id links a Staxis-created ticket back to the schedule it came from, and staxis_preventive_task_closed_by_work_order stamps last_completed_at when that ticket is closed — monotonic, so it can only move the date forward, whichever of the two honest paths happens first. staxis_preventive_task_done_clears_called clears the follow-up flag whenever last_completed_at advances, so every writer inherits it. staxis_execute_finding_action gains a preventive verify branch (declines when the task was marked done between the offer and the tap) and freezes the schedule link into the created ticket. RLS unchanged: preventive_tasks keeps its existing authenticated policies because the Preventive tab reads it through the browser client and Maintenance is a signed-in section.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
