-- Demo/investor bypass flag.
-- When true, /api/auth/check-trust returns trusted=true regardless of device cookie,
-- so the account skips the post-password OTP step entirely.
-- Set manually for the shared demo account only — never expose in any UI.

alter table accounts
  add column if not exists skip_2fa boolean not null default false;

comment on column accounts.skip_2fa is
  'Demo/investor bypass. When true, /api/auth/check-trust returns trusted=true regardless of device cookie. Set manually for the shared demo account only — never expose in any UI.';

insert into applied_migrations (version, description)
values ('0124', 'accounts.skip_2fa flag for the shared demo/investor login (bypasses post-password OTP)')
on conflict (version) do nothing;
