-- Defense-in-depth DB constraint for the skip_2fa privileged-account
-- refusal added to the auth/2FA audit on 2026-05-22.
--
-- Application layer already refuses to honor `accounts.skip_2fa=true`
-- when role='admin' or property_access contains '*' (see
-- src/app/api/auth/check-trust/route.ts and src/lib/api-auth.ts
-- validateDeviceTrust). This constraint backstops both checks at the
-- storage layer so a future code path that writes skip_2fa without
-- going through those gates physically cannot create the bad state.
--
-- Pre-flight: abort the migration if existing data already violates the
-- invariant. ALTER TABLE … ADD CONSTRAINT would fail with a confusing
-- check_violation; this DO block surfaces the actual count + a clear
-- remediation pointer. Per CLAUDE.md, migrations are applied to prod
-- manually, so the operator sees this RAISE and decides whether to
-- (a) fix the data and re-run, or (b) skip the migration entirely.
--
-- Note: property_access is uuid[] in the DB. The "all properties"
-- wildcard ('*' in app code) is a CLIENT-SIDE-ONLY convention — admins
-- are stored with an empty property_access array and the client maps
-- that to ['*']. So the privileged-account constraint reduces to
-- `role = 'admin'` at the storage layer.
do $$
declare
  bad_count int;
begin
  select count(*) into bad_count
  from public.accounts
  where skip_2fa = true
    and role = 'admin';

  if bad_count > 0 then
    raise exception
      'Migration 0156 aborted: % accounts row(s) have skip_2fa=true on an admin account. '
      'These rows would be locked OUT of OTP bypass anyway by check-trust/requireSession, but the CHECK '
      'constraint refuses to apply with them in place. Resolve before re-running: '
      'SELECT id, username, role FROM accounts WHERE skip_2fa = true AND role = ''admin''; '
      'Then either UPDATE accounts SET skip_2fa = false WHERE id IN (...), or change role to non-admin.',
      bad_count;
  end if;
end$$;

-- The constraint itself. role <> 'admin' is the storage-layer guarantee.
alter table public.accounts
  add constraint accounts_skip_2fa_not_privileged
  check (skip_2fa = false or role <> 'admin');

comment on constraint accounts_skip_2fa_not_privileged on public.accounts is
  'Audit 2026-05-22: defense in depth for skip_2fa. The DB will refuse to '
  'store skip_2fa=true on an admin role, even if a code path bypasses '
  'check-trust + requireSession. The application-layer refusals (which '
  'ALSO inspect client-side wildcard property_access semantics) are the '
  'primary gate; this constraint is the storage-layer backstop.';

-- Tell PostgREST to reload its schema cache so the new constraint is
-- visible to subsequent inserts/updates without a server restart.
notify pgrst, 'reload schema';

-- Self-register for the doctor's supabase_migrations_applied check.
insert into public.applied_migrations (version, description)
values (
  '0156',
  'Audit 2026-05-22: CHECK constraint accounts_skip_2fa_not_privileged backstops the app-layer refusal of skip_2fa=true on admin rows.'
)
on conflict (version) do nothing;
