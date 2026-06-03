-- ═══════════════════════════════════════════════════════════════════════════
-- 0254 — Communications "Slack-Classic" redesign: the data the new UI needs.
--
-- Additive only. Every existing column/table is untouched, so the currently
-- deployed (flat-chat) Communications tab keeps working unchanged until this
-- branch merges. Five additions:
--   1. comms_messages.parent_message_id  → threaded replies (Slack threads)
--   2. comms_messages.pinned_at / _by     → a per-channel pinned board
--   3. comms_tasks.priority               → Normal / High / Urgent to-dos
--   4. comms_reactions                    → the ✓ acknowledgement "reaction"
--                                           (a casual read-ack on ANY message —
--                                           distinct from the formal require-ack
--                                           announcement flow in 0248)
--   5. comms_presence                     → activity heartbeat → the green
--                                           "on shift" dots (online = seen in
--                                           the last couple of minutes)
--
-- All comms_* tables remain service-role-only (deny-all RLS; reached only via
-- /api/comms/* with supabaseAdmin after the route authenticates the caller).
-- NO SMS — in-app only.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1+2. Threaded replies + pinning on comms_messages ───────────────────────
alter table public.comms_messages
  add column if not exists parent_message_id  uuid references public.comms_messages(id) on delete cascade,
  add column if not exists pinned_at          timestamptz,
  add column if not exists pinned_by_staff_id uuid;

-- Replies fetched by parent; partial index keeps it tiny (most msgs are top-level).
create index if not exists comms_messages_parent_idx
  on public.comms_messages (parent_message_id)
  where parent_message_id is not null;

-- Pinned board per conversation, newest-pin first.
create index if not exists comms_messages_pinned_idx
  on public.comms_messages (conversation_id, pinned_at desc)
  where pinned_at is not null;

comment on column public.comms_messages.parent_message_id is
  'Threaded reply → the top-level message it answers. null = a top-level message (shown in the main pane). Replies are shown only in the thread panel.';
comment on column public.comms_messages.pinned_at is
  'When this message was pinned to the channel''s pinned board (null = not pinned).';

-- ── 3. To-do priority ───────────────────────────────────────────────────────
alter table public.comms_tasks
  add column if not exists priority text not null default 'normal'
    check (priority in ('normal', 'high', 'urgent'));

comment on column public.comms_tasks.priority is
  'To-do urgency: normal | high | urgent. Drives the colour dot + URGENT tag in the To-do view.';

-- ── 4. Acknowledgement "reactions" (the ✓ read-ack pill) ────────────────────
-- @rls: service-role-only — accessed only via /api/comms/* with supabaseAdmin;
-- RLS enabled with no anon/authenticated policies (deny-all).
create table if not exists public.comms_reactions (
  id          uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties(id) on delete cascade,
  message_id  uuid not null references public.comms_messages(id) on delete cascade,
  staff_id    uuid not null,
  kind        text not null default 'ack',
  created_at  timestamptz not null default now(),
  -- One ack per person per message: a double-tap is idempotent (unique violation
  -- is caught + treated as success), a toggle deletes the row.
  unique (message_id, staff_id, kind)
);
create index if not exists comms_reactions_message_idx
  on public.comms_reactions (message_id);

-- ── 5. Activity presence (the "on shift / online" dots) ─────────────────────
-- @rls: service-role-only — same deny-all pattern. One row per staff per
-- property, upserted on every Communications poll; "online" = last_seen_at
-- within the freshness window the server applies when it reads this back.
create table if not exists public.comms_presence (
  property_id  uuid not null references public.properties(id) on delete cascade,
  staff_id     uuid not null,
  last_seen_at timestamptz not null default now(),
  primary key (property_id, staff_id)
);
create index if not exists comms_presence_property_idx
  on public.comms_presence (property_id, last_seen_at desc);

-- ── RLS: service-role only (deny anon/authenticated; access via /api/*) ─────
alter table public.comms_reactions enable row level security;
alter table public.comms_presence  enable row level security;

comment on table public.comms_reactions is
  'Casual per-message read-acknowledgement reactions (the ✓ pill). NOT the formal require-ack announcement flow (comms_acknowledgements / 0248). Service-role only.';
comment on table public.comms_presence is
  'Activity heartbeat per staff per property → the green "on shift" presence dots. Online = recently seen. Service-role only.';

-- PostgREST schema-cache reload (picked up by the running API).
notify pgrst, 'reload schema';

-- Self-register so the doctor's applied-migrations check + the
-- migration-bookkeeping drift test see this version.
insert into public.applied_migrations (version, description)
values ('0254', 'communications Slack-Classic redesign data: comms_messages.parent_message_id (threaded replies) + pinned_at/pinned_by_staff_id (pinned board); comms_tasks.priority (normal/high/urgent); comms_reactions (casual ✓ read-ack reactions, idempotent unique(message,staff,kind)); comms_presence (activity heartbeat → on-shift/online dots). Additive — the deployed flat-chat tab is unchanged. comms_* tables service-role-only. NO SMS.')
on conflict (version) do nothing;
