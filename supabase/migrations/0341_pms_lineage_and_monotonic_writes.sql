-- ═══════════════════════════════════════════════════════════════════════════
-- 0341 — Lineage stamp on every pms_* row + monotonic supersession.
--
-- INVARIANT 1 — "there is no number in the system without a receipt"
--   Every row in every pms_* data table carries a NOT NULL ingest_run_id
--   resolving to a real pms_ingest_runs row (0340). 20 write targets: the 19
--   descriptor tables in pms_table_schemas plus pms_feed_values.
--
--   Deliberately NOT adding source_report_id / parser_version / ingested_at as
--   per-row columns. Both are one PK join away on pms_ingest_runs, and a
--   denormalized second copy is exactly the "two receipts that disagree"
--   failure. The authoritative arrival time is pms_ingest_runs.finished_at.
--
-- INVARIANT 2 — "an older report can never overwrite a newer one"
--   A delayed 11am report must not clobber the 2pm restatement. Enforced by a
--   BEFORE UPDATE trigger, not writer code, so it holds for ANY writer —
--   including hand-run SQL. The trigger RETURNs NULL (skips the write); note
--   that RETURN OLD would still perform the UPDATE with OLD's values and churn
--   xmax / fire AFTER triggers / wake realtime listeners.
--
--   Scoped to the same report_kind. Once two report kinds write the same table
--   (arrivals and in-house both touch pms_reservations), a fresh report of
--   kind A must NOT block a slightly-older report of kind B from updating B's
--   own columns. Runs with different report_kind are never compared.
--
--   Append-strategy tables (pms_room_status_log, pms_activity_log) never
--   UPDATE, so they carry no trigger; 0342's unique indexes are their guard.
--
-- WHY NOW: 129 rows exist across 5 of these 20 tables (13 + 33 + 41 + 40 + 2).
-- The backfill is seconds today and a multi-hour migration once a real hotel's
-- history is in there. The CUA robot has been off since ~2026-07-06, so the
-- write window is genuinely quiet — verify property_sessions is stopped before
-- applying.
--
-- APPLY ORDER: after 0340. Idempotent; safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

-- The 20 write targets. Kept as one list so a future pms_* table that forgets
-- the column is caught by the doctor's pms_lineage_columns_complete check,
-- which compares information_schema against pms_table_schemas at runtime.
create or replace function public._pms_lineage_tables()
returns text[]
language sql
immutable
set search_path = pg_catalog, public
as $$
  select array[
    'pms_activity_log',
    'pms_cancellations',
    'pms_channel_performance',
    'pms_feed_values',
    'pms_forecast_daily',
    'pms_future_bookings',
    'pms_groups_and_blocks',
    'pms_guest_balances',
    'pms_guests',
    'pms_housekeeping_assignments',
    'pms_in_house_snapshot',
    'pms_lost_and_found',
    'pms_no_shows',
    'pms_payments_daily',
    'pms_rates_and_inventory',
    'pms_reservations',
    'pms_revenue_daily',
    'pms_room_status_log',
    'pms_rooms_inventory',
    'pms_work_orders_v2'
  ]::text[];
$$;

comment on function public._pms_lineage_tables() is
  'The pms_* write targets that must carry a NOT NULL ingest_run_id. 19 descriptor tables (pms_table_schemas) + pms_feed_values. Created 0341.';

-- ─── Part A: add the column (nullable first) ───────────────────────────────
-- ON DELETE CASCADE is deliberate. Deleting a property cascades into BOTH
-- pms_ingest_runs and the data tables; with NO ACTION the two cascade paths
-- could collide mid-delete and break the delete-hotel flow. Nothing else
-- deletes a run, so in practice this only ever fires as part of that cascade —
-- and "delete the run, delete the rows it produced" is coherent un-ingest.

do $$
declare
  tbl text;
