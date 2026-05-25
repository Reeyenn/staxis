-- Migration 0218: housekeeper voice issue reporting (feature #11)
--
-- Adds three pieces of infrastructure that let a housekeeper tap a mic on the
-- room card, speak in any of EN/ES/HT/TL/VI, and get a structured maintenance
-- ticket auto-created from the transcription:
--
--   1. Two new columns on agent_voice_sessions:
--        mode                 — 'general' | 'housekeeper_issue'
--                                Controls which system prompt the voice-brain
--                                webhook composes and which subset of the
--                                tool catalog the agent can call. Persisted on
--                                the session row (not just dynamic_variables)
--                                so a malicious client can't escalate from
--                                'housekeeper_issue' mode to 'general' mid-
--                                session and gain access to the full tool set.
--        current_room_number  — UI-supplied room hint for issue mode. Lets the
--                                agent default room_number = "305" without
--                                making the housekeeper say it twice.
--
--   2. New table staxis_voice_issues:
--        Captures structured maintenance reports created from a housekeeper
--        voice session. We deliberately do NOT write into pms_work_orders_v2
--        because that table is a reconciled snapshot of the PMS feed — the
--        CUA's writeStrategy='reconcile' (recipe-adapter.ts:165-171) auto-
--        resolves any row that disappears from the next PMS sync. A Staxis-
--        originated ticket has no upstream PMS counterpart and would be
--        marked 'resolved' on the next 30-second poll. Keeping these in their
--        own table sidesteps the reconciliation collision and gives the
--        maintenance dashboard a clean "operator-reported" feed to merge with
--        the PMS feed via a view (built later).
--
--   3. New private storage bucket voice-issues:
--        Reserved for the audio clip of the spoken issue (future enhancement —
--        v1 of the feature stores only the transcription). Private so the
--        clips never leak via the anon client; uploads + signed-URL reads go
--        through /api routes with service-role.

-- ── 1. Voice-session mode + room hint ───────────────────────────────────
-- Both columns nullable so the rollout doesn't disturb in-flight rows. The
-- application code treats null mode as 'general' (the only mode that existed
-- before this migration).
alter table public.agent_voice_sessions
  add column if not exists mode text default 'general'
    check (mode is null or mode in ('general', 'housekeeper_issue')),
  add column if not exists current_room_number text;

comment on column public.agent_voice_sessions.mode is
  'Voice agent mode. ''general'' = full chat/voice catalog scoped by role. ''housekeeper_issue'' = locked to the createMaintenanceWorkOrder tool with a specialized prompt. Persisted on the row (not dynamic_variables) so a client cannot escalate mid-session.';

comment on column public.agent_voice_sessions.current_room_number is
  'Optional room-number hint forwarded from the UI on session mint (e.g. the room card the mic was tapped from). Tools default to this value when the user doesn''t restate the room.';

-- ── 2. staxis_voice_issues table ────────────────────────────────────────
-- Structured maintenance reports created from a housekeeper voice session.
-- One row per submitted ticket. The CUA never touches this table, so the
-- reconcile-mode auto-resolve on pms_work_orders_v2 doesn't affect us.
-- @rls: service-role-only — Writes from the createMaintenanceWorkOrder agent tool (server-side, supabaseAdmin). Reads from /api/maintenance/* routes that already gate on property access. Browsers / anon clients never touch this table directly; deny-all RLS is the right posture (matches agent_voice_sessions in 0143).
create table if not exists public.staxis_voice_issues (
  id                       uuid primary key default gen_random_uuid(),
  property_id              uuid not null references public.properties(id) on delete cascade,
  staff_id                 uuid references public.staff(id) on delete set null,
  account_id               uuid references public.accounts(id) on delete set null,
  conversation_id          uuid references public.agent_conversations(id) on delete set null,
  -- Idempotency anchor. Codex 2026-05-25 (MAJOR fix): without a per-session
  -- unique constraint, a retried model call OR a webhook retry creates a
  -- second ticket with identical content. The tool now stamps the row with
  -- the resolved voice-session id and the partial unique index below
  -- collapses duplicate inserts onto the first row. The partial WHERE is
  -- there because we still allow NULL for historical / synthetic inserts
  -- (e.g. tests that bypass a real voice session).
  voice_session_id         uuid references public.agent_voice_sessions(id) on delete set null,

  -- Structured fields extracted by the agent from the spoken transcription.
  room_number              text,
  action                   text not null
                           check (action in ('REPAIR','REPLACE','CLEAN','INSPECT')),
  item                     text not null,
  location_detail          text,
  severity                 text not null default 'MINOR'
                           check (severity in ('MINOR','MAJOR','URGENT')),
  note                     text,

  -- Audit trail back to what the housekeeper actually said.
  original_language        text,
  original_transcription   text,

  -- Future: storage path inside the voice-issues bucket (NULL for v1 — the
  -- agent doesn't have access to the raw mic stream, just the ElevenLabs
  -- transcription). A storage path lets a follow-up reconstruct the audio if
  -- the transcription is ambiguous.
  voice_clip_path          text,

  -- Lifecycle. open → in_progress → resolved (or cancelled).
  status                   text not null default 'open'
                           check (status in ('open','in_progress','resolved','cancelled')),
  assigned_to              text,
  resolved_at              timestamptz,
  resolved_by              text,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

comment on table public.staxis_voice_issues is
  'Maintenance tickets created from a housekeeper voice report (feature #11). Deliberately separate from pms_work_orders_v2 because that table is a reconciled snapshot of the PMS feed and would auto-resolve any Staxis-originated row.';

create index if not exists staxis_voice_issues_property_status_idx
  on public.staxis_voice_issues (property_id, status, created_at desc);

create index if not exists staxis_voice_issues_staff_idx
  on public.staxis_voice_issues (property_id, staff_id, created_at desc)
  where staff_id is not null;

create index if not exists staxis_voice_issues_room_idx
  on public.staxis_voice_issues (property_id, room_number)
  where room_number is not null;

-- Idempotency: one ticket per voice session. A duplicate insert (model
-- retried createMaintenanceWorkOrder, webhook retried, etc.) hits this
-- index, the tool catches the 23505 and returns the existing row.
create unique index if not exists staxis_voice_issues_voice_session_unique
  on public.staxis_voice_issues (voice_session_id)
  where voice_session_id is not null;

-- ── 3. RLS ─────────────────────────────────────────────────────────────
-- Deny-all by default — service-role only. Reads + writes go through /api/*
-- routes that already gate on property access. Matches the agent_*
-- tables (0143) and the inspection tables (0212).
alter table public.staxis_voice_issues enable row level security;
-- No policies — service-role bypasses RLS, all other roles get nothing.

-- ── 4. Storage bucket for voice clips ──────────────────────────────────
-- Bucket is private. Uploads will go through /api/agent/voice-issue/upload
-- when the v2 mic-clip path lands; for v1 the bucket is created so the
-- column has a destination but the upload path is empty.
-- @storage: service-role-only — reads via signed URLs minted server-side.
insert into storage.buckets (id, name, public)
values ('voice-issues', 'voice-issues', false)
on conflict (id) do nothing;

-- ── 5. Migration record ────────────────────────────────────────────────
-- Renumbered twice at merge time: started 0214 → became 0215 when
-- cua-vision shipped its 0214_phase_b_hardening → became 0218 when the
-- cua-vision follow-up renumbered its three migrations forward into the
-- 0215/0216/0217 slots. Keeping the rename history here in case the
-- pattern repeats and the next merger needs to bump us again.
insert into public.applied_migrations (version, description)
values (
  '0218',
  'voice-issue-reporting: agent_voice_sessions.mode + current_room_number, staxis_voice_issues table, voice-issues storage bucket. Feature #11.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
