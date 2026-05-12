-- ═══════════════════════════════════════════════════════════════════════════
-- 0076_backfill_applied_migrations.sql
--
-- Bookkeeping-only backfill for the 31 migrations that pre-date or skipped
-- the `INSERT INTO applied_migrations` self-registration convention. Their
-- schema changes are ALREADY APPLIED to the live database (ML is running,
-- 2FA works, join codes work, the inventory cockpit shows live data). This
-- migration only updates the manifest table so the doctor's schema-drift
-- detector regains visibility into them.
--
-- The 31 versions break down as:
--   - 0001-0014 (14 versions): pre-tracker initial schema + early features
--   - 0021-0023 (3 versions):  ML infrastructure additions written before
--                              the convention was adopted as standard
--   - 0050-0060 (11 versions): admin + analytics tables added 2026-Q1
--                              that missed the convention
--   - 0062-0065 (4 versions):  inventory ML foundation + 2FA + invites,
--                              same convention miss
--
-- Why we don't retro-patch each migration file:
--   The files are already deployed. Editing them would create a confusing
--   history ("was the INSERT there when it ran or not?") and wouldn't
--   change the live state. The doctor's drift detector only cares about
--   the applied_migrations table; backfilling there is the operationally
--   meaningful fix. Going forward, the new migration-bookkeeping test
--   (src/lib/__tests__/migration-bookkeeping.test.ts) enforces that every
--   NEW migration includes the INSERT.
--
-- Verified context: May 2026 audit pass-6 (the post-deploy smoke test
-- was flagging 15 of these as "missing" after EXPECTED_MIGRATIONS was
-- extended to 0075; the remaining 16 were already excluded from the list).
-- ═══════════════════════════════════════════════════════════════════════════

insert into public.applied_migrations (version, description) values
  -- ─── 0001-0014: pre-tracker initial schema + early features ───────────
  ('0001', 'initial schema (backfilled — pre-tracker)'),
  ('0002', 'auth bridge (backfilled — pre-tracker)'),
  ('0003', 'harden user_owns_property (backfilled — pre-tracker)'),
  ('0004', 'rls_status view (backfilled — pre-tracker)'),
  ('0005', 'normalize auth tokens (backfilled — pre-tracker)'),
  ('0006', 'enable realtime publication (backfilled — pre-tracker)'),
  ('0007', 'realtime publication doctor helper (backfilled — pre-tracker)'),
  ('0008', 'api_limits + staxis_api_limit_hit RPC (backfilled — pre-tracker)'),
  ('0009', 'realtime column filter (backfilled — pre-tracker)'),
  ('0010', 'staff.last_paired_at (backfilled — pre-tracker)'),
  ('0011', 'pull_metrics + session (backfilled — pre-tracker)'),
  ('0012', 'cleaning_events table (backfilled — pre-tracker)'),
  ('0013', 'fix REPLICA IDENTITY on staff/shift_confirmations (backfilled — pre-tracker)'),
  ('0014', 'allow hk_center_on_demand pull_type (backfilled — pre-tracker)'),
  -- ─── 0021-0023: ML infra written before convention was standard ───────
  ('0021', 'ML infrastructure (backfilled — convention not yet standard)'),
  ('0022', 'cleaning_minutes view (backfilled — convention not yet standard)'),
  ('0023', 'ML post-review fixes (backfilled — convention not yet standard)'),
  -- ─── 0050-0060: admin + analytics tables that missed the convention ───
  ('0050', 'prospects (backfilled — convention missed)'),
  ('0051', 'app_events (backfilled — convention missed)'),
  ('0052', 'user_feedback (backfilled — convention missed)'),
  ('0053', 'roadmap_items (backfilled — convention missed)'),
  ('0054', 'admin_audit_log (backfilled — convention missed)'),
  ('0055', 'expenses (backfilled — convention missed)'),
  ('0056', 'claude_usage_log (backfilled — convention missed)'),
  ('0057', 'github_events (backfilled — convention missed)'),
  ('0058', 'claude_sessions (backfilled — convention missed)'),
  ('0059', 'expenses_custom_categories (backfilled — convention missed)'),
  ('0060', 'local_worktrees (backfilled — convention missed)'),
  -- ─── 0062-0065: inventory ML + 2FA + invites — convention missed ──────
  ('0062', 'inventory_ml_foundation (backfilled — convention missed)'),
  ('0063', 'trusted_devices (backfilled — convention missed)'),
  ('0064', 'team_roles_and_invites (backfilled — convention missed)'),
  ('0065', 'accounts_phone_and_simplified_join_codes (backfilled — convention missed)')
on conflict (version) do nothing;

-- Self-register so the doctor's drift detector sees this migration too.
insert into public.applied_migrations (version, description)
values ('0076', 'backfill applied_migrations bookkeeping for 31 untracked migrations')
on conflict (version) do nothing;
