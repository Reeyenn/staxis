-- ═══════════════════════════════════════════════════════════════════════════
-- 0342 — Append-table dedup + the report-address security model.
--
-- Two independent halves, deliberately in ONE migration because neither has a
-- DNS dependency and both are needed before the first real report lands:
--
--   A. APPEND DEDUP. pms_room_status_log and pms_activity_log have only a PK
--      today — nothing stops a re-forwarded email (or a replay) from doubling
--      the event log. Their descriptor natural keys get real unique indexes,
--      and generic-table-writer switches from insert() to
--      upsert(..., ignoreDuplicates: true) on the back of them.
--
--   B. REPORT ADDRESS. Today the per-hotel inbox address is the PMS property
--      code (txa32@getstaxis.com) — guessable, so anyone could mail a
--      fabricated occupancy report at it. Reports get their own unguessable
--      capability-token address whose PLAINTEXT is never stored: only a
--      sha256 (the O(1) inbound lookup) and a vault-encrypted copy for
--      re-display during onboarding.
--
-- DELIBERATELY NOT HERE
--   * Address ROTATION (prev-local + dual-accept window + rotate RPC).
--     Rotating a report address means the hotel must reconfigure their PMS
--     scheduler anyway, so the overlap window buys little. Add it when a
--     rotation actually happens.
--   * A CHECK pinning report mail to a specific inbox domain. Cloudflare
--     Email Routing on a SUBDOMAIN is not confirmed available on the current
--     zone/plan, so hard-coding 'in.getstaxis.com' into a constraint could
--     make the first real report insert fail. The route enforces the
--     report/auth-code split at runtime (recipient domain, or an unambiguous
--     local-part prefix on the apex) and this migration only enforces the
--     shape-independent half.
--
-- APPLY ORDER: after 0341 (report_file_id references pms_report_files).
-- Idempotent; safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══ Part A — append-table natural-key dedup ═══════════════════════════════
-- Preflight in the 0207 Part C style: refuse to create the index over existing
-- duplicates rather than failing halfway with an opaque 23505.

do $$
declare
  dupes bigint;
begin
  select count(*) into dupes from (
    select 1 from public.pms_room_status_log
     group by property_id, room_number, changed_at
    having count(*) > 1
  ) d;
  if dupes > 0 then
    raise exception
      '0342: pms_room_status_log has % duplicate (property_id, room_number, changed_at) group(s). Resolve before applying — the unique index cannot be created over them.', dupes;
  end if;

  select count(*) into dupes from (
    select 1 from public.pms_activity_log
     group by property_id, captured_at, pms_user, action
    having count(*) > 1
  ) d;
  if dupes > 0 then
    raise exception
      '0342: pms_activity_log has % duplicate (property_id, captured_at, pms_user, action) group(s). Resolve before applying.', dupes;
  end if;
end $$;

create unique index if not exists pms_room_status_log_natural_uidx
  on public.pms_room_status_log (property_id, room_number, changed_at);

-- pms_user / action are nullable, and Postgres treats NULLs as distinct by
-- default — which would let an unlimited number of (pid, ts, NULL, NULL) rows
-- through and defeat the whole point. NULLS NOT DISTINCT (PG15+; prod is 17)
-- makes them collide like any other value.
create unique index if not exists pms_activity_log_natural_uidx
  on public.pms_activity_log (property_id, captured_at, pms_user, action)
  nulls not distinct;

comment on index public.pms_room_status_log_natural_uidx is
  'Re-delivery / replay of the same report can never append a duplicate event row. Backs generic-table-writer''s writeAppend upsert(ignoreDuplicates). Created 0342.';
comment on index public.pms_activity_log_natural_uidx is
  'Same as pms_room_status_log_natural_uidx. NULLS NOT DISTINCT because pms_user/action are nullable. Created 0342.';

-- ═══ Part B — report inbox address + sender pinning ════════════════════════

alter table public.scraper_credentials
  -- sha256 of the LOWERCASED local part. The inbound lookup key; the plaintext
  -- is never stored in the clear, so a DB read does not hand over the address.
  add column if not exists report_inbox_hash            text,
  -- Vault/pgcrypto ciphertext, same mechanism as ca_username_encrypted (0069).
  -- Only so onboarding can re-display the address to the GM.
  add column if not exists report_inbox_local_encrypted text,
  -- Trust-on-first-use sender pinning: the VERIFIED DKIM signing domains this
  -- hotel has approved. Empty = nothing parses; the first delivery surfaces an
  -- "approve this sender" decision instead of trusting a stranger.
  add column if not exists report_sender_domains        text[] not null default '{}'::text[],
  -- Raw-byte retention POLICY. NULL = keep forever (the default until the
  -- founder decides). Set to N to purge raw objects older than N days; the
  -- receipt row always survives.
  add column if not exists report_raw_retention_days    integer;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'scraper_credentials_retention_positive') then
    alter table public.scraper_credentials
      add constraint scraper_credentials_retention_positive
      check (report_raw_retention_days is null or report_raw_retention_days > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'scraper_credentials_report_hash_shape') then
    alter table public.scraper_credentials
      add constraint scraper_credentials_report_hash_shape
      check (report_inbox_hash is null or report_inbox_hash ~ '^[0-9a-f]{64}$');
  end if;
