-- Migration 0143: agent_voice_sessions — server-resolved identity for voice agent
--
-- Codex adversarial review 2026-05-16 (P0): the voice path reconstructed
-- ToolContext entirely from client-controlled `customLlmExtraBody.dynamic_variables`.
-- Any authenticated user could mint a voice session for their own property, then
-- intercept the ElevenLabs SDK config before WS handshake to replace the
-- dynamic_variables with another property's UUID. The webhook accepted those
-- values verbatim and called getToolsForRole(role) without surface='voice',
-- exposing every chat tool on the forged identity. Cross-tenant escape from
-- any authenticated account, no precondition.
--
-- Root-cause fix (Pattern A — identity must not cross a trust boundary without
-- re-validation): a server-side voice-session row. /voice-session writes the
-- row at mint-time and returns only the row id as a nonce. /voice-brain looks
-- up the nonce, re-loads identity from the accounts table (never trusting the
-- snapshot for authorization), and re-runs userHasPropertyAccess.
--
-- The role/property snapshots are kept for audit only; authorization always
-- reads from the current accounts row so revocation propagates immediately.

-- ─── Table ────────────────────────────────────────────────────────────

create table if not exists public.agent_voice_sessions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  data_user_id uuid not null references auth.users(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  conversation_id uuid not null references public.agent_conversations(id) on delete cascade,
  -- Snapshots are for audit / debugging only. Authorization MUST re-load from
  -- accounts at every webhook call so revocation propagates immediately.
  role_snapshot text not null,
  staff_id_snapshot uuid,
  created_at timestamptz not null default now(),
  -- 4-hour TTL: a voice session is meant for one conversation. ElevenLabs
  -- signed URLs expire much sooner (~15 min) so this is the outer bound for
  -- a long conversation; the typical session ends in minutes. Stale rows are
  -- ignored by resolveVoiceSession() and reaped by a future cron.
  expires_at timestamptz not null default (now() + interval '4 hours')
);

comment on table public.agent_voice_sessions is
  'Server-side voice-session record. The id is the nonce passed through ElevenLabs dynamic_variables; the webhook re-resolves account/property/role from this row + the accounts table. Closes Codex 2026-05-16 P0 voice-identity-forgery. Snapshots are audit-only — authorization always re-loads.';

-- ─── Indexes ───────────────────────────────────────────────────────────

-- Hot path: webhook lookup by id (already a PK, but explicit for clarity).
-- Property-level rollup for /admin/agent voice telemetry (future).
create index if not exists agent_voice_sessions_property_created_idx
  on public.agent_voice_sessions(property_id, created_at desc);

-- Account-level lookup for "your active voice sessions" UI (future).
create index if not exists agent_voice_sessions_account_created_idx
  on public.agent_voice_sessions(account_id, created_at desc);

-- Expiry reaper (future cron). Plain btree on expires_at — a partial index
-- using `where expires_at < now()` would need now() to be IMMUTABLE, which
-- it isn't, so Postgres rejects it. The reaper filters at query time.
create index if not exists agent_voice_sessions_expires_idx
  on public.agent_voice_sessions(expires_at);

-- ─── RLS ───────────────────────────────────────────────────────────────
-- Deny-all by default. The route uses supabaseAdmin (service-role) for
-- inserts + lookups; ordinary clients never read this table directly.
-- Modeled after agent_prompts (0102) and agent_*_archived (0105).

alter table public.agent_voice_sessions enable row level security;

-- No policies — service-role bypasses RLS, all other roles get nothing.
-- This is intentional: the id is a capability token; anything that could
-- read the table from a non-admin context could mint forged sessions.

-- ─── Track the migration ──────────────────────────────────────────────

insert into public.applied_migrations (version, description)
values ('0143', 'agent_voice_sessions: server-resolved identity for voice agent (Codex 2026-05-16 P0 fix; Pattern A)')
on conflict (version) do nothing;

-- ─── Schema reload notice ─────────────────────────────────────────────
-- Reload PostgREST's schema cache so /api routes see the new table.

notify pgrst, 'reload schema';
