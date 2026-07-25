-- 0337 — properties.housekeeping_setup: the one-time Housekeeping questionnaire answer.
--
-- feature/housekeeping-levels (2026-07-24). The first time anyone at a hotel
-- opens the Housekeeping section they answer six short questions (how a clean
-- room gets into their system today, how long a room should take, when the
-- shift starts and who builds the board, who inspects rooms, what else the
-- housekeepers do besides rooms) and then pick how much of Staxis they want to
-- run: manager-only planning, the head housekeeper's day, or the whole crew on
-- phones. It is asked once, saved once, and never asked again.
--
-- SEMANTICS:
--   NULL (every existing hotel)                  = questionnaire NOT done.
--   Row present but "completedAt" null/missing   = questionnaire NOT done.
--   Row present with a non-empty "completedAt"   = done; never ask again.
-- => Deliberately NO default and NO backfill: a hotel that has never seen the
--    questionnaire must be indistinguishable from one that abandoned it
--    halfway, and both must get the questionnaire on the next visit. The
--    reader (isHousekeepingSetupComplete in src/lib/housekeeping/setup-gate.ts)
--    supplies that judgement; the column is just storage.
--
-- The stored answers are load-bearing for two things beyond the gate itself:
--   • "checkoutMinutes" / "stayoverMinutes" are the standard room times the
--     whole earned-hours-vs-paid-hours labor-cost math rests on.
--   • "statusEntry" decides whether the crew-on-phones level is even offerable.
--     Hotels whose housekeepers already type room status in themselves (room
--     phone code, or their own login in the hotel's own system) must never be
--     offered it — a tap in Staxis would be a second entry of the same fact,
--     i.e. extra work, which is the one thing this product must never add.
--
-- NO RLS CHANGE. The existing public.properties policies already cover a new
-- column, and browser UPDATE on properties is intentionally admin-only — this
-- column is written exclusively by a service-role API route, never by the
-- browser client. Adding a browser-writable path here would be a regression.

begin;

alter table public.properties
  add column if not exists housekeeping_setup jsonb;

comment on column public.properties.housekeeping_setup is
  'One-time Housekeeping questionnaire answers, asked the first time anyone opens Housekeeping for this hotel. Shape: { version:1, completedAt: string|null, level:1|2|3, recommendedLevel:1|2|3, statusEntry: housekeeper_radio|supervisor_keys|housekeeper_direct|unsure, checkoutMinutes:int 5-240, stayoverMinutes:int 5-240, shiftStartTime: "HH:MM" 24h, boardBuiltBy: head_housekeeper|gm|nobody|unsure, inspection: none|spot_check|every_room, sideDuties: (laundry|breakfast|lobby|public_areas|shuttle)[], boardPhotoPath: string|null (storage path, not a URL) }. NULL = questionnaire never done; a non-empty completedAt = done, never ask again (no backfill, no default). Parsed defensively by src/lib/housekeeping/setup-gate.ts; written only by a service-role API route (browser UPDATE on properties is admin-only).';

insert into public.applied_migrations (version, description)
values (
  '0337',
  'properties.housekeeping_setup — one-time Housekeeping questionnaire answers (adoption level, standard room minutes, shift start, board owner, inspection policy, side duties, board photo path). Additive nullable jsonb; NULL = not set up; no backfill; no RLS change (service-role writes only).'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
