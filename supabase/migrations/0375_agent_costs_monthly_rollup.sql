-- 0375_agent_costs_monthly_rollup.sql
--
-- The AI books get a permanent summary, so that raw rows can eventually be
-- pruned without any spend figure changing.
--
-- ═══ WHY THIS TABLE EXISTS ═══════════════════════════════════════════════
-- `agent_costs` is the financial record (INV-43: "agent_costs is the BOOKS").
-- It grows one row per billable provider call and had exactly one pruner —
-- ml-retention-purge — which was an unconditional DELETE past a window, and
-- which has been unscheduled since 2026-05-30. So today the table only grows,
-- and the day someone re-enables that purge, money silently leaves the books.
--
-- The fix is not a bigger window. It is: summarise first, prune second, and
-- never prune a month that has not been summarised and verified. This table is
-- the summary. `agent_costs` remains the source of truth for everything inside
-- the retention window; this table is what survives beyond it.
--
-- ═══ THE GRAIN, AND WHY EACH COLUMN IS IN THE KEY ════════════════════════
-- One row per (month, property, feature, model, kind, state, swept). Every
-- column in that key is there because some live reader groups or filters by it,
-- and a dimension dropped here is a question that can never be answered again
-- once the raw rows are gone:
--
--   month     — the bucket. `date_trunc('month', created_at at time zone 'UTC')`.
--   property  — per-hotel spend; NOT NULL on the source, so never NULL here.
--   feature   — /admin/ai-staff sums per AI employee (0374). NULLABLE, and the
--               null is meaningful: rows written before 0374 have no
--               recoverable job and must keep reading as unattributed rather
--               than being lumped into some bucket. Hence the coalesce in the
--               unique index below rather than a NOT NULL default.
--   model     — the AI Control Center recommendations tab groups by model, and
--               the knowledge-embedding budget filters on it.
--   kind      — /api/agent/metrics splits request / background / eval / audio /
--               vision.
--   state     — 'reserved' vs 'finalized'. Kept rather than filtered because
--               the readers DISAGREE: the AI-staff figure counts only
--               finalized, but the recommendations tab counts everything. A
--               rollup that pre-filtered to finalized would silently change the
--               second number.
--   swept     — a swept hold is a reservation that timed out and was zeroed. It
--               is not money. Same reasoning as `state`: some readers exclude
--               it, so the distinction has to survive.
--
-- ═══ WHAT IS SUMMED ══════════════════════════════════════════════════════
-- cost_usd is numeric(10,6) on the source. The sum column is numeric(14,6):
-- same scale, six more digits of headroom, so a fold is EXACT — no float, no
-- rounding, no drift. Token counts and a row count come along because
-- /api/agent/metrics reports them and they cost nothing to carry.
--
-- ═══ THIS MIGRATION IS ADDITIVE ══════════════════════════════════════════
-- It creates a table and a function. It does NOT delete a single row, and it
-- does not alter `agent_costs`. Applying it changes no number on any screen.

