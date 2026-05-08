-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0035: Stripe webhook idempotency + uniqueness invariants
--
-- Two fixes from the review of 0034:
--
--   1. properties.stripe_customer_id had no uniqueness constraint, so a
--      data corruption bug or a botched Stripe migration could end up
--      with two properties pointing at the same customer. The webhook
--      handler does `.eq('stripe_customer_id', customerId)` and updates
--      ALL matching rows — silently double-billing or double-flipping
--      states. Add UNIQUE.
--
--   2. The webhook handler had no idempotency layer. Stripe retries
--      events on non-2xx responses, and even on success there's a
--      small window where a second delivery can arrive (Stripe's docs
--      explicitly warn about it). Without dedupe, repeated
--      checkout.session.completed events could double-process. Add a
--      stripe_processed_events table that the handler INSERTs into
--      first; on conflict (already processed) we 200 and skip.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Unique stripe_customer_id ───────────────────────────────────────
-- Partial unique index: NULL is allowed (we don't generate a customer
-- until first checkout for some signup paths). Two NULLs don't conflict.

create unique index if not exists properties_stripe_customer_id_unique_idx
  on public.properties (stripe_customer_id)
  where stripe_customer_id is not null;

comment on index properties_stripe_customer_id_unique_idx is
  'One property per Stripe customer. Webhook handler relies on this — without it a corrupted dataset would be double-billed.';

-- ─── 2. stripe_processed_events ─────────────────────────────────────────
-- One row per Stripe event_id we've successfully processed. Webhook
-- handler INSERTs first (with on conflict do nothing); if rowCount=0
-- we know we've seen this event before and short-circuit. Stripe events
-- are immutable so processing once is enough.
--
-- TTL: not strictly needed. Stripe event_ids are 64 chars and we get
-- maybe 10 events/property/month → at 300 hotels that's 3000/month.
-- A year of events is 36k rows, ~3 MB. Cheap enough to keep forever
-- for audit trail, but a 90-day retention cron is fine if we want it.

create table if not exists public.stripe_processed_events (
  event_id     text primary key,
  event_type   text not null,
  /** Property id resolved at processing time, for audit trail. */
  property_id  uuid references public.properties(id) on delete set null,
  processed_at timestamptz not null default now(),
  /** Lightweight payload metadata for replay debugging (NOT the full
   *  event — too large; Stripe keeps the canonical copy). */
  metadata     jsonb
);

create index if not exists stripe_processed_events_property_idx
  on public.stripe_processed_events (property_id, processed_at desc)
  where property_id is not null;

create index if not exists stripe_processed_events_recent_idx
  on public.stripe_processed_events (processed_at desc);

alter table public.stripe_processed_events enable row level security;

drop policy if exists stripe_processed_events_deny_browser on public.stripe_processed_events;
create policy stripe_processed_events_deny_browser on public.stripe_processed_events
  for all to anon, authenticated using (false) with check (false);

comment on table public.stripe_processed_events is
  'Idempotency table for the Stripe webhook handler. Insert first; if conflict, this event was already processed and we 200 + skip. Service-role only.';

-- ─── Record migration ───────────────────────────────────────────────────
insert into public.applied_migrations (version, description)
values ('0035', 'Stripe webhook idempotency + properties.stripe_customer_id UNIQUE')
on conflict (version) do nothing;
