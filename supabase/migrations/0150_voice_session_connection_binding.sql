-- Migration 0150: agent_voice_sessions connection binding + idle expiry
--
-- Closes Plan v2 M-1 ("Voice-session nonce is a 4-hour bearer with no
-- connection binding"). Even with the Pattern A server-resolved identity
-- shipped in 0143, the session id flowing through ElevenLabs is a long-
-- lived bearer capability: anyone who learns a `staxis_voice_session_id`
-- and holds the (org-wide) `ELEVENLABS_WEBHOOK_SECRET` can replay turns
-- as the victim for the full 4-hour TTL, because resolveVoiceSession()
-- only checks { row exists, not expired, account exists, access valid }.
--
-- Fix:
--   1. Bind the row to ElevenLabs' own `conversation_id` on the FIRST
--      webhook turn. Subsequent turns must match — a forged replay from a
--      different ElevenLabs conversation is refused.
--   2. Stamp `last_turn_at` on every accepted turn. Turns that arrive more
--      than 5 minutes after the last accepted turn are refused as
--      `session_idle_expired` — a long-lived nonce that nobody is actively
--      using becomes useless almost immediately.
--   3. Tighten the default TTL for NEW rows from 4h to 30 min. Real voice
--      conversations end in single-digit minutes; the previous 4h ceiling
--      gave a captured nonce far more replay window than any legitimate
--      session needed. Existing rows keep their old TTL until they expire
--      (forward-only — no UPDATE on existing rows).
--
-- All three columns are nullable / soft so the rollout doesn't break the
-- in-flight voice traffic: the application code treats NULL
-- `elevenlabs_conversation_id` as "not yet bound" and accepts the first
-- turn, then writes the binding atomically (compare-and-set).

alter table public.agent_voice_sessions
  add column if not exists elevenlabs_conversation_id text,
  add column if not exists last_turn_at timestamptz;

-- Tighten the default for FUTURE rows. Existing rows keep their 4h TTL.
alter table public.agent_voice_sessions
  alter column expires_at set default (now() + interval '30 minutes');

-- Lookup index for the binding check. Partial because most rows haven't
-- claimed their connection yet (pre-fix) or are post-claim and looked up
-- by primary key anyway; the partial index just keeps the b-tree small.
create index if not exists agent_voice_sessions_eleven_conv_idx
  on public.agent_voice_sessions(elevenlabs_conversation_id)
  where elevenlabs_conversation_id is not null;

-- Index for the idle reaper (future cron) — find rows whose last_turn_at
-- is far in the past so we can purge or mark them dead.
create index if not exists agent_voice_sessions_last_turn_idx
  on public.agent_voice_sessions(last_turn_at);

comment on column public.agent_voice_sessions.elevenlabs_conversation_id is
  'ElevenLabs Conversational AI conversation_id, written on the FIRST webhook turn that accepts this row. Subsequent turns whose body carries a different conversation_id are rejected as session_binding_mismatch. Closes M-1 in security/03-ai-cua-scraper-ml-plan v2.';

comment on column public.agent_voice_sessions.last_turn_at is
  'Timestamp of the most recent accepted webhook turn. A gap of >5 minutes between turns rejects the next turn as session_idle_expired — real voice conversations turn within seconds, large gaps suggest a replayed or abandoned nonce.';

insert into applied_migrations (version, description)
values (
  '0150',
  'agent_voice_sessions: connection binding + idle expiry + tighter default TTL (M-1, voice replay close)'
)
on conflict (version) do nothing;

-- ─── Schema reload notice ─────────────────────────────────────────────
notify pgrst, 'reload schema';
