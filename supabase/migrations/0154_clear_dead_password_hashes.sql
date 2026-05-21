-- 0154 — Clear leftover bcrypt password_hash values from the pre-Supabase-Auth era.
--
-- Background (Batch E / F-NEW from the security plan + CLAUDE.md note):
--   accounts.password_hash was the authentication source of truth in the
--   Firestore-era custom-auth flow. Migration 0002 (auth-bridge) dropped
--   the NOT NULL constraint when Supabase Auth took over as the real
--   authenticator. New accounts (accept-invite + use-join-code routes)
--   insert NULL since 0002.
--
--   But the rows that existed before 0002 still carry their old bcrypt
--   hashes. Today nothing in src/ reads the column, so those hashes are
--   dead-weight — but they're real bcrypt(cost=10) hashes sitting in the
--   DB. If the accounts table ever leaks (intentional export, breach,
--   support engineer's pg_dump), those hashes are offline-crackable. No
--   security harm without a breach, but defense-in-depth says "don't
--   keep credentials you don't need."
--
-- What this does:
--   • UPDATE accounts SET password_hash = NULL WHERE password_hash IS NOT NULL
--   • Leave the column in place (nullable). Dropping the column would be
--     a breaking schema change for any out-of-tree code paths we haven't
--     audited (older seed scripts, ad-hoc admin queries); making every
--     value NULL achieves the same security goal with zero schema risk.
--
-- Idempotent. Safe to re-run (UPDATE 0 on the second run).

update public.accounts
   set password_hash = null
 where password_hash is not null;

-- Document the column as deprecated. Anyone who runs `\d accounts` in
-- psql will see the comment and know not to write here.
comment on column public.accounts.password_hash is
  'DEPRECATED — Firestore-era custom-auth artifact. Supabase Auth is the real authenticator (migration 0002). Cleared in 0154; new rows leave it NULL. Column kept for back-compat; can be dropped in a future migration once we''re certain no out-of-tree code reads it.';

-- Bookkeeping
insert into public.applied_migrations (version, description)
values (
  '0154',
  'Batch E: clear leftover bcrypt password_hash values from the pre-Supabase-Auth era; document column as deprecated'
)
on conflict (version) do nothing;
