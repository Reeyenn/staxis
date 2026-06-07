-- 0273 — Allow SINGLE-USE owner/GM hotel_join_codes (reconcile M1.5 owner
--        onboarding with the 0152 hardening).
--
-- Background. Phase M1.5 designed hotel owner self-onboarding around an
-- admin-issued join code: /api/admin/properties/create mints a single-use
-- ('max_uses' = 1) code with role='owner' (or 'general_manager'), the owner
-- redeems it at /onboard, and /api/auth/use-join-code transfers
-- properties.owner_id from the placeholder admin to the real owner.
--
-- The later 0152 hardening (F-06) added the CHECK constraint
-- 'hotel_join_codes_role_check_no_privileged' which BLANKET-forbids any
-- owner/GM code:
--   role IS NULL OR role IN ('front_desk','housekeeping','maintenance')
-- That rejected the very code the admin-create flow tries to mint, so owner
-- self-onboarding has been fully broken since 0152 (May 2026) — the admin UI
-- showed "Property created but join code generation failed".
--
-- 0152 exists for a real reason: a SHARED / MULTI-USE owner code, if leaked,
-- would let a stranger redeem it and seize ownership of a hotel (the redeem
-- path rewrites properties.owner_id). We do NOT want to reopen that.
--
-- The reconciliation: owner/GM codes are allowed ONLY when single-use
-- (max_uses = 1). A single-use code becomes one specific person's one-shot
-- invite; it cannot be a shared credential. Multi-use owner/GM codes remain
-- forbidden at the DB layer (the takeover threat 0152 closed). The redemption
-- route (/api/auth/use-join-code) adds the second half of the invariant — an
-- anti-displacement guard that only honours an owner/GM code on an UNCLAIMED
-- hotel (still owned by the admin placeholder, onboarding not yet completed).
--
-- Idempotent. Safe to re-run. Permissive (relaxes a CHECK) so it is safe to
-- apply to prod ahead of the code merge: the live redemption code keeps
-- rejecting owner codes until the matching route change ships, so there is no
-- window where a privileged code is both mintable AND redeemable insecurely.

alter table public.hotel_join_codes
  drop constraint if exists hotel_join_codes_role_check_no_privileged;

alter table public.hotel_join_codes
  add constraint hotel_join_codes_role_check_no_privileged
  check (
    role is null
    or role in ('front_desk', 'housekeeping', 'maintenance')
    -- owner / general_manager are allowed ONLY as a single-use invite.
    -- Multi-use privileged codes remain forbidden (shared-code takeover).
    or (role in ('owner', 'general_manager') and max_uses = 1)
  );

-- ── Close the RLS escalation the relaxed CHECK would otherwise open ──────────
-- hotel_join_codes_manage_for_own_hotels (0067, MFA-tightened in 0161) lets
-- ANY authenticated user with the hotel in property_access — including a GM or
-- even a housekeeper invited during onboarding — INSERT/UPDATE rows for that
-- hotel via the browser client. Until now the CHECK above blocked owner/GM
-- rows, so the worst such a client could write was a null/staff code. With
-- owner/GM single-use rows now permitted by the CHECK, that same client could
-- mint role='owner' for an UNCLAIMED hotel and redeem it to self-promote to
-- owner (owner_id is still the admin placeholder, so the redeem guard passes).
--
-- Fix: restrict BOTH the read (USING) and write (WITH CHECK) sides so
-- authenticated clients can only see/manage non-privileged (null / staff-role)
-- codes. Owner/GM rows become invisible AND unwritable to the authenticated
-- (browser) client — they are handled exclusively by the admin API via the
-- service-role client (bypasses RLS, requireAdmin-gated).
--
-- Why USING matters too: the single-use owner code is a SECRET one-time
-- invite. With the old USING, any property_access holder (a GM or staff member
-- invited before the owner redeemed) could `select * from hotel_join_codes`
-- for their hotel, READ the owner's code value, and redeem it to take over the
-- still-unclaimed hotel. Hiding privileged rows from the read path closes that.
--
-- No app flow reads or writes this table through an authenticated (non-service-
-- role) client today — every /api/auth/* and admin route uses supabaseAdmin —
-- so this only narrows the unused defense-in-depth allowance for null/staff
-- codes and breaks nothing.
alter policy hotel_join_codes_manage_for_own_hotels
  on public.hotel_join_codes
  using (
    public.user_owns_property(hotel_id)
    and public.mfa_verified_or_grace()
    and (role is null or role in ('front_desk', 'housekeeping', 'maintenance'))
  )
  with check (
    public.user_owns_property(hotel_id)
    and public.mfa_verified_or_grace()
    and (role is null or role in ('front_desk', 'housekeeping', 'maintenance'))
  );

-- Bookkeeping
insert into public.applied_migrations (version, description)
values (
  '0273',
  'M1.5 reconcile: allow single-use owner/GM hotel_join_codes (multi-use still forbidden); anti-displacement guard lives in /api/auth/use-join-code'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