begin
  foreach tbl in array public._pms_lineage_tables()
  loop
    execute format(
      'alter table public.%I add column if not exists ingest_run_id uuid', tbl
    );
    if not exists (
      select 1 from pg_constraint
       where conname = tbl || '_ingest_run_fk'
    ) then
      execute format(
        'alter table public.%I add constraint %I foreign key (ingest_run_id) references public.pms_ingest_runs(id) on delete cascade',
        tbl, tbl || '_ingest_run_fk'
      );
    end if;
    execute format(
      'create index if not exists %I on public.%I (ingest_run_id)',
      tbl || '_ingest_run_idx', tbl
    );
  end loop;
end $$;

-- ─── Part B: backfill — one legacy run per property that has rows ──────────
-- Everything written before this migration came from the CUA generic writer.
-- One run per property, source_kind='legacy', so those rows get a truthful
-- receipt instead of a fabricated one.

insert into public.pms_ingest_runs
  (property_id, source_kind, mode, parser_name, parser_version,
   source_captured_at, started_at, finished_at, status)
select p.id, 'legacy', 'live', 'cua-generic-writer', 'pre-0341',
       now(), now(), now(), 'succeeded'
  from public.properties p
 where not exists (
   select 1 from public.pms_ingest_runs r
    where r.property_id = p.id and r.parser_version = 'pre-0341'
 );

do $$
declare
  tbl text;
  n   bigint;
begin
  foreach tbl in array public._pms_lineage_tables()
  loop
    execute format(
      'update public.%I t set ingest_run_id = r.id
         from public.pms_ingest_runs r
        where r.property_id = t.property_id
          and r.parser_version = ''pre-0341''
          and t.ingest_run_id is null',
      tbl
    );
    get diagnostics n = row_count;
    if n > 0 then
      raise notice '0341: backfilled % row(s) in %', n, tbl;
    end if;
  end loop;
end $$;

-- ─── Part C: NOT NULL — the real enforcement ───────────────────────────────
-- Any row that still has no run at this point means an unmodelled writer, and
-- SET NOT NULL will (correctly) fail loudly rather than let it through.

do $$
declare
  tbl text;
begin
  foreach tbl in array public._pms_lineage_tables()
  loop
    execute format('alter table public.%I alter column ingest_run_id set not null', tbl);
    execute format(
      'comment on column public.%I.ingest_run_id is %L',
      tbl,
      'Receipt. Points at the pms_ingest_runs row that produced this data. NOT NULL — there is no number in the system without a receipt. Added 0341.'
    );
  end loop;
end $$;

-- ─── Part D: monotonic supersession trigger ────────────────────────────────

create or replace function public.pms_reject_stale_ingest()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_old_captured timestamptz;
  v_new_captured timestamptz;
  v_old_kind     text;
  v_new_kind     text;
begin
  -- Same run (a multi-row batch), or one side unattributed: nothing to compare.
  if new.ingest_run_id is null
     or old.ingest_run_id is null
     or new.ingest_run_id = old.ingest_run_id then
    return new;
  end if;

  select r.source_captured_at, f.report_kind
    into v_new_captured, v_new_kind
    from public.pms_ingest_runs r
    left join public.pms_report_files f on f.id = r.report_file_id
   where r.id = new.ingest_run_id;

  select r.source_captured_at, f.report_kind
    into v_old_captured, v_old_kind
    from public.pms_ingest_runs r
    left join public.pms_report_files f on f.id = old.ingest_run_id
   where r.id = old.ingest_run_id;

  if v_new_captured is null or v_old_captured is null then
    return new; -- can't reason about it; don't block a legitimate write
  end if;

  -- Different report kinds write different columns of the same table. A fresh
  -- arrivals report must not freeze an older-but-newer-for-its-own-columns
  -- housekeeping report out. Only like-for-like is compared.
  if v_new_kind is distinct from v_old_kind then
    return new;
  end if;

  if v_new_captured < v_old_captured then
    insert into public.error_logs (source, message, property_id, context)
    values (
      'pms_reject_stale_ingest',
      format('%s: stale ingest rejected (incoming as-of %s is older than stored %s)',
             tg_table_name, v_new_captured, v_old_captured),
      new.property_id,
      jsonb_build_object(
        'table', tg_table_name,
        'incoming_run', new.ingest_run_id,
        'stored_run', old.ingest_run_id,
        'incoming_captured_at', v_new_captured,
        'stored_captured_at', v_old_captured
      )
    );
    return null; -- SKIP the UPDATE entirely (RETURN OLD would still write)
  end if;

  return new;
