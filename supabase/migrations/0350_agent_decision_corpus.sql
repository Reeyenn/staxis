-- 0350: The decision/outcome corpus.
--
-- WHY THIS TABLE EXISTS AT ALL (it is a new surface; here is the justification)
--
-- Every AI action today is recorded in agent_pending_actions, which is FK'd
-- ON DELETE CASCADE to BOTH agent_conversations and accounts (migration 0300,
-- lines 49-51). Archive a conversation or offboard the GM who used the copilot
-- and the record of what the AI proposed, what the human did about it, and
-- whether it worked is deleted. A track record that disappears when a manager
-- quits is not a track record.
--
-- agent_decisions therefore deliberately does NOT cascade:
--   conversation_id  — NO foreign key at all (survives archive/purge)
--   actor_account_id — ON DELETE SET NULL (survives the employee)
--   property_id      — ON DELETE CASCADE (deleting a hotel SHOULD delete its
--                      data; that is a customer-offboarding requirement)
--
-- WHAT IT CAPTURES THAT NOTHING ELSE DOES
--
-- 1. state_snapshot — buildHotelSnapshot() output is stringified into the
--    system prompt on every turn and then discarded. "What did the AI see when
--    it said that?" is currently unanswerable, and every day without the
--    capture is a day of it permanently lost. Stored inline as jsonb (~2-4 KB;
--    noise against a 42 MB database) with state_snapshot_hash present from day
--    one so a content-addressed dedup table is a mechanical migration later if
--    volume ever justifies one. Do NOT build that table now.
--
-- 2. args_diff — the human-correction signal. A correction of a factual premise
--    first: agent_pending_actions.tool_args is NOT overwritten when a user
--    edits an action card (resolve-action/route.ts computes effectiveArgs as a
--    local and never writes it back; finalizePendingAction persists only
--    status/result/error). So the model's PROPOSAL survives today and the
--    EXECUTED args are what is lost. Capturing executed_args and diffing it
--    against proposed_args is what turns "the human approved" into "the human
--    approved after changing the recipient" — the most valuable training signal
--    in the whole table, and it is free at write time.
--    Computed by a DB TRIGGER, not in TypeScript, so it cannot be forgotten by
--    a future call site.
--
-- 3. decision_ms — hesitation. Also free.
--
-- Deferred on purpose (columns present, writer not built): outcome_kind /
-- outcome_observed_at / outcome_facts. Populating them needs a per-tool
-- outcome probe on every mutating tool plus a daily cron; the columns land now
-- so that work is a code change rather than another migration.

begin;

-- ─── agent_decisions ───────────────────────────────────────────────────────
-- @rls: service-role-only — written by server routes, read by admin/analysis
-- paths via supabaseAdmin. Never browser-readable: the state snapshot carries
-- per-hotel operational counts. RLS is enabled with an explicit deny-all
-- browser policy below.

