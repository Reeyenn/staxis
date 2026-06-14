-- ═══════════════════════════════════════════════════════════════════════════
-- 0280 — Shift Log Book (Quore "Logs → Log Book" parity, recaps only)
--
-- A shift handoff: any staffer posts a titled free-text recap scoped to their
-- property; others reply in a thread. Newest-first, grouped by day. No "log
-- sheets", no structured forms — recaps + replies only. Lives as a "Log book"
-- sub-tab inside Communications + a dashboard card.
--
-- @rls: service-role-only — accessed only via /api/comms/logbook* with
-- supabaseAdmin; RLS ENABLED with NO anon/authenticated policies (deny-all),
-- same posture as every other comms_* table (0241 / 0248 / 0254). All access
-- is scoped by property_id in code.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Recaps ─────────────────────────────────────────────────────────────────
-- @rls: service-role-only — accessed only via /api/comms/logbook with supabaseAdmin; deny-all (RLS on, no policies), scoped by property_id in code.
create table if not exists public.comms_log_entries (
  id               uuid primary key default gen_random_uuid(),
  property_id      uuid not null references public.properties(id) on delete cascade,
  author_staff_id  uuid,
  title            text not null,
  body             text not null default '',
  -- optional bucket: front_desk | housekeeping | maintenance | general (nullable).
  -- left free-form text (no check) so future buckets don't need a migration; the
  -- API validates the allowed set on write.
  category         text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists comms_log_entries_property_created_idx
  on public.comms_log_entries (property_id, created_at desc);

-- ── Replies (one thread per recap) ───────────────────────────────────────────
-- @rls: service-role-only — accessed only via /api/comms/logbook/replies with supabaseAdmin; deny-all (RLS on, no policies), scoped by property_id in code.
create table if not exists public.comms_log_replies (
  id               uuid primary key default gen_random_uuid(),
  entry_id         uuid not null references public.comms_log_entries(id) on delete cascade,
  property_id      uuid not null references public.properties(id) on delete cascade,
  author_staff_id  uuid,
  body             text not null,
  created_at       timestamptz not null default now()
);
create index if not exists comms_log_replies_entry_created_idx
  on public.comms_log_replies (entry_id, created_at);

-- ── RLS: service-role only (deny anon/authenticated; access via /api/*) ───────
alter table public.comms_log_entries enable row level security;
alter table public.comms_log_replies enable row level security;

comment on table public.comms_log_entries is
  'Shift Log Book recaps (titled free-text handoffs, scoped per property). Service-role only; access via /api/comms/logbook.';
comment on table public.comms_log_replies is
  'Threaded replies to a Shift Log Book recap. Service-role only; access via /api/comms/logbook/replies.';

-- PostgREST schema-cache reload (picked up by the running API).
notify pgrst, 'reload schema';

-- Self-register so the doctor's applied-migrations check + the
-- migration-bookkeeping drift test see this version.
insert into public.applied_migrations (version, description)
values ('0280', 'feature/log-book: Shift Log Book — comms_log_entries + comms_log_replies (titled per-property recaps + threaded replies). Service-role only (deny-all RLS); access via /api/comms/logbook*.')
on conflict (version) do nothing;
