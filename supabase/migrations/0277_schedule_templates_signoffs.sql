-- 0277: Staff → Schedule redesign (unified Day/Week scheduling tab).
--
-- schedule_templates — whole-period staffing plans a manager saves from the
--   Fill modal and reapplies later. scope='day' payload: array of
--   { staffId, department, startMin, endMin }; scope='week' payload: array
--   of 7 such arrays (Sun..Sat).
-- schedule_week_signoffs — the "Finish week" manager sign-off flag, one row
--   per (property, Sunday week_start). Pure bookkeeping for the week boxes'
--   ✓ DONE state; deliberately separate from week_publications (publish).
--
-- Both tables are service-role only (RLS enabled, no policies): every read
-- and write goes through /api/staff-schedule/* routes gated by
-- verifyTeamManager. No realtime needed — the editing UI is the only writer.

-- @rls: service-role-only — manager-only template store; every read/write
-- goes through /api/staff-schedule/templates (verifyTeamManager + supabaseAdmin).
create table if not exists public.schedule_templates (
  id          uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties(id) on delete cascade,
  scope       text not null check (scope in ('day','week')),
  name        text not null check (char_length(name) between 1 and 80),
  payload     jsonb not null,
  created_by  uuid references public.accounts(id) on delete set null,
  created_at  timestamptz not null default now()
);

create index if not exists idx_schedule_templates_property
  on public.schedule_templates (property_id, scope, created_at desc);

-- @rls: service-role-only — manager-only sign-off flag; every read/write
-- goes through /api/staff-schedule/week-done (verifyTeamManager + supabaseAdmin).
create table if not exists public.schedule_week_signoffs (
  id          uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties(id) on delete cascade,
  week_start  date not null,
  finished_by uuid references public.accounts(id) on delete set null,
  finished_at timestamptz not null default now(),
  unique (property_id, week_start)
);

alter table public.schedule_templates enable row level security;
alter table public.schedule_week_signoffs enable row level security;

-- ─── Track the migration ─────────────────────────────────────────────────
insert into public.applied_migrations (version, description)
values ('0277', 'feature/staff-schedule-redesign: schedule_templates (whole-day/week staffing plans) + schedule_week_signoffs (Finish-week flag), service-role only.')
on conflict (version) do nothing;

notify pgrst, 'reload schema';
