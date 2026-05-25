-- ═══════════════════════════════════════════════════════════════════════════
-- 0215 — Daily/weekly housekeeping reports + self-serve role management
--
-- Adds the persistence layer for feature #17:
--
--   1. report_runs           — audit trail of every report generated + the
--                              delivery outcome per recipient. Doubles as
--                              the idempotency key (only one row per
--                              property + report_type + report_date).
--
--   2. report_preferences    — per-user delivery preferences (time-of-day,
--                              channels, CC list, vacation pause, weekly
--                              opt-in).
--
--   3. role_changes          — purpose-built audit log of every role change
--                              that runs through the team-management UI.
--                              We already write a generic admin_audit_log
--                              row for these via writeAudit(), but the
--                              structured columns here make it cheap to
--                              build a "show me the history of role X for
--                              person Y" UI later without parsing jsonb.
--
--   4. accounts.active       — boolean flag for self-serve deactivate.
--                              The recipient query for reports and any
--                              future "who can sign in" check filters on
--                              this. property_access is preserved on
--                              deactivate so reactivating restores their
--                              previous hotel scope.
--
--   5. accounts.last_sign_in_at — informational; populated by the login
--                              route on each successful sign-in. The
--                              Settings → Users page shows it so an owner
--                              can spot dormant accounts.
--
-- @rls: service-role-only — all three new tables are read/written exclusively
-- through /api routes that use supabaseAdmin. Adding `-- @rls: service-role-only`
-- as the table comment + REVOKE + explicit deny policies for anon/authenticated
-- so the RLS coverage audit passes without adding allowlist entries.
--
-- Manual prod apply: per project_migration_application_manual.md.
-- Idempotent: create table if not exists + add column if not exists.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. report_runs ─────────────────────────────────────────────────────────
-- @rls: service-role-only — written by cron routes, read by an admin UI
-- (not yet built) that lets Reeyen browse "what got emailed when". Never
-- read from the browser.
create table if not exists public.report_runs (
  id                  uuid primary key default gen_random_uuid(),
  property_id         uuid not null references public.properties(id) on delete cascade,

  -- 'daily' covers a single business date. 'weekly' covers a Mon–Sun
  -- window ending on report_date.
  report_type         text not null check (report_type in ('daily', 'weekly')),

  -- Property-local business date the report covers (the date the cron
  -- decided to fire for, NOT the UTC date of the cron run).
  report_date         date not null,

  generated_at        timestamptz not null default now(),

  -- Snapshot of who was supposed to get this report at the moment we
  -- queued the sends. Shape: [{ accountId, email, role, channel: 'email'|'sms'|'both' }, ...].
  -- Storing this rather than re-deriving means the report_runs row is a
  -- complete record even if someone is later removed from the team.
  recipients          jsonb not null default '[]'::jsonb,

  -- Per-recipient send outcome. Shape:
  --   [{ email, channel, status: 'sent'|'failed'|'rate_limited'|'skipped',
  --      resendId?, error?, attempts, last_attempt_at }, ...]
  email_send_status   jsonb not null default '[]'::jsonb,

  -- Full computed report payload. Big-ish (~5-20kB per row) but keeping
  -- it makes "re-render this report in the browser" trivial without
  -- re-querying the source tables (which may have moved on).
  report_payload      jsonb,

  -- Weekly only: the Claude-generated 1-paragraph summary. Null for daily.
  insight_text        text,

  -- Bookkeeping
  created_at          timestamptz not null default now(),

  -- One row per (property, type, date). Doubles as the idempotency
  -- guard: the cron INSERTs first and aborts on conflict, so a retried
  -- cron tick can't double-send.
  constraint report_runs_unique unique (property_id, report_type, report_date)
);

comment on table public.report_runs is
  'Audit trail of every daily/weekly report generated, with per-recipient delivery outcome. Service-role only — read/written by /api/cron/run-*-report. Created 0215.';

create index if not exists report_runs_property_date_idx
  on public.report_runs (property_id, report_date desc, report_type);

alter table public.report_runs enable row level security;
revoke all on public.report_runs from public, anon, authenticated;
grant select, insert, update, delete on public.report_runs to service_role;
drop policy if exists report_runs_deny_browser on public.report_runs;
create policy report_runs_deny_browser on public.report_runs
  for all to anon, authenticated using (false) with check (false);


