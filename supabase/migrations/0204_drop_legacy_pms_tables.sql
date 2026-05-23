-- ═══════════════════════════════════════════════════════════════════════════
-- 0204 — Drop legacy PMS data tables (Plan v4 cutover).
--
-- Why this exists:
--   Plan v4 (mission-plan-a-optimized-torvalds.md) replaces the Railway
--   scraper + cua-service onboarding pull-data path with a single
--   universal CUA writing to the new pms_* schema (migrations 0201-0203).
--   The old tables that the scraper + pull-data-saver wrote to are now
--   orphaned. Reeyen explicitly chose to drop them rather than archive:
--   "we don't need the training data. delete everything."
--
--   Dropping these tables WILL break the current Staxis web app's
--   housekeeper page, dashboard, work-orders surfaces — Reeyen is
--   rebuilding the web app separately against the new pms_* schema.
--   That trade-off is the Plan v4 accepted scope.
--
-- What's dropped:
--   - plan_snapshots          (Railway scraper's daily plan)
--   - rooms                   (per-property/date room status)
--   - work_orders             (CA OOO + maintenance)
--   - scraper_status          (key/value jsonb scraper state)
--   - dashboard_by_date       (cua-service per-property daily snapshot)
--   - pull_metrics            (Railway scraper observability)
--
-- What's kept:
--   - scraper_credentials       (still used — credentials per property)
--   - scraper_credentials_decrypted (view, depends on above)
--   - scraper_session           (still used — Playwright storageState)
--   - pms_recipes               (versioned recipes, kept for compatibility
--                                even though new system uses pms_knowledge_files)
--   - onboarding_jobs           (still used by /api/pms/* onboarding flow
--                                via the legacy job-runner path that we're
--                                keeping during the cutover window)
--   - pull_jobs                 (still used by the legacy pull-job-runner
--                                that we're keeping during cutover; will
--                                be dropped in a follow-up migration once
--                                the new system has proven stable)
--
-- Idempotent: drop table if exists. Safe to re-run.
--
-- Manual prod apply: per project_migration_application_manual.md.
-- ═══════════════════════════════════════════════════════════════════════════

-- Drop tables. CASCADE removes dependent views/foreign-keys.
-- Listed in reverse-dependency order (children first) just for clarity;
-- CASCADE handles any actual ordering issues at the DB layer.

drop table if exists public.pull_metrics             cascade;
drop table if exists public.dashboard_by_date        cascade;
drop table if exists public.scraper_status           cascade;
drop table if exists public.work_orders              cascade;
drop table if exists public.rooms                    cascade;
drop table if exists public.plan_snapshots           cascade;

-- Track the migration.
insert into public.applied_migrations (version, description)
values (
  '0204',
  'Plan v4 cutover: drop legacy PMS data tables (plan_snapshots, rooms, work_orders, scraper_status, dashboard_by_date, pull_metrics). Web app surfaces that read these will fail until rebuilt against the new pms_* schema.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
