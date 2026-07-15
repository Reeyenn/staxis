-- ═══════════════════════════════════════════════════════════════════════════
-- 0308 — Inventory tab layout (per-hotel filter-tab customization).
--
-- The inventory filter tabs (All / General / Breakfast / hotel-defined custom
-- categories) are now fully rearrangeable and removable per property. This
-- stores two things per hotel:
--   • order  — the display order of the tabs (keys: 'general', 'breakfast',
--     'custom:<uuid>'). 'all' is always pinned first and never stored here.
--   • hidden — the built-in tabs the hotel has removed ('general'/'breakfast').
--     Hiding a built-in only affects the TAB; items keep their category and
--     still appear under All. Fully reversible (add it back from Edit mode).
--
-- ADDITIVE + non-breaking: NULL (every existing hotel) = the default layout
-- (All, General, Breakfast, then customs) with nothing hidden — unchanged.
-- Custom categories themselves live in inventory_custom_categories (0307);
-- this only records order + built-in visibility.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS inventory_tab_layout jsonb;

COMMENT ON COLUMN public.properties.inventory_tab_layout IS
  'Per-hotel inventory filter-tab layout: { "order": string[], "hidden": string[] }. order = display order of tab keys (general | breakfast | custom:<uuid>); hidden = removed built-in tabs. NULL = default layout, nothing hidden. Managed from the inventory filter bar Edit mode.';

INSERT INTO public.applied_migrations (version, description)
VALUES (
  '0308',
  'Inventory tab layout: nullable properties.inventory_tab_layout jsonb ({order,hidden}) for per-hotel rearrangeable/removable inventory filter tabs. Additive — NULL = default order, nothing hidden.'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
