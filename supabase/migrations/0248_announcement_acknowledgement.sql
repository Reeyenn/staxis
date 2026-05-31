-- ════════════════════════════════════════════════════════════════════════
-- 0248_announcement_acknowledgement.sql — "Require acknowledgement" for
-- Communications announcements.
-- ════════════════════════════════════════════════════════════════════════
-- Adds a HARD read-confirmation on top of the existing Communications system
-- (migration 0241). Most announcements stay normal. When a manager ticks an
-- optional "Require acknowledgement" box, every recipient must explicitly tap
-- "I read & understand" — which writes a comms_acknowledgements row — and the
-- manager gets a live who-has / who-hasn't tracker.
--
-- This is DISTINCT from the passive `comms_members.last_read_at` "seen"
-- receipt: opening the feed advances last_read_at, but does NOT satisfy a
-- required acknowledgement. The two coexist untouched.
--
-- Org-wide mandatory-read: an owner/admin can post ONE require-ack
-- announcement to ALL their properties at once. Each property gets its own
-- announcement copy (so each hotel's staff acknowledge in their own feed),
-- grouped under a single comms_ack_campaigns row so completion can be
-- aggregated across properties.
--
-- ADDITIVE ONLY. Normal announcements (requires_ack=false, the default) behave
-- EXACTLY as before. comms_* tables are service-role-only: RLS is enabled with
-- NO anon/authenticated policies, so every read/write goes through /api/comms/*
-- using supabaseAdmin (same posture as migration 0241).
-- ════════════════════════════════════════════════════════════════════════

-- ── Org-wide campaign (groups the per-property announcement copies) ──────────
-- @rls: service-role-only — accessed only via /api/* with supabaseAdmin; RLS enabled with no anon/authenticated policies (deny-all)
create table if not exists public.comms_ack_campaigns (
  id                 uuid primary key default gen_random_uuid(),
  -- The owner/admin account that launched the blast (for the campaign roll-up).
  created_by_account uuid references public.accounts(id) on delete set null,
  title              text,
  created_at         timestamptz not null default now()
);

-- ── Flags on the announcement message ───────────────────────────────────────
-- requires_ack: this announcement demands an explicit "I read & understand".
-- Default false → existing rows + normal announcements are unaffected.
alter table public.comms_messages
  add column if not exists requires_ack boolean not null default false;
-- ack_campaign_id: set only on the per-property copies that belong to ONE
-- org-wide blast. null for a single-property announcement.
alter table public.comms_messages
  add column if not exists ack_campaign_id uuid
    references public.comms_ack_campaigns(id) on delete set null;

-- "Does this conversation have any require-ack announcements?" — used to keep
-- an un-acked required announcement lit in the unread/badge logic even after
-- last_read_at advances. Partial index keeps it tiny (only required rows).
create index if not exists comms_messages_requires_ack_idx
  on public.comms_messages (conversation_id)
  where requires_ack = true;
create index if not exists comms_messages_ack_campaign_idx
  on public.comms_messages (ack_campaign_id)
  where ack_campaign_id is not null;

-- ── Hard acknowledgements (one row per person per required message) ──────────
-- @rls: service-role-only — accessed only via /api/* with supabaseAdmin; RLS enabled with no anon/authenticated policies (deny-all)
create table if not exists public.comms_acknowledgements (
  id              uuid primary key default gen_random_uuid(),
  message_id      uuid not null references public.comms_messages(id) on delete cascade,
  property_id     uuid not null references public.properties(id) on delete cascade,
  -- The staff member who acknowledged (a staff.id, matching comms_members.staff_id;
  -- no FK, mirroring comms_members so externally-managed staff rows stay flexible).
  staff_id        uuid not null,
  acknowledged_at timestamptz not null default now(),
  -- One ack per person per message → the "I read & understand" tap is idempotent
  -- (a double-tap / replay can never double-count).
  unique (message_id, staff_id)
);
create index if not exists comms_acknowledgements_message_idx
  on public.comms_acknowledgements (message_id);
create index if not exists comms_acknowledgements_staff_idx
  on public.comms_acknowledgements (property_id, staff_id);

-- ── RLS: service-role only (deny anon/authenticated; access via /api/*) ──────
alter table public.comms_ack_campaigns    enable row level security;
alter table public.comms_acknowledgements enable row level security;

comment on table public.comms_acknowledgements is
  'Hard per-person acknowledgements of require-ack announcements — DISTINCT from passive comms_members.last_read_at "seen". One row per (message, staff). Service-role only; access via /api/comms/acknowledge*.';
comment on table public.comms_ack_campaigns is
  'Groups the per-property announcement copies of one org-wide mandatory-read blast so completion can be aggregated across properties. Service-role only.';
comment on column public.comms_messages.requires_ack is
  'true → recipients must explicitly tap "I read & understand" (writes comms_acknowledgements). Default false = a normal announcement.';
comment on column public.comms_messages.ack_campaign_id is
  'Set only on the per-property copies of an org-wide mandatory-read campaign (FK comms_ack_campaigns). null for single-property announcements.';

-- PostgREST schema-cache reload (picked up by the running API).
notify pgrst, 'reload schema';

-- Self-register so the doctor's applied-migrations check + the
-- migration-bookkeeping drift test see this version.
insert into public.applied_migrations (version, description)
values ('0248', 'announcement acknowledgement: requires_ack + ack_campaign_id on comms_messages; comms_acknowledgements (hard per-person read-confirm, unique per message+staff → idempotent); comms_ack_campaigns (org-wide mandatory-read campaigns aggregated across properties). Additive — normal announcements unchanged. comms_* tables service-role-only.')
on conflict (version) do nothing;