end $$;

-- One hotel per address, fleet-wide. Partial so un-configured hotels coexist.
create unique index if not exists scraper_credentials_report_inbox_hash_uidx
  on public.scraper_credentials (report_inbox_hash)
  where report_inbox_hash is not null;

comment on column public.scraper_credentials.report_inbox_hash is
  'sha256(lowercased local part) of this hotel''s report-inbox address. The O(1) inbound lookup key; plaintext is never stored in the clear. Created 0342.';
comment on column public.scraper_credentials.report_sender_domains is
  'Trust-on-first-use allowlist of VERIFIED DKIM signing domains for report mail. A file from an unlisted domain is stored but never parsed (pms_report_files CHECK). Created 0342.';
comment on column public.scraper_credentials.report_raw_retention_days is
  'Raw-byte retention policy. NULL = keep forever (default; the founder has not decided). The receipt row is never deleted either way. Created 0342.';

-- Plaintext → hash + ciphertext happens INSIDE Postgres so the address never
-- passes through Node in a form that could reach a log. Sibling of
-- staxis_upsert_scraper_credentials (0140).
create or replace function public.staxis_set_report_inbox(
  p_property_id uuid,
  p_local       text
) returns text
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, vault
as $$
declare
  v_local text;
  v_hash  text;
begin
  v_local := lower(btrim(coalesce(p_local, '')));
  -- Capability token: long enough that guessing is hopeless, and restricted to
  -- characters every mail system handles identically.
  if v_local !~ '^[a-z0-9][a-z0-9._-]{19,63}$' then
    raise exception 'report inbox local part must be 20-64 chars of [a-z0-9._-] and start alphanumeric'
      using errcode = 'invalid_parameter_value';
  end if;

  v_hash := encode(extensions.digest(v_local, 'sha256'), 'hex');

  update public.scraper_credentials
     set report_inbox_hash            = v_hash,
         report_inbox_local_encrypted = public.encrypt_pms_credential(v_local)
   where property_id = p_property_id;

  if not found then
    raise exception 'no scraper_credentials row for property %', p_property_id
      using errcode = 'no_data_found';
  end if;

  return v_hash;
end;
$$;

revoke all on function public.staxis_set_report_inbox(uuid, text) from public, anon, authenticated;
grant execute on function public.staxis_set_report_inbox(uuid, text) to service_role;

comment on function public.staxis_set_report_inbox(uuid, text) is
  'Set a hotel''s report-inbox address: stores sha256(local) + vault ciphertext, never plaintext. SECURITY DEFINER, service_role only. Created 0342.';

-- ═══ Part C — message-class split on pms_inbox_messages ════════════════════
-- Report mail and PMS 2FA mail must never be confused for one another. The
-- route derives `kind` from the RECIPIENT, never from content.

alter table public.pms_inbox_messages
  add column if not exists kind           text not null default 'auth_code',
  -- The domain the message was delivered to. Recorded (not constrained to a
  -- literal) because the report-routing shape is not confirmed yet.
  add column if not exists inbox_domain   text,
  add column if not exists report_file_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pms_inbox_messages_kind_check') then
    alter table public.pms_inbox_messages
      add constraint pms_inbox_messages_kind_check check (kind in ('auth_code', 'report'));
  end if;

  -- A report with no Message-Id cannot be deduped, so it is refused outright.
  if not exists (select 1 from pg_constraint where conname = 'pms_inbox_messages_report_needs_message_id') then
    alter table public.pms_inbox_messages
      add constraint pms_inbox_messages_report_needs_message_id
      check (kind <> 'report' or message_id is not null);
  end if;

  -- A report must record which address it arrived on, so the report/auth-code
  -- split is auditable after the fact even though the literal domain is not
  -- pinned here.
  if not exists (select 1 from pg_constraint where conname = 'pms_inbox_messages_report_needs_domain') then
    alter table public.pms_inbox_messages
      add constraint pms_inbox_messages_report_needs_domain
      check (kind <> 'report' or inbox_domain is not null);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'pms_inbox_messages_report_file_fk') then
    alter table public.pms_inbox_messages
      add constraint pms_inbox_messages_report_file_fk
      foreign key (report_file_id) references public.pms_report_files(id) on delete set null;
  end if;
end $$;

-- Staleness detection reads THIS table, not pms_report_files: content dedup
-- means a quiet hotel mailing byte-identical reports for hours produces no new
-- file rows, and a files-based check would false-alarm.
create index if not exists pms_inbox_messages_kind_recv_idx
  on public.pms_inbox_messages (property_id, kind, received_at desc);

comment on column public.pms_inbox_messages.kind is
  'Derived from the RECIPIENT address only, never from content. ''report'' = PMS report scheduler mail; ''auth_code'' = the Okta 2FA path (unchanged). Created 0342.';

-- ─── Bookkeeping + PostgREST schema reload ─────────────────────────────────
insert into public.applied_migrations (version, description)
values (
  '0342',
  'Append-table natural-key unique indexes (room_status_log, activity_log) + unguessable per-hotel report inbox address (sha256 lookup + vault ciphertext + TOFU sender domains + retention policy) + report/auth-code message-class split.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
