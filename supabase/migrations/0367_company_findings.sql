-- ═══════════════════════════════════════════════════════════════════════════
-- 0367 — company_findings: a problem that belongs to the COMPANY, not a hotel.
--
-- WHAT THIS IS FOR
-- The portfolio checks. "Beaumont spent $800 and Lufkin $1,400 on comparable
-- weeks" is not a fact about Beaumont and it is not a fact about Lufkin — it is
-- a fact about the pair, and the only person it is addressed to is the one who
-- owns both. Same for "3 of your hotels stopped logging maintenance". Neither
-- has a property_id, and inventing one would put a company-level card on some
-- arbitrary hotel's queue.
--
-- ─── WHY A SECOND TABLE AND NOT A COLUMN ON `findings` ─────────────────────
-- "Extend before you add" is the standing rule, and it was the first thing
-- tried. It does not survive contact with the one guarantee the findings ledger
-- exists to provide.
--
-- `findings.property_id` is NOT NULL. To hold a company-scope row it would have
-- to become nullable, and the moment it does:
--
--   1. THE SILENCER BREAKS. The whole one-problem-one-row guarantee is the
--      partial unique index `findings_one_active_per_problem_uq (property_id,
--      dedupe_key)`. In Postgres, NULLs are DISTINCT in a unique index — so
--      every company-scope row would be unique against every other one, and the
--      same portfolio problem would stack a fresh card every single night. That
--      is precisely the failure 0360 was written to make impossible, and it
--      would come back silently: no error, just a growing pile.
--
--   2. THE TENANT WALL GETS A HOLE IN IT. Every read of `findings` in the app
--      goes through `scopedDb(propertyId)`, which applies `property_id = $1`
--      before handing the query builder back — that filter IS the wall, because
--      the table is deny-all RLS. A nullable column means every one of those
--      call sites now has a second case to think about, and the failure mode of
--      forgetting is a company row being invisible (harmless) or a NULL-scoped
--      read reaching rows it should not (not harmless).
--
--   3. ~15 EXISTING READS WOULD EACH NEED TO RE-STATE "and not the company
--      ones". Zero regression on the hotel ledger is worth more than one saved
--      table.
--
-- A separate table gets all three for free: its own NOT NULL organization_id,
-- its own unique index over a column that is never null, and a scoping helper
-- (`scopedCompanyDb` in src/lib/company/company-findings.ts) that cannot be
-- pointed at `findings` by accident. The shape is deliberately a MIRROR of
-- `findings` so the same status vocabulary, the same silencer semantics and the
-- same price-is-a-range rule hold on both sides and one card renderer serves
-- both.
--
-- WHAT IS DELIBERATELY *NOT* HERE
--   • No `company_finding_runs`. The liveness sentence a VP reads ("checked 384
--     things overnight") is the SUM of their own hotels' `finding_runs` rows,
--     which are real, already written, and already per-hotel honest. A second
--     runs table would be a second, weaker copy of an artifact that already
--     exists — and it would be able to disagree with it.
--   • No demotion counters (shown/acted/ignored). Self-demotion is a per-hotel
--     behaviour ("does anyone AT THIS HOTEL read this check"); a company has one
--     reader and demoting a portfolio check on one VP's scrolling is not a thing
--     anybody asked for. Columns that nothing writes are columns that rot.
--
-- ACCESS MODEL — SERVICE-ROLE ONLY, identical to `findings` (0360),
-- `company_knowledge` (0365) and `agent_memory` (0256): anon + authenticated
-- deny-all. The organization_id filter applied in server code IS the tenant
-- boundary, not defence in depth.
--
-- NOT APPLIED automatically — migrations are applied by hand (CLAUDE.md).
-- Idempotent.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. company_findings ────────────────────────────────────────────────────
-- @rls: service-role-only — written by the portfolio checks and read by server
-- code that has already resolved which company the caller wears a hat at.
create table if not exists public.company_findings (
  id                      uuid primary key default gen_random_uuid(),

  -- Tenancy. Cascades: winding up a management company removes what we found
  -- across it. The hotels and their own findings are untouched — they outlive
  -- the operator, which is the real-world relationship.
  organization_id         uuid not null references public.organizations(id) on delete cascade,

  -- Which portfolio check produced this. Stable slug, matches
  -- PortfolioDetector.id in src/lib/company/portfolio.ts.
  detector_id             text not null check (char_length(detector_id) between 1 and 64),

  -- THE identity of the problem, independent of its size. Detector-prefixed.
  -- Never contains the measurement, for the same reason the hotel ledger's does
  -- not: "$800 vs $1,400" and "$800 vs $1,600" are the same problem.
  dedupe_key              text not null check (char_length(dedupe_key) between 1 and 200),

  summary                 text not null check (char_length(summary) between 1 and 500),

  severity                text not null check (severity in ('critical','attention','info')),

  disposition             text not null default 'fyi'
                            check (disposition in ('propose','recommend','fyi','ask','drop')),

  status                  text not null default 'open' check (status in (
                            'open','updated','resolved','known_problem','muted','expired'
                          )),

  -- ── the receipt ──────────────────────────────────────────────────────────
  receipt_query_id        text not null check (char_length(receipt_query_id) between 1 and 120),
  -- { params, values, basis, hotels: [...] } — including WHICH hotels are in
  -- the comparison, which is the only way a VP can check a side-by-side claim.
  evidence                jsonb not null default '{}'::jsonb,
  as_of                   timestamptz,
  weakest_input_age_days  numeric check (weakest_input_age_days is null or weakest_input_age_days >= 0),

  magnitude               numeric not null default 0,

  -- ── the price tag: a RANGE or nothing ────────────────────────────────────
  price_low_cents         integer,
  price_high_cents        integer,
  price_currency          text not null default 'USD' check (char_length(price_currency) = 3),
  price_basis             text check (price_basis is null or char_length(price_basis) between 1 and 300),

  -- ── lifecycle ────────────────────────────────────────────────────────────
  first_seen_at           timestamptz not null default now(),
  last_seen_at            timestamptz not null default now(),
  occurrence_count        integer not null default 1 check (occurrence_count >= 1),

  status_changed_at       timestamptz not null default now(),
  status_changed_by       uuid references public.accounts(id) on delete set null,
  resolved_at             timestamptz,

  silenced_at_magnitude   numeric,
  escalated_at            timestamptz,

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  -- Same rule as the hotel ledger: a price is a RANGE or it is absent. A point
  -- estimate wearing a range's clothes (low = high) is refused by the schema.
  constraint company_findings_price_is_a_range check (
    (price_low_cents is null and price_high_cents is null)
    or (
      price_low_cents is not null and price_high_cents is not null
      and price_low_cents >= 0
      and price_high_cents > price_low_cents
    )
  ),

  constraint company_findings_seen_window_ordered check (last_seen_at >= first_seen_at)
);

-- ═══ THE SILENCER, IN THE DATABASE — over a column that is never null ═══
-- The whole reason this table exists rather than a nullable column on
-- `findings`. At most ONE active row per (company, problem). A second run that
-- finds the same portfolio problem CANNOT insert; it must update.
--
-- 'muted' and 'known_problem' are inside the index so a silenced problem
-- blocks a fresh open row. 'resolved' and 'expired' are outside it so a
-- recurrence is genuinely new information with its own first_seen_at.
create unique index if not exists company_findings_one_active_per_problem_uq
  on public.company_findings (organization_id, dedupe_key)
  where status in ('open','updated','known_problem','muted');

-- The portfolio queue read: "what is wrong across this company, worst first".
create index if not exists company_findings_org_status_idx
  on public.company_findings (organization_id, status, last_seen_at desc);

comment on table public.company_findings is
  'One row per (company, problem) for as long as a COMPANY-SCOPE problem exists — cross-hotel comparisons and portfolio-wide aggregates, which belong to no single hotel. Mirrors public.findings deliberately (same statuses, same silencer semantics, same price-is-a-range rule) so one card renderer serves both. Separate from findings because findings.property_id is NOT NULL and making it nullable would defeat findings_one_active_per_problem_uq (NULLs are distinct in a unique index) and put a hole in the scopedDb tenant filter. Service-role-only. Added 0367.';

comment on column public.company_findings.dedupe_key is
  'Stable identity of the PROBLEM, detector-prefixed, never containing the measurement — so a comparison that moves from $800-vs-$1,400 to $800-vs-$1,600 updates one row instead of opening a second card.';

comment on column public.company_findings.evidence is
  'The receipt, including WHICH hotels are in the comparison set. A side-by-side claim a VP cannot check against the named hotels is a rumour.';

comment on column public.company_findings.silenced_at_magnitude is
  'The magnitude the VP consented to when they tapped "known problem". Escalation is measured from here.';

-- ── 2. RLS — service-role only; anon + authenticated deny-all ──────────────
alter table public.company_findings enable row level security;
revoke all on public.company_findings from public, anon, authenticated;
grant select, insert, update, delete on public.company_findings to service_role;
drop policy if exists company_findings_deny_all on public.company_findings;
create policy company_findings_deny_all on public.company_findings
  for all to anon, authenticated using (false) with check (false);

-- ── 3. updated_at trigger (shared fn from 0202) ────────────────────────────
drop trigger if exists set_updated_at on public.company_findings;
create trigger set_updated_at before update on public.company_findings
  for each row execute function public._pms_set_updated_at();

-- ── 4. Bookkeeping + schema reload ─────────────────────────────────────────
insert into public.applied_migrations (version, description)
values (
  '0367',
  'company_findings: the org-scoped half of the findings ledger, for portfolio checks (cross-hotel comparisons, "N of your hotels stopped X") that belong to no single property. company_findings_one_active_per_problem_uq is the one-problem-one-row guarantee over a NOT NULL organization_id — the reason this is a table rather than a nullable property_id on findings, where NULL-distinct semantics would have silently defeated the index. Service-role-only (deny-all anon+authenticated). No company_finding_runs: VP liveness sums the company hotels own finding_runs rows.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
