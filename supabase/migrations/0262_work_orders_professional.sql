-- 0262 — Work orders: "Call in a professional" lane (Maintenance redesign, Jun 2026).
--
-- The redesigned Work Orders board adds a fourth triage lane — "Professional" —
-- for jobs handed to an outside contractor. These columns are all additive and
-- nullable (needs_pro defaults false), so existing code that never sets them is
-- untouched: a row with needs_pro=false behaves exactly as before.
--
--   needs_pro      — flagged as needing an outside pro (routes the card to the
--                    Professional lane even when severity is normal/low/urgent)
--   pro_trade      — what kind of contractor (Plumbing, Electrical, HVAC, …)
--   pro_company    — who was called (company name)
--   pro_phone      — their number
--   pro_called_at  — when the pro was logged

alter table public.work_orders
  add column if not exists needs_pro     boolean not null default false,
  add column if not exists pro_trade     text,
  add column if not exists pro_company   text,
  add column if not exists pro_phone     text,
  add column if not exists pro_called_at timestamptz;

-- Self-register so the migration-bookkeeping check + doctor see it as applied.
insert into public.applied_migrations (version, description)
values (
  '0262',
  'work_orders: add needs_pro + pro_trade/pro_company/pro_phone/pro_called_at for the "Call in a professional" triage lane (Maintenance redesign).'
)
on conflict (version) do nothing;

-- PostgREST caches the schema — reload so the new columns are visible to the API.
notify pgrst, 'reload schema';
