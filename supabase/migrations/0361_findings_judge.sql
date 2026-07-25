-- ═══════════════════════════════════════════════════════════════════════════
-- 0361 — The findings judge: what the model is allowed to say, and what it cost.
--
-- WHAT THIS IS
-- 0360 gave every problem one row and one deterministic, template-generated
-- sentence. This migration adds the columns a MODEL may write to — and nothing
-- else. The judge sorts survivors into propose/recommend/fyi/ask/drop, phrases
-- each in English and Spanish, and explains itself in one line. It may reorder,
-- phrase and sort. It may not add a finding, change a number, change a price
-- range, or bring back something the silencer killed.
--
-- WHY THE JUDGE GETS ITS OWN COLUMNS INSTEAD OF OVERWRITING THE OLD ONES
-- `summary` and `disposition` stay exactly what the DETECTOR decided, forever.
-- The judge writes alongside them. Three things fall out of that:
--   • With the model unavailable, malformed, over budget, or caught lying, the
--     row still means something — there is a deterministic sentence and a
--     deterministic verdict underneath, written by code.
--   • "What did the model change?" is a column comparison, not an archaeology
--     project.
--   • A future phase can turn the judge off and lose phrasing, not findings.
--
-- `judged_input_hash` is what stops us paying for the same judgement every
-- night: it fingerprints exactly the fields the judge was shown. Same hash ⇒
-- nothing it saw has moved ⇒ no call. A finding whose evidence changed gets a
-- new hash and is re-judged. Zero new/updated findings means zero model calls,
-- which is the whole cost story on a quiet night.
--
-- `judged_source` records WHO wrote the phrasing: 'model' when the model's text
-- survived the numeric/entity guard, 'template' when it did not (or when there
-- was no call at all). The guard is the mechanical twin of fake-success-guard:
-- every numeral and named entity in the generated prose must appear in the
-- finding's structured payload, or the phrasing is discarded before it is ever
-- stored. `judged_guard_rejected` is the per-row record that this happened, so
-- the model's miss rate is a query rather than a hunch.
--
-- ── the money ──────────────────────────────────────────────────────────────
-- INV-17: the agent cost caps deliberately count only kind='request'. Every
-- background row — summaries, consolidation, and now the judge — is excluded
-- ON PURPOSE, so user-facing chat can never be starved by a cron. The
-- consequence is that background work has no ceiling at all, which was fine
-- when background work was a handful of Haiku calls and is not fine now that a
-- nightly per-hotel judge exists.
--
-- `findings_ai_spend` is that ceiling: a small, dedicated, per-hotel-per-day
-- ledger with the same reserve → finalize/cancel discipline as
-- `staxis_reserve_agent_spend` (0082), including the advisory lock, because
-- check-then-write is racy and this is exactly the shape that bit us before.
--
-- Why not extend agent_costs (the "extend before you add" justification):
--   • `agent_costs.user_id` is NOT NULL. A nightly cron has no user; the
--     consolidator borrows a "representative manager", which is null for a
--     hotel with no manager row — the spend then cannot be booked at all.
--   • `staxis_reserve_agent_spend` hard-codes kind='request' in three sums.
--     Making it cap background work means widening the signature of a function
--     that every user-facing chat turn calls, and dropping/recreating it. 0358
--     recorded the same reasoning for a different function; the lesson held.
--   • Booking judge spend as kind='request' would silently shrink the hotel's
--     chat budget and inflate the "what did users cost us" screens.
-- The judge still writes its real usage to `agent_costs` as kind='background'
-- like every other background caller, so the spend screens stay complete. This
-- table is the GATE, not the books.
--
-- Day boundary is UTC, matching agent_costs, so the two ledgers agree about
-- what "today" means.
--
-- NOT APPLIED automatically — migrations are applied by hand (CLAUDE.md).
-- Idempotent. The judge columns are UI-inert until a later phase renders them.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Judge columns on findings ───────────────────────────────────────────
alter table public.findings
  -- The judge's verdict. SEPARATE from `disposition`, which stays whatever the
  -- detector declared. Null = never judged (or judged and dropped by the guard
  -- before a verdict was reached).
  add column if not exists judged_disposition   text,
  -- One or two sentences, in the manager's language. Never the raw model text:
  -- every numeral and named entity in here appeared in this row's structured
  -- payload, or this column holds the deterministic template instead.
  add column if not exists judged_summary_en    text,
  add column if not exists judged_summary_es    text,
  -- Why the judge sorted it where it did. Short, for the audit trail.
  add column if not exists judged_rationale     text,
  -- The judge's ordering within its run. Lower = the judge wanted it seen
  -- first. Advisory: severity and magnitude still exist and still mean what
  -- they meant.
  add column if not exists judged_rank          integer,
  -- 'model'    — the model's phrasing survived the guard and is stored here.
  -- 'template' — deterministic phrasing: no call, a malformed reply, the daily
  --              cap, or the guard caught an unbacked number.
  add column if not exists judged_source        text,
  add column if not exists judged_at            timestamptz,
  -- Which model produced it, when one did. Null on the template path.
  add column if not exists judged_model         text,
  -- Fingerprint of EXACTLY the fields the judge was shown (summary, severity,
  -- magnitude, price, evidence basis, as-of). Unchanged hash ⇒ nothing it
  -- reasoned about moved ⇒ do not pay to judge it again.
  add column if not exists judged_input_hash    text,
  -- True when the guard threw model phrasing away for this row. The model's
  -- miss rate is `count(*) filter (where judged_guard_rejected)`.
  add column if not exists judged_guard_rejected boolean not null default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'findings_judged_disposition_valid'
  ) then
    alter table public.findings add constraint findings_judged_disposition_valid
      check (
        judged_disposition is null
        or judged_disposition in ('propose','recommend','fyi','ask','drop')
      );
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'findings_judged_source_valid'
  ) then
    alter table public.findings add constraint findings_judged_source_valid
      check (judged_source is null or judged_source in ('model','template'));
  end if;

  -- Phrasing is bilingual or it is absent. A row with English but no Spanish
  -- would render as English silently standing in for Spanish on a Spanish
  -- speaker's screen, which is the specific failure the language rule exists to
  -- prevent (CLAUDE.md: every user-facing string is EN + ES).
  if not exists (
    select 1 from pg_constraint where conname = 'findings_judged_phrasing_is_bilingual'
  ) then
    alter table public.findings add constraint findings_judged_phrasing_is_bilingual
      check (
        (judged_summary_en is null and judged_summary_es is null)
        or (judged_summary_en is not null and judged_summary_es is not null)
      );
  end if;
