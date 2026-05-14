-- Phase M2 (2026-05-14): GIN index on accounts.property_access for RLS perf.
--
-- Why this exists:
--   user_owns_property(p_id) is the RLS gate on every owner-scoped table
--   (properties, rooms, staff, cleaning_events, inventory, inventory_counts,
--   prediction_log, every prediction table — 15+ tables).
--
--   Its body:
--     select exists (
--       select 1 from public.accounts a
--       where a.data_user_id = auth.uid()
--         and (a.role = 'admin' or p_id = any (a.property_access))
--     );
--
--   The accounts_data_user_id_idx (already present) speeds up the first
--   filter. The `p_id = any (a.property_access)` array-contains check
--   has NO supporting index today. With ~3-10 rows per user that's fine
--   at 1 hotel; at 300 hotels × 10 staff each = 3000 accounts rows the
--   linear scan inside ANY() compounds with every owner-scoped query.
--
--   GIN on the property_access uuid[] column lets Postgres use the
--   `&&` (overlaps) operator and (since PG 15) the `@>` operator
--   directly on the array, with index support. The planner can then
--   short-circuit the seq scan when checking which accounts contain
--   a given property_id.
--
-- Verified before fix:
--   - psql \d public.accounts confirms property_access is uuid[] NOT NULL
--   - existing indexes on accounts: pkey, data_user_id_idx, username_idx,
--     username_key. None on property_access.
--
-- Why CONCURRENTLY isn't here:
--   We can't run CREATE INDEX CONCURRENTLY inside a Supabase migration
--   transaction. accounts is a small table (1-3000 rows over the next
--   year) so the brief lock is acceptable.

CREATE INDEX IF NOT EXISTS accounts_property_access_gin_idx
  ON public.accounts USING gin (property_access);

INSERT INTO public.applied_migrations (version, description)
VALUES ('0121', 'Phase M2: GIN index on accounts.property_access for RLS perf at fleet scale')
ON CONFLICT (version) DO NOTHING;
