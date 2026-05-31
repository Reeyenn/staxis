-- Migration 0235: Complaints / Service Recovery ("glitch tracking")
-- ════════════════════════════════════════════════════════════════════════
-- A dedicated guest-complaint log that beats a manual list by being
-- AI-assisted: auto-categorize + severity, auto-route to a work order,
-- service-recovery draft, repeat-issue flagging, and satisfaction callbacks.
--
-- Design notes:
--   * Property-scoped, RLS-gated exactly like guest_requests (the closest
--     analog — both hold guest PII: name / contact / free-text notes).
--     The browser policy AND-s user_owns_property(property_id) with
--     public.mfa_verified_or_grace() — the exact PII-table pattern the 0161
--     sweep applied to guest_requests. Server-side writes
--     (agent tool, voice, AI pipeline, cron nudges) go through supabaseAdmin
--     which bypasses RLS.
--   * Reads/realtime: the authed manager UI subscribes via the anon client
--     (subscribeTable), same as work_orders / rooms — so the table is added
--     to the supabase_realtime publication with replica identity full.
--   * linked_work_order_id ties a complaint to the legacy work_orders row
--     auto-created for maintenance/cleanliness complaints (that's the table
--     the Maintenance > Work orders tab + Dashboard tile read).
-- ════════════════════════════════════════════════════════════════════════

set search_path = public, pg_catalog;

create table if not exists public.complaints (
  id                   uuid primary key default gen_random_uuid(),
  property_id          uuid not null references public.properties(id) on delete cascade,

  -- What & who
  guest_name           text,
  guest_contact        text,                 -- phone or email (free text; PII)
  room_number          text,
  category             text not null default 'other'
                         check (category in (
                           'maintenance','cleanliness','noise','service',
                           'billing','amenities','other'
                         )),
  severity             text not null default 'medium'
                         check (severity in ('low','medium','high')),
  description          text not null,

  -- Lifecycle
  status               text not null default 'open'
                         check (status in ('open','in_progress','resolved','closed')),
  assigned_to          uuid references public.staff(id) on delete set null,
  assigned_name        text,                 -- snapshot of assignee name
  assigned_dept        text
                         check (assigned_dept is null or assigned_dept in (
                           'maintenance','housekeeping','front_desk','management','other'
                         )),
  linked_work_order_id uuid references public.work_orders(id) on delete set null,
  resolution_notes     text,
  resolved_at          timestamptz,

  -- Satisfaction callback
  callback_at          timestamptz,          -- when to follow up with the guest
  callback_done        boolean not null default false,
  callback_notes       text,
  callback_nudged_at   timestamptz,          -- last callback-due SMS nudge (cron idempotency)
  escalation_nudged_at timestamptz,          -- last high-severity escalation SMS (cron idempotency)

  -- Provenance
  source               text not null default 'front_desk'
                         check (source in ('front_desk','housekeeper','voice','guest')),
  created_by           uuid,                 -- accounts.id / auth uid of logger (nullable: voice/guest)
  created_by_name      text,                 -- snapshot

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- Indexes mirror guest_requests + add callback-due / status scans used by the
-- tab filters, the dashboard tile, and the nightly callback-nudge cron.
create index if not exists complaints_property_created_idx
  on public.complaints (property_id, created_at desc);
create index if not exists complaints_property_status_idx
  on public.complaints (property_id, status);
create index if not exists complaints_property_callback_idx
  on public.complaints (property_id, callback_done, callback_at)
  where callback_at is not null;
create index if not exists complaints_room_idx
  on public.complaints (property_id, room_number)
  where room_number is not null;

-- updated_at maintenance (shared trigger fn from 0001)
drop trigger if exists complaints_touch on public.complaints;
create trigger complaints_touch
  before update on public.complaints
  for each row execute function touch_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────
-- Same shape as guest_requests: owner + MFA-verified session for the browser
-- (anon/authenticated) role; service_role bypasses RLS for server writes.
alter table public.complaints enable row level security;

drop policy if exists "owner rw complaints" on public.complaints;
create policy "owner rw complaints" on public.complaints
  for all
  using (user_owns_property(property_id) and public.mfa_verified_or_grace())
  with check (user_owns_property(property_id) and public.mfa_verified_or_grace());

-- ── Realtime ───────────────────────────────────────────────────────────────
-- Full row image so subscribeTable's payload predicate + refetch works, and
-- register the table on the realtime publication (same as work_orders).
alter table public.complaints replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'complaints'
     ) then
    alter publication supabase_realtime add table public.complaints;
  end if;
end$$;

-- PostgREST caches the schema; force a reload so the new table is queryable.
notify pgrst, 'reload schema';
