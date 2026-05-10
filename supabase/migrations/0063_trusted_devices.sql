-- ═══════════════════════════════════════════════════════════════════════════
-- Trusted devices for the Phase-2 2FA flow.
--
-- After a successful password sign-in, if the device isn't already trusted,
-- the app sends a 6-digit OTP via email and only logs the user in after the
-- code is verified. If the user checks "Trust this device" on the verify
-- screen, an httpOnly cookie + this row are written. Subsequent sign-ins
-- from that device skip the OTP step until the row expires (30 days
-- by default).
--
-- Cookie carries a random opaque token; we store sha256(token) in token_hash.
-- A cookie alone does nothing without a matching, non-expired row.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists trusted_devices (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null references accounts(id) on delete cascade,
  token_hash      text not null,
  user_agent      text,
  ip              text,
  created_at      timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  expires_at      timestamptz not null
);

create index if not exists trusted_devices_account_idx on trusted_devices(account_id);
create index if not exists trusted_devices_expires_idx on trusted_devices(expires_at);
create unique index if not exists trusted_devices_account_token_uidx
  on trusted_devices(account_id, token_hash);

-- RLS-on with no policies — only service-role writes via API routes.
alter table trusted_devices enable row level security;
