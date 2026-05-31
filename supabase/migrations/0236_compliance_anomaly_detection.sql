-- ═══════════════════════════════════════════════════════════════════════════
-- 0236 — Engineering Compliance v2: leak/spike anomaly detection
--
-- v1 (0229) records readings + flags out-of-RANGE against static thresholds.
-- v2 adds TREND/anomaly detection: catch problems BEFORE a hard threshold —
-- water/electric spikes (leak/equipment), a fridge trending warm before
-- spoilage, pool chemistry drifting toward failure, or a flatlined meter
-- (stuck/dead sensor).
--
-- ONE table: compliance_anomaly_alerts. Baselines are computed on the fly from
-- recent reading history (mirrors the pure-function approach in
-- src/lib/inventory-anomaly.ts — no per-property-tuned model, no baseline
-- cache table to go stale). Cold-start is honest: the engine does NOT alert
-- until there's enough history for a stable baseline (src/lib/compliance/
-- anomaly.ts), so no false alarms on day 1.
--
-- RLS — SERVICE-ROLE ONLY (mirrors the v1 compliance_* tables / inspections /
-- activity_log). All access via /api/* + supabaseAdmin. Detection runs server-
-- side (the reading write-path hook in store.ts + the sweep cron).
-- ═══════════════════════════════════════════════════════════════════════════

-- @rls: service-role-only — all UI access mediated by /api/compliance/* via supabaseAdmin (matches v1 compliance_* + inspections + activity_log). Anomaly detection is server-internal.
create table if not exists public.compliance_anomaly_alerts (
  id                  uuid primary key default gen_random_uuid(),
  property_id         uuid not null references public.properties(id) on delete cascade,
  reading_type_id     uuid not null references public.compliance_reading_types(id) on delete cascade,
  -- The triggering reading (real-time hook). Null for sweep-detected slow trends.
  reading_id          uuid references public.compliance_readings(id) on delete set null,

  kind                text not null check (kind in ('spike', 'drift', 'flatline')),
  severity            text not null default 'warn' check (severity in ('info', 'warn', 'critical')),

  -- Baseline + observation snapshot (for the UI + audit; numeric, nullable).
  baseline_mean       numeric,   -- rolling mean (point) or mean consumption delta (meter)
  baseline_stddev     numeric,
  observed_value      numeric,   -- the reading value (point) or consumption delta (meter)
  score               numeric,   -- z-score (point) or rate ratio (meter)
  confidence          numeric,   -- 0..1

  reason              text not null,         -- plain-English EN (templated; may be AI-sharpened)
  reason_es           text,                   -- plain-Spanish ES
  ai_phrased          boolean not null default false,

  detected_by         text not null default 'reading' check (detected_by in ('reading', 'sweep')),
  status              text not null default 'active' check (status in ('active', 'acknowledged', 'resolved')),
  work_order_id       uuid references public.work_orders(id) on delete set null,  -- auto-opened for a high-confidence leak

  -- One ACTIVE alert per (type, kind, day). Re-detecting the same condition the
  -- same day does NOT create a duplicate or re-text — the partial unique index
  -- below is the dedupe guard.
  dedupe_key          text not null,

  acknowledged_at     timestamptz,
  acknowledged_by     text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.compliance_anomaly_alerts is
  'Engineering Compliance v2 leak/spike anomaly alerts. One row per detected trend anomaly (spike/drift/flatline). Baselines computed on the fly from reading history; cold-start-gated. property_id scoped, service-role-only. Created 0236.';
comment on column public.compliance_anomaly_alerts.dedupe_key is
  'type:kind:local-date. A partial unique index on (reading_type_id, dedupe_key) WHERE status=active prevents duplicate active alerts + re-texting for the same condition the same day.';

create index if not exists compliance_anomaly_prop_status_idx
  on public.compliance_anomaly_alerts (property_id, status, created_at desc);
create index if not exists compliance_anomaly_type_status_idx
  on public.compliance_anomaly_alerts (reading_type_id, status);
create unique index if not exists compliance_anomaly_active_dedupe_uq
  on public.compliance_anomaly_alerts (reading_type_id, dedupe_key)
  where status = 'active';

-- ── RLS — service-role only; anon + authenticated deny-all ──────────────────
alter table public.compliance_anomaly_alerts enable row level security;
revoke all on public.compliance_anomaly_alerts from public, anon, authenticated;
grant select, insert, update, delete on public.compliance_anomaly_alerts to service_role;

drop policy if exists compliance_anomaly_alerts_deny_all on public.compliance_anomaly_alerts;
create policy compliance_anomaly_alerts_deny_all on public.compliance_anomaly_alerts
  for all to anon, authenticated using (false) with check (false);

-- ── updated_at trigger (shared function from 0202) ──────────────────────────
drop trigger if exists set_updated_at on public.compliance_anomaly_alerts;
create trigger set_updated_at before update on public.compliance_anomaly_alerts
  for each row execute function public._pms_set_updated_at();

-- ── Bookkeeping + schema reload ─────────────────────────────────────────────
insert into public.applied_migrations (version, description)
values (
  '0236',
  'Engineering Compliance v2: compliance_anomaly_alerts (leak/spike/drift/flatline anomaly detection). Service-role-only RLS. Baselines computed on the fly from reading history; cold-start-gated. Detection hooks the reading write-path + a sweep cron; notifies engineer + GM by SMS, auto-opens a work order for high-confidence leaks. Surfaced on the Maintenance Compliance tab + Dashboard tile.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
