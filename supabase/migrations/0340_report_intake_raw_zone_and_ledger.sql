-- ═══════════════════════════════════════════════════════════════════════════
-- 0340 — Report-email intake: immutable raw zone + ingest ledger.
--
-- WHY THIS EXISTS
--   Data intake is moving from the 24/7 CUA robot to scheduled PMS report
--   emails. Every number the app shows must be traceable back to the exact
--   file the PMS mailed, and a duplicate / forged / late / replayed email
--   must never quietly change a number.
--
--   This migration builds the STORAGE half only — the report FORMATS are
--   still unknown, so nothing here assumes a layout, a column set, or a
--   report kind. It creates:
--     1. pms_report_files  — one row per (hotel, distinct file content).
--                            The receipt. Bytes live in Storage.
--     2. pms_ingest_runs   — one row per (file, parser version, mode).
--                            The parse attempt. file:attempt is 1:N so it
--                            cannot live on the file row.
--     3. private bucket `pms-raw` — the bytes themselves.
--
-- EXTEND-BEFORE-YOU-ADD
--   pms_report_files is NOT a new table: it REPURPOSES pms_reports_cache
--   (created empty by 0202, 0 rows in prod, no descriptor in
--   pms_table_schemas, never written by any code path). Its old
--   unique (property_id, report_type, report_date) is DROPPED — it allowed
--   exactly one row per report per day, which is fatal when a hotel mails
--   the same report 24-48x/day: the second delivery would destroy the first
--   receipt. pms_ingest_runs is the one genuinely new table.
--
-- RETENTION IS A POLICY, NOT A HARD-CODED WINDOW
--   scraper_credentials.report_raw_retention_days (added in 0342) decides
--   when raw bytes are purged. NULL = keep forever, which is the default
--   until the founder decides. The receipt row ALWAYS outlives the file:
--   check ((raw_purged_at is null) = (storage_path is not null)) forces the
--   purge path to null the path and stamp the timestamp together.
--
-- APPLY ORDER: 0340 → 0341 → 0342. Manual apply (project convention);
-- idempotent, safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Part A: pms_reports_cache → pms_report_files ──────────────────────────

do $$
begin
  if exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'pms_reports_cache'
  ) and not exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'pms_report_files'
  ) then
    -- Guard: the repurpose is only safe while the table is empty. 0 rows in
    -- prod as of 2026-07-24; refuse rather than silently reshape real data.
    if (select count(*) from public.pms_reports_cache) > 0 then
      raise exception
        'pms_reports_cache is not empty — 0340 repurposes it and would reshape real rows. Investigate before applying.';
    end if;
    alter table public.pms_reports_cache rename to pms_report_files;
  end if;
end $$;

-- Drop the fatal one-row-per-report-per-day key (see header).
alter table public.pms_report_files
  drop constraint if exists pms_reports_cache_unique;

do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='pms_report_files' and column_name='report_type') then
    alter table public.pms_report_files rename column report_type to report_kind;
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='pms_report_files' and column_name='report_date') then
    alter table public.pms_report_files rename column report_date to business_date;
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='pms_report_files' and column_name='fetched_at') then
    alter table public.pms_report_files rename column fetched_at to received_at;
  end if;
end $$;

-- report_kind / business_date are UNKNOWN until a classifier exists (there is
-- no real report corpus yet), so both must be nullable.
alter table public.pms_report_files alter column report_kind  drop not null;
alter table public.pms_report_files alter column business_date drop not null;

-- Bytes live in Storage, never in a jsonb column. parsed_summary is the
-- parser's job and does not belong on the receipt.
alter table public.pms_report_files drop column if exists raw_content;
alter table public.pms_report_files drop column if exists parsed_summary;

alter table public.pms_report_files
  -- Content address. Lowercase hex sha256 of the exact bytes.
  add column if not exists content_sha256     text,
  add column if not exists byte_size          bigint,
  add column if not exists mime_type          text,
  add column if not exists original_filename  text,
  -- <property_id>/<yyyy>/<mm>/<sha256>.<ext>. NULL only after a retention purge.
  add column if not exists storage_path       text,
  -- Provider Message-Id of the delivering email. A report without one cannot
  -- be deduped at the message layer, so the route refuses it before we get here.
  add column if not exists message_id         text,
  add column if not exists from_addr          text,
  add column if not exists subject            text,
  -- The VERIFIED DKIM signing domain, not the spoofable From string.
  add column if not exists sender_domain      text,
  add column if not exists sender_approved    boolean not null default false,
  -- The report's as-of time. Falls back to the mail Date header until a real
  -- report format is in hand. Drives monotonic supersession (0341).
  add column if not exists source_captured_at timestamptz,
  add column if not exists contains_pan       boolean not null default false,
  add column if not exists raw_purged_at      timestamptz,
  add column if not exists last_error         text,
  add column if not exists status             text not null default 'pending_upload';

