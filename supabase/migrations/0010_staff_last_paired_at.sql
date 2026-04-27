-- ═══════════════════════════════════════════════════════════════════════════
-- 0010 — staff.last_paired_at
--
-- Adds a timestamp recording when each staff member last opened their
-- housekeeper or laundry mobile link and confirmed who they are. The
-- timestamp is the manager's "did Maria open her phone today?" signal —
-- without it, the manager has no way to know if a freshly-onboarded
-- housekeeper has actually pulled up the link they were sent.
--
-- Set by: POST /api/save-fcm-token (despite the legacy name; the route
--         was renamed but its function shifted from "save FCM token" to
--         "stamp last-paired" during the 2026-04-22 Firebase → Supabase
--         migration that retired FCM web push).
-- Read by: housekeeping/page.tsx Settings tab roster view.
-- ═══════════════════════════════════════════════════════════════════════════

alter table staff
  add column if not exists last_paired_at timestamptz;

comment on column staff.last_paired_at is
  'Set by /api/save-fcm-token whenever the staff member opens their housekeeper or laundry link. Operators use it to spot housekeepers who never paired with their device.';
