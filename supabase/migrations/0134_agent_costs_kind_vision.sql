-- Migration 0134: extend agent_costs.kind to include 'vision'
--
-- Security review 2026-05-16 (Surface 3 P2 — Pattern F): vision invoice
-- scans + shelf photo counts call Anthropic Vision but never wrote their
-- spend to agent_costs. Result: the daily $ cap (`assertAudioBudget`,
-- which sums today's agent_costs across all kinds) NEVER saw vision
-- usage. Hourly request-count limit (50/hr/property) caught volume but
-- not $.
--
-- Adding the 'vision' kind lets the cost-controls primitive book vision
-- spend alongside audio/eval/background, so a single property hitting
-- the daily $ cap via lots of small vision scans gets blocked the same
-- way it would via chat or voice spend.
--
-- Mirror of migration 0117's pattern (which added 'audio').

ALTER TABLE public.agent_costs
  DROP CONSTRAINT IF EXISTS agent_costs_kind_check;

ALTER TABLE public.agent_costs
  ADD CONSTRAINT agent_costs_kind_check
  CHECK (kind IN ('request', 'eval', 'background', 'audio', 'vision'));

INSERT INTO public.applied_migrations (version, description)
VALUES ('0134', 'agent_costs.kind extended to include ''vision'' — closes Surface 3 P2 Pattern F')
ON CONFLICT (version) DO NOTHING;

NOTIFY pgrst, 'reload schema';
