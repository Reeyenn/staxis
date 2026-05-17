-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0149: Document remaining polymorphic / external ID columns
--
-- Data-model audit follow-up (2026-05-17). Migration 0142 enforced 8 implied
-- foreign keys and documented 3 polymorphic columns. The follow-up pass
-- flagged three more <name>_id columns that look like FKs but cannot be
-- enforced as such:
--
--   - agent_messages.tool_call_id  → an external Anthropic / OpenAI tool-call
--                                    ID (text), not a uuid into any table.
--   - claude_usage_log.job_id      → polymorphic between onboarding_jobs.id
--                                    and pull_jobs.id (set by the CUA worker).
--   - stripe_processed_events      → write-only by design (Stripe idempotency
--                                    insert-then-check pattern in the webhook
--                                    handler).
--
-- These were the audit's residual concerns. Adding COMMENT ON COLUMN /
-- COMMENT ON TABLE entries so the next data-model audit doesn't re-flag
-- them and so future contributors understand the absence of a FK.
--
-- Pure DDL metadata change — no data movement, no behavior change.
-- ═══════════════════════════════════════════════════════════════════════════

comment on column public.agent_messages.tool_call_id is
  'External tool-call ID emitted by the Anthropic / OpenAI Messages API as part of a tool_use content block. Echoed back on the matching tool_result message so call/result pairs can be reconstructed (see 0079_agent_layer.sql). Text, not uuid; no DB-level FK because the producer is the external model API.';

comment on column public.claude_usage_log.job_id is
  'Polymorphic reference to the CUA job that triggered the Anthropic call: onboarding_jobs.id for mapping/extraction workloads, pull_jobs.id for live-pull workloads. Set by the CUA worker (cua-service/src/usage-log.ts). DB-level FK not feasible — validate at the producer layer.';

comment on table public.stripe_processed_events is
  'Stripe webhook idempotency ledger. Written by /api/stripe/webhook on each event id before dispatch (insert-then-check pattern enforces single-delivery semantics). Read implicitly via the unique-violation that the insert returns when Stripe retries an event — there is no SELECT path by design.';

insert into applied_migrations (version, description)
values (
  '0149',
  'document polymorphic / external-ID columns (agent_messages.tool_call_id, claude_usage_log.job_id, stripe_processed_events)'
)
on conflict (version) do nothing;
