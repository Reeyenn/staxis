-- ═══════════════════════════════════════════════════════════════════════════
-- 0294 — Reduced-exposure inventory prior columns on inventory_rate_priors.
--
-- WHAT & WHY
--   The inventory-usage model was rebuilt (2026-07-05) from an occupancy
--   regression (daily_rate = a + b·occupancy) to a REDUCED EXPOSURE model:
--       window_consumption = s · (ΣCheckouts + κ·ΣStayovers)
--   where s is the per-checkout-equivalent usage scale (the single learned
--   coefficient) and κ is fixed per item from its usage_per_stayover /
--   usage_per_checkout config.
--
--   The cohort prior therefore has to be denominated per-CHECKOUT-EQUIVALENT
--   (units per (checkout + κ·stayover)) instead of per-room-per-day, so a new
--   hotel's item can seed s directly. The existing per-room-per-day column
--   (prior_rate_per_room_per_day) is KEPT untouched — the occupancy-family
--   model and other consumers still read it. This migration only ADDS the
--   exposure-prior columns:
--       rate_per_checkout_eq  numeric  — pooled median s_hat across hotels
--       n_hotels              int      — distinct hotels contributing to the
--                                        exposure prior (mirrors the existing
--                                        n_hotels_contributing, added separately
--                                        so a future producer can diverge the
--                                        two denominations' contributor counts).
--
--   inventory_priors.py (aggregate_inventory_priors) writes both columns; the
--   trainer's _lookup_exposure_prior reads rate_per_checkout_eq to seed s for a
--   brand-new item.
--
-- IDEMPOTENT: add-column-if-not-exists + create-or-replace bookkeeping. Safe to
--   re-run. Modeled on 0292's structure (applied_migrations + NOTIFY pgrst).
--
-- Manual prod apply: per project_migration_application_manual.md — this file is
--   NOT auto-applied on deploy; the doctor check is the net. The orchestrator
--   applies it manually.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE public.inventory_rate_priors
  ADD COLUMN IF NOT EXISTS rate_per_checkout_eq numeric(12,6);

ALTER TABLE public.inventory_rate_priors
  ADD COLUMN IF NOT EXISTS n_hotels integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.inventory_rate_priors.rate_per_checkout_eq IS
  'Reduced-exposure prior (0294): pooled median per-(checkout + κ·stayover) usage scale s across contributing hotels for this (cohort_key, item_canonical_name). Seeds the single learned coefficient s of the exposure model window_consumption = s·(ΣCO + κ·ΣSO) for a brand-new item. NULL when no exposure signal exists (falls back to converting prior_rate_per_room_per_day). Distinct from prior_rate_per_room_per_day, which the legacy occupancy-family model still reads.';

COMMENT ON COLUMN public.inventory_rate_priors.n_hotels IS
  'Reduced-exposure prior (0294): count of DISTINCT hotels contributing to rate_per_checkout_eq. Mirrors n_hotels_contributing but tracked separately for the exposure denomination so the two can diverge as producers evolve. Used by the precision cap (prior strength ceilinged at ~1 hotel-worth of evidence until ≥4 hotels enable between-hotel empirical Bayes).';

INSERT INTO public.applied_migrations (version, description)
VALUES (
  '0294',
  'Reduced-exposure inventory priors: add inventory_rate_priors.rate_per_checkout_eq (pooled median per-(checkout+κ·stayover) usage scale) + n_hotels. Seeds the exposure model''s single coefficient s for new items. Keeps prior_rate_per_room_per_day for the occupancy-family model.'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