create table if not exists public.agent_decisions (
  id uuid primary key default gen_random_uuid(),

  -- Tenancy (DINV-1). Cascades: offboarding a hotel removes its data.
  property_id uuid not null references public.properties(id) on delete cascade,

  occurred_at timestamptz not null default now(),
  -- DINV-2: the hotel's LOCAL business date, supplied by the writer from the
  -- property timezone. A trigger cannot derive it (the row cannot see the
  -- property's timezone without a lookup that would silently rewrite intent).
  business_date date not null,

  surface text not null check (surface in ('chat','voice','walkthrough','cron','api')),

  -- Who decided, and how.
  actor_kind text not null check (actor_kind in (
    'ai_proposed',     -- the model proposed; no human verdict yet
    'human_approved',  -- approved as proposed
    'human_denied',    -- rejected
    'human_edited',    -- approved after changing the arguments
    'ai_autonomous',   -- executed with no approval gate (read-only/quick tier)
    'human_direct'     -- a human did it without the AI
  )),
  -- SET NULL, not CASCADE: the decision outlives the employee.
  actor_account_id uuid references public.accounts(id) on delete set null,
  actor_role text,

  -- NO foreign key on purpose. agent_conversations is archived and purged;
  -- the corpus must not be.
  conversation_id uuid,
  -- Same reasoning: agent_pending_actions cascades away, this link must not.
  pending_action_id uuid,

  tool_name text not null,
  proposed_args jsonb not null default '{}'::jsonb,
  executed_args jsonb,
  -- Written by the trigger below. Keys where proposed != executed.
  args_diff jsonb,

  decision_ms integer check (decision_ms is null or decision_ms >= 0),

  -- What the hotel looked like at decision time.
  state_snapshot jsonb not null,
  state_snapshot_hash text not null,

  model_id text,
  prompt_version text,

  result jsonb,
  error text,

  -- Outcome layer (columns now, probes later — see the header).
  outcome_kind text check (outcome_kind is null or outcome_kind in (
    'stood','reverted','superseded','not_observable','unknown'
  )),
  outcome_observed_at timestamptz,
  outcome_facts jsonb,

  -- Explicit human verdict, mirrored from user_feedback by the trigger below.
  feedback_rating smallint check (feedback_rating is null or feedback_rating in (-1, 0, 1)),
  feedback_note text,
  feedback_at timestamptz,
  feedback_by uuid references public.accounts(id) on delete set null,

  created_at timestamptz not null default now()
);

create index if not exists agent_decisions_property_time_idx
  on public.agent_decisions (property_id, occurred_at desc);
create index if not exists agent_decisions_tool_idx
  on public.agent_decisions (tool_name, occurred_at desc);
create index if not exists agent_decisions_pending_idx
  on public.agent_decisions (pending_action_id)
  where pending_action_id is not null;
-- Drives the future outcome-probe cron: rows past their window with no verdict.
create index if not exists agent_decisions_outcome_pending_idx
  on public.agent_decisions (occurred_at)
  where outcome_kind is null;

-- ─── Append-only-ish: the PROPOSAL is immutable ────────────────────────────
-- The proposal and the state it was made against are historical fact. Only the
-- resolution/outcome/feedback columns may be filled in afterwards. Enforced by
-- a trigger rather than by convention, because "we only ever update the
-- outcome columns" is exactly the kind of rule that quietly stops being true.
create or replace function public.staxis_agent_decisions_immutable()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.property_id     is distinct from old.property_id
  or new.occurred_at     is distinct from old.occurred_at
  or new.business_date   is distinct from old.business_date
  or new.tool_name       is distinct from old.tool_name
  or new.proposed_args   is distinct from old.proposed_args
  or new.state_snapshot  is distinct from old.state_snapshot
  or new.state_snapshot_hash is distinct from old.state_snapshot_hash
  or new.conversation_id is distinct from old.conversation_id then
    raise exception
      'agent_decisions: the proposal and its state snapshot are immutable (row %)', old.id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists agent_decisions_immutable on public.agent_decisions;
create trigger agent_decisions_immutable
  before update on public.agent_decisions
  for each row execute function public.staxis_agent_decisions_immutable();

-- ─── args_diff is computed by the DB, never by a call site ─────────────────
create or replace function public.staxis_agent_decisions_args_diff()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  diff jsonb := '{}'::jsonb;
  k text;
begin
  if new.executed_args is null then
    new.args_diff := null;
    return new;
  end if;
  for k in
    select jsonb_object_keys(coalesce(new.proposed_args, '{}'::jsonb))
    union
    select jsonb_object_keys(new.executed_args)
  loop
    if (new.proposed_args -> k) is distinct from (new.executed_args -> k) then
      diff := diff || jsonb_build_object(
        k,
        jsonb_build_object('proposed', new.proposed_args -> k, 'executed', new.executed_args -> k)
      );
    end if;
  end loop;
  new.args_diff := diff;
  return new;
end;
$$;

drop trigger if exists agent_decisions_args_diff on public.agent_decisions;
create trigger agent_decisions_args_diff
  before insert or update of executed_args, proposed_args on public.agent_decisions
  for each row execute function public.staxis_agent_decisions_args_diff();

-- ─── RLS: service-role only ────────────────────────────────────────────────
-- @rls: service-role-only — the corpus is written by server routes and read by
-- admin/analysis paths via supabaseAdmin. Never browser-readable: the state
-- snapshot includes per-hotel operational counts.
alter table public.agent_decisions enable row level security;
revoke all on public.agent_decisions from public, anon, authenticated;
drop policy if exists agent_decisions_deny_all_browser on public.agent_decisions;
create policy agent_decisions_deny_all_browser
  on public.agent_decisions for all
  using (false) with check (false);

comment on table public.agent_decisions is
  'Append-only record of every AI decision: what was proposed, what the hotel looked like at the time, what the human did, and (later) whether it held up. Deliberately survives conversation archive and employee offboarding — see 0350 header.';
comment on column public.agent_decisions.conversation_id is
  'NO foreign key on purpose: agent_conversations is archived/purged and the corpus must outlive it.';
comment on column public.agent_decisions.state_snapshot is
  'buildHotelSnapshot() output at decision time, PII-redacted. Without it "what did the AI see" is unreconstructable.';
comment on column public.agent_decisions.args_diff is
  'Keys where the executed args differ from the proposed args — the human-correction signal. Written by a trigger, never by a call site.';

-- ─── agent_pending_actions: capture what actually RAN ──────────────────────
-- The proposal survives today; the executed args do not. These three columns
-- close that gap on the existing row as well, so the approval flow keeps a
-- complete record even for rows written before agent_decisions existed.
alter table public.agent_pending_actions
  add column if not exists executed_args jsonb,
  add column if not exists state_snapshot_hash text,
  add column if not exists decision_ms integer;

comment on column public.agent_pending_actions.executed_args is
  'The args the tool actually ran with (post-edit). Differs from tool_args when the user adjusted the card.';

-- ─── user_feedback: link a report to the decision it is about ──────────────
-- Extension, not a new table or a new route. The existing POST /api/feedback
-- carries the new categories; the CHECK below must widen or every such insert
-- is rejected (the original 0052 constraint allows only five categories).
alter table public.user_feedback
  add column if not exists decision_id uuid references public.agent_decisions(id) on delete set null,
  add column if not exists rating smallint,
  add column if not exists eval_case_name text;

alter table public.user_feedback
  drop constraint if exists user_feedback_category_check;
alter table public.user_feedback
  add constraint user_feedback_category_check check (category in (
    'bug','feature_request','general','complaint','love',
    -- New: a thumbs verdict on a specific AI answer/action.
    'ai_answer',
    -- New: "the AI got this wrong". Closing one of these is what obliges
    -- someone to name the permanent eval case that now covers it.
    'ai_wrong'
  ));

alter table public.user_feedback
  drop constraint if exists user_feedback_rating_check;
alter table public.user_feedback
  add constraint user_feedback_rating_check check (rating is null or rating in (-1, 0, 1));

create index if not exists user_feedback_decision_idx
  on public.user_feedback (decision_id)
  where decision_id is not null;

comment on column public.user_feedback.eval_case_name is
  'The EvalCase.name that now permanently covers this report. An ai_wrong report cannot honestly be resolved without one.';

-- Mirror the rating onto the decision so the corpus read path is single-table.
-- DB-enforced sync, not code-enforced: a second write path cannot forget it.
create or replace function public.staxis_mirror_feedback_to_decision()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.decision_id is not null and new.rating is not null then
    update public.agent_decisions
       set feedback_rating = new.rating,
           feedback_note   = new.message,
           feedback_at     = now()
     where id = new.decision_id;
  end if;
  return new;
end;
$$;

drop trigger if exists user_feedback_mirror_decision on public.user_feedback;
create trigger user_feedback_mirror_decision
  after insert or update of rating, decision_id on public.user_feedback
  for each row execute function public.staxis_mirror_feedback_to_decision();

-- ─── Retention ─────────────────────────────────────────────────────────────
-- Recorded here rather than by editing 0103: that migration is already applied,
-- so edits to it never reach the database.
comment on table public.agent_decisions is
  'Append-only AI decision corpus. EXEMPT FROM RETENTION PURGE — see EXEMPT_FROM_PURGE in src/app/api/cron/ml-retention-purge/route.ts and the disjointness test in src/lib/__tests__/retention-purge-exemptions.test.ts. A corpus a cron can delete is not a corpus.';

insert into public.applied_migrations (version, description)
values (
  '0350',
  'Agent decision/outcome corpus: agent_decisions (survives conversation + account deletion), executed-args capture on agent_pending_actions, user_feedback decision link + ai_answer/ai_wrong categories'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
