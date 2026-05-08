-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0038: subscription_status enum normalization + trial_ends_at default
--
-- Two HIGH findings from review pass 3:
--
--   H3 — properties.subscription_status CHECK accepted 'cancelled' (British)
--        but Stripe sends 'canceled' (American). The first time a customer
--        actually cancelled, the webhook's UPDATE would throw 23514. Also
--        missing from the enum: 'unpaid', 'incomplete_expired', 'paused' —
--        all real Stripe Subscription statuses we'd see in dunning flows.
--
--   H4 — properties.trial_ends_at had no DEFAULT, so a row inserted with
--        subscription_status='trial' but no explicit trial_ends_at would
--        end up NULL. The expire-trials cron uses < now() which excludes
--        NULL, so a NULL-trial-end gives the property a free account
--        forever. Add a DEFAULT (now() + interval '14 days') and a CHECK
--        that prevents trial-without-end from ever existing.
--
-- All changes safe to apply on a live DB:
--   - Step 1 renames any existing 'cancelled' rows to 'canceled' so the
--     new CHECK accepts them.
--   - Step 2 swaps the constraint atomically.
--   - Step 3 backfills NULL trial_ends_at for current trial rows.
--   - Step 4 sets the column default for future inserts.
--   - Step 5 adds a partial CHECK that all of 1-4 satisfy.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Normalize 'cancelled' → 'canceled' (Stripe's spelling) ─────────

-- Pre-migration there's exactly one possible value for cancelled rows:
-- 'cancelled' (set by the webhook's customer.subscription.deleted handler
-- and by mapStripeStatus). After this update the only canceled rows
-- spell it 'canceled'.
update public.properties
set subscription_status = 'canceled'
where subscription_status = 'cancelled';

-- ─── 2. Swap CHECK constraint to the full Stripe + Staxis vocabulary ──

-- Drop the 0034 constraint (whose name follows the Postgres default
-- naming convention). If the project ever generated a different name,
-- this will fail loudly — that's fine, manual cleanup is appropriate.
alter table public.properties
  drop constraint if exists properties_subscription_status_check;

-- New constraint: Stripe's full Subscription.Status set + our local
-- 'trial' (mapped from Stripe 'trialing' via mapStripeStatus). 'canceled'
-- is American spelling now; mapStripeStatus updated in same PR to match.
alter table public.properties
  add constraint properties_subscription_status_check
  check (subscription_status in (
    'trial',                 -- local: pre-payment trial period (Stripe 'trialing' maps here)
    'active',                -- paying, in good standing
    'past_due',              -- payment failed, dunning
    'canceled',              -- subscription terminated (Stripe spelling)
    'incomplete',            -- first invoice not yet paid (24h window)
    'incomplete_expired',    -- first invoice never paid → terminal
    'unpaid',                -- recurring payment failed past dunning → terminal-ish
    'paused'                 -- temporarily paused (rare)
  ));

-- ─── 3. Backfill NULL trial_ends_at for any existing trial properties ──

-- The trial countdown for these rows starts NOW (not from created_at),
-- because some may have been created weeks ago and would have already
-- expired. Better to give them a fresh 14-day clock than to silently
-- past_due them on the first cron run.
update public.properties
set trial_ends_at = now() + interval '14 days'
where subscription_status = 'trial'
  and trial_ends_at is null;

-- ─── 4. Set DEFAULT so future inserts that omit the column get 14 days ─

-- This is the primary fix: any row inserted with status='trial' now has
-- trial_ends_at automatically populated. Application code that does
-- specify trial_ends_at explicitly is unaffected.
alter table public.properties
  alter column trial_ends_at set default (now() + interval '14 days');

-- ─── 5. Hard invariant: trial rows must have an end date ───────────────

-- Belt-and-suspenders against future regressions. If app code ever tries
-- to write subscription_status='trial' with NULL trial_ends_at, the
-- transaction fails immediately instead of silently creating a never-
-- ending free trial.
alter table public.properties
  add constraint properties_trial_has_end
  check (subscription_status <> 'trial' or trial_ends_at is not null);

-- ─── Record migration ───────────────────────────────────────────────────
insert into public.applied_migrations (version, description)
values ('0038', 'subscription_status enum normalization + trial_ends_at DEFAULT/CHECK')
on conflict (version) do nothing;
