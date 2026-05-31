-- ════════════════════════════════════════════════════════════════════════
-- 0237_communications.sql — Built-in staff messaging ("Communications")
-- ════════════════════════════════════════════════════════════════════════
-- A hotel-owned team-chat replacing WhatsApp/consumer apps:
--   • 1:1 direct messages + department channels + announcements
--   • read cursors (drives unread badges + "who's seen it" receipts)
--   • photo / voice attachments (private bucket, signed URLs)
--   • structured shift-handoff posts
--   • a to-do list (assign to person OR department, due date, check off)
--   • per-message auto-translation cache (each reader in their own language)
--   • per-user app-language preference (managers; floor staff use staff.language)
--
-- NO SMS anywhere. All notifications are in-app (unread counts, polling).
--
-- Service-role only: RLS is enabled with NO policies, so anon/authenticated
-- are denied by default. Every read/write goes through /api/* routes that use
-- supabaseAdmin (service-role), which bypasses RLS. Same pattern as
-- 0233_complaints.sql.
-- ════════════════════════════════════════════════════════════════════════

-- ── Conversations ───────────────────────────────────────────────────────
-- One row per DM, channel, or the property's announcement feed.
create table if not exists public.comms_conversations (
  id                uuid primary key default gen_random_uuid(),
  property_id       uuid not null references public.properties(id) on delete cascade,
  -- 'dm' (1:1), 'channel' (department), 'announcement' (manager → everyone)
  kind              text not null check (kind in ('dm', 'channel', 'announcement')),
  -- channels: 'front_desk' | 'housekeeping' | 'maintenance' | 'all_staff'
  -- announcement: 'announcements'. null for DMs.
  channel_key       text,
  -- DMs: canonical "<minStaffId>:<maxStaffId>" so a pair maps to ONE convo.
  -- null for channels/announcement.
  dm_key            text,
  title             text,
  created_by_staff_id uuid,
  last_message_at   timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- One channel/announcement feed per key per property.
create unique index if not exists comms_conversations_channel_uidx
  on public.comms_conversations (property_id, channel_key)
  where channel_key is not null;
-- One DM per staff-pair per property.
create unique index if not exists comms_conversations_dm_uidx
  on public.comms_conversations (property_id, dm_key)
  where dm_key is not null;
create index if not exists comms_conversations_property_idx
  on public.comms_conversations (property_id, last_message_at desc nulls last);

-- ── Members / read cursors ──────────────────────────────────────────────
-- For DMs: the two participants. For channels/announcement: a row is lazily
-- created the first time a staff opens the feed, purely to track last_read_at
-- (channel *visibility* is dynamic — derived from staff.department — so we do
-- NOT need a membership row to see a channel). last_read_at drives both the
-- unread badge and the "seen by" read receipts.
create table if not exists public.comms_members (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid not null references public.properties(id) on delete cascade,
  conversation_id uuid not null references public.comms_conversations(id) on delete cascade,
  staff_id        uuid not null,
  last_read_at    timestamptz,
  created_at      timestamptz not null default now(),
  unique (conversation_id, staff_id)
);
create index if not exists comms_members_staff_idx
  on public.comms_members (property_id, staff_id);

-- ── Messages ────────────────────────────────────────────────────────────
create table if not exists public.comms_messages (
  id                uuid primary key default gen_random_uuid(),
  property_id       uuid not null references public.properties(id) on delete cascade,
  conversation_id   uuid not null references public.comms_conversations(id) on delete cascade,
  -- staff who sent it. null for Staxis-assistant / system posts.
  sender_staff_id   uuid,
  -- 'staff' | 'staxis' (in-chat assistant) | 'system'
  sender_kind       text not null default 'staff'
                      check (sender_kind in ('staff', 'staxis', 'system')),
  -- The original text (transcript for voice; may be '' for photo-only posts).
  body              text not null default '',
  -- Best-effort BCP-47 code of `body` so we don't re-translate into its own lang.
  source_lang       text,
  -- 'text' | 'announcement' | 'handoff' | 'photo' | 'voice' | 'task' | 'system'
  msg_type          text not null default 'text'
                      check (msg_type in ('text','announcement','handoff','photo','voice','task','system')),
  -- Attachments (private bucket path; signed URL minted on read).
  attachment_path   text,
  attachment_kind   text check (attachment_kind in ('photo','voice')),
  voice_duration_ms integer,
  -- Structured shift-handoff fields (msg_type='handoff').
  handoff_shift     text check (handoff_shift in ('morning','afternoon','night','overnight')),
  handoff_outstanding text,
  -- Free-form structured payload (action results, polish metadata, etc.).
  meta              jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now()
);
create index if not exists comms_messages_conversation_idx
  on public.comms_messages (conversation_id, created_at);
create index if not exists comms_messages_property_idx
  on public.comms_messages (property_id, created_at desc);

-- ── Per-message translation cache ───────────────────────────────────────
-- Cascades on message delete (so deleting a message removes its translations).
create table if not exists public.comms_message_translations (
  id              uuid primary key default gen_random_uuid(),
  message_id      uuid not null references public.comms_messages(id) on delete cascade,
  lang            text not null,
  translated_body text not null,
  created_at      timestamptz not null default now(),
  unique (message_id, lang)
);

-- ── To-do list ──────────────────────────────────────────────────────────
create table if not exists public.comms_tasks (
  id                  uuid primary key default gen_random_uuid(),
  property_id         uuid not null references public.properties(id) on delete cascade,
  title               text not null,
  notes               text,
  -- assign to a person OR a department (at least one is typically set).
  assigned_staff_id   uuid,
  assigned_department text,
  due_at              timestamptz,
  status              text not null default 'open' check (status in ('open','done')),
  created_by_staff_id uuid,
  -- "Turn this message into a task" provenance.
  source_message_id   uuid references public.comms_messages(id) on delete set null,
  completed_at        timestamptz,
  completed_by_staff_id uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists comms_tasks_property_status_idx
  on public.comms_tasks (property_id, status, due_at nulls last);

-- ── Generic UI-string translation cache (GLOBAL, non-tenant) ────────────
-- Caches app-chrome string translations so the 5-language switcher renders
-- HT/TL/VI without re-calling the model. Keyed by sha256(source)+lang. Holds
-- only generic UI labels + the requester's own text → no tenant linkage, so a
-- shared cache across properties is safe and maximizes hit rate. Message
-- BODIES are NOT cached here — those live in comms_message_translations
-- (message-scoped, cascades on delete).
create table if not exists public.comms_translation_cache (
  id              uuid primary key default gen_random_uuid(),
  source_hash     text not null,
  target_lang     text not null,
  source_text     text not null,
  translated_text text not null,
  created_at      timestamptz not null default now(),
  unique (source_hash, target_lang)
);

-- ── Per-user app-language preference (managers / authenticated accounts) ──
-- Floor staff already persist their choice in staff.language; this mirrors
-- that for account-based users so the whole app follows them across devices.
alter table public.accounts
  add column if not exists preferred_language text;

-- ── RLS: service-role only (deny anon/authenticated; access via /api/*) ──
alter table public.comms_conversations        enable row level security;
alter table public.comms_members              enable row level security;
alter table public.comms_messages             enable row level security;
alter table public.comms_message_translations enable row level security;
alter table public.comms_tasks                enable row level security;
alter table public.comms_translation_cache    enable row level security;

comment on table public.comms_conversations is
  'Staff messaging conversations (dm/channel/announcement). Service-role only; access via /api/comms/* and /api/housekeeper/messages/*.';
comment on table public.comms_messages is
  'Staff messages. NO SMS — in-app only. Service-role only.';
comment on table public.comms_tasks is
  'Communications to-do list. Service-role only.';

-- PostgREST schema-cache reload (picked up by the running API).
notify pgrst, 'reload schema';
