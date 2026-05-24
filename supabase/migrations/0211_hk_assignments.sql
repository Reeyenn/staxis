-- ═══════════════════════════════════════════════════════════════════════════
-- 0211 — hk_assignments: housekeeper → cleaning_task allocations produced by
--                       the auto-assignment engine.
--
-- Why this exists:
--   Migration 0210 introduced the cleaning_tasks table. Tasks are created
--   with assignee_id=null. This branch (feature/hk-auto-assignment)
--   builds the scoring engine that decides which housekeeper gets each
--   task and in what order. We keep the assignment history in its own
--   table rather than just writing to cleaning_tasks.assignee_id so we
--   can: (a) track reason/score for every decision, (b) preserve the
--   audit trail when a manager reassigns, and (c) recompute the queue
--   order without losing prior context.
--
--   The cleaning_tasks.assignee_id column is still kept in sync as a
--   denormalized cache so housekeeper-facing reads stay a single-table
--   query. Source of truth for "who has this task right now" = the row
--   in hk_assignments with is_active=true.
--
-- Lifecycle:
--   - Each cleaning_task can have many hk_assignments rows over its life,
--     but only ONE is_active=true at a time. Enforced by the partial
--     unique index on (cleaning_task_id) where is_active.
--   - Re-assignment supersedes: old row's is_active flips false, new row
--     is inserted with is_active=true. Old rows are kept indefinitely
--     for audit.
--   - When a task is completed/cancelled/superseded upstream, its active
--     hk_assignment stays is_active=true. The engine reads task.status
--     to decide whether the row is still "live" for queueing purposes.
--
-- staff.language already exists (migration 0001) with default 'en' and a
-- check constraint that limits it to 'en'/'es'. The original spec called
-- for a new `language_preference` column, but that would be redundant
-- with what's already there. Housekeepers already toggle this from the
-- mobile app via /api/housekeeper/save-language — see the toggle button
-- in src/app/housekeeper/[id]/page.tsx. The scoring engine reads
-- staff.language directly. No schema change needed for that piece.
--
-- Tenant scoping:
--   property_id on every row. RLS posture matches cleaning_tasks (0210):
--   service-role only. The web app reads through /api/* with
--   supabaseAdmin; the future housekeeper-facing UI branch will add
--   per-role policies.
--
-- Manual prod apply: per project_migration_application_manual.md. Must
-- be applied AFTER 0210 — the cleaning_tasks FK depends on it.
-- Idempotent: create-if-not-exists everywhere. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

-- @rls: service-role-only — matches cleaning_tasks (0210) and pms_* (0202).
-- Browser reads/writes go through /api/housekeeping/* with supabaseAdmin.
create table if not exists public.hk_assignments (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references public.properties(id) on delete cascade,

  -- Allocation
  cleaning_task_id      uuid not null references public.cleaning_tasks(id) on delete cascade,
  housekeeper_id        uuid not null references public.staff(id) on delete restrict,
  queue_order           integer not null default 0
                        check (queue_order >= 0),

  -- Lifecycle: only one row per task carries is_active=true. The partial
  -- unique index below enforces that. Inactive rows are the history of
  -- prior assignments (manager reassignments, sick-callout re-spreads).
  is_active             boolean not null default true,

  -- Provenance
  assigned_at           timestamptz not null default now(),
  assigned_by           text not null default 'auto'
                        check (assigned_by in ('auto', 'manual', 'rebalance')),
  -- assigned_by_user_id is the manager's user id when assigned_by='manual'
  -- or 'rebalance'. NULL for 'auto'. Not an FK to auth.users to keep this
  -- table portable across reseeds.
  assigned_by_user_id   uuid,

  -- Explainability — the scoring engine writes the short reason it picked
  -- this housekeeper (e.g. "floor match + workload balance + Spanish guest").
  -- Score is the raw composite score from src/lib/assignment-engine; useful
  -- when debugging "why did Maria get this room?" support questions.
  reason                text,
  score                 numeric,

  -- Bookkeeping
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table public.hk_assignments is
  'Housekeeper → cleaning_task allocations. One is_active=true row per task at a time. History rows are kept for audit. Created 0211.';
comment on column public.hk_assignments.is_active is
  'True for the current allocation; false for superseded history rows. Exactly one true row per cleaning_task (enforced below).';
comment on column public.hk_assignments.assigned_by is
  '"auto" = scoring engine, "manual" = manager drag-and-drop reassignment, "rebalance" = engine re-running after sick callout.';
comment on column public.hk_assignments.reason is
  'Short human-readable explanation, e.g. "floor 2 match + workload balance + Spanish guest".';
comment on column public.hk_assignments.score is
  'Raw composite score from the scoring engine. Useful for debugging surprising assignments. NULL for manual reassignments.';

-- One active assignment per task. Partial unique index = exactly one
-- is_active=true row per cleaning_task_id; multiple is_active=false rows
-- (the audit history) are allowed.
create unique index if not exists hk_assignments_one_active_per_task
  on public.hk_assignments (cleaning_task_id)
  where is_active;

create index if not exists hk_assignments_housekeeper_active_idx
  on public.hk_assignments (housekeeper_id, queue_order)
  where is_active;

create index if not exists hk_assignments_property_active_idx
  on public.hk_assignments (property_id, is_active);

-- RLS: service-role only. Matches cleaning_tasks (0210) and pms_* (0202).
alter table public.hk_assignments enable row level security;
revoke all on public.hk_assignments from public, anon, authenticated;
grant select, insert, update, delete on public.hk_assignments to service_role;
drop policy if exists hk_assignments_deny_all_browser on public.hk_assignments;
create policy hk_assignments_deny_all_browser on public.hk_assignments
  for all to anon, authenticated using (false) with check (false);
comment on policy hk_assignments_deny_all_browser on public.hk_assignments is
  'Service-role only. Auto-assign engine writes; UI reads via /api/* with supabaseAdmin. Created 0211.';

-- updated_at trigger — reuses the _pms_set_updated_at function from 0202.
drop trigger if exists set_updated_at on public.hk_assignments;
create trigger set_updated_at before update on public.hk_assignments
  for each row execute function public._pms_set_updated_at();

insert into public.applied_migrations (version, description)
values (
  '0211',
  'hk_assignments: housekeeper → cleaning_task allocations with audit history. One active row per task. Service-role only.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
