-- ═══════════════════════════════════════════════════════════════════════════
-- 0307 — Custom inventory categories (hotel-defined inventory "tabs").
--
-- Every hotel is different: one runs a bar (Liquor), another tracks Petty cash.
-- This lets a property add its own inventory categories that show up as tabs
-- alongside the built-in General / Breakfast filters.
--
-- ADDITIVE + non-breaking by design:
--   • The built-in `inventory.category` enum (housekeeping/maintenance/
--     breakfast) is UNTOUCHED — every existing item keeps behaving exactly as
--     before. It still drives icons/colors.
--   • A NEW nullable `inventory.custom_category_id` says "this item lives in a
--     custom tab instead of the built-in General/Breakfast buckets."
--     NULL (every existing row) = unchanged behavior.
--   • ON DELETE SET NULL: deleting a custom category never deletes items — they
--     just fall back to their built-in category and reappear under General/
--     Breakfast.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- Guard: the RLS helper this migration's policies depend on.
DO $$
BEGIN
  IF to_regprocedure('public.mfa_verified_or_grace()') IS NULL THEN
    RAISE EXCEPTION 'apply migration 0159 first — mfa_verified_or_grace() missing';
  END IF;
END $$;

-- ─── 1. The custom categories ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.inventory_custom_categories (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 40),
  sort         integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inventory_custom_categories_property_idx
  ON public.inventory_custom_categories (property_id);

DROP TRIGGER IF EXISTS inventory_custom_categories_touch ON public.inventory_custom_categories;
CREATE TRIGGER inventory_custom_categories_touch
  BEFORE UPDATE ON public.inventory_custom_categories
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

COMMENT ON TABLE public.inventory_custom_categories IS
  'Hotel-defined inventory categories shown as filter tabs (e.g. Liquor, Petty cash) alongside the built-in General/Breakfast buckets. Items point at one via inventory.custom_category_id. Managed from the inventory filter bar.';

-- RLS — same shape as inventory_budget_sections (0306): owner rw + mfa gate.
ALTER TABLE public.inventory_custom_categories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner rw inventory_custom_categories" ON public.inventory_custom_categories;
CREATE POLICY "owner rw inventory_custom_categories"
  ON public.inventory_custom_categories
  FOR ALL TO authenticated
  USING ((user_owns_property(property_id)) AND public.mfa_verified_or_grace())
  WITH CHECK ((user_owns_property(property_id)) AND public.mfa_verified_or_grace());

-- ─── 2. The item → custom category link (nullable, non-breaking) ──────────
ALTER TABLE public.inventory
  ADD COLUMN IF NOT EXISTS custom_category_id uuid
  REFERENCES public.inventory_custom_categories(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS inventory_custom_category_idx
  ON public.inventory (property_id, custom_category_id)
  WHERE custom_category_id IS NOT NULL;

COMMENT ON COLUMN public.inventory.custom_category_id IS
  'Optional: the hotel-defined custom category this item lives in (inventory_custom_categories). NULL (default, every existing item) = the item lives in its built-in category''s General/Breakfast bucket, unchanged. Set → the item shows only under its custom tab.';

-- ─── applied_migrations bookkeeping ──────────────────────────────────────
INSERT INTO public.applied_migrations (version, description)
VALUES (
  '0307',
  'Custom inventory categories: new inventory_custom_categories table (per-property named tabs, RLS owner rw + mfa gate) + nullable inventory.custom_category_id (ON DELETE SET NULL). Additive — existing items (NULL) unchanged; the built-in category enum is untouched.'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
