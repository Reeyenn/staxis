-- Migration 0237: Financials — GM/owner finance suite (Checkbook + Budget + CapEx)
-- (Authored as 0236; renumbered to 0237 after a parallel session claimed 0236
--  for compliance_anomaly_alerts. Orchestrator does the final renumber at merge.)
-- ════════════════════════════════════════════════════════════════════════════
-- An AI-native finance ledger that fills itself in: revenue auto-flows from the
-- PMS (pms_revenue_daily — single source of truth with the owner Dashboard),
-- expenses auto-import from scanned invoices (Claude Vision), and the AI
-- forecasts overspend before month-end.
--
-- Four tables, ALL property-scoped:
--   • financial_expenses  — the checkbook register (money as integer CENTS)
--   • department_budgets   — per-department monthly budget (vs. actual = sum of
--                            expenses for that dept/month, computed live)
--   • capex_projects       — capital projects (quote vs spent-to-date)
--   • capex_line_items     — actual costs rolled up under a capex project
--
-- SECURITY: finance is the most sensitive surface in the app. These tables are
-- SERVICE-ROLE-ONLY — RLS enabled with NO browser-readable policy (deny-all for
-- anon/authenticated). Every read AND write goes through /api/financials/* which
-- uses supabaseAdmin behind requireFinanceAccess (requireSession + owner/GM/admin
-- role gate + userHasPropertyAccess). There is intentionally NO anon read path,
-- so the RLS-empty-state bug class cannot apply and a non-manager can never pull
-- another property's books even with a valid session. Mirrors the pattern the
-- audit allowlists (api_limits, expenses, app_events): RLS-on + service-role.
--
-- Money is stored as BIGINT CENTS everywhere — no floats, no rounding drift.
-- ════════════════════════════════════════════════════════════════════════════

set search_path = public, pg_catalog;

-- ── Checkbook register ──────────────────────────────────────────────────────
-- @rls: service-role-only — finance ledger; all access via /api/financials/*
--   (supabaseAdmin + requireFinanceAccess). No anon/authenticated read path.
create table if not exists public.financial_expenses (
  id                 uuid primary key default gen_random_uuid(),
  property_id        uuid not null references public.properties(id) on delete cascade,

  expense_date       date not null,
  amount_cents       bigint not null check (amount_cents >= 0),
  vendor             text,
  department         text not null default 'other'
                       check (department in (
                         'rooms','housekeeping','maintenance','front_desk',
                         'breakfast','utilities','sales_marketing','admin_general','other'
                       )),
  category           text,                 -- finer label (e.g. "linens", "repairs"); free text, capped in the API
  source             text not null default 'manual'
                       check (source in ('manual','invoice_scan')),
  notes              text,

  -- Invoice provenance (set when source = 'invoice_scan')
  invoice_number     text,
  invoice_date       date,

  created_by         uuid,                 -- accounts.id / auth uid of the logger
  created_by_name    text,                 -- snapshot

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists financial_expenses_property_date_idx
  on public.financial_expenses (property_id, expense_date desc);
create index if not exists financial_expenses_property_dept_date_idx
  on public.financial_expenses (property_id, department, expense_date);

drop trigger if exists financial_expenses_touch on public.financial_expenses;
create trigger financial_expenses_touch
  before update on public.financial_expenses
  for each row execute function touch_updated_at();

-- ── Per-department monthly budget ───────────────────────────────────────────
-- @rls: service-role-only — finance budgets; all access via /api/financials/*
--   (supabaseAdmin + requireFinanceAccess). No anon/authenticated read path.
-- One row per (property, department, month). month_start is always the first of
-- the month so MTD aggregation is a clean equality match (mirrors
-- inventory_budgets, migration 0061).
create table if not exists public.department_budgets (
  property_id        uuid not null references public.properties(id) on delete cascade,
  department         text not null
                       check (department in (
                         'rooms','housekeeping','maintenance','front_desk',
                         'breakfast','utilities','sales_marketing','admin_general','other'
                       )),
  month_start        date not null,
  budget_cents       bigint not null check (budget_cents >= 0),
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (property_id, department, month_start)
);

drop trigger if exists department_budgets_touch on public.department_budgets;
create trigger department_budgets_touch
  before update on public.department_budgets
  for each row execute function touch_updated_at();

-- ── Capital projects ────────────────────────────────────────────────────────
-- @rls: service-role-only — finance capex; all access via /api/financials/*
--   (supabaseAdmin + requireFinanceAccess). No anon/authenticated read path.
create table if not exists public.capex_projects (
  id                 uuid primary key default gen_random_uuid(),
  property_id        uuid not null references public.properties(id) on delete cascade,

  name               text not null,
  description        text,
  quote_cents        bigint not null default 0 check (quote_cents >= 0),
  status             text not null default 'planned'
                       check (status in ('planned','approved','in_progress','on_hold','complete','cancelled')),
  vendor             text,
  start_date         date,
  target_date        date,

  created_by         uuid,
  created_by_name    text,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists capex_projects_property_idx
  on public.capex_projects (property_id, created_at desc);
create index if not exists capex_projects_property_status_idx
  on public.capex_projects (property_id, status);

drop trigger if exists capex_projects_touch on public.capex_projects;
create trigger capex_projects_touch
  before update on public.capex_projects
  for each row execute function touch_updated_at();

-- ── Capex line items (actual costs incurred under a project) ─────────────────
-- @rls: service-role-only — finance capex lines; all access via /api/financials/*
--   (supabaseAdmin + requireFinanceAccess). No anon/authenticated read path.
-- property_id is denormalized (in addition to the project FK) so the same
-- service-role-only RLS posture + tenant-scope audit coverage applies directly,
-- and every query can scope by property_id without a join.
create table if not exists public.capex_line_items (
  id                 uuid primary key default gen_random_uuid(),
  capex_project_id   uuid not null references public.capex_projects(id) on delete cascade,
  property_id        uuid not null references public.properties(id) on delete cascade,

  label              text not null,
  amount_cents       bigint not null default 0 check (amount_cents >= 0),
  vendor             text,
  incurred_date      date,
  source             text not null default 'manual'
                       check (source in ('manual','invoice_scan')),

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists capex_line_items_project_idx
  on public.capex_line_items (capex_project_id);
create index if not exists capex_line_items_property_idx
  on public.capex_line_items (property_id);

drop trigger if exists capex_line_items_touch on public.capex_line_items;
create trigger capex_line_items_touch
  before update on public.capex_line_items
  for each row execute function touch_updated_at();

-- ── RLS: enable on all four, NO browser policy (service-role-only / deny-all) ─
-- supabaseAdmin (server) bypasses RLS for the /api/financials/* paths. With RLS
-- on and zero permissive policies, anon + authenticated browser roles are denied
-- every row — the strongest cross-tenant posture for sensitive finance data.
alter table public.financial_expenses enable row level security;
alter table public.department_budgets  enable row level security;
alter table public.capex_projects      enable row level security;
alter table public.capex_line_items    enable row level security;

-- Belt-and-braces: revoke any default table grants from the browser roles so
-- access depends solely on RLS (which denies) + service-role (which bypasses).
revoke all on public.financial_expenses from anon, authenticated;
revoke all on public.department_budgets  from anon, authenticated;
revoke all on public.capex_projects      from anon, authenticated;
revoke all on public.capex_line_items    from anon, authenticated;

-- PostgREST caches the schema; force a reload so the new tables are queryable.
notify pgrst, 'reload schema';

-- Self-register so the doctor's applied-migrations check + the
-- migration-bookkeeping drift test see this version.
insert into public.applied_migrations (version, description)
values ('0237', 'financials: checkbook (financial_expenses) + department_budgets + capex_projects/line_items — service-role-only, money as bigint cents')
on conflict (version) do nothing;
