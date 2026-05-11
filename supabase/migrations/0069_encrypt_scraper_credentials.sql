-- 0069_encrypt_scraper_credentials.sql
-- Encrypt the PMS login credentials in scraper_credentials at rest.
--
-- BEFORE: ca_username + ca_password stored in plaintext. Migration
-- 0018's own comment flagged this: "Rotate to pgcrypto with a
-- server-side master key when we have >2 properties." That time is now
-- (we're wiring multi-tenant scraper in Phase 1.1 next).
--
-- AFTER:
--   * vault.secrets has a 'pms_credentials_key' entry — 32 bytes of
--     gen_random_bytes, base64-encoded. The actual key never leaves
--     Postgres; only the encrypted form sits at rest.
--   * Two SQL helpers, encrypt_pms_credential() and decrypt_pms_credential(),
--     pull the key from vault.decrypted_secrets and apply pgp_sym_encrypt /
--     pgp_sym_decrypt (AES-256 via extensions.pgcrypto). Both are
--     SECURITY DEFINER and EXECUTE grant is restricted to service_role.
--   * scraper_credentials gets two new columns ca_username_encrypted text
--     and ca_password_encrypted text; the plaintext columns are dropped.
--   * scraper_credentials_decrypted view auto-decrypts on read. Grant
--     SELECT only to service_role. Anon/authenticated have no access.
--
-- Callers — scraper/properties-loader.js — read from
-- scraper_credentials_decrypted as if the columns were still plaintext.
-- Writers must call encrypt_pms_credential() explicitly when inserting
-- or updating credentials.

-- ─── 1. Master key in Vault ───────────────────────────────────────────
do $$
declare
  exists_already boolean;
begin
  select exists(select 1 from vault.secrets where name='pms_credentials_key')
  into exists_already;
  if not exists_already then
    perform vault.create_secret(
      encode(gen_random_bytes(32), 'base64'),
      'pms_credentials_key',
      'AES-256 master key for scraper_credentials encryption (migration 0069)'
    );
  end if;
end $$;

-- ─── 2. Encrypt / decrypt helper functions ────────────────────────────
create or replace function public.encrypt_pms_credential(plaintext text)
returns text
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  master_key text;
begin
  if plaintext is null then return null; end if;

  select decrypted_secret into master_key
  from vault.decrypted_secrets
  where name = 'pms_credentials_key'
  limit 1;

  if master_key is null then
    raise exception 'pms_credentials_key not found in vault';
  end if;

  return encode(
    extensions.pgp_sym_encrypt(plaintext, master_key, 'cipher-algo=aes256, compress-algo=2'),
    'base64'
  );
end;
$$;

create or replace function public.decrypt_pms_credential(ciphertext text)
returns text
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  master_key text;
begin
  if ciphertext is null then return null; end if;

  select decrypted_secret into master_key
  from vault.decrypted_secrets
  where name = 'pms_credentials_key'
  limit 1;

  if master_key is null then
    raise exception 'pms_credentials_key not found in vault';
  end if;

  return extensions.pgp_sym_decrypt(decode(ciphertext, 'base64'), master_key);
end;
$$;

revoke all on function public.encrypt_pms_credential(text) from public, anon, authenticated;
revoke all on function public.decrypt_pms_credential(text) from public, anon, authenticated;
grant execute on function public.encrypt_pms_credential(text) to service_role;
grant execute on function public.decrypt_pms_credential(text) to service_role;

-- ─── 3. Encrypted columns on scraper_credentials + backfill + drop plaintext
alter table public.scraper_credentials
  add column if not exists ca_username_encrypted text;
alter table public.scraper_credentials
  add column if not exists ca_password_encrypted text;

update public.scraper_credentials
set ca_username_encrypted = encrypt_pms_credential(ca_username),
    ca_password_encrypted = encrypt_pms_credential(ca_password)
where (ca_username_encrypted is null and ca_username is not null)
   or (ca_password_encrypted is null and ca_password is not null);

-- Verify backfill: any row with plaintext but no ciphertext blocks the drop.
do $$
declare
  bad_count int;
begin
  select count(*) into bad_count
  from public.scraper_credentials
  where (ca_username is not null and ca_username_encrypted is null)
     or (ca_password is not null and ca_password_encrypted is null);

  if bad_count > 0 then
    raise exception 'encryption backfill incomplete: % rows have plaintext but no ciphertext', bad_count;
  end if;
end $$;

alter table public.scraper_credentials drop column if exists ca_username;
alter table public.scraper_credentials drop column if exists ca_password;

-- ─── 4. Auto-decrypting view (read-only, service-role only) ──────────
create or replace view public.scraper_credentials_decrypted with (security_invoker=on) as
select
  property_id,
  pms_type,
  ca_login_url,
  decrypt_pms_credential(ca_username_encrypted) as ca_username,
  decrypt_pms_credential(ca_password_encrypted) as ca_password,
  is_active,
  scraper_instance,
  notes,
  created_at,
  updated_at
from public.scraper_credentials;

comment on view public.scraper_credentials_decrypted is
  'Auto-decrypts ca_username and ca_password on read. Only service_role has SELECT — anon and authenticated have no access (defense in depth on top of the underlying scraper_credentials_deny_browser RLS policy). Write path: insert/update scraper_credentials directly using encrypt_pms_credential(...) on the values.';

revoke all on public.scraper_credentials_decrypted from anon, authenticated, public;
grant select on public.scraper_credentials_decrypted to service_role;

-- ─── 5. Bookkeeping ──────────────────────────────────────────────────
insert into public.applied_migrations (version, description)
values ('0069', 'encrypt scraper_credentials ca_username/ca_password via Vault + pgcrypto; add scraper_credentials_decrypted view')
on conflict (version) do nothing;