-- ── 2. report_preferences ──────────────────────────────────────────────────
-- @rls: service-role-only — read/written by /api/settings/notifications/*.
-- Browser writes go through the API + requireSession; no direct supabase
-- client access.
create table if not exists public.report_preferences (
  id                  uuid primary key default gen_random_uuid(),
  account_id          uuid not null references public.accounts(id) on delete cascade,
  property_id         uuid not null references public.properties(id) on delete cascade,

  -- 24-hour "HH:MM" in property-local time. The cron decides whether to
  -- fire based on each property's timezone. Default 20:00 = 8pm local.
  delivery_time_local text not null default '20:00'
                      check (delivery_time_local ~ '^[0-2][0-9]:[0-5][0-9]$'),

  -- Which channels to use. Shape: { email: bool, sms: bool }.
  -- Default email-only; SMS link goes through the existing Twilio path.
  channels            jsonb not null default '{"email": true, "sms": false}'::jsonb,

  -- Extra recipients beyond the GM themselves. Array of email strings.
  -- Lower-cased + de-duped before insert.
  cc_emails           jsonb not null default '[]'::jsonb,

  -- When non-null + in the future, no sends fire. Vacation pause.
  paused_until        timestamptz,

  -- Weekly digest opt-in/out (defaults to on; users who don't want
  -- Sundays can toggle off).
  weekly_enabled      boolean not null default true,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- One row per (account, property). Account-property pair is unique.
  constraint report_preferences_unique unique (account_id, property_id)
);

comment on table public.report_preferences is
  'Per-user, per-property preferences for daily/weekly housekeeping reports. Service-role only — read/written by /api/settings/notifications/*. Created 0215.';

create index if not exists report_preferences_property_idx
  on public.report_preferences (property_id);

alter table public.report_preferences enable row level security;
revoke all on public.report_preferences from public, anon, authenticated;
grant select, insert, update, delete on public.report_preferences to service_role;
drop policy if exists report_preferences_deny_browser on public.report_preferences;
create policy report_preferences_deny_browser on public.report_preferences
  for all to anon, authenticated using (false) with check (false);


-- ── 3. role_changes ───────────────────────────────────────────────────────
-- @rls: service-role-only — written by /api/auth/team (PUT) and the new
-- /api/settings/users routes. Surfaced in a future audit-history UI via
-- another /api route; never read from the browser directly.
create table if not exists public.role_changes (
  id                       uuid primary key default gen_random_uuid(),
  account_id               uuid not null references public.accounts(id) on delete cascade,
  property_id              uuid not null references public.properties(id) on delete cascade,

  -- Who made the change. The account ID of the manager/owner who clicked
  -- the role dropdown. Nullable because future system-driven changes
  -- (transfer-ownership cron, etc.) might not have an actor.
  changed_by_account_id    uuid references public.accounts(id) on delete set null,

  -- old_role nullable because the first row for a brand-new account
  -- doesn't have a prior role to record. new_role is always set.
  old_role                 text,
  new_role                 text not null,

  -- 'role_change' (default), 'deactivate', 'reactivate', 'transfer_ownership'.
  -- Lets a future UI render different icons / colors per action type.
  change_kind              text not null default 'role_change'
                           check (change_kind in (
                             'role_change',
                             'deactivate',
                             'reactivate',
                             'transfer_ownership'
                           )),

  -- Optional free-text reason. Useful when an owner records "promoted
  -- after handover" or "former GM left". UI doesn't enforce it today.
  reason                   text,

  changed_at               timestamptz not null default now()
);

comment on table public.role_changes is
  'Structured audit log of role changes. Cheaper to query than admin_audit_log because the columns are typed. Service-role only — written by /api/auth/team + /api/settings/users. Created 0215.';

create index if not exists role_changes_account_idx
  on public.role_changes (account_id, changed_at desc);
create index if not exists role_changes_property_idx
  on public.role_changes (property_id, changed_at desc);

alter table public.role_changes enable row level security;
revoke all on public.role_changes from public, anon, authenticated;
grant select, insert, update, delete on public.role_changes to service_role;
drop policy if exists role_changes_deny_browser on public.role_changes;
create policy role_changes_deny_browser on public.role_changes
  for all to anon, authenticated using (false) with check (false);


-- ── 4. accounts.active + accounts.last_sign_in_at ─────────────────────────
-- `active` defaults to true (every existing row stays signable-in). The
-- recipient query for reports — and any future "can this account sign in"
-- check — filters on `active = true`. Deactivation preserves
-- property_access so reactivation restores the old scope without rebuild.
--
-- `last_sign_in_at` is informational; populated by the login route on
-- success. Surfaced in Settings → Users so an owner can spot dormant
-- accounts. Reads are best-effort — a missed write doesn't break login.
alter table public.accounts
  add column if not exists active             boolean      not null default true,
  add column if not exists last_sign_in_at    timestamptz;

comment on column public.accounts.active is
  'When false, the account is deactivated: blocked from sign-in (enforced by the login route) and excluded from report-recipient queries. property_access preserved so reactivation restores prior hotel scope. Added 0215.';
comment on column public.accounts.last_sign_in_at is
  'Set by the login route on each successful sign-in. Best-effort — a missed write does not block login. Surfaced in Settings → Users to flag dormant accounts. Added 0215.';

create index if not exists accounts_active_idx on public.accounts (active);
