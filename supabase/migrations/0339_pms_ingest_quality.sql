-- ═══════════════════════════════════════════════════════════════════════════
-- 0339 — Ingest quality foundation: freshness SLOs as rows, quarantine,
--        unmapped-column capture, anomalies, and ONE definition of
--        "is this feed fresh" that lives in SQL.
--
-- WHY
-- The report era makes STALENESS the dominant failure mode, not "never
-- connected". A hotel's PMS report schedule gets switched off and nothing in
-- Staxis notices, because the vocabulary has no word for "real but old". A
-- manager then acts on 9-hour-old occupancy shown with a fresh face.
--
-- Every "is data flowing" signal in the product today is derived from
-- property_sessions — the 24/7 robot that stopped writing on ~2026-07-06.
-- This migration lays the data foundation for re-grounding those signals on
-- "when did the last report actually arrive", which is the only question the
-- report era can answer honestly.
--
-- WHAT (all additive; nothing here changes an existing read path)
--   A. pms_feed_catalog        — the five feeds as ROWS (kills the triplicated
--                                hardcoded feed lists) + which pms_* table each
--                                one lands in + whether it is required.
--   B. pms_feed_expectations   — the freshness SLO per (hotel, feed) as a ROW.
--                                Hotel #2 on a different report schedule is a
--                                row, not a code branch.
--   C. pms_ingest_quarantine   — rows the parser could not accept, with the
--                                raw row kept so a parser fix can replay them.
--   D. pms_unmapped_columns    — a column we did not recognise, captured and
--                                surfaced instead of silently dropped.
--   E. pms_ingest_anomalies    — day-over-day weirdness. FLAGS, never blocks.
--   F. pms_feed_health_v1      — THE single definition of feed freshness.
--      pms_property_health_v1  — per-hotel roll-up of the same.
--      pms_quarantine_rollup_v1 — cross-delivery display roll-up (see FLAW A).
--
-- ── FIX FOR FATAL FLAW A (delivery accounting vs. dedupe) ──────────────────
-- The original design paired a global partial-unique index on (fingerprint)
-- WHERE status='open' — so a repeat of a persistent bad row bumps
-- `occurrences` instead of inserting — with a per-delivery CHECK
-- (rows_parsed = rows_written + rows_quarantined). Those two are jointly
-- unsatisfiable: delivery #2 carrying the same 3 recurring bad rows inserts NO
-- new quarantine rows (the dedupe bumps rows that belong to delivery #1), so
-- its rows_quarantined stays 0 while rows_written is short by 3, and the
-- delivery can NEVER be marked 'parsed'. The pipeline wedges on the second
-- occurrence of any persistent bad row.
--
-- Fix, inside the same architecture: the open-dedupe is scoped PER DELIVERY
-- (unique (delivery_id, fingerprint) where status='open'), so every delivery
-- accounts for its own rejects and the arithmetic always balances. The
-- cross-delivery "this same bad row has now shown up 11 times" view is a
-- DISPLAY-SIDE roll-up (pms_quarantine_rollup_v1), not a storage constraint.
-- Deliveries that arrive without a ledger id (delivery_id is null) keep the
-- old per-property dedupe, because there is no delivery to account for.
--
-- ── FIX FOR FATAL FLAW B (manual / skip-PMS hotels must not regress) ───────
-- Today a hotel with no property_sessions row derives NO_PMS_FEED_STATUS:
-- mode 'no_pms', every feed 'live', countsTrusted true — the load-bearing
-- fail-safe that renders manual hotels exactly as they render today
-- (src/lib/pms/feed-status.ts). The rule "no enabled expectation row implies
-- unavailable" would have flipped every manual hotel to all-unavailable and
-- neutralised its dashboard and housekeeper board.
--
-- This view therefore emits NO ROWS AT ALL for a property with no expectation
-- rows. Zero rows is the signal, and the reader
-- (src/lib/pms-feed-status-server.ts) falls through to the existing derivation
-- — which returns NO_PMS_FEED_STATUS for a manual hotel. 'unavailable' is
-- reserved for an expectation row that exists and is DISABLED: someone
-- deliberately said "this hotel does not send this report".
--
-- ── VIEW SECURITY ─────────────────────────────────────────────────────────
-- All views are `security_invoker = true` and REVOKE'd from anon/authenticated.
-- A default (owner-rights) view over deny-all-browser tables, exposed through
-- PostgREST with default grants, would hand per-hotel freshness and quarantine
-- data to anon — bypassing the exact RLS pattern the base tables use. With
-- security_invoker the base-table policies apply to the caller, and the REVOKE
-- means the view is not reachable from the browser at all. Server reads go
-- through supabaseAdmin (service_role), which bypasses RLS as usual.
--
-- ── WHAT THIS MIGRATION DELIBERATELY DOES NOT DO ──────────────────────────
-- It does not create, alter, or reference by name the per-delivery ingest
-- ledger. That table belongs to the report-intake workstream and does not
-- exist on this branch. The seam is:
--   • pms_ingest_quarantine.delivery_id — a plain uuid, no FK, nullable.
--   • public.pms_feed_delivery_signal_v1 — a STUB view returning zero rows.
--     The intake workstream replaces it with `create or replace view` over its
--     own ledger, keeping the column names and types below. Nothing else in
--     this migration or in the app moves when it does.
--   • public.pms_delivery_quarantine_count(uuid) — the count the intake
--     workstream's own trigger should write into its rows_quarantined column,
--     so the writer cannot supply the number itself.
--
-- Idempotent: create-if-not-exists + create-or-replace + drop-policy-if-exists.
-- Manual prod apply (project_migration_application_manual.md); the doctor's
-- supabase_migrations_applied check is the net.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ─── A. pms_feed_catalog — the five feeds, as rows ────────────────────────
-- @rls: service-role-only — fleet configuration, no tenant column; read by
-- /api/admin/* and the feed-health views via supabaseAdmin.

create table if not exists public.pms_feed_catalog (
  feed_key      text primary key,
  label         text not null,
  /** A required feed's absence ambers the UI. Single source of truth for
   *  "required" — REQUIRED_TARGETS in src/lib/pms/feed-status.ts and
   *  mapping-driver's copy both defer to this once they read the catalog. */
  required      boolean not null default false,
  /** Which pms_* table this feed lands in. FK so a typo cannot invent a feed
   *  that writes nowhere. Nullable for a feed with no single target table. */
  target_table  text references public.pms_table_schemas(table_name),
  /** The CUA-era action name, kept so the two vocabularies can be joined
   *  during the transition (FEED_TARGETS in src/lib/pms/feed-status.ts). */
  legacy_target text,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.pms_feed_catalog is
  'The feeds Staxis expects from a hotel PMS, one row each. Replaces the hardcoded feed lists in onboarding-detail, feed-status.ts and pms-coverage. Adding a feed is a row.';

alter table public.pms_feed_catalog enable row level security;
revoke all on public.pms_feed_catalog from public, anon, authenticated;
grant select, insert, update, delete on public.pms_feed_catalog to service_role;
drop policy if exists pms_feed_catalog_deny_all_browser on public.pms_feed_catalog;
create policy pms_feed_catalog_deny_all_browser
  on public.pms_feed_catalog
  for all to anon, authenticated
  using (false) with check (false);

insert into public.pms_feed_catalog (feed_key, label, required, target_table, legacy_target, notes)
values
  ('roomStatus',      'Room status',      true,  'pms_room_status_log',          'getRoomStatus',
   'Per-room clean/dirty/occupied state. Drives the housekeeping board.'),
  ('arrivals',        'Arrivals',         true,  'pms_reservations',             'getArrivals',
   'Today''s expected check-ins. Shares pms_reservations with departures.'),
  ('departures',      'Departures',       true,  'pms_reservations',             'getDepartures',
   'Today''s expected check-outs. Shares pms_reservations with arrivals.'),
  ('workOrders',      'Work orders',      true,  'pms_work_orders_v2',           'getWorkOrders',
   'Open maintenance items.'),
  ('dashboardCounts', 'Dashboard counts', false, 'pms_in_house_snapshot',        'getDashboardCounts',
   'House-level counters (occupied / vacant clean / arrivals remaining). Not every PMS exposes these, hence not required.'),
  ('housekeeping',    'Housekeeping',     false, 'pms_housekeeping_assignments', 'getHousekeeping',
   'PMS-side housekeeping assignments, where the PMS owns them.')
on conflict (feed_key) do update
  set label         = excluded.label,
      required      = excluded.required,
      target_table  = excluded.target_table,
      legacy_target = excluded.legacy_target,
      notes         = excluded.notes,
      updated_at    = now();

-- ─── B. pms_feed_expectations — the SLO, as a row ─────────────────────────
-- @rls: service-role-only — per-hotel ingest configuration; written by the
-- admin routes and the onboarding wizard via supabaseAdmin.

create table if not exists public.pms_feed_expectations (
  property_id             uuid not null references public.properties(id) on delete cascade,
  feed_key                text not null references public.pms_feed_catalog(feed_key),
  /** The PMS-side report this feed is fed by ("Housekeeping Status Report").
   *  Free text: it is the hotel's own report name, not ours. */
  report_type             text,
  cadence_kind            text not null check (cadence_kind in ('interval', 'daily_at')),
  expected_every_minutes  integer check (expected_every_minutes is null or expected_every_minutes > 0),
  expected_at_local       time,
  /** IANA zone the daily_at time is expressed in. Null falls back to
   *  properties.timezone, then UTC. */
  timezone                text,
  /** How late is late. Start at ~2/3 of the cadence and tune from real
   *  delivery timings: too tight and a normal 5-minute email delay ambers the
   *  whole dashboard, which trains everyone to ignore amber. */
  grace_minutes           integer not null default 20 check (grace_minutes >= 0),
  /** Where a breach goes. 'doctor_fail' is what makes the existing 5-minute
   *  /api/cron/vercel-watchdog loop the late-report watchdog — no new cron. */
  alert_channel           text not null default 'doctor_warn'
                          check (alert_channel in ('none', 'doctor_warn', 'doctor_fail')),
  enabled                 boolean not null default true,
  notes                   text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  primary key (property_id, feed_key),
  -- Cadence coherence: an interval SLO has a period and no clock time; a
  -- daily_at SLO has a clock time and no period. A row that claims both (or
  -- neither) has no computable due time and would silently read 'live'.
  constraint pms_feed_expectations_cadence_coherent check (
    (cadence_kind = 'interval'
      and expected_every_minutes is not null
      and expected_at_local is null)
    or
    (cadence_kind = 'daily_at'
      and expected_at_local is not null
      and expected_every_minutes is null)
  )
);

comment on table public.pms_feed_expectations is
  'Freshness SLO per (hotel, feed). A hotel on a different report schedule is a ROW, never a code branch. Zero rows for a property means "this hotel has no PMS report expectation" and the app falls back to its manual-hotel fail-safe.';

alter table public.pms_feed_expectations enable row level security;
revoke all on public.pms_feed_expectations from public, anon, authenticated;
grant select, insert, update, delete on public.pms_feed_expectations to service_role;
drop policy if exists pms_feed_expectations_deny_all_browser on public.pms_feed_expectations;
create policy pms_feed_expectations_deny_all_browser
  on public.pms_feed_expectations
  for all to anon, authenticated
  using (false) with check (false);

create index if not exists pms_feed_expectations_enabled_idx
  on public.pms_feed_expectations (property_id) where enabled;

-- ─── C. pms_ingest_quarantine — rows we could not accept ──────────────────
-- @rls: service-role-only — raw PMS rows may carry guest PII; only the admin
-- quarantine queue reads it, always through supabaseAdmin.

create table if not exists public.pms_ingest_quarantine (
  id             uuid primary key default gen_random_uuid(),
  property_id    uuid not null references public.properties(id) on delete cascade,
  /** The intake ledger row this reject belongs to. Deliberately NO foreign
   *  key: that table belongs to the report-intake workstream and may not be
   *  deployed yet. Nullable so quarantine works before the ledger exists. */
  delivery_id    uuid,
  report_type    text,
  target_table   text references public.pms_table_schemas(table_name),
  row_index      integer,
  /** The row exactly as parsed, so a parser fix can replay it. */
  raw_row        jsonb not null,
  reason_code    text not null check (reason_code in (
                   'missing_required', 'type_mismatch', 'range', 'enum',
                   'cross_field', 'parse', 'duplicate_key', 'unknown')),
  reason_detail  text,
  /** Stable identity of "this same bad row, again". Composed app-side as
   *  sha256(property_id | target_table | reason_code | natural key or the
   *  canonicalised raw row) — see quarantineFingerprint() in
   *  src/lib/pms/quarantine.ts. property_id and target_table are IN the hash
   *  so two hotels' (or two tables') identical bad rows cannot collide. */
  fingerprint    text not null,
  occurrences    integer not null default 1 check (occurrences > 0),
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  status         text not null default 'open'
                 check (status in ('open', 'reprocessed', 'dismissed', 'superseded')),
  resolved_at    timestamptz,
  resolved_by    uuid,
  resolution_note text
);

comment on table public.pms_ingest_quarantine is
  'Rows a report delivered that the parser could not accept. Keeps the raw row so a parser fix can replay it. Open-dedupe is scoped per delivery so per-delivery row accounting always balances; the cross-delivery "seen 11 times" view is pms_quarantine_rollup_v1.';

comment on column public.pms_ingest_quarantine.delivery_id is
  'Intake-ledger row id. No FK on purpose — the ledger is owned by the report-intake workstream and may post-date this migration.';

alter table public.pms_ingest_quarantine enable row level security;
revoke all on public.pms_ingest_quarantine from public, anon, authenticated;
grant select, insert, update, delete on public.pms_ingest_quarantine to service_role;
drop policy if exists pms_ingest_quarantine_deny_all_browser on public.pms_ingest_quarantine;
create policy pms_ingest_quarantine_deny_all_browser
  on public.pms_ingest_quarantine
  for all to anon, authenticated
  using (false) with check (false);

-- FLAW-A FIX, part 1: open-dedupe scoped to the delivery that produced the
-- reject. Delivery #2 carrying the same persistent bad row inserts its OWN
-- open row, so its rejects are counted against ITS parse and the accounting
-- balances. Without the delivery scope the second delivery silently reports
-- zero rejects and can never be marked parsed.
create unique index if not exists pms_ingest_quarantine_open_per_delivery_uidx
  on public.pms_ingest_quarantine (delivery_id, fingerprint)
  where status = 'open' and delivery_id is not null;

-- FLAW-A FIX, part 2: with no ledger row there is nothing to account for, so
-- the old per-property collapse is the right behaviour — one open item per
-- distinct problem, occurrences bumped on repeat.
create unique index if not exists pms_ingest_quarantine_open_no_delivery_uidx
  on public.pms_ingest_quarantine (property_id, fingerprint)
  where status = 'open' and delivery_id is null;

create index if not exists pms_ingest_quarantine_open_idx
  on public.pms_ingest_quarantine (property_id, target_table)
  where status = 'open';

create index if not exists pms_ingest_quarantine_delivery_idx
  on public.pms_ingest_quarantine (delivery_id)
  where delivery_id is not null;

-- ─── D. pms_unmapped_columns — a column we did not recognise ──────────────
-- @rls: service-role-only — sample values are redacted but still PMS-derived.

create table if not exists public.pms_unmapped_columns (
  property_id   uuid not null references public.properties(id) on delete cascade,
  report_type   text not null,
  target_table  text references public.pms_table_schemas(table_name),
  column_label  text not null,
  /** Up to 3 redacted samples, so a human can tell what the column IS. */
  sample_values jsonb not null default '[]'::jsonb,
  occurrences   integer not null default 1 check (occurrences > 0),
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  status        text not null default 'open' check (status in ('open', 'mapped', 'ignored')),
  resolved_at   timestamptz,
  resolved_by   uuid,
  primary key (property_id, report_type, column_label)
);

comment on table public.pms_unmapped_columns is
  'A column that appeared in a hotel report and is not in the table descriptor. Its value still lands (in raw->_unmapped on the row); this row is the review queue. An open row degrades the feed to "learning" in pms_feed_health_v1 — there is deliberately no second denormalised review flag to drift.';

alter table public.pms_unmapped_columns enable row level security;
revoke all on public.pms_unmapped_columns from public, anon, authenticated;
grant select, insert, update, delete on public.pms_unmapped_columns to service_role;
drop policy if exists pms_unmapped_columns_deny_all_browser on public.pms_unmapped_columns;
create policy pms_unmapped_columns_deny_all_browser
  on public.pms_unmapped_columns
  for all to anon, authenticated
  using (false) with check (false);

create index if not exists pms_unmapped_columns_open_idx
  on public.pms_unmapped_columns (property_id, target_table)
  where status = 'open';

-- ─── E. pms_ingest_anomalies — flags, never blocks ────────────────────────
-- @rls: service-role-only — admin surface + agent caveat only.

create table if not exists public.pms_ingest_anomalies (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid not null references public.properties(id) on delete cascade,
  feed_key        text references public.pms_feed_catalog(feed_key),
  kind            text not null,
  observed        numeric,
  baseline        numeric,
  ratio           numeric,
  detail          text,
  detected_at     timestamptz not null default now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid
);

comment on table public.pms_ingest_anomalies is
  'Day-over-day weirdness in an arriving report (occupancy jumped 45 points, revenue fell to zero, row count collapsed). An anomaly FLAGS and never blocks a write — containment is last-good preservation plus honest staleness, and a hotel really can sell out overnight.';

alter table public.pms_ingest_anomalies enable row level security;
revoke all on public.pms_ingest_anomalies from public, anon, authenticated;
grant select, insert, update, delete on public.pms_ingest_anomalies to service_role;
drop policy if exists pms_ingest_anomalies_deny_all_browser on public.pms_ingest_anomalies;
create policy pms_ingest_anomalies_deny_all_browser
  on public.pms_ingest_anomalies
  for all to anon, authenticated
  using (false) with check (false);

create index if not exists pms_ingest_anomalies_open_idx
  on public.pms_ingest_anomalies (property_id, detected_at desc)
  where acknowledged_at is null;

-- ─── Accounting seam for the report-intake workstream ─────────────────────
-- The intake ledger owns `rows_parsed / rows_written / rows_quarantined` and
-- the CHECK that ties them together. It must NOT let the writer supply
-- rows_quarantined — that is the whole point of the invariant. This function
-- is the number; the intake migration attaches a trigger on
-- pms_ingest_quarantine that writes it:
--
--   create trigger <ledger>_sync_quarantine
--     after insert or update or delete on public.pms_ingest_quarantine
--     for each row execute function <their trigger fn>();
--
--   -- inside that function:
--   update public.<ledger> set rows_quarantined =
--     public.pms_delivery_quarantine_count(coalesce(new.delivery_id, old.delivery_id))
--   where id = coalesce(new.delivery_id, old.delivery_id);
--
-- 'dismissed' rejects still count: the row WAS rejected by this delivery, a
-- human just decided not to chase it. Excluding them would unbalance the
-- delivery's arithmetic retroactively.
create or replace function public.pms_delivery_quarantine_count(p_delivery_id uuid)
returns integer
language sql
stable
set search_path = public, pg_temp
as $$
  select count(*)::integer
    from public.pms_ingest_quarantine
   where delivery_id = p_delivery_id;
$$;

comment on function public.pms_delivery_quarantine_count(uuid) is
  'Rejects attributable to one intake-ledger delivery. The intake workstream trigger writes this into its rows_quarantined column so the writer cannot fake the row accounting.';

revoke all on function public.pms_delivery_quarantine_count(uuid) from public, anon, authenticated;
grant execute on function public.pms_delivery_quarantine_count(uuid) to service_role;

-- ─── Freshness arithmetic ─────────────────────────────────────────────────
-- Kept as a function so the two views and any future consumer share ONE
-- implementation, and so `now` is a parameter (testable at an arbitrary
-- clock instead of only "right now").
--
-- interval: minutes elapsed since the last signal, minus the period. A feed
--   that arrived 10 minutes ago on a 30-minute cadence is 0 late.
-- daily_at: minutes since the most recent occurrence of the clock time in the
--   hotel's own zone. A signal at or after that instant is 0 late. DST-correct
--   because the day arithmetic happens in local wall time before converting
--   back.
create or replace function public.pms_feed_minutes_late(
  p_cadence_kind          text,
  p_expected_every_minutes integer,
  p_expected_at_local     time,
  p_timezone              text,
  p_last_signal_at        timestamptz,
  p_now                   timestamptz
) returns numeric
language sql
stable
set search_path = public, pg_temp
as $$
  select case
    when p_last_signal_at is null then null::numeric
    when p_cadence_kind = 'interval' then greatest(
      0::numeric,
      (extract(epoch from (p_now - p_last_signal_at)) / 60.0)::numeric
        - coalesce(p_expected_every_minutes, 0)::numeric
    )
    when p_cadence_kind = 'daily_at' and p_expected_at_local is not null then (
      select case
        when p_last_signal_at >= d.due then 0::numeric
        else (extract(epoch from (p_now - d.due)) / 60.0)::numeric
      end
      from (
        select case
          when (((p_now at time zone z.tz)::date + p_expected_at_local) at time zone z.tz) <= p_now
            then (((p_now at time zone z.tz)::date + p_expected_at_local) at time zone z.tz)
            else ((((p_now at time zone z.tz)::date - 1) + p_expected_at_local) at time zone z.tz)
        end as due
        from (select coalesce(nullif(p_timezone, ''), 'UTC') as tz) z
      ) d
    )
    else null::numeric
  end;
$$;

comment on function public.pms_feed_minutes_late(text, integer, time, text, timestamptz, timestamptz) is
  'How many minutes past its promised arrival a feed is. NULL when nothing has ever arrived (that is "learning", not "late").';

revoke all on function public.pms_feed_minutes_late(text, integer, time, text, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.pms_feed_minutes_late(text, integer, time, text, timestamptz, timestamptz)
  to service_role;

-- ─── The delivery-signal SEAM (stub) ──────────────────────────────────────
-- "A report ARRIVED and parsed" is a different fact from "a row was written".
-- A report that legitimately contains zero rows (a hotel with no open work
-- orders) writes nothing, so the target table's max(last_synced_at) never
-- moves and a naive freshness rule would call that feed stale forever despite
-- a perfectly healthy pipe. Delivery time is therefore the PRIMARY signal and
-- the target table's newest row is the fallback.
--
-- On this branch there is no intake ledger, so this stub returns zero rows and
-- freshness falls back to the table stamp. The report-intake workstream
-- replaces it with `create or replace view` over its ledger — SAME column
-- names, SAME types, one row per (property_id, feed_key) with the newest
-- successfully-parsed delivery time. Nothing else moves when it does.
create or replace view public.pms_feed_delivery_signal_v1
with (security_invoker = true) as
select
  null::uuid        as property_id,
  null::text        as feed_key,
  null::timestamptz as last_delivery_at
where false;

comment on view public.pms_feed_delivery_signal_v1 is
  'SEAM. Newest successfully-parsed delivery per (hotel, feed). Stub returning zero rows until the report-intake ledger lands; replace with create-or-replace over that ledger keeping these exact column names and types.';

-- ─── Per-table freshness signal ───────────────────────────────────────────
-- SQL cannot scan a table named by a column value, so the physical scan set is
-- enumerated here. The feed → table MAPPING still lives in pms_feed_catalog
-- (rows), so a hotel with a different report SET needs no code change; only
-- adding a brand-new pms_* table — which is DDL anyway — touches this list.
create index if not exists pms_room_status_log_freshness_idx
  on public.pms_room_status_log (property_id, last_synced_at desc);
create index if not exists pms_reservations_freshness_idx
  on public.pms_reservations (property_id, last_synced_at desc);
create index if not exists pms_work_orders_v2_freshness_idx
  on public.pms_work_orders_v2 (property_id, last_synced_at desc);
create index if not exists pms_housekeeping_assignments_freshness_idx
  on public.pms_housekeeping_assignments (property_id, last_synced_at desc);

create or replace view public.pms_feed_table_signal_v1
with (security_invoker = true) as
  select 'pms_room_status_log'::text as target_table, property_id, max(last_synced_at) as last_report_at
    from public.pms_room_status_log group by property_id
  union all
  select 'pms_reservations', property_id, max(last_synced_at)
    from public.pms_reservations group by property_id
  union all
  select 'pms_work_orders_v2', property_id, max(last_synced_at)
    from public.pms_work_orders_v2 group by property_id
  union all
  select 'pms_in_house_snapshot', property_id, max(last_synced_at)
    from public.pms_in_house_snapshot group by property_id
  union all
  select 'pms_housekeeping_assignments', property_id, max(last_synced_at)
    from public.pms_housekeeping_assignments group by property_id;

comment on view public.pms_feed_table_signal_v1 is
  'Newest row stamp per (pms_* table, hotel). Secondary freshness signal — a legitimately empty report moves the delivery signal but not this one.';

-- ─── F. pms_feed_health_v1 — THE definition of feed freshness ─────────────
--
-- Precedence, highest first:
--   1. expectation disabled          → 'unavailable'  (someone said "this
--                                      hotel does not send this report")
--   2. an open unmapped column       → 'learning'     (the shape changed; the
--                                      numbers are not trustworthy)
--   3. nothing has ever arrived      → 'learning'
--   4. minutes_late > grace_minutes  → 'stale'        (the number is REAL but
--                                      OLD — stamp it, never blank it)
--   5. otherwise                     → 'live'
--
-- Open quarantine COUNT deliberately does NOT force 'learning'. Five bad rows
-- out of three hundred does not make the other 295 untrustworthy, and
-- 'learning' blanks user-visible numbers. Quarantine backlog is a doctor warn
-- plus the admin queue — which is where a human can actually act on it.
--
-- A property with NO expectation rows produces NO ROWS here. See FATAL FLAW B
-- at the top: zero rows is how a manual / skip-PMS hotel keeps its
-- render-exactly-as-today fail-safe.
create or replace view public.pms_feed_health_v1
with (security_invoker = true) as
with base as (
  select
    e.property_id,
    e.feed_key,
    c.label,
    c.required,
    c.target_table,
    c.legacy_target,
    e.report_type,
    e.enabled,
    e.cadence_kind,
    e.expected_every_minutes,
    e.expected_at_local,
    coalesce(nullif(e.timezone, ''), p.timezone, 'UTC') as timezone,
    e.grace_minutes,
    e.alert_channel,
    t.last_report_at,
    d.last_delivery_at,
    greatest(d.last_delivery_at, t.last_report_at) as last_signal_at,
    coalesce(q.open_count, 0) as open_quarantine_count,
    coalesce(u.open_count, 0) as open_unmapped_count
  from public.pms_feed_expectations e
  join public.pms_feed_catalog c
    on c.feed_key = e.feed_key
  left join public.properties p
    on p.id = e.property_id
  left join public.pms_feed_table_signal_v1 t
    on t.property_id = e.property_id and t.target_table = c.target_table
  left join public.pms_feed_delivery_signal_v1 d
    on d.property_id = e.property_id and d.feed_key = e.feed_key
  left join lateral (
    select count(*)::integer as open_count
      from public.pms_ingest_quarantine qq
     where qq.property_id = e.property_id
       and qq.status = 'open'
       -- Attribute a reject to a feed by the table it was headed for, or by
       -- the hotel's own report name. Both sides must be non-null: matching
       -- null-to-null would make every unattributed reject count against
       -- every feed.
       and ((c.target_table is not null and qq.target_table = c.target_table)
            or (e.report_type is not null and qq.report_type = e.report_type))
  ) q on true
  left join lateral (
    select count(*)::integer as open_count
      from public.pms_unmapped_columns uu
     where uu.property_id = e.property_id
       and uu.status = 'open'
       and ((c.target_table is not null and uu.target_table = c.target_table)
            or (e.report_type is not null and uu.report_type = e.report_type))
  ) u on true
)
select
  b.*,
  public.pms_feed_minutes_late(
    b.cadence_kind, b.expected_every_minutes, b.expected_at_local,
    b.timezone, b.last_signal_at, now()
  ) as minutes_late,
  case
    when b.enabled is not true then 'unavailable'
    when b.open_unmapped_count > 0 then 'learning'
    when b.last_signal_at is null then 'learning'
    when coalesce(public.pms_feed_minutes_late(
           b.cadence_kind, b.expected_every_minutes, b.expected_at_local,
           b.timezone, b.last_signal_at, now()), 0) > b.grace_minutes then 'stale'
    else 'live'
  end as state
from base b;

comment on view public.pms_feed_health_v1 is
  'THE single definition of "is this feed fresh". One row per (hotel, feed) that has an expectation row. Zero rows for a hotel means "no PMS report expectation" and the app falls back to its manual-hotel fail-safe.';

-- ─── Per-hotel roll-up ────────────────────────────────────────────────────
-- worst_state ordering: learning (numbers untrustworthy) > stale (real but
-- old) > live > unavailable. 'unavailable' only wins when EVERY feed is
-- disabled — one deliberately-off feed must not amber a healthy hotel.
create or replace view public.pms_property_health_v1
with (security_invoker = true) as
select
  property_id,
  case
    when bool_or(state = 'learning') then 'learning'
    when bool_or(state = 'stale')    then 'stale'
    when bool_or(state = 'live')     then 'live'
    else 'unavailable'
  end                                                   as worst_state,
  count(*)::integer                                     as feeds_total,
  count(*) filter (where state = 'live')::integer       as feeds_live,
  count(*) filter (where state = 'stale')::integer      as feeds_stale,
  count(*) filter (where state = 'learning')::integer   as feeds_learning,
  count(*) filter (where state = 'unavailable')::integer as feeds_unavailable,
  count(*) filter (where enabled and required and state in ('stale', 'learning'))::integer
                                                        as required_feeds_degraded,
  min(last_signal_at)                                   as oldest_signal_at,
  max(last_signal_at)                                   as newest_signal_at,
  max(minutes_late)                                     as worst_minutes_late,
  sum(open_quarantine_count)::integer                   as open_quarantine_total,
  sum(open_unmapped_count)::integer                     as open_unmapped_total
from public.pms_feed_health_v1
group by property_id;

comment on view public.pms_property_health_v1 is
  'Per-hotel roll-up of pms_feed_health_v1. newest_signal_at is the "as of" time the copilot and the dashboard quote.';

-- ─── Cross-delivery quarantine roll-up (display side of the FLAW-A fix) ───
-- Storage keeps one open row per (delivery, problem) so per-delivery
-- accounting balances. This is where "the same bad row has now shown up in 11
-- deliveries" gets answered, without a storage constraint that wedges the
-- pipeline.
create or replace view public.pms_quarantine_rollup_v1
with (security_invoker = true) as
select
  property_id,
  target_table,
  report_type,
  reason_code,
  fingerprint,
  count(*)::integer                              as open_rows,
  count(distinct delivery_id)::integer           as deliveries_affected,
  sum(occurrences)::bigint                       as total_occurrences,
  min(first_seen_at)                             as first_seen_at,
  max(last_seen_at)                              as last_seen_at,
  (array_agg(reason_detail order by last_seen_at desc))[1] as latest_reason_detail
from public.pms_ingest_quarantine
where status = 'open'
group by property_id, target_table, report_type, reason_code, fingerprint;

comment on view public.pms_quarantine_rollup_v1 is
  'Cross-delivery view of the same recurring bad row. The DISPLAY-side answer to "how often has this happened", replacing the global unique index that would have wedged per-delivery row accounting.';

-- ─── View grants ─────────────────────────────────────────────────────────
-- security_invoker means the base-table deny-all policies already apply to a
-- browser caller; the REVOKE means the view is not even reachable. Server
-- reads use service_role, which bypasses RLS as usual.
revoke all on public.pms_feed_delivery_signal_v1 from public, anon, authenticated;
revoke all on public.pms_feed_table_signal_v1     from public, anon, authenticated;
revoke all on public.pms_feed_health_v1           from public, anon, authenticated;
revoke all on public.pms_property_health_v1       from public, anon, authenticated;
revoke all on public.pms_quarantine_rollup_v1     from public, anon, authenticated;

grant select on public.pms_feed_delivery_signal_v1 to service_role;
grant select on public.pms_feed_table_signal_v1     to service_role;
grant select on public.pms_feed_health_v1           to service_role;
grant select on public.pms_property_health_v1       to service_role;
grant select on public.pms_quarantine_rollup_v1     to service_role;

insert into public.applied_migrations (version, description)
values ('0339', 'Ingest quality: feed catalog + per-hotel freshness SLOs as rows + quarantine (per-delivery dedupe) + unmapped-column capture + anomalies, and pms_feed_health_v1 as the single SQL definition of feed freshness')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
