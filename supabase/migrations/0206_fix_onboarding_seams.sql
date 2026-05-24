-- ═══════════════════════════════════════════════════════════════════════════
-- 0206 — Fix the onboarding seams broken by Plan v4 cutover.
--
-- Why this exists:
--   A senior-engineer review of the new-hotel onboarding flow found three
--   sharp gaps the v4 rebuild missed:
--
--   A. Saving PMS credentials doesn't create a property_sessions row.
--      The supervisor (cua-service/src/session-supervisor.ts) only spawns
--      drivers for properties with status IN ('starting','alive'). The
--      only code that inserts the row is the driver itself, on first
--      heartbeat — but the driver doesn't run unless the supervisor
--      spawns it. Net: hotels created post-v4 sit dead forever.
--
--      Fix: extend RPC staxis_upsert_scraper_credentials (the atomic
--      one called by /api/pms/save-credentials) to ALSO upsert a
--      property_sessions row in the same transaction.
--
--   B. Existing hotels (Comfort Suites Beaumont, the comfort_suites
--      investor demo) never had a property_sessions row written, so
--      they're invisible to the new v4 admin surfaces.
--
--      Fix: backfill — insert property_sessions rows for every property
--      with an active scraper_credentials row that's missing a session.
--
--   C. An unsupported PMS family (anything ≠ 'choice_advantage' today)
--      crashes the driver into 'failed_restart' with no admin-clear
--      "needs mapping" state. failed_restart is the dead-letter signal,
--      not the "waiting for human" signal — confusing the funnel UX.
--
--      Fix: add 'paused_no_knowledge_file' to the property_sessions
--      status CHECK constraint. session-driver gets updated to use it.
--
-- What this migration does NOT do:
--   - Drop the empty onboarding_jobs/pull_jobs stubs (15+ legacy
--     consumers still read them and get an empty array — harmless).
--     A future migration can drop them after those consumers are
--     audited.
--
-- Idempotent: create or replace function + insert on conflict do nothing
-- + drop constraint if exists. Safe to re-run.
--
-- Manual prod apply: per project_migration_application_manual.md.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Part A: extend the credentials RPC to bootstrap property_sessions ────
--
-- Same signature as 0140, atomic in the same transaction. Adds one
-- property_sessions UPSERT after the credentials write.
--
-- Conflict semantics on the session UPSERT:
--   - If the row doesn't exist: insert with status='starting'. Triggers
--     a driver spawn on next supervisor reconcile (~30s).
--   - If the row exists in 'failed_restart' or 'stopped': re-arm to
--     'starting' (admin saved new creds, give it another try).
--   - If the row exists in any other state (alive, paused_mfa,
--     paused_cost_cap, paused_circuit_breaker): LEAVE IT ALONE. We
--     don't want a creds re-save to bounce a live session out of its
--     paused state — the admin's resume flow owns that.

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
  -- session.userId === properties.owner_id). We only enforce existence
  -- so we don't write orphaned credentials.
  select exists(select 1 from public.properties where id = p_property_id)
  into v_prop_exists;
  if not v_prop_exists then
    raise exception 'property % not found', p_property_id
      using errcode = 'no_data_found';
  end if;

  -- Atomic upsert. Function-scoped transaction wraps all three writes;
  -- if any fails, none commits.
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

  -- Bootstrap the property_sessions row so the supervisor sees this
  -- hotel and spawns a driver on next reconcile. Only re-arm dead/stopped
  -- states; leave alive/paused alone (those have their own admin flows).
  --
  -- The `status in ('failed_restart', 'stopped')` predicate is repeated
  -- across four SET assignments below. This is structural — a PL/pgSQL
  -- local boolean computed before the upsert would introduce a TOCTOU
  -- between the SELECT and the INSERT...ON CONFLICT, and Postgres'
  -- ON CONFLICT SET clause has no syntax for a single computed-once
  -- predicate. Keeping it atomic is the priority; the repetition is the
  -- cost. Update all four together if the rule changes.
  insert into public.property_sessions
    (property_id, pms_family, status,
     restart_count, daily_claude_cost_micros, daily_claude_cost_resets_at)
  values
    (p_property_id, p_pms_type, 'starting',
     0, 0, now())
  on conflict (property_id) do update set
    pms_family    = excluded.pms_family,
    status        = case
                      when public.property_sessions.status in ('failed_restart', 'stopped')
                        then 'starting'
                      else public.property_sessions.status
                    end,
    restart_count = case
                      when public.property_sessions.status in ('failed_restart', 'stopped')
                        then 0
                      else public.property_sessions.restart_count
                    end,
    paused_reason = case
                      when public.property_sessions.status in ('failed_restart', 'stopped')
                        then null
                      else public.property_sessions.paused_reason
                    end,
    paused_until  = case
                      when public.property_sessions.status in ('failed_restart', 'stopped')
                        then null
                      else public.property_sessions.paused_until
                    end;
end;
$$;

comment on function public.staxis_upsert_scraper_credentials(uuid, text, text, text, text) is
  'Atomic upsert of PMS credentials (encrypted via vault) + properties.pms_type/pms_url + property_sessions bootstrap. Extended in 0206 to also bootstrap the CUA session row so saving creds actually starts the worker.';

-- Re-grant (idempotent). RPC body changed; permissions stay the same.
revoke all on function public.staxis_upsert_scraper_credentials(uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.staxis_upsert_scraper_credentials(uuid, text, text, text, text)
  to service_role;

-- ─── Part B: extend property_sessions.status CHECK ────────────────────────
--
-- Add 'paused_no_knowledge_file' — the v4 driver enters this state
-- when no active pms_knowledge_files row exists for its pms_family.
-- Distinct from 'failed_restart' (which is the dead-letter signal):
-- this is an admin-resolvable "we haven't taught the CUA this PMS yet"
-- state. Counts in the OnboardingTab "Needs help" surface so the admin
-- knows to run the mapper.

alter table public.property_sessions
  drop constraint if exists property_sessions_status_check;

alter table public.property_sessions
  add constraint property_sessions_status_check
  check (status in (
    'starting',
    'alive',
    'paused_cost_cap',
    'paused_mfa',
    'paused_no_knowledge_file',
    'paused_circuit_breaker',
    'failed_restart',
    'stopped'
  ));

-- ─── Part C: backfill property_sessions for existing properties ───────────
--
-- Every property with an active scraper_credentials row that's missing
-- a property_sessions row gets one in 'starting' state. The supervisor
-- picks them up on next reconcile and spawns drivers.
--
-- This brings Comfort Suites + the investor demo + anything else that
-- existed before today into the v4 admin surfaces. Without this they'd
-- be invisible.

insert into public.property_sessions (
  property_id, pms_family, status,
  restart_count, daily_claude_cost_micros, daily_claude_cost_resets_at
)
select
  sc.property_id,
  sc.pms_type,
  'starting',
  0,
  0,
  now()
from public.scraper_credentials sc
where sc.is_active = true
  and not exists (
    select 1
    from public.property_sessions ps
    where ps.property_id = sc.property_id
  );

-- ─── Track the migration ─────────────────────────────────────────────────
insert into public.applied_migrations (version, description)
values (
  '0206',
  'Fix onboarding seams: credentials RPC also upserts property_sessions; backfill sessions for existing hotels; add paused_no_knowledge_file status.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