end $$;

-- The queue read, once the UI phase sorts by the judge's ordering.
create index if not exists findings_property_judged_idx
  on public.findings (property_id, judged_disposition, judged_rank)
  where judged_at is not null;

comment on column public.findings.judged_disposition is
  'The judge''s verdict, kept separate from `disposition` so the detector''s deterministic verdict survives an unavailable, malformed, over-budget, or caught-lying model.';

comment on column public.findings.judged_input_hash is
  'Fingerprint of exactly the fields the judge was shown. Same hash means nothing it reasoned about moved, so the nightly run does not pay to judge the row again.';

comment on column public.findings.judged_source is
  'Who wrote the phrasing: ''model'' when the generated text passed the numeric/entity guard, ''template'' when code wrote it instead. Never a mixture within one row.';

comment on column public.findings.judged_guard_rejected is
  'True when the prose guard found a numeral or named entity in the generated text that does not appear in this row''s structured payload, and threw the phrasing away. The model''s miss rate is countable from this column.';

-- ── 2. Judge outcome on finding_runs ───────────────────────────────────────
-- Same reason finding_runs exists at all: a night with no judged findings and a
-- night where the judge was over budget look identical from the findings table.
alter table public.finding_runs
  -- 'no_findings'        nothing new or changed — by design, zero model calls
  -- 'model'              a call was made and its output was used
  -- 'fallback_cap'       the hotel''s daily findings-AI budget was exhausted
  -- 'fallback_error'     the provider failed or timed out
  -- 'fallback_malformed' the reply broke the output contract and was refused
  -- 'skipped'            the judge was switched off for this run
  add column if not exists judge_mode              text,
  add column if not exists judge_findings          integer not null default 0
                             check (judge_findings >= 0),
  add column if not exists judge_cost_usd          numeric not null default 0
                             check (judge_cost_usd >= 0),
  -- How many findings had model phrasing thrown away by the guard this run.
  add column if not exists judge_guard_rejections  integer not null default 0
                             check (judge_guard_rejections >= 0);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'finding_runs_judge_mode_valid'
  ) then
    alter table public.finding_runs add constraint finding_runs_judge_mode_valid
      check (
        judge_mode is null
        or judge_mode in ('no_findings','model','fallback_cap','fallback_error','fallback_malformed','skipped')
      );
  end if;
