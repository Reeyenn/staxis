-- 0065: accounts.phone + simplified join codes
--
-- Two related changes:
--   1. accounts.phone — staff signing up via /signup provide their phone for
--      contact (the housekeeping / front-desk people the hotel will need to
--      reach for shift confirmations). Optional column so existing rows
--      stay valid.
--   2. hotel_join_codes.role made nullable — the new "share a code with
--      your whole team" flow no longer pre-binds a role at code creation.
--      The role is chosen by the staff member during signup. Legacy codes
--      that still have role set continue to work; the use-join-code route
--      prefers a code-baked role over the signup payload for back-compat.

alter table accounts
  add column if not exists phone text;

alter table hotel_join_codes
  alter column role drop not null;
