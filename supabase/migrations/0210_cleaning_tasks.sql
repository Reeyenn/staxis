-- ═══════════════════════════════════════════════════════════════════════════
-- 0210 — cleaning_tasks: Staxis-side cleaning task records produced by the
--                       rules engine.
--
-- Why this exists:
--   The rules engine (src/lib/rules-engine/) reads from pms_* (CUA-owned)
--   and produces a richer, Staxis-side notion of a "cleaning task" than
--   the raw HK plan the PMS exposes. Each row carries: cleaning type,
--   priority, due-by time, estimated minutes, inspection requirement,
--   extras (fruit basket, supervisor inspection, baby cot, etc.), and
--   the list of rules that fired (for explainability and auditing).
--
--   The engine is idempotent: re-running on the same PMS state produces
--   the same tasks. Idempotency is enforced by the unique (property_id,
--   dedupe_key) constraint. dedupe_key = "<room_number>::<business_date>"
--   in property-local time; the engine upserts on that pair every run.
--
-- Tenant scoping:
--   property_id (FK to properties.id) on every row. RLS posture matches
--   pms_* (0202): service-role only. The future UI branch will add
--   per-role policies; for now, /api/* routes mediate via supabaseAdmin.
--
-- PII note:
--   notes and rules_fired hold descriptors like "VIP Platinum" or
--   "Spanish-speaking" — language and tier categories, no guest names
--   or contact info. Engine deliberately omits guest_name when writing.
--   source_pms_reservation_id is the raw PMS ID (text, not FK) so we
--   can correlate to pms_reservations for forensics without violating
--   referential integrity when pms_reservations rows get re-upserted.
--
-- Assignment scope:
--   assignee_id is intentionally NULL on every row this migration
--   creates. Assignment lives in a separate future branch — when that
--   wires up, it just updates this column.
--
-- Manual prod apply: per project_migration_application_manual.md.
-- Idempotent: create table if not exists. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.cleaning_tasks (
  id                         uuid primary key default gen_random_uuid(),
  property_id                uuid not null references public.properties(id) on delete cascade,

  -- Identity + dedupe
  room_number                text not null,
  business_date              date not null,
  dedupe_key                 text not null,

  -- What to clean
  cleaning_type              text not null
                             check (cleaning_type in (
                               'departure',
                               'departure_deep',
                               'stayover',
                               'refresh',
                               'deep',
                               'room_check',
                               'inspection_only',
                               'no_clean'
                             )),
  priority                   text not null default 'normal'
                             check (priority in ('urgent','high','normal','low')),

  -- Timing
  due_by                     timestamptz,
  estimated_minutes          integer
                             check (estimated_minutes is null or estimated_minutes >= 0),

  -- Quality + extras
  requires_inspection        boolean not null default false,
  extras                     jsonb not null default '[]'::jsonb,
  notes                      text,

  -- Explainability — every task carries the list of rules that produced
  -- it AND the input snapshot used. rules_fired is a jsonb array of
  -- { id, summary }. rule_inputs is the RoomContext snapshot (no guest
  -- names — see PII note above).
  rules_fired                jsonb not null default '[]'::jsonb,
  rule_inputs                jsonb,

  -- Lifecycle
  status                     text not null default 'scheduled'
                             check (status in (
                               'scheduled',
                               'ready_now',
                               'in_progress',
                               'paused',
                               'completed',
                               'inspection_pending',
                               'inspected_pass',
                               'inspected_fail',
                               'correction_pending',
                               'correction_complete',
                               'check_pending',
                               'check_complete',
                               'deferred',
                               'skipped',
                               'cancelled',
                               'superseded'
                             )),
  assignee_id                uuid,   -- staff.id, null until assignment branch lands

  -- Provenance
  source_pms_reservation_id  text,
  source_engine_run_id       uuid,
  source_property_timezone   text,

  -- Lifecycle timestamps
  scheduled_at               timestamptz,
  started_at                 timestamptz,
  paused_at                  timestamptz,
  completed_at               timestamptz,
  inspected_at               timestamptz,

  -- Engine bookkeeping
  last_evaluated_at          timestamptz not null default now(),
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),

  constraint cleaning_tasks_dedupe_unique unique (property_id, dedupe_key)
);

comment on table public.cleaning_tasks is
  'Staxis-side cleaning tasks generated by the rules engine. One row per (property, room_number, business_date). Idempotent upsert on (property_id, dedupe_key). Created 0210.';
comment on column public.cleaning_tasks.dedupe_key is
  'Per-property idempotency key. Format: "<room_number>::<business_date>" in property-local time.';
comment on column public.cleaning_tasks.rules_fired is
  'Array of { id, summary } objects — which rules produced this task and why. For explainability.';
comment on column public.cleaning_tasks.rule_inputs is
  'Snapshot of RoomContext used for evaluation. No guest names; loyalty tier and language flags only.';
comment on column public.cleaning_tasks.assignee_id is
  'Housekeeper staff.id. NULL until the assignment branch wires this up; engine never sets it.';

create index if not exists cleaning_tasks_property_date_idx
  on public.cleaning_tasks (property_id, business_date desc);
create index if not exists cleaning_tasks_status_idx
  on public.cleaning_tasks (property_id, status)
  where status in ('scheduled','ready_now','in_progress','paused','inspection_pending');
create index if not exists cleaning_tasks_assignee_idx
  on public.cleaning_tasks (assignee_id, status)
  where assignee_id is not null;

-- RLS posture matches pms_* (migration 0202): service-role only. The web
-- app reads via /api/* with supabaseAdmin; the housekeeper-facing UI
-- branch will add per-role read policies in a follow-up migration.
alter table public.cleaning_tasks enable row level security;
revoke all on public.cleaning_tasks from public, anon, authenticated;
grant select, insert, update, delete on public.cleaning_tasks to service_role;
drop policy if exists cleaning_tasks_deny_all_browser on public.cleaning_tasks;
create policy cleaning_tasks_deny_all_browser on public.cleaning_tasks
  for all to anon, authenticated using (false) with check (false);
comment on policy cleaning_tasks_deny_all_browser on public.cleaning_tasks is
  'Service-role only. Rules engine writes; UI reads via /api/* with supabaseAdmin. Created 0210.';

-- updated_at trigger — reuses the _pms_set_updated_at function from 0202.
-- (The function is generic; the _pms_ prefix is historical.)
drop trigger if exists set_updated_at on public.cleaning_tasks;
create trigger set_updated_at before update on public.cleaning_tasks
  for each row execute function public._pms_set_updated_at();

insert into public.applied_migrations (version, description)
values (
  '0210',
  'cleaning_tasks: Staxis-side cleaning tasks from the rules engine. Unique by (property_id, dedupe_key) for idempotent upsert. Service-role only.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
