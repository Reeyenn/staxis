-- Migration 0083: capture exact Anthropic model ID alongside the tier
--
-- agent_costs.model currently stores the TIER ('sonnet' | 'haiku' | 'opus').
-- The Anthropic API also returns the exact model snapshot ID in the
-- response (e.g. 'claude-sonnet-4-6-20260427'). Capturing this lets us
-- correlate quality shifts to specific Claude releases — useful when
-- Anthropic ships periodic snapshot updates and we want to A/B compare.
--
-- We add a separate column rather than overloading `model` so the
-- /admin/agent dashboard's existing groupings ("how much did we spend on
-- Sonnet today") still work; the new column is purely additional context.

alter table public.agent_costs
  add column if not exists model_id text;

-- Update the finalize RPC to accept and persist the new column. The other
-- three RPCs (reserve, cancel, record_assistant_turn) don't touch model
-- info — only finalize gets called with the response.model value from
-- Anthropic, after the stream has completed.
create or replace function public.staxis_finalize_agent_spend(
  p_reservation_id uuid,
  p_conversation_id uuid,
  p_actual_usd numeric,
  p_model text,
  p_model_id text,
  p_tokens_in integer,
  p_tokens_out integer,
  p_cached_input_tokens integer
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.agent_costs
  set state = 'finalized',
      conversation_id = p_conversation_id,
      cost_usd = p_actual_usd,
      model = p_model,
      model_id = p_model_id,
      tokens_in = p_tokens_in,
      tokens_out = p_tokens_out,
      cached_input_tokens = p_cached_input_tokens
  where id = p_reservation_id;
end;
$$;

comment on function public.staxis_finalize_agent_spend(uuid, uuid, numeric, text, text, integer, integer, integer) is
  'Reconcile a reservation to actual spend after the agent stream completes. Includes exact Anthropic model_id alongside the tier. Codex review fix S5, 2026-05-13.';

-- The previous (7-arg) overload is no longer used by application code.
-- Drop it so callers using the old signature error loudly rather than
-- silently dropping the model_id.
drop function if exists public.staxis_finalize_agent_spend(uuid, uuid, numeric, text, integer, integer, integer);

-- Grants — service_role only, same as the prior version.
revoke execute on function public.staxis_finalize_agent_spend(uuid, uuid, numeric, text, text, integer, integer, integer) from public;
revoke execute on function public.staxis_finalize_agent_spend(uuid, uuid, numeric, text, text, integer, integer, integer) from anon, authenticated;
grant  execute on function public.staxis_finalize_agent_spend(uuid, uuid, numeric, text, text, integer, integer, integer) to   service_role;

insert into public.applied_migrations (version, description)
values ('0083', 'Codex review: capture exact Anthropic model_id alongside tier')
on conflict (version) do nothing;