end $$;

comment on column public.finding_runs.judge_mode is
  'How the night''s phrasing was produced. ''no_findings'' (zero model calls, by design), ''model'', or one of the deterministic fallbacks — cap exhausted, provider failure, or a reply that broke the output contract.';

-- ── 3. findings_ai_spend — the background cap INV-17 leaves out ────────────
-- @rls: service-role-only. Written by the nightly judge, read by nothing in the
-- browser.
create table if not exists public.findings_ai_spend (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references public.properties(id) on delete cascade,

  -- Which background feature spent it. One table, room for the weekly AI sweep
  -- that Phase 3 adds, without a second cap system to reason about.
  feature      text not null default 'findings.judge'
                 check (char_length(feature) between 1 and 64),

  -- reserved  — in flight; counts against the cap, actual spend unknown
  -- finalized — reconciled to what the provider actually charged
  -- cancelled — the hold was released without spend
  state        text not null default 'reserved'
                 check (state in ('reserved','finalized','cancelled')),

  cost_usd     numeric not null default 0 check (cost_usd >= 0),
  model        text,
  model_id     text,
  tokens_in    integer not null default 0 check (tokens_in >= 0),
  tokens_out   integer not null default 0 check (tokens_out >= 0),

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- The cap sum: one hotel, today, rows that still count.
create index if not exists findings_ai_spend_property_day_idx
  on public.findings_ai_spend (property_id, created_at desc)
  where state in ('reserved', 'finalized');

comment on table public.findings_ai_spend is
  'Per-hotel-per-day spend ceiling for the findings layer''s background AI. Exists because the agent cost caps count only kind=''request'' (INV-17) — background work is excluded on purpose so a cron cannot starve user-facing chat, which also left background work with no ceiling at all. Reserve → finalize/cancel under an advisory lock, mirroring staxis_reserve_agent_spend (0082). This is the GATE; the books are still agent_costs (kind=''background''). Service-role-only. Added 0361.';

comment on column public.findings_ai_spend.state is
  'reserved = in flight and counting against the cap; finalized = reconciled to actual provider spend; cancelled = hold released with no spend. Reservations older than the RPC''s abandon window stop counting, so a crashed run cannot lock a hotel out of tomorrow.';

alter table public.findings_ai_spend enable row level security;
revoke all on public.findings_ai_spend from public, anon, authenticated;
grant select, insert, update, delete on public.findings_ai_spend to service_role;
drop policy if exists findings_ai_spend_deny_all on public.findings_ai_spend;
create policy findings_ai_spend_deny_all on public.findings_ai_spend
  for all to anon, authenticated using (false) with check (false);

drop trigger if exists set_updated_at on public.findings_ai_spend;
create trigger set_updated_at before update on public.findings_ai_spend
  for each row execute function public._pms_set_updated_at();

-- ── 4. Reserve / finalize / cancel ─────────────────────────────────────────
--
-- Reserve holds the worst-case cost under a per-hotel advisory lock BEFORE the
-- call, then finalize reconciles it to what actually happened. Check-then-write
-- without the lock is racy: two runners on the same hotel would both read the
-- same pre-write sum and both pass. That exact bug is why 0081/0082 exist.
--
-- Abandoned reservations: a run that dies between reserve and finalize leaves a
-- 'reserved' row forever. The agent ledger solves this with a sweeper cron
-- (0090). This one solves it inside the sum — a reservation older than
-- p_abandon_after_minutes simply stops counting — so there is no cron to
-- forget to schedule and no way for one crash to lock a hotel out of its
-- findings for the rest of the day.
create or replace function public.staxis_reserve_findings_spend(
  p_property_id uuid,
  p_feature text,
  p_estimated_usd numeric,
  p_cap_usd numeric,
  p_abandon_after_minutes integer default 360
)
returns table (
  ok boolean,
  reservation_id uuid,
  reason text,
  property_spend_usd numeric,
  cap_usd numeric
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_lock_key bigint;
  v_day_start timestamptz;
  v_spend numeric;
  v_id uuid;
begin
  if p_estimated_usd is null or p_estimated_usd < 0 then
    raise exception 'staxis_reserve_findings_spend: p_estimated_usd must be >= 0';
  end if;
  if p_cap_usd is null or p_cap_usd < 0 then
    raise exception 'staxis_reserve_findings_spend: p_cap_usd must be >= 0';
  end if;

  -- Keyspace is namespaced by the table name so it cannot collide with the
  -- agent_costs lock keys, which a concurrent chat turn may be holding.
  v_lock_key := ('x' || substr(md5('findings_ai_spend:property:' || p_property_id::text), 1, 16))::bit(64)::bigint;
  perform pg_advisory_xact_lock(v_lock_key);

  -- UTC day, matching agent_costs, so the two ledgers agree on "today".
  v_day_start := date_trunc('day', now() at time zone 'UTC');

  select coalesce(sum(cost_usd), 0)
    into v_spend
    from public.findings_ai_spend
    where property_id = p_property_id
      and created_at >= v_day_start
      and (
        state = 'finalized'
        or (
          state = 'reserved'
          -- An abandoned hold stops counting instead of blocking forever.
          and created_at >= now() - make_interval(mins => greatest(p_abandon_after_minutes, 1))
        )
      );

  if (v_spend + p_estimated_usd) > p_cap_usd then
    return query select false, null::uuid, 'property_daily_cap'::text, v_spend, p_cap_usd;
    return;
  end if;

  insert into public.findings_ai_spend (property_id, feature, state, cost_usd, model)
  values (p_property_id, coalesce(p_feature, 'findings.judge'), 'reserved', p_estimated_usd, 'pending')
  returning id into v_id;

  return query select true, v_id, null::text, v_spend, p_cap_usd;
end;
$$;

comment on function public.staxis_reserve_findings_spend is
  'Atomic per-hotel-per-day cap check and reservation for background findings AI, under a per-property advisory lock. Reservations older than p_abandon_after_minutes stop counting toward the cap, so a crashed run cannot lock a hotel out for the rest of the day. Added 0361.';

create or replace function public.staxis_finalize_findings_spend(
  p_reservation_id uuid,
  p_actual_usd numeric,
  p_model text,
  p_model_id text,
  p_tokens_in integer,
  p_tokens_out integer
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.findings_ai_spend
     set state = 'finalized',
         cost_usd = greatest(coalesce(p_actual_usd, 0), 0),
         model = p_model,
         model_id = p_model_id,
         tokens_in = greatest(coalesce(p_tokens_in, 0), 0),
         tokens_out = greatest(coalesce(p_tokens_out, 0), 0),
         updated_at = now()
   where id = p_reservation_id
     and state = 'reserved';
end;
$$;

comment on function public.staxis_finalize_findings_spend is
  'Reconcile a findings-AI reservation to actual provider spend. No-op when the row was already finalized or cancelled, so a retry cannot double-book. Added 0361.';

create or replace function public.staxis_cancel_findings_spend(
  p_reservation_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.findings_ai_spend
     set state = 'cancelled',
         cost_usd = 0,
         updated_at = now()
   where id = p_reservation_id
     and state = 'reserved';
end;
$$;

comment on function public.staxis_cancel_findings_spend is
  'Release a findings-AI hold without recording spend. Used when the call never reached the provider. Added 0361.';

revoke all on function public.staxis_reserve_findings_spend(uuid, text, numeric, numeric, integer) from public, anon, authenticated;
revoke all on function public.staxis_finalize_findings_spend(uuid, numeric, text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.staxis_cancel_findings_spend(uuid) from public, anon, authenticated;
grant execute on function public.staxis_reserve_findings_spend(uuid, text, numeric, numeric, integer) to service_role;
grant execute on function public.staxis_finalize_findings_spend(uuid, numeric, text, text, integer, integer) to service_role;
grant execute on function public.staxis_cancel_findings_spend(uuid) to service_role;

-- ── 5. Bookkeeping + schema reload ─────────────────────────────────────────
insert into public.applied_migrations (version, description)
values (
  '0361',
  'The findings judge. Judge columns on findings (verdict, EN+ES phrasing, rationale, rank, source, input hash, guard-rejection flag) written ALONGSIDE the detector''s deterministic summary and disposition, never over them — so an unavailable, malformed, over-budget or caught-lying model costs phrasing, not findings. findings_judged_phrasing_is_bilingual refuses half-translated phrasing. judged_input_hash is what makes a quiet night cost nothing. finding_runs gains judge_mode so "no findings to judge" and "over budget" are distinguishable. findings_ai_spend + reserve/finalize/cancel RPCs add the per-hotel-per-day background ceiling that INV-17 deliberately leaves out of the agent caps, with the same advisory-lock discipline as 0082 and a self-healing abandoned-reservation window instead of a sweeper cron.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
