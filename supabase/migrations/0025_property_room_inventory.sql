-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0025: properties.room_inventory — full room list per property
--
-- Why this exists
-- ─────────────────────────────────────────────────────────────────────────
-- Choice Advantage's "Housekeeping Check-off List" CSV (the report our
-- scraper pulls) only contains rooms that need housekeeping attention
-- today: dirty rooms, occupied rooms, checkouts, arrivals. Rooms that are
-- already Vacant Clean — sitting ready for the next guest with nothing to
-- do — get omitted entirely.
--
-- Result: when Maria clicked "Load Rooms" she only ever saw ~45 of the
-- property's 74 rooms. The other ~29 (vacant clean) had no row in the
-- rooms table for today's date because the CSV never mentioned them.
--
-- Reeyen, 2026-05-03: 'every room at comfort suites should display here
-- no matter what.' The vision is for Staxis to be the source of truth
-- for housekeeping, not a slave to Choice Advantage's report quirks.
-- Eventually Choice Advantage gets fed FROM Staxis, not the other way
-- around.
--
-- Fix: store each property's master list of room numbers, and have
-- /api/populate-rooms-from-plan union the CSV rooms with this list. Any
-- room number in inventory but missing from the CSV gets seeded as
-- vacant clean (no icon on the tile). All 74 always render.
--
-- Backfill: Comfort Suites Beaumont — 74 rooms, per the property's real
-- floor layout. Skips 107/109/111 on Floor 1, and 213/313/413 across
-- floors 2/3/4 (typical hotel numbering quirk — no 13s, no triskaidekaphobia
-- jokes from front-desk staff).
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Schema change ────────────────────────────────────────────────────────
alter table properties
  add column if not exists room_inventory text[] not null default '{}';

comment on column properties.room_inventory is
  'Master list of all room numbers at this property. /api/populate-rooms-from-plan unions this with the CSV-derived rooms — anything in inventory but missing from CSV is seeded as vacant clean. Empty array (the default) skips the union and falls back to CSV-only behavior, so existing properties without inventory data don''t break.';

-- 2. Backfill Comfort Suites Beaumont ─────────────────────────────────────
-- Idempotent: only updates rows where inventory is currently empty.
-- Safe to re-run.
update properties
set room_inventory = array[
  -- Floor 1 (9 rooms — skips 107, 109, 111)
  '101','102','103','104','105','106','108','110','112',
  -- Floor 2 (21 rooms — 201–222 except 213)
  '201','202','203','204','205','206','207','208','209','210','211','212',
  '214','215','216','217','218','219','220','221','222',
  -- Floor 3 (22 rooms — 300–322 except 313)
  '300','301','302','303','304','305','306','307','308','309','310','311','312',
  '314','315','316','317','318','319','320','321','322',
  -- Floor 4 (22 rooms — 400–422 except 413)
  '400','401','402','403','404','405','406','407','408','409','410','411','412',
  '414','415','416','417','418','419','420','421','422'
]
where name ilike '%comfort suites%'
  and (room_inventory is null or array_length(room_inventory, 1) is null);

-- 3. Track migration so the doctor's EXPECTED_MIGRATIONS check stays green ─
insert into applied_migrations (version, name)
values ('0025', 'property_room_inventory')
on conflict (version) do nothing;