-- NOT NULL on the identity columns. Safe unconditionally: the table is empty
-- (guarded above) so there is nothing to backfill.
alter table public.pms_report_files alter column content_sha256     set not null;
alter table public.pms_report_files alter column byte_size          set not null;
alter table public.pms_report_files alter column message_id         set not null;
alter table public.pms_report_files alter column source_captured_at set not null;

do $$
begin
  -- Same bytes for the same hotel = exactly one receipt and one object.
  if not exists (select 1 from pg_constraint where conname = 'pms_report_files_content_unique') then
    alter table public.pms_report_files
      add constraint pms_report_files_content_unique unique (property_id, content_sha256);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'pms_report_files_sha_shape') then
    alter table public.pms_report_files
      add constraint pms_report_files_sha_shape check (content_sha256 ~ '^[0-9a-f]{64}$');
  end if;

  if not exists (select 1 from pg_constraint where conname = 'pms_report_files_size_positive') then
    alter table public.pms_report_files
      add constraint pms_report_files_size_positive check (byte_size > 0);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'pms_report_files_status_check') then
    alter table public.pms_report_files
      add constraint pms_report_files_status_check check (status in (
        'pending_upload',            -- ledger row written, bytes not yet landed
        'stored',                    -- bytes verified against content_sha256
        'hash_mismatch',             -- downloaded bytes did not match the address
        'quarantined_pan',           -- cardholder data detected; excluded everywhere
        'blocked_unapproved_sender', -- stored, but the hotel has not approved this sender
        'parsed',                    -- turned into pms_* rows by an ingest run
        'failed'                     -- upload abandoned or permanently unusable
      ));
  end if;

  -- A file can NEVER reach parsed state from an unapproved sender. The route
  -- gate can be bypassed by a bug; this cannot.
  if not exists (select 1 from pg_constraint where conname = 'pms_report_files_parsed_requires_approval') then
    alter table public.pms_report_files
      add constraint pms_report_files_parsed_requires_approval
      check (status <> 'parsed' or sender_approved);
  end if;

  -- The receipt outlives the file: a purge must null the path and stamp the
  -- timestamp in the SAME write, or the row is rejected.
  if not exists (select 1 from pg_constraint where conname = 'pms_report_files_purge_pairing') then
    alter table public.pms_report_files
      add constraint pms_report_files_purge_pairing
      check ((raw_purged_at is null) = (storage_path is not null));
  end if;
end $$;

create index if not exists pms_report_files_property_recv_idx
  on public.pms_report_files (property_id, received_at desc);
-- Hot path for the stuck-upload sweeper + the doctor check.
create index if not exists pms_report_files_pending_idx
  on public.pms_report_files (received_at)
  where status = 'pending_upload';
create index if not exists pms_report_files_message_id_idx
  on public.pms_report_files (message_id);

comment on table public.pms_report_files is
  'One row per (hotel, distinct file content) mailed by a PMS report scheduler. The RECEIPT: content address, provenance, sender verdict, retention state. Bytes live in the private pms-raw bucket. Repurposed from the empty pms_reports_cache (0202) by 0340.';
comment on column public.pms_report_files.content_sha256 is
  'Lowercase hex sha256 of the exact attachment bytes. Computed in the Cloudflare Email Worker, re-verified on download before any parse.';
comment on column public.pms_report_files.source_captured_at is
  'The report''s as-of time (falls back to the mail Date header). Drives monotonic supersession in 0341 — an older report can never clobber a newer one.';
comment on column public.pms_report_files.report_kind is
  'Nullable ON PURPOSE. No report corpus exists yet, so there is no classifier. Fill it when one ships.';

-- ─── Part B: pms_ingest_runs (the parse-attempt ledger) ────────────────────
-- @rls: service-role-only — ingest bookkeeping; worker writes, admin reads via supabaseAdmin. Never browser-readable.

