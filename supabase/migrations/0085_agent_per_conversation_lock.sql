-- Migration 0084: per-conversation advisory lock for the agent route
--
-- Adversarial review (2026-05-13) finding A-C4: two browser tabs sending
-- to the same conversationId interleave writes by microsecond created_at.
-- The pattern in src/app/api/agent/command/route.ts:
--   1. loadConversation() → reads history
--   2. recordUserTurn() → writes user message
--   3. streamAgent() → writes assistant + tool rows over time
-- has no per-conversation serialization. Two concurrent POSTs:
--   tab A: load(history@v0) → write user_msg_A
--   tab B: load(history@v0) → write user_msg_B
--   tab A: write assistant_A
--   tab B: write assistant_B
-- ...orders by microsecond timestamp into user-user-assistant-assistant,
-- which violates Anthropic's "tool_use must be immediately followed by
-- tool_result" rule on the next replay.
--
-- This RPC takes a pg_advisory_xact_lock keyed on the conversation_id.
-- The route calls it inside a transaction wrapping the load+writeUserTurn
-- prep window. The lock auto-releases on transaction end, so it does NOT
-- hold across the long-lived SSE stream — only across the prep step where
-- the race exists.

create or replace function public.staxis_lock_conversation(
  p_conversation_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_lock_key bigint;
begin
  -- Same hash pattern as the cost-control RPCs (md5 → bit(64) → bigint)
  -- so we play nicely with other staxis_* advisory locks (no collisions).
  v_lock_key := ('x' || substr(md5('agent_conv:' || p_conversation_id::text), 1, 16))::bit(64)::bigint;
  perform pg_advisory_xact_lock(v_lock_key);
end;
$$;

comment on function public.staxis_lock_conversation is
  'Per-conversation advisory lock. Caller must be inside a transaction — the lock releases automatically when the transaction commits or rolls back. Used by /api/agent/command to serialize the load-history → write-user-turn prep window so two browser tabs cannot interleave writes. Codex adversarial review 2026-05-13 (A-C4).';

revoke all on function public.staxis_lock_conversation(uuid) from public, anon, authenticated;
grant execute on function public.staxis_lock_conversation(uuid) to service_role;

insert into public.applied_migrations (version, description)
values ('0085', 'Codex review: per-conversation advisory lock RPC (A-C4)')
on conflict (version) do nothing;
