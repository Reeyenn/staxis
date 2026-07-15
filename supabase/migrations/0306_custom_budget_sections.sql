-- ═══════════════════════════════════════════════════════════════════════════
-- 0306 — Custom inventory budget sections + total-budget mode.
--
-- The Budgets panel is rebuilt around two ways a GM budgets inventory:
--   • 'total'    — one number per month for the whole inventory.
--   • 'sections' — the three app categories PLUS custom, hotel-defined
--                  sections ("Pool supplies"), each mapped to specific
--                  inventory items so spend tracks automatically.
--
-- Three pieces:
--   1. inventory_budgets.category CHECK relaxed: allows 'total' and
--      'section:<uuid>' keys alongside the three category keys.
--   2. properties.inventory_budget_mode — which way this hotel budgets.
--   3. inventory_budget_sections — the custom sections themselves
--      (name + the item ids whose orders count toward the section).
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- Guard: the RLS helper this migration's policies depend on.
DO $$
BEGIN
  IF to_regprocedure('public.mfa_verified_or_grace()') IS NULL THEN
    RAISE EXCEPTION 'apply migration 0159 first — mfa_verified_or_grace() missing';
  END IF;
END $$;

-- ─── 1. Budget rows can now be keyed by 'total' or a custom section ──────
ALTER TABLE public.inventory_budgets
  DROP CONSTRAINT IF EXISTS inventory_budgets_category_check;
ALTER TABLE public.inventory_budgets
  ADD CONSTRAINT inventory_budgets_category_check
  CHECK (
    category IN ('housekeeping', 'maintenance', 'breakfast', 'total')
    OR category ~ '^section:[0-9a-fA-F-]{36}$'
  );

-- ─── 2. Per-property budget mode ─────────────────────────────────────────
ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS inventory_budget_mode text NOT NULL DEFAULT 'sections'
  CHECK (inventory_budget_mode IN ('total', 'sections'));

COMMENT ON COLUMN public.properties.inventory_budget_mode IS
  'How this hotel budgets inventory: ''total'' = one whole-inventory number per month (inventory_budgets category=''total''); ''sections'' = per-category rows plus custom section:<uuid> rows. Set from the inventory Budgets panel.';

-- ─── 3. Custom sections ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.inventory_budget_sections (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 60),
  -- Inventory item ids whose orders count toward this section's spend.
  item_ids     uuid[] NOT NULL DEFAULT '{}',
  sort         integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inventory_budget_sections_property_idx
  ON public.inventory_budget_sections (property_id);

DROP TRIGGER IF EXISTS inventory_budget_sections_touch ON public.inventory_budget_sections;
CREATE TRIGGER inventory_budget_sections_touch
  BEFORE UPDATE ON public.inventory_budget_sections
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

COMMENT ON TABLE public.inventory_budget_sections IS
  'Hotel-defined budget sections for inventory ("Pool supplies"): a name plus the inventory item ids whose orders count toward the section''s spend. Budget dollars live in inventory_budgets keyed category=''section:<id>''. Managed from the inventory Budgets panel.';

-- RLS — same shape as inventory_budgets (0061 + 0161 mfa gate).
ALTER TABLE public.inventory_budget_sections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner rw inventory_budget_sections" ON public.inventory_budget_sections;
CREATE POLICY "owner rw inventory_budget_sections"
  ON public.inventory_budget_sections
  FOR ALL TO authenticated
  USING ((user_owns_property(property_id)) AND public.mfa_verified_or_grace())
  WITH CHECK ((user_owns_property(property_id)) AND public.mfa_verified_or_grace());

-- ─── applied_migrations bookkeeping ──────────────────────────────────────
INSERT INTO public.applied_migrations (version, description)
VALUES (
  '0306',
  'Custom inventory budget sections + total-budget mode: relaxes inventory_budgets.category to allow ''total'' and ''section:<uuid>'' keys, adds properties.inventory_budget_mode (total|sections, default sections), and creates inventory_budget_sections (name + item_ids per hotel, RLS owner rw + mfa gate). Budgets panel rebuild.'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