create table if not exists public.pms_ingest_runs (
  id                  uuid primary key default gen_random_uuid(),
  property_id         uuid not null references public.properties(id) on delete cascade,
  -- CASCADE: a file and its parse attempts are one unit. Nothing deletes a
  -- file except the property-delete cascade, so this never orphans a run.
  report_file_id      uuid references public.pms_report_files(id) on delete cascade,
  source_kind         text not null check (source_kind in ('report_email', 'cua', 'manual_backfill', 'legacy')),
  mode                text not null default 'live' check (mode in ('live', 'replay')),
  parser_name         text not null,
  parser_version      text not null,
  knowledge_file_id   uuid references public.pms_knowledge_files(id) on delete set null,
  source_captured_at  timestamptz not null,
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  status              text not null default 'running'
                      check (status in ('running', 'succeeded', 'failed', 'diffed', 'promoted')),
  rows_written        integer not null default 0 check (rows_written >= 0),
  rows_rejected       integer not null default 0 check (rows_rejected >= 0),
  diff                jsonb,
  attempt_count       integer not null default 1 check (attempt_count >= 1),
  error               text,
  constraint pms_ingest_runs_email_needs_file
    check (source_kind <> 'report_email' or report_file_id is not null)
);

-- The same file is never parsed into the live tables twice by the same parser
-- version: a retry UPDATEs attempt_count on this row, it cannot insert a second.
-- (report_file_id NULL for cua/legacy runs — NULLs are distinct, so robot polls
-- are unconstrained, which is what we want.)
create unique index if not exists pms_ingest_runs_file_version_mode_uidx
  on public.pms_ingest_runs (report_file_id, parser_version, mode);

create index if not exists pms_ingest_runs_property_started_idx
  on public.pms_ingest_runs (property_id, started_at desc);

comment on table public.pms_ingest_runs is
  'One row per (report file, parser version, mode) parse attempt. Every pms_* data row points at one of these via ingest_run_id (0341) — there is no number in the system without a receipt. Created 0340.';

-- ─── Part C: RLS — service-role only, deny-all browser ─────────────────────
-- Same posture as the 0202 siblings.

do $$
declare
  tbl text;
begin
  for tbl in select unnest(array['pms_report_files', 'pms_ingest_runs'])
  loop
    execute format('alter table public.%I enable row level security', tbl);
    execute format('revoke all on public.%I from public, anon, authenticated', tbl);
    execute format('grant select, insert, update, delete on public.%I to service_role', tbl);
    execute format('drop policy if exists %I on public.%I', tbl || '_deny_all_browser', tbl);
    execute format(
      'create policy %I on public.%I for all to anon, authenticated using (false) with check (false)',
      tbl || '_deny_all_browser', tbl
    );
    execute format(
      'comment on policy %I on public.%I is %L',
      tbl || '_deny_all_browser', tbl,
      'Service-role only. Report receipts carry guest-bearing filenames and subjects; the ledger is operational bookkeeping. Browser reads go through /api/* with supabaseAdmin. Created 0340.'
    );
  end loop;
end $$;

-- ─── Part D: the private raw-bytes bucket ──────────────────────────────────
-- Raw report files contain guest names (and possibly card fragments). They are
-- NEVER readable by a browser session, signed-in or not: no storage.objects
-- policy is granted to anon/authenticated, mirroring knowledge-docs (0252).
-- All reads go through supabaseAdmin-minted short-lived signed URLs from
-- cron/admin routes; all writes go through a signed UPLOAD url minted with
-- upsert:false, so the object itself is un-overwritable once it lands.
--
-- allowed_mime_types is deliberately NARROW: csv / plain / pdf / xls / xlsx.
-- zip and message/rfc822 were dropped — no PMS is known to send them and each
-- one invites a container-parsing surface we would have to secure forever.
--
-- @storage: service-role-only — private bucket for raw PMS report attachments; supabaseAdmin mints every signed upload/download URL server-side. No anon/authenticated policy by design. Per-property scoping is enforced by the object path (<property_id>/<yyyy>/<mm>/<sha256>.<ext>) which only the server constructs.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'pms-raw', 'pms-raw', false, 26214400,
  array[
    'text/csv',
    'text/plain',
    'application/pdf',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ─── Bookkeeping + PostgREST schema reload ─────────────────────────────────
insert into public.applied_migrations (version, description)
values (
  '0340',
  'Report-email intake storage: pms_reports_cache repurposed to pms_report_files (content-addressed receipts, immutable), new pms_ingest_runs parse-attempt ledger, private pms-raw bucket. Storage half only — no format assumptions.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
