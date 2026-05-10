-- ═══════════════════════════════════════════════════════════════════════════
-- Phase-3 onboarding: customer-facing roles + invite/join-code tables.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Extend accounts.role to include the four new customer-facing roles.
--    Keep 'staff' as a legacy alias so the row that AuthContext defaults
--    to (when the role is null/unknown) continues to validate.
alter table accounts drop constraint if exists accounts_role_check;
alter table accounts add constraint accounts_role_check
  check (role in (
    'admin',           -- Staxis system admin (Reeyen)
    'owner',           -- hotel owner — sees everything for their hotel(s)
    'general_manager', -- day-to-day ops; same access as owner minus billing
    'front_desk',      -- check-ins, guest requests, room status
    'housekeeping',    -- cleans rooms (also covers breakfast/laundry attendants)
    'maintenance',     -- work orders, preventive tasks
    'staff'            -- legacy alias; new accounts use one of the above
  ));

-- 2. Account invites — email-based onboarding. Owner/GM/admin sends the
--    invitee a link `/invite/<token>` that lets them set a password and
--    activate their account on a specific hotel.
--    token_hash = sha256(token); the raw token only lives in the email.
create table if not exists account_invites (
  id            uuid primary key default gen_random_uuid(),
  hotel_id      uuid not null references properties(id) on delete cascade,
  email         text not null,
  role          text not null check (role in ('owner','general_manager','front_desk','housekeeping','maintenance')),
  token_hash    text not null unique,
  expires_at    timestamptz not null,
  invited_by    uuid not null references accounts(id) on delete cascade,
  created_at    timestamptz not null default now(),
  accepted_at   timestamptz,
  accepted_by   uuid references accounts(id) on delete set null
);
create index if not exists account_invites_hotel_idx on account_invites(hotel_id);
create index if not exists account_invites_email_idx on account_invites(lower(email));
create index if not exists account_invites_expires_idx on account_invites(expires_at);
alter table account_invites enable row level security;

-- 3. Hotel join codes — owner generates a 6-letter code, hands it out, staff
--    redeems it on /join with their email + name + password. Code is per
--    hotel + per role with optional max_uses + expiry.
create table if not exists hotel_join_codes (
  id            uuid primary key default gen_random_uuid(),
  hotel_id      uuid not null references properties(id) on delete cascade,
  code          text not null unique,
  role          text not null check (role in ('owner','general_manager','front_desk','housekeeping','maintenance')),
  expires_at    timestamptz not null,
  max_uses      integer not null default 1,
  used_count    integer not null default 0,
  created_by    uuid not null references accounts(id) on delete cascade,
  created_at    timestamptz not null default now(),
  revoked_at    timestamptz
);
create index if not exists hotel_join_codes_hotel_idx on hotel_join_codes(hotel_id);
create index if not exists hotel_join_codes_expires_idx on hotel_join_codes(expires_at);
alter table hotel_join_codes enable row level security;
