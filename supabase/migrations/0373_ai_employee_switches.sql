-- ═══════════════════════════════════════════════════════════════════════════
-- 0373 — One switch per AI employee, so the founder can stop one of them.
--
-- (0372 is deliberately left free for a sibling branch landing the same week.
--  A gap is harmless: the doctor discovers migrations from disk, and 0044-0049
--  have been an unfilled gap since May.)
--
-- WHAT THIS IS NOT
-- It is not the master switch. Every scheduled job in this product is off today
-- and this migration schedules nothing, starts nothing, and changes no default.
-- The master switch — the one that turns the machine on at launch — stays where
-- it is: in the founder's hands, in vercel.json and the schedule registry.
--
-- WHAT THIS IS
-- The 13 AI employees are job titles over one engine. After launch, when the
-- machine is running, the founder needs to be able to stop ONE of them — the
-- Morning Briefer specifically, without stopping the nightly check that feeds
-- it, and without touching the other twelve. That is an override, and an
-- override needs somewhere to live.
--
-- WHY A TABLE AND NOT A COLUMN ON app_settings
-- `app_settings` is a singleton with one column per setting (0310, 0318, 0319).
-- Thirteen employees would be thirteen columns, and every new hire would be a
-- migration and a type regeneration. A row per switched-off employee is the
-- same information with none of that, and it carries the two facts a column
-- cannot: WHEN it was switched off and BY WHOM. On a control whose whole
-- purpose is "I turned this off on purpose", that provenance is the point.
--
-- DEFAULT ON, AND THE DEFAULT IS THE ABSENCE OF A ROW
-- No row means the employee is on. Only an explicit `switched_off = true`
-- stops anything. That is the founder's ruling stated in the schema itself:
-- this page cannot start anything, and it cannot silently stop anything
-- either — a stop is a row somebody wrote.
--
-- `employee_id` is the registry id (src/lib/ai/employee-registry.ts), plain
-- text with no foreign key: the roster is CODE, not data. A row for an id the
-- code no longer knows is inert — the reader only ever asks about ids the
-- registry named — and the roster-integrity test is what stops an employee
-- being renamed out from under its own switch.
--
-- ACCESS — service-role only, like every other founder-scoped table. The one
-- writer is /api/admin/mission/ai-staff behind requireAdmin (session +
-- role='admin'), the same gate the shared-knowledge promotion queue uses.
-- Hotels must never see this table: which of Staxis's own employees is
-- switched off is Staxis's business, not a customer's.
--
-- NOT APPLIED automatically — migrations are applied by hand (CLAUDE.md).
-- Idempotent; safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

create table if not exists public.ai_employee_switches (
  -- The registry id (e.g. 'morning_briefer'). Same character class the
  -- detector registry enforces on detector ids, for the same reason: it is
  -- written down in code, in this table, and in the audit trail, so it must
  -- not be the kind of string that can be spelled two ways.
  employee_id      text primary key
                     check (employee_id ~ '^[a-z][a-z0-9_]{2,63}$'),

  -- The only value that stops anything. Default false so an accidental insert
  -- cannot switch an employee off.
  switched_off     boolean not null default false,

  -- Provenance. Null while switched_off is false.
  switched_off_at  timestamptz,
  switched_off_by  uuid references public.accounts(id) on delete set null,

  -- Free-text reason the founder can leave himself. Never shown to a hotel.
  note             text check (note is null or char_length(note) <= 500),

  updated_at       timestamptz not null default now(),

  -- "Switched off" and "when/who" travel together or not at all. Without this
  -- a row can claim an employee is off with no record of the decision, which is
  -- exactly the state this table exists to make impossible.
  constraint ai_employee_switches_off_has_provenance
    check (switched_off = false or switched_off_at is not null)
);

comment on table public.ai_employee_switches is
  'Per-AI-employee kill override, founder-only. One row per employee that has been switched OFF; absence of a row means on. This is NOT the master switch that starts the scheduled machine — it only stops a named employee once the machine is running. Read by src/lib/ai/employee-switches.ts, written by /api/admin/mission/ai-staff behind requireAdmin. Added 0373.';

comment on column public.ai_employee_switches.employee_id is
  'Registry id from src/lib/ai/employee-registry.ts. No FK — the roster lives in code. A row for an unknown id is inert; the roster-integrity test prevents a rename from orphaning a switch.';

comment on column public.ai_employee_switches.switched_off is
  'true = the founder stopped this employee. The generation paths in its bundle check this before doing any work. Default false: an insert cannot accidentally stop anything.';

alter table public.ai_employee_switches enable row level security;
revoke all on public.ai_employee_switches from public, anon, authenticated;
grant select, insert, update, delete on public.ai_employee_switches to service_role;

drop policy if exists ai_employee_switches_deny_all on public.ai_employee_switches;
create policy ai_employee_switches_deny_all on public.ai_employee_switches
  for all to anon, authenticated using (false) with check (false);

drop trigger if exists set_updated_at on public.ai_employee_switches;
create trigger set_updated_at before update on public.ai_employee_switches
  for each row execute function public._pms_set_updated_at();

insert into public.applied_migrations (version, description)
values (
  '0373',
  'ai_employee_switches: per-AI-employee kill override (founder-only, default on = no row); not the master switch'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
