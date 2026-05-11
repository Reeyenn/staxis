-- 0066_property_id_indexes.sql
-- Add property_id indexes on tables that have the column but no index leading
-- with property_id. Cheap insurance before we onboard hotel #2+ — scans get
-- expensive past ~50 properties without these.
--
-- The audit query that found these:
--   with cols as (select c.table_name from information_schema.columns c
--     join information_schema.tables t on (t.table_schema, t.table_name) = (c.table_schema, c.table_name)
--     where c.table_schema='public' and c.column_name='property_id' and t.table_type='BASE TABLE'),
--   indexed as (select distinct c.relname as table_name from pg_index i
--     join pg_class c on c.oid=i.indrelid
--     join pg_attribute a on a.attrelid=c.oid and a.attnum=i.indkey[0]
--     where a.attname='property_id' and c.relnamespace=(select oid from pg_namespace where nspname='public'))
--   select c.table_name from cols c left join indexed i using (table_name) where i.table_name is null;
--
-- Returns 4 base tables: dashboard_by_date, error_logs, idempotency_log, pull_metrics.
--
-- We use IF NOT EXISTS so this migration is safe to re-run. We pick composite
-- indexes (property_id, created_at DESC) for the time-series tables since
-- almost all reads are "recent N rows for this property". The PG planner
-- can still use these for property_id-only filters.

create index if not exists error_logs_property_recent_idx
  on public.error_logs (property_id, ts desc);

comment on index public.error_logs_property_recent_idx is
  'Per-property recent-errors scan for /api/admin/recent-errors + the 72h retention purge cron. Composite (property_id, ts desc) so the doctor''s per-hotel error widget at 500 properties stays fast. NB: this table uses ts, not created_at.';

create index if not exists pull_metrics_property_created_idx
  on public.pull_metrics (property_id, created_at desc);

comment on index public.pull_metrics_property_created_idx is
  'Per-property pull latency / success rate aggregation. Hit by /api/admin/doctor and the scraper-health workflow.';

create index if not exists dashboard_by_date_property_idx
  on public.dashboard_by_date (property_id, date desc);

comment on index public.dashboard_by_date_property_idx is
  'Per-property historical dashboard pulls. The PK is (date, property_id) — great for "all hotels on a date", bad for "this hotel over time". This index fixes the second access pattern.';

create index if not exists idempotency_log_property_idx
  on public.idempotency_log (property_id);

comment on index public.idempotency_log_property_idx is
  'Per-property idempotency lookups. Most reads are by request_id (already indexed via PK), but admin and debug paths filter by property_id.';

-- ─── Bookkeeping ────────────────────────────────────────────────────────
-- Idempotency marker so this migration only applies once when the harness
-- replays the directory.
insert into public.applied_migrations (version, description)
values ('0066', 'property_id indexes for error_logs, pull_metrics, dashboard_by_date, idempotency_log')
on conflict (version) do nothing;
