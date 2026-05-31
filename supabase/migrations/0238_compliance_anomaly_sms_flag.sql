-- ═══════════════════════════════════════════════════════════════════════════
-- 0238 — Engineering Compliance v2: per-property anomaly-SMS gate (default OFF)
--
-- The owner wants NO automatic texting on anomalies yet ("route any SMS through
-- me first"). v2's anomaly engine otherwise always texts maintenance (warn/
-- critical) + the GM (critical). This adds a single per-property switch,
-- default FALSE, that the engine checks before sending EITHER text.
--
-- When OFF (default): the alert is still recorded, the ⚠️ still shows in-app
-- (Compliance tab + engineer page + Dashboard count), and a high-confidence
-- leak still auto-opens a work order — only the SMS is suppressed. Flip the
-- column to TRUE per property (no redeploy) once the owner approves texting.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.properties
  add column if not exists compliance_anomaly_sms_enabled boolean not null default false;

comment on column public.properties.compliance_anomaly_sms_enabled is
  'When TRUE, the v2 anomaly engine may text maintenance (warn/critical) + the GM (critical) on a detected leak/spike. Default FALSE = record + in-app + auto-work-order only, NO SMS (owner gate, 2026-05-31). Checked in src/lib/compliance/anomaly-engine.ts recordAndNotify.';

insert into public.applied_migrations (version, description)
values (
  '0238',
  'Engineering Compliance v2: properties.compliance_anomaly_sms_enabled (default FALSE). Owner gate — anomaly engine records + shows in-app + auto-opens work orders but sends NO SMS unless this per-property flag is enabled.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