end;
$$;

comment on function public.pms_reject_stale_ingest() is
  'BEFORE UPDATE guard on upsert/reconcile pms_* tables: an ingest run whose source_captured_at is older than the stored row''s run (same report_kind) cannot overwrite it. Returns NULL to skip the write. Created 0341.';

-- Applied to every NON-append table. Reconcile tables (pms_work_orders_v2,
-- pms_lost_and_found) are included on purpose — their auto-resolve/dispose
-- path is exactly where a stale report does the most damage.
do $$
declare
  tbl text;
begin
  foreach tbl in array public._pms_lineage_tables()
  loop
    if tbl in ('pms_room_status_log', 'pms_activity_log') then
      continue; -- append-only; never updated
    end if;
    execute format('drop trigger if exists reject_stale_ingest on public.%I', tbl);
    execute format(
      'create trigger reject_stale_ingest before update on public.%I for each row execute function public.pms_reject_stale_ingest()',
      tbl
    );
  end loop;
end $$;

-- ─── Part E: the drift detector the doctor calls ───────────────────────────
-- A pms_* table added by a FUTURE workstream must not be able to ship without
-- a receipt. This compares the live schema against pms_table_schemas (the
-- descriptor table every writer already reads) and returns anything that lacks
-- a NOT NULL ingest_run_id with a real FK. The doctor polls it every 5 minutes
-- via vercel-watchdog, so the gap surfaces as a fail, not as a discovery two
-- months later.
--
-- SECURITY DEFINER because information_schema/pg_constraint reads are
-- role-sensitive; service_role-only execute. Read-only, no side effects.

create or replace function public.pms_lineage_gaps()
returns table (missing_table text, reason text)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select t.table_name::text,
         case
           when c.column_name is null then 'missing ingest_run_id column'
           when c.is_nullable = 'YES' then 'ingest_run_id is nullable'
           else 'no foreign key to pms_ingest_runs'
         end
    from public.pms_table_schemas t
    left join information_schema.columns c
           on c.table_schema = 'public'
          and c.table_name   = t.table_name
          and c.column_name  = 'ingest_run_id'
   where to_regclass('public.' || quote_ident(t.table_name)) is not null
     and (
       c.column_name is null
       or c.is_nullable = 'YES'
       or not exists (
         select 1
           from pg_constraint k
          where k.conrelid  = to_regclass('public.' || quote_ident(t.table_name))
            and k.contype   = 'f'
            and k.confrelid = to_regclass('public.pms_ingest_runs')
       )
     );
$$;

revoke all on function public.pms_lineage_gaps() from public, anon, authenticated;
grant execute on function public.pms_lineage_gaps() to service_role;

comment on function public.pms_lineage_gaps() is
  'Returns every pms_table_schemas table lacking a NOT NULL ingest_run_id with an FK to pms_ingest_runs. Empty = invariant holds. Polled by /api/admin/doctor. Created 0341.';

-- ─── Bookkeeping + PostgREST schema reload ─────────────────────────────────
insert into public.applied_migrations (version, description)
values (
  '0341',
  'Lineage: NOT NULL ingest_run_id on all 20 pms_* write targets (129 rows backfilled to a legacy run) + pms_reject_stale_ingest BEFORE UPDATE trigger so an older report can never clobber a newer one.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
