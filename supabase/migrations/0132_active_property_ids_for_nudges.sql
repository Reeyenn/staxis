-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0132: staxis_active_property_ids_for_nudges
--
-- /api/agent/nudges/check runs every 5 minutes via Vercel cron and used to
-- iterate ALL properties via `properties.select('id')`. At fleet scale that
-- means 288 nudge-evaluation passes per day per property, even for
-- properties with zero agent activity in the relevant window. Most are
-- wasted work.
--
-- This function returns only the property IDs that have had ANY
-- agent_messages row in the last N days. Cron handler swaps its listing
-- query for this RPC.
--
-- Cost audit recommendation #9 in .claude/reports/cost-hotpaths-audit.md.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function staxis_active_property_ids_for_nudges(
  p_window_days int default 7
)
returns table (property_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  -- Properties that had ANY agent activity in the window. We look at
  -- agent_messages directly because:
  --   • a conversation can be "active" (last_message_at recent) but the
  --     agent_conversations row's `updated_at` lags behind by the time
  --     a message is recorded under load — agent_messages is the source
  --     of truth
  --   • EXISTS short-circuits per property, so this is fast even on
  --     large agent_messages tables (we have a (property_id, created_at)
  --     index — see migration 0027 onwards)
  -- 2026-05-17 fix: agent_messages has no direct property_id column —
  -- it joins to properties via agent_conversations.property_id. Original
  -- draft of this migration referenced m.property_id and failed at
  -- create-function time. The /api/agent/nudges/check route fell back
  -- to listing all properties (rpcErr branch) until this fix landed.
  select p.id
    from properties p
   where exists (
     select 1
       from agent_messages m
       join agent_conversations c on c.id = m.conversation_id
      where c.property_id = p.id
        and m.created_at >= now() - make_interval(days => p_window_days)
   );
$$;

-- Allow the cron's service role to invoke it. Cron handlers run as the
-- service role (CRON_SECRET-gated), so authenticated grant is sufficient
-- and follows the existing convention from migration 0125.
grant execute on function staxis_active_property_ids_for_nudges(int) to authenticated;
grant execute on function staxis_active_property_ids_for_nudges(int) to service_role;

comment on function staxis_active_property_ids_for_nudges(int) is
  'Returns property IDs with any agent_messages activity in the last N days. '
  'Used by the nudges-check cron to avoid evaluating dormant properties. '
  'Migration 0132 (2026-05-17).';

insert into applied_migrations (version, description)
values (
  '0132',
  'cost audit: staxis_active_property_ids_for_nudges RPC for nudges-check cron scope tightening'
)
on conflict (version) do nothing;