create table if not exists public.agent_costs_monthly (
  id uuid primary key default gen_random_uuid(),

  -- ── the grain ──────────────────────────────────────────────────────────
  month        date        not null,
  property_id  uuid        not null references public.properties(id) on delete cascade,
  feature      text,
  model        text,
  kind         text        not null,
  state        text        not null,
  swept        boolean     not null,

  -- ── the money ──────────────────────────────────────────────────────────
  -- Wider than the source's numeric(10,6) so a month of rows cannot overflow
  -- the sum, and the SAME scale so the fold is exact.
  cost_usd              numeric(14,6) not null default 0,
  tokens_in             bigint        not null default 0,
  tokens_out            bigint        not null default 0,
  cached_input_tokens   bigint        not null default 0,
  row_count             bigint        not null default 0,

  -- ── the audit trail of the fold itself ─────────────────────────────────
  -- earliest/latest let a reader state the true span a summarised month
  -- covers, which is what keeps the "attributed since" caveat on
  -- /admin/ai-staff honest after the raw rows are gone.
  earliest_created_at timestamptz not null,
  latest_created_at   timestamptz not null,

  -- Stamped only once the fold has been checked against the raw sum. A month
  -- with a NULL here has NOT been verified and its raw rows MUST NOT be
  -- pruned. This column is the entire safety interlock.
  verified_at timestamptz,

  built_at   timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per grain. `coalesce` on the nullable dimensions because NULL is
-- never equal to NULL in a unique index, which would let duplicate rows
-- accumulate for exactly the unattributed history we most need to count once.
create unique index if not exists agent_costs_monthly_grain_uq
  on public.agent_costs_monthly (
    month,
    property_id,
    coalesce(feature, ''),
    coalesce(model, ''),
    kind,
    state,
    swept
  );

-- The read patterns: "this month, everything" and "this feature over time".
create index if not exists agent_costs_monthly_month_idx
  on public.agent_costs_monthly (month desc);
create index if not exists agent_costs_monthly_feature_idx
  on public.agent_costs_monthly (feature, month desc) where feature is not null;

comment on table public.agent_costs_monthly is
  'Per-month summary of agent_costs, at the grain every live spend reader groups by. '
  'Written by /api/cron/agent-costs-rollup. A month may only have its raw agent_costs '
  'rows pruned AFTER verified_at is stamped, which happens only when this summary''s '
  'sum matches the raw sum exactly. See INV-43.';

comment on column public.agent_costs_monthly.verified_at is
  'The safety interlock. NULL = this month has not been proven to match the raw rows, '
  'so its raw rows must not be deleted. Stamped by the rollup cron only after an exact '
  'sum comparison.';

-- ═══ RLS: deny-all ═══════════════════════════════════════════════════════
-- This is fleet-wide financial data. It is read by service-role code only
-- (the same posture as agent_costs' own admin reads). RLS on with NO policies
-- = deny-all for anon and authenticated, which is the intended state; the
-- doctor's RLS-coverage check has a service-role allowlist that this table is
-- added to in the same change.
alter table public.agent_costs_monthly enable row level security;

revoke all on public.agent_costs_monthly from anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- staxis_rollup_agent_costs_month(p_month date)
--
-- Folds one whole month of agent_costs into agent_costs_monthly, then VERIFIES
-- the fold and stamps verified_at only if it is exact.
--
-- Idempotent: re-running for the same OPEN month recomputes from the raw rows
-- and overwrites. That matters because a month is only final once it is over —
-- the cron re-folds the current month harmlessly every night, and the numbers
-- simply firm up.
--
-- ═══ TWO GUARDS, AND WHY EACH ONE IS LOAD-BEARING ════════════════════════
--
-- GUARD 1 — a verified month is FROZEN. Re-folding a month whose raw rows have
--   already been pruned would be a disaster: the fold would find zero raw rows,
--   the `delete` below would drop the real summary, and the insert would put
--   nothing back. The month's money would vanish from the books entirely, and
--   the verification step would even agree with itself (0 = 0). So the very
--   first thing this function does is refuse to touch a month that already
--   carries `verified_at`. Once a month is verified it is immutable, and a
--   closed month cannot gain new rows anyway (created_at is now() at insert).
--
-- GUARD 2 — only a month that is OVER may be verified. The current month is
--   still growing; stamping it verified would freeze it mid-month by Guard 1
--   and every later row would be summarised nowhere. So the stamp is withheld
--   until the month has ended, which also means the current month can never be
--   pruned.
--
-- Together: open months re-fold freely and are never pruned; closed months
-- verify once and are then frozen; only frozen months are prunable.
--
-- Returns one row: what it folded and whether it verified.
--
-- ═══ WHAT `verified` MEANS IN THE RETURN ROW ═════════════════════════════
-- `verified` = "the fold reproduces the raw sum and row count exactly". It is
-- NOT the same as "this month is now prunable". An OPEN month can be perfectly
-- correct — and returns verified=true — while deliberately carrying no
-- `verified_at` stamp, because Guard 2 withholds the stamp until the month is
-- over. That is why the two are separate: the return value is a health signal
-- the cron logs, and the DURABLE STAMP is the only thing that authorises a
-- prune. /api/cron/agent-costs-rollup re-reads the stamp from the table
-- immediately before deleting anything and never prunes on this boolean.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.staxis_rollup_agent_costs_month(p_month date)
returns table (
  month           date,
  grains          bigint,
  rows_folded     bigint,
  raw_cost_usd    numeric,
  rolled_cost_usd numeric,
  verified        boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- The bucket label. Computed as a pure DATE, never by casting a timestamptz.
  --
  -- Casting v_start to date would be a real bug: v_start is a timestamptz, and
  -- casting one to date resolves it in the SESSION's timezone. At any negative UTC
  -- offset that lands on the last day of the PREVIOUS month — 2026-01-01 was
  -- stored as 2025-12-31 — so every bucket was mislabelled, and the cron's
  -- freeze/prune matching (which compares 'YYYY-MM-01' strings) silently
  -- stopped lining up with the rows. Caught by the PGlite integration test,
  -- which runs at a non-UTC offset; production Postgres defaults to UTC and
  -- would have hidden it until someone changed the session timezone.
  v_month date;
  v_start timestamptz;
  v_end   timestamptz;
  v_raw_cost    numeric;
  v_raw_rows    bigint;
  v_rolled_cost numeric;
  v_rolled_rows bigint;
  v_grains      bigint;
  v_ok          boolean;
begin
  -- Month boundaries in UTC. The source column is timestamptz, so this is an
  -- unambiguous half-open range [start, end) — no row lands in two months and
  -- none falls between them.
  v_month := date_trunc('month', p_month::timestamp)::date;
  v_start := date_trunc('month', p_month::timestamp) at time zone 'UTC';
  v_end   := (date_trunc('month', p_month::timestamp) + interval '1 month') at time zone 'UTC';

  -- ── GUARD 1: a verified month is frozen. Never re-fold it ───────────────
  -- See the header. Without this, re-folding a month whose raw rows were
  -- already pruned would delete the summary and replace it with nothing.
  if exists (
    select 1 from public.agent_costs_monthly
     where agent_costs_monthly.month = v_month
       and agent_costs_monthly.verified_at is not null
  ) then
    return query
      select v_month,
             count(*)::bigint,
             coalesce(sum(acm.row_count), 0)::bigint,
             coalesce(sum(acm.cost_usd), 0)::numeric,
             coalesce(sum(acm.cost_usd), 0)::numeric,
             true
        from public.agent_costs_monthly acm
       where acm.month = v_month;
    return;
  end if;

  -- ── 1. The raw truth, measured BEFORE we write anything ─────────────────
  select coalesce(sum(cost_usd), 0), count(*)
    into v_raw_cost, v_raw_rows
    from public.agent_costs
   where created_at >= v_start and created_at < v_end;

  -- ── 2. Fold ─────────────────────────────────────────────────────────────
  -- Deliberately clears the month first rather than relying on the upsert
  -- alone: if a grain existed last night and has no rows tonight (a row was
  -- corrected away), a pure upsert would leave the stale grain behind and the
  -- verification below would fail for a reason nobody could find.
  delete from public.agent_costs_monthly where agent_costs_monthly.month = v_month;

  insert into public.agent_costs_monthly (
    month, property_id, feature, model, kind, state, swept,
    cost_usd, tokens_in, tokens_out, cached_input_tokens, row_count,
    earliest_created_at, latest_created_at, updated_at
  )
  select
    v_month,
    ac.property_id,
    ac.feature,
    ac.model,
    ac.kind,
    ac.state,
    (ac.swept_at is not null),
    sum(ac.cost_usd),
    sum(coalesce(ac.tokens_in, 0)),
    sum(coalesce(ac.tokens_out, 0)),
    sum(coalesce(ac.cached_input_tokens, 0)),
    count(*),
    min(ac.created_at),
    max(ac.created_at),
    now()
  from public.agent_costs ac
  where ac.created_at >= v_start and ac.created_at < v_end
  group by ac.property_id, ac.feature, ac.model, ac.kind, ac.state, (ac.swept_at is not null);

  get diagnostics v_grains = row_count;

  -- ── 3. Verify: the fold must reproduce the raw sum EXACTLY ──────────────
  -- Both sides are numeric, so `=` is exact decimal equality. No epsilon, on
  -- purpose: this is money, and "close enough" is how a ledger starts drifting.
  select coalesce(sum(cost_usd), 0), coalesce(sum(row_count), 0)
    into v_rolled_cost, v_rolled_rows
    from public.agent_costs_monthly
   where agent_costs_monthly.month = v_month;

  v_ok := (v_rolled_cost = v_raw_cost) and (v_rolled_rows = v_raw_rows);

  -- Stamp the interlock only on an exact match, and only once the month is
  -- OVER (Guard 2 — see the header). On mismatch, or mid-month, verified_at
  -- stays NULL, which is what forbids the pruner from touching this month.
  if v_ok and v_end <= now() then
    update public.agent_costs_monthly
       set verified_at = now()
     where agent_costs_monthly.month = v_month;
  end if;

  return query select
    v_month, v_grains, v_raw_rows, v_raw_cost, v_rolled_cost, v_ok;
end;
$$;

revoke all on function public.staxis_rollup_agent_costs_month(date) from public, anon, authenticated;
grant execute on function public.staxis_rollup_agent_costs_month(date) to service_role;

comment on function public.staxis_rollup_agent_costs_month(date) is
  'Folds one month of agent_costs into agent_costs_monthly and stamps verified_at only '
  'if the folded sum equals the raw sum exactly. Idempotent — safe to re-run for the '
  'current month every night.';


-- ═══════════════════════════════════════════════════════════════════════════
-- staxis_agent_costs_attribution_start()
--
-- The true first moment of attributed spend, across BOTH the surviving raw
-- rows and the summary.
--
-- Why this needs to exist: /admin/ai-staff prints "spend attributed since X" by
-- scanning agent_costs for the oldest row with a non-null feature. The moment
-- any raw row is pruned, that scan starts returning the oldest SURVIVING row —
-- so the screen would quietly claim attribution began later than it did, and
-- the caveat it exists to show would retire itself. Reading the summary too
-- keeps the sentence true after a prune.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.staxis_agent_costs_attribution_start()
returns timestamptz
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select least(
    (select min(created_at) from public.agent_costs where feature is not null),
    (select min(earliest_created_at) from public.agent_costs_monthly where feature is not null)
  );
$$;

revoke all on function public.staxis_agent_costs_attribution_start() from public, anon, authenticated;
grant execute on function public.staxis_agent_costs_attribution_start() to service_role;

comment on function public.staxis_agent_costs_attribution_start() is
  'Oldest attributed spend across surviving raw rows AND the monthly summary. Keeps the '
  '"attributed since" note on /admin/ai-staff honest once raw rows are pruned.';

INSERT INTO public.applied_migrations (version, description)
VALUES ('0375', 'agent_costs_monthly: a permanent per-month summary of the AI books, at the grain every live spend reader groups by (month, property, feature, model, kind, state, swept), so raw agent_costs rows can eventually be pruned without any spend figure changing. staxis_rollup_agent_costs_month folds a month and stamps verified_at ONLY when the fold reproduces the raw sum and row count exactly — that stamp is the interlock the pruner requires. Two guards: a verified month is frozen and never re-folded (re-folding a pruned month would delete the summary and put nothing back), and only a month that is OVER may be verified. staxis_agent_costs_attribution_start spans the raw rows and the summary so the "attributed since" note on /admin/ai-staff stays true after a prune. Additive: deletes nothing, alters nothing, changes no number on any screen.')
ON CONFLICT (version) DO NOTHING;
