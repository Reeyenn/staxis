-- ═══════════════════════════════════════════════════════════════════════════
-- 0211 — Sick callout coverage flow (feature #6).
--
-- Why this exists:
--   When a housekeeper can't work (sick, family emergency, mid-shift bail),
--   the system needs to redistribute their remaining rooms across the team
--   AND let a manager revert the callout in one click if it was a mistake.
--   The redistribution itself is owned by the auto-assignment engine
--   (feature/hk-auto-assignment) — this table is the audit log + state
--   anchor that triggers the re-spread and tracks the original assignment
--   shape so a revert can put things back exactly the way they were.
--
-- Source of truth for "who is out today":
--   A staff member is OUT for a date iff there exists a callout_events row
--   with (staff_id, business_date, status='active'). Reverts flip status
--   to 'reverted' so a single staff member can call out, revert, and call
--   out again on the same day without breaking uniqueness — a partial
--   unique index enforces "at most one ACTIVE callout per (staff, date)".
--
-- impacted_assignments shape (jsonb array):
--   [{
--     "task_id":              "uuid of the cleaning_tasks row",
--     "room_number":          "108",                   -- snapshot for audit
--     "original_assignee_id": "uuid of the sick staff",
--     "redistributed_to":     "uuid of the receiving staff" | null,
--     "task_status_at_redistribute": "scheduled" | "in_progress" | ...
--   }]
--   The revert path walks this array, checks the current cleaning_tasks
--   row, and only reassigns back if the task hasn't been STARTED by the
--   new assignee in the meantime ("if started: stays with new assignee").
-- ═══════════════════════════════════════════════════════════════════════════

-- @rls: service-role-only — all access goes through /api/* routes that use
-- supabaseAdmin; no browser/anon client ever talks to this table directly.
-- Same posture as cleaning_tasks (0210) and the pms_* tables.
create table if not exists public.callout_events (
  id                       uuid primary key default gen_random_uuid(),
  property_id              uuid not null references public.properties(id) on delete cascade,
  staff_id                 uuid not null references public.staff(id)      on delete cascade,
  business_date            date not null,

  -- Who reported, when, why
  reported_at              timestamptz not null default now(),
  -- 'self'    — housekeeper tapped the button in their mobile page
  -- 'manager' — manager clicked "Mark sick" on the dashboard
  -- 'sms'     — housekeeper texted SICK to the hotel's Twilio number
  reported_by              text not null check (reported_by in ('self', 'manager', 'sms')),
  reported_by_user_id      uuid,                  -- set when reported_by='manager' (the manager's auth uuid)
  reason                   text check (reason in ('sick', 'family', 'personal', 'other')),
  note                     text,                  -- optional free text from the reporter

  -- Mid-shift variant — when the housekeeper was already on the clock and
  -- wanted to leave. Recorded for audit; the cron processor uses it to
  -- decide WHEN to actually redistribute (immediately for 'now', after
  -- a delay for 'in_15_min', after the in-progress task completes for
  -- 'after_current_room'). NULL for pre-shift callouts (the most common case).
  leave_timing             text check (leave_timing in ('now', 'in_15_min', 'after_current_room')),

  -- Lifecycle state
  status                   text not null default 'active' check (status in ('active', 'reverted')),

  -- Redistribution bookkeeping. NULL = not yet redistributed (pending cron).
  -- When redistribute_at is in the future, the cron processor waits until
  -- it passes before firing. After firing, redistributed_at is set and
  -- impacted_assignments captures the before/after for revert.
  redistribute_at          timestamptz default now(),  -- when to fire redistribute (default: immediately)
  redistributed_at         timestamptz,                -- when redistribute actually ran (null = still pending)
  impacted_assignments     jsonb not null default '[]'::jsonb,

  -- Revert bookkeeping
  reverted_at              timestamptz,
  reverted_by_user_id      uuid,           -- set when manager reverted (auth uuid)
  reverted_by_staff_id     uuid references public.staff(id) on delete set null,  -- set when housekeeper self-reverted
  revert_reason            text,
  -- After revert, the audit log keeps a frozen copy of which rooms went
  -- back to the sick housekeeper vs which stayed with the new assignee
  -- (because they were already started). One element per impacted task.
  revert_outcome           jsonb,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- ───────────────────────────────────────────────────────────────────────────
-- Indexes — every read path the service module uses
-- ───────────────────────────────────────────────────────────────────────────

-- "Show me today's active callouts for this property" (CalloutBanner.tsx).
create index if not exists callout_events_property_date_idx
  on public.callout_events (property_id, business_date);

-- "Is this staff member out today?" (housekeeper page button label, manager
-- dashboard staff card, redistribution pre-check).
create index if not exists callout_events_staff_date_idx
  on public.callout_events (staff_id, business_date);

-- Cron tick: "what callouts need redistribute fired now?"
create index if not exists callout_events_pending_redistribute_idx
  on public.callout_events (redistribute_at)
  where status = 'active' and redistributed_at is null;

-- ───────────────────────────────────────────────────────────────────────────
-- At most ONE active callout per (staff, date). Reverts flip status to
-- 'reverted' which drops out of this partial index, allowing a fresh
-- callout to be inserted on the same day (e.g., HK reports sick → manager
-- reverts → HK reports sick again from a different channel).
-- ───────────────────────────────────────────────────────────────────────────

create unique index if not exists callout_events_one_active_per_staff_date_idx
  on public.callout_events (staff_id, business_date)
  where status = 'active';

-- ───────────────────────────────────────────────────────────────────────────
-- updated_at trigger — match the convention used by other tables in this
-- schema. The function set_callout_events_updated_at is local to this
-- migration so we don't depend on whichever order other migrations apply.
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.set_callout_events_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists callout_events_updated_at_trg on public.callout_events;
create trigger callout_events_updated_at_trg
  before update on public.callout_events
  for each row execute function public.set_callout_events_updated_at();

-- ───────────────────────────────────────────────────────────────────────────
-- RLS — service-role only, same posture as cleaning_tasks (0210) and
-- pms_* tables. All access goes through API routes; no client ever talks
-- to this table directly.
-- ───────────────────────────────────────────────────────────────────────────

alter table public.callout_events enable row level security;

drop policy if exists callout_events_service_role_only on public.callout_events;
create policy callout_events_service_role_only
  on public.callout_events
  for all
  to public
  using (false)
  with check (false);

-- ───────────────────────────────────────────────────────────────────────────
-- Schema cache reload — PostgREST needs to see the new table before
-- supabaseAdmin can read it. Without this, the first /api/housekeeping/callout
-- hit after the migration apply gets a confusing "table not found" error.
-- ───────────────────────────────────────────────────────────────────────────

notify pgrst, 'reload schema';

insert into public.applied_migrations (version, description)
values ('0211', 'Add callout_events table for the sick-callout coverage flow (feature #6). Tracks self/manager/SMS callouts, impacted task list, and revert outcomes. Service-role only.')
on conflict (version) do nothing;
