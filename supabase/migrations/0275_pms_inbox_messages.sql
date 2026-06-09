-- ═══════════════════════════════════════════════════════════════════════════
-- 0275 — PMS inbox: full-message capture + apex address move
--
-- Extends the Okta inbox (0274) two ways:
--   1. pms_inbox_messages — stores the FULL inbound email (subject, from, body,
--      links) so the onboarding admin can click the Okta account-SETUP link
--      ("set your password" / enroll MFA) directly in /admin/pms-inbox. The
--      0274 pms_auth_codes path (6-digit codes for the robot) is unchanged.
--   2. Moves the inbox address scheme from the rejected `pms.getstaxis.com`
--      subdomain to the apex `<propertycode>@getstaxis.com` (Choice's Okta user
--      form rejects subdomained emails). Data fix rewrites existing addresses.
--
-- Pipeline: Okta email → Cloudflare Email Routing (apex catch-all) → Email
-- Worker → POST /api/pms-inbox/inbound (verifies DKIM/DMARC + shared secret) →
-- pms_inbox_messages (full message) AND, when a code is present, pms_auth_codes.
--
-- SECURITY: setup links + email bodies are sensitive. Service-role only,
-- deny-all to anon/authenticated (mirrors pms_auth_codes 0274 / the pms_*
-- tables). They never reach the browser — the admin viewer reads them through
-- an admin-gated API route that strips raw HTML to validated http(s) links.
-- ═══════════════════════════════════════════════════════════════════════════

-- @rls: service-role-only — full PMS inbox emails (setup links + code mails); webhook writes, admin reads; never user-readable
create table if not exists public.pms_inbox_messages (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references public.properties(id) on delete cascade,
  -- The inbox address the message was delivered to (e.g. txa32@getstaxis.com).
  email_to     text not null,
  -- Header From (display name or bare address). Cosmetic; the verified verdict
  -- gates storage in the webhook before we ever reach an insert.
  from_addr    text,
  subject      text,
  -- Plain-text body. body_html is retained for audit but NEVER rendered as HTML
  -- — the admin API extracts validated http(s) links from it server-side.
  body_text    text,
  body_html    text,
  received_at  timestamptz not null default now(),
  -- Provider Message-Id. UNIQUE (partial, below) so a replayed/duplicate
  -- delivery of the same message can't insert twice.
  message_id   text,
  created_at   timestamptz not null default now()
);

-- Per-hotel newest-first listing (the admin viewer's hot path).
create index if not exists pms_inbox_messages_property_recv_idx
  on public.pms_inbox_messages (property_id, received_at desc);

-- Dedup / replay guard: the same provider message can only ever store once.
-- Partial (where message_id is not null) so rows without a message-id are allowed.
create unique index if not exists pms_inbox_messages_message_id_uidx
  on public.pms_inbox_messages (message_id)
  where message_id is not null;

-- ── RLS: service-role only (mirrors pms_auth_codes 0274) ───────────────────
alter table public.pms_inbox_messages enable row level security;
revoke all on public.pms_inbox_messages from public, anon, authenticated;
grant select, insert, update, delete on public.pms_inbox_messages to service_role;

drop policy if exists pms_inbox_messages_deny_all_browser on public.pms_inbox_messages;
create policy pms_inbox_messages_deny_all_browser on public.pms_inbox_messages
  for all
  to anon, authenticated
  using (false)
  with check (false);

comment on table public.pms_inbox_messages is
  'Full inbound PMS-inbox emails (Okta account-setup links + 2FA code mails) for the admin viewer. Service-role only; webhook (/api/pms-inbox/inbound) writes, admin API reads. Created 0275.';
comment on policy pms_inbox_messages_deny_all_browser on public.pms_inbox_messages is
  'Service-role only. Inbound email bodies / setup links must never be browser/anon-readable. Created 0275.';

-- ── Data fix: move existing inbox addresses to the apex ────────────────────
-- The robot's Okta user email moved from `<code>@pms.getstaxis.com` (rejected by
-- Choice's form) to the apex `<code>@getstaxis.com`. Rewrite any stored address
-- so the webhook's recipient → property lookup keeps resolving. lower() because
-- the webhook normalizes the recipient to lowercase before the equality lookup,
-- so the stored value must be lowercase to match. The 0274 unique-lower index on
-- pms_login_email still holds (apex values stay unique).
update public.scraper_credentials
   set pms_login_email = lower(regexp_replace(pms_login_email, '@pms\.getstaxis\.com$', '@getstaxis.com'))
 where pms_login_email like '%@pms.getstaxis.com';

-- Back the webhook's `pms_login_email = <lowercased recipient>` lookup with a
-- plain btree. The 0274 index is on lower(pms_login_email) (an expression index
-- a raw-column equality can't use); without this the lookup seq-scans every
-- inbound email. Stored values are lowercase (data fix above), so a raw equality
-- on the normalized recipient is both correct and index-backed.
create index if not exists scraper_credentials_pms_login_email_idx
  on public.scraper_credentials (pms_login_email);

-- PostgREST caches the schema; force a reload so the new table is queryable.
notify pgrst, 'reload schema';

insert into public.applied_migrations (version, description)
values ('0275', 'PMS inbox: pms_inbox_messages (full emails) + apex pms_login_email data fix')
on conflict (version) do nothing;
