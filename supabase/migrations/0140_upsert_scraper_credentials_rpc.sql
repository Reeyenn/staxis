-- 0140_upsert_scraper_credentials_rpc.sql
-- Atomic upsert of PMS credentials + properties.pms_type/pms_url in a single
-- transaction.
--
-- WHY THIS EXISTS:
--   Migration 0069 dropped the plaintext ca_username/ca_password columns and
--   added their encrypted equivalents. The Next.js save-credentials route
--   (src/app/api/pms/save-credentials/route.ts) was never updated — it was
--   still writing to the dropped column names, so every "Test Connection"
--   click silently failed at the Postgres layer (column does not exist) and
--   `scraper_credentials` stayed at zero rows in prod. The route also did
--   two separate writes (scraper_credentials upsert, then properties update)
--   with no transaction, so even after fixing the encryption bug a partial
--   commit could leave the two stores inconsistent.
--
-- WHAT THIS DOES:
--   * `staxis_upsert_scraper_credentials(property_id, pms_type, login_url,
--      username, password)` — single atomic transaction that:
--      1. Upserts scraper_credentials with encrypt_pms_credential() applied
--         to username + password (ciphertext only at rest).
--      2. Updates properties.pms_type + properties.pms_url in the same txn.
--      3. Verifies the property exists; raises if not (callers do their own
--         ownership check before calling this function).
--   * SECURITY DEFINER so callers don't need direct access to vault.secrets.
--   * EXECUTE granted to service_role only — anon/authenticated cannot reach.

set local statement_timeout to '30s';

create or replace function public.staxis_upsert_scraper_credentials(
  p_property_id uuid,
  p_pms_type text,
  p_login_url text,
  p_username text,
  p_password text
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, vault
as $$
declare
  v_prop_exists boolean;
begin
  -- Caller is responsible for ownership check (the route does this via
  -- session.userId === properties.owner_id). We only enforce existence so
  -- we don't write orphaned credentials.
  select exists(select 1 from public.properties where id = p_property_id)
  into v_prop_exists;
  if not v_prop_exists then
    raise exception 'property % not found', p_property_id
      using errcode = 'no_data_found';
  end if;

  -- Atomic upsert. Function-scoped transaction wraps both writes; if either
  -- fails, neither commits.
  insert into public.scraper_credentials
    (property_id, pms_type, ca_login_url,
     ca_username_encrypted, ca_password_encrypted, is_active)
  values
    (p_property_id, p_pms_type, p_login_url,
     public.encrypt_pms_credential(p_username),
     public.encrypt_pms_credential(p_password),
     true)
  on conflict (property_id) do update set
    pms_type              = excluded.pms_type,
    ca_login_url          = excluded.ca_login_url,
    ca_username_encrypted = excluded.ca_username_encrypted,
    ca_password_encrypted = excluded.ca_password_encrypted,
    is_active             = true,
    updated_at            = now();

  update public.properties
  set pms_type = p_pms_type,
      pms_url  = p_login_url
  where id = p_property_id;
end;
$$;

revoke all on function public.staxis_upsert_scraper_credentials(uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.staxis_upsert_scraper_credentials(uuid, text, text, text, text)
  to service_role;

comment on function public.staxis_upsert_scraper_credentials(uuid, text, text, text, text) is
  'Atomic upsert of PMS credentials (encrypted at rest via vault + pgcrypto) AND properties.pms_type/pms_url. SECURITY DEFINER + service_role only. See migration 0140.';

-- ─── Bookkeeping ────────────────────────────────────────────────────
insert into public.applied_migrations (version, description)
values ('0140', 'staxis_upsert_scraper_credentials RPC: atomic credentials encrypt + properties stamp')
on conflict (version) do nothing;
