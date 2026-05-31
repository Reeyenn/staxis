-- Migration 0239: CapEx approval workflow + financials SMS gate + attachments
-- ════════════════════════════════════════════════════════════════════════════
-- Evolves capex_projects (from 0237) from basic project tracking into a full
-- capital-REQUEST → approval → in-progress → completed workflow, adds a
-- per-property switch to gate finance anomaly/overspend SMS (default OFF, owner
-- rule "route any text through me first" — mirrors 0238's compliance flag), and
-- a private bucket for attached quotes/photos kept in each project's binder.
--
-- All additive. capex_projects stays SERVICE-ROLE-ONLY (RLS marker from 0237);
-- money stays integer cents. Empty in prod today, so the status remap is a
-- no-op safety net.
-- ════════════════════════════════════════════════════════════════════════════

set search_path = public, pg_catalog;

-- ── CapEx project → capital request/approval fields ─────────────────────────
alter table public.capex_projects
  add column if not exists request_type        text not null default 'budgeted'
                             check (request_type in ('budgeted','emergency')),
  add column if not exists category             text
                             check (category is null or category in (
                               'renovation','equipment','technology','safety',
                               'exterior','furniture','other'
                             )),
  -- The estimate the request is submitted/approved on (overrun is measured
  -- against this). quote_cents (from 0237) stays as the scanned-quote figure.
  add column if not exists estimated_cost_cents bigint not null default 0
                             check (estimated_cost_cents >= 0),
  add column if not exists pct_complete         integer not null default 0
                             check (pct_complete between 0 and 100),
  add column if not exists submitted_by         uuid,
  add column if not exists submitted_by_name    text,
  add column if not exists approved_by          uuid,
  add column if not exists approved_by_name     text,
  add column if not exists approved_at          timestamptz,
  add column if not exists decided_at           timestamptz,
  add column if not exists decision_notes       text,
  add column if not exists attachment_path      text;

-- New status lifecycle: Requested → Approved | Rejected | Revisions-Needed →
-- In-Progress → Completed (+ Cancelled). Remap the old 0237 values first (the
-- table is empty in prod, so this is a safety net), then swap the CHECK + default.
update public.capex_projects set status = 'requested' where status = 'planned';
update public.capex_projects set status = 'in_progress' where status = 'on_hold';
update public.capex_projects set status = 'completed' where status = 'complete';

alter table public.capex_projects drop constraint if exists capex_projects_status_check;
alter table public.capex_projects
  add constraint capex_projects_status_check
  check (status in ('requested','approved','rejected','revisions_needed','in_progress','completed','cancelled'));
alter table public.capex_projects alter column status set default 'requested';

create index if not exists capex_projects_property_target_idx
  on public.capex_projects (property_id, target_date);

-- ── Per-property finance-SMS gate (default OFF) ─────────────────────────────
-- Owner rule: no automatic texting. When FALSE (default) the overspend/anomaly
-- sweep records the alert (app_events) and shows it in-app + on the Dashboard,
-- but sends NO SMS. Flip TRUE per property (no redeploy) once the owner opts in.
-- Mirrors properties.compliance_anomaly_sms_enabled (migration 0238).
alter table public.properties
  add column if not exists financials_alerts_sms_enabled boolean not null default false;

comment on column public.properties.financials_alerts_sms_enabled is
  'When TRUE, the financials-alert-sweep cron may text the alert phone on overspend/anomaly. Default FALSE = record + in-app only, NO SMS (owner gate, 2026-05-31). Checked in /api/cron/financials-alert-sweep.';

-- ── Attachments bucket (quotes / photos for the capex binder) ───────────────
-- @storage: service-role-only — uploads + views via server-minted paths/signed
-- URLs behind requireFinanceAccess. Browser/anon denied. Mirrors 0230.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('capex-attachments', 'capex-attachments', false, 10485760,
   array['image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "service role rw capex-attachments" on storage.objects;
create policy "service role rw capex-attachments"
  on storage.objects
  for all
  to service_role
  using (bucket_id = 'capex-attachments')
  with check (bucket_id = 'capex-attachments');

drop policy if exists "anon deny capex-attachments" on storage.objects;
create policy "anon deny capex-attachments"
  on storage.objects
  for all
  to anon, authenticated
  using (bucket_id <> 'capex-attachments')
  with check (bucket_id <> 'capex-attachments');

notify pgrst, 'reload schema';

insert into public.applied_migrations (version, description)
values ('0239', 'capex approval workflow (request→approve→in-progress→completed, estimate/overrun/pct, attachments bucket) + properties.financials_alerts_sms_enabled (default FALSE)')
on conflict (version) do nothing;
