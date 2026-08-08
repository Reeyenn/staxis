# Operational runbook

Append-only session log for **manual production changes** — anything that
doesn't pass through git history. Migrations applied by hand, env vars
touched in dashboards, secrets rotated, one-off SQL fixes, etc.

**Why this file exists:** Round 18 review surfaced that several
production changes today were invisible to anyone reading the repo:
3 migrations applied via `psql`, 11 rows deleted from
`inventory_rate_priors`, 1 Vercel env var added, 3 GitHub Actions
secrets created and later moved into a `production` environment.
Without a paper trail, the next on-call has no way to reconstruct
prod state.

**Rules:**

1. Add a date-stamped section every time you touch prod outside git.
2. List what changed, why, and how to revert.
3. Newest entries at the top. Don't edit old entries.
4. If the change is reversible via a checked-in script, link the script.
5. If the change is `gh`/`vercel`/`supabase`-CLI driven, paste the
   exact command (with secrets redacted).
6. Hooks/CI/process changes belong in code, not here. This log is for
   the irreversible-from-git ops.

## 2026-08-08 — Stop legacy Robot Hotel recurring to-dos

### Data cleanup

The old browser-walk sentence `Robot check: nightly walkthrough` was parsed as
a daily recurrence. It left six active templates at the Robot Hotel that could
spawn rows outside the corrected one-shot walk. We deactivated exactly these
six active templates (count 6), keeping the inactive `d7d61844-fd65-48df-9e3b-df6a1f77e91a`
template untouched:

```text
302b5469-35d6-46a2-a3bd-8ae4c90967c1
46f32de9-b5d2-430d-b239-18aa0afb8b5c
5b54102f-46cf-4f28-b035-e39bc65ed101
762e6636-a284-494b-8117-58d24e4031d4
e20bac3f-7421-4879-b126-2f229957bfea
f883c686-4c9f-42de-9327-5e31429c5c30
```

Every row matched property `d4e83b9d-a87b-473a-afa1-ed3975cb9863`, the exact
title above, creator `74dafc84-fe29-453e-8c19-9142c4677adc`, and `active = true`.
No task or history row was deleted.

### Guarded command (password redacted)

The read-only preflight returned `expected=6 | active=6 | matched=6 | unexpected=0 | missing=0`.
The production change used one `ON_ERROR_STOP` transaction, locked and
rechecked the matching active rows, aborted unless the six-row set matched,
then updated only those IDs under all tenant/title/creator/active predicates:

```text
set -a; source ~/.config/staxis/tokens.env; set +a
PGSSLMODE=require PGPASSWORD='[redacted]' psql --no-psqlrc --set=ON_ERROR_STOP=1 \
  --host "$SUPABASE_DB_HOST" --port 5432 \
  --username "postgres.$SUPABASE_PROJECT_REF" --dbname postgres <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TEMP TABLE robot_cleanup_expected (id uuid PRIMARY KEY) ON COMMIT DROP;
INSERT INTO robot_cleanup_expected (id) VALUES
  ('302b5469-35d6-46a2-a3bd-8ae4c90967c1'),
  ('5b54102f-46cf-4f28-b035-e39bc65ed101'),
  ('762e6636-a284-494b-8117-58d24e4031d4'),
  ('46f32de9-b5d2-430d-b239-18aa0afb8b5c'),
  ('f883c686-4c9f-42de-9327-5e31429c5c30'),
  ('e20bac3f-7421-4879-b126-2f229957bfea');
DO $$
DECLARE
  expected_count integer;
  active_count integer;
  matched_count integer;
  updated_count integer;
BEGIN
  SELECT count(*) INTO expected_count FROM pg_temp.robot_cleanup_expected;
  PERFORM r.id
  FROM public.recurring_task_templates AS r
  WHERE r.property_id = 'd4e83b9d-a87b-473a-afa1-ed3975cb9863'
    AND r.title = 'Robot check: nightly walkthrough'
    AND r.created_by_staff_id = '74dafc84-fe29-453e-8c19-9142c4677adc'
    AND r.active = true
  FOR UPDATE;
  SELECT count(*) INTO active_count
  FROM public.recurring_task_templates AS r
  WHERE r.property_id = 'd4e83b9d-a87b-473a-afa1-ed3975cb9863'
    AND r.title = 'Robot check: nightly walkthrough'
    AND r.created_by_staff_id = '74dafc84-fe29-453e-8c19-9142c4677adc'
    AND r.active = true;
  SELECT count(*) INTO matched_count
  FROM public.recurring_task_templates AS r
  JOIN pg_temp.robot_cleanup_expected AS e ON e.id = r.id
  WHERE r.property_id = 'd4e83b9d-a87b-473a-afa1-ed3975cb9863'
    AND r.title = 'Robot check: nightly walkthrough'
    AND r.created_by_staff_id = '74dafc84-fe29-453e-8c19-9142c4677adc'
    AND r.active = true;
  IF expected_count <> 6 OR active_count <> expected_count OR matched_count <> expected_count THEN
    RAISE EXCEPTION 'robot template guard mismatch: expected %, active %, matched %', expected_count, active_count, matched_count;
  END IF;
  UPDATE public.recurring_task_templates AS r
  SET active = false, updated_at = now()
  FROM pg_temp.robot_cleanup_expected AS e
  WHERE r.id = e.id
    AND r.property_id = 'd4e83b9d-a87b-473a-afa1-ed3975cb9863'
    AND r.title = 'Robot check: nightly walkthrough'
    AND r.created_by_staff_id = '74dafc84-fe29-453e-8c19-9142c4677adc'
    AND r.active = true;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  IF updated_count <> expected_count THEN
    RAISE EXCEPTION 'robot template update count mismatch: expected %, updated %', expected_count, updated_count;
  END IF;
  RAISE NOTICE 'robot template cleanup guard passed; deactivated % exact rows', updated_count;
END $$;
COMMIT;
SQL
```

### Verification and rollback

Post-transaction verification found all six expected rows inactive, zero active
rows for the exact property/title/creator predicate, and zero open
`comms_tasks` spawned from these templates. Existing task instances and their
completion history remain available for audit.

To reverse this one-time cleanup, run the same redacted `psql` setup and a
guarded transaction that locks/requires the same six IDs with the same
property/title/creator predicates and `active = false`, then sets only those
rows back to `active = true` (abort unless exactly six rows are updated):

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TEMP TABLE robot_cleanup_rollback_expected (id uuid PRIMARY KEY) ON COMMIT DROP;
INSERT INTO robot_cleanup_rollback_expected (id) VALUES
  ('302b5469-35d6-46a2-a3bd-8ae4c90967c1'),
  ('46f32de9-b5d2-430d-b239-18aa0afb8b5c'),
  ('5b54102f-46cf-4f28-b035-e39bc65ed101'),
  ('762e6636-a284-494b-8117-58d24e4031d4'),
  ('e20bac3f-7421-4879-b126-2f229957bfea'),
  ('f883c686-4c9f-42de-9327-5e31429c5c30');
DO $$
DECLARE
  inactive_count integer;
  matched_count integer;
  restored_count integer;
BEGIN
  PERFORM r.id
  FROM public.recurring_task_templates AS r
  WHERE r.property_id = 'd4e83b9d-a87b-473a-afa1-ed3975cb9863'
    AND r.title = 'Robot check: nightly walkthrough'
    AND r.created_by_staff_id = '74dafc84-fe29-453e-8c19-9142c4677adc'
    AND r.active = false
  FOR UPDATE;
  SELECT count(*) INTO inactive_count
  FROM public.recurring_task_templates AS r
  WHERE r.property_id = 'd4e83b9d-a87b-473a-afa1-ed3975cb9863'
    AND r.title = 'Robot check: nightly walkthrough'
    AND r.created_by_staff_id = '74dafc84-fe29-453e-8c19-9142c4677adc'
    AND r.active = false;
  SELECT count(*) INTO matched_count
  FROM public.recurring_task_templates AS r
  JOIN pg_temp.robot_cleanup_rollback_expected AS e ON e.id = r.id
  WHERE r.property_id = 'd4e83b9d-a87b-473a-afa1-ed3975cb9863'
    AND r.title = 'Robot check: nightly walkthrough'
    AND r.created_by_staff_id = '74dafc84-fe29-453e-8c19-9142c4677adc'
    AND r.active = false;
  IF inactive_count <> 6 OR matched_count <> 6 THEN
    RAISE EXCEPTION 'robot template rollback guard mismatch: inactive %, matched %', inactive_count, matched_count;
  END IF;
  UPDATE public.recurring_task_templates AS r
  SET active = true, updated_at = now()
  FROM pg_temp.robot_cleanup_rollback_expected AS e
  WHERE r.id = e.id
    AND r.property_id = 'd4e83b9d-a87b-473a-afa1-ed3975cb9863'
    AND r.title = 'Robot check: nightly walkthrough'
    AND r.created_by_staff_id = '74dafc84-fe29-453e-8c19-9142c4677adc'
    AND r.active = false;
  GET DIAGNOSTICS restored_count = ROW_COUNT;
  IF restored_count <> 6 THEN
    RAISE EXCEPTION 'robot template rollback count mismatch: restored %', restored_count;
  END IF;
END $$;
COMMIT;
```

## Access Stage A release contract (pending approval)

Migrations `0418` through `0423` are intentionally not applied by this branch.
When this train is approved for production, apply it in this order with the
single-migration runner:

1. Apply `0418_authoritative_access_cutover_preflight.sql`.
2. Inspect `account_access_cutover_preflight_runs` and its issue rows. Confirm
   the committed baseline run has `created_by = '0418'`; unresolved rows remain
   reported and skipped.
3. Apply `0419_authoritative_access_cutover_backfill.sql`, then apply `0420`,
   `0421`, `0422`, and `0423` sequentially.
4. Verify the `applied_migrations` rows and Stage A invariant evidence, then
   rerun the migration checker before merge.

Do not use the bulk pending-migration runner for this train. Stop after the
0418 inspection if the preflight evidence is unexpected. Production apply,
merge, and deploy still require parent authorization and both safety reviews.

---

## 2026-08-01 — My Hotel / My Company People invitations

### Migration applied to prod (via `scripts/apply-migration.ts`)

| File | What | How to verify |
|---|---|---|
| `0416_people_invite_identity_linking.sql` | Adds optional roster-profile targets to email invitations, atomic invite-acceptance linking, guarded access grants for existing Staxis accounts, pending-profile reservations, and deterministic roster reuse for shared-link approvals. | Migration `0416` has one row; `account_invites.target_staff_id` exists; the targeted invite and existing-account grant RPCs exist; only `service_role` can execute the grant RPC. |

Applied with:

```text
set -a; source /Users/reeyen/.config/staxis/tokens.env; set +a
npx tsx scripts/apply-migration.ts supabase/migrations/0416_people_invite_identity_linking.sql
```

Post-apply verification: `npx tsx scripts/check-migrations-applied.ts` reported all 360 production-required migrations applied. Direct production checks confirmed the `0416` row, target-staff column, both new RPC signatures, service-role execution, and browser-role denial. Roll back application callers first. Preserve account access, staff links, invitation history, and audit rows; a forward fix is safer than dropping linked identity data. If a schema rollback is unavoidable, restore the 0393/0395 function definitions, remove the new grant/helper functions after callers are gone, and remove the target column only after clearing every remaining target safely.

---

## 2026-07-22 — My Hotel account access controls

### Migration applied to prod (via `scripts/apply-migration.ts`)

| File | What | How to verify |
|---|---|---|
| `0335_account_lifecycle_intents.sql` | Adds durable, service-role-only account disable/reactivate operations; atomic hotel-role and ownership guards; normalized organization-owner protection; lifecycle fences; and complete per-hotel/admin audit writes. | Migration `0335` has one row, `account_lifecycle_intents` exists, no browser role can read it or execute lifecycle RPCs, and the account lifecycle guards are present on `accounts`. |

Applied with:

```text
npx tsx scripts/apply-migration.ts supabase/migrations/0335_account_lifecycle_intents.sql
```

Post-apply verification: `npx tsx scripts/check-migrations-applied.ts` reported all 284 production-required migrations applied. Direct production checks confirmed one `0335` row, the intent table, both account guards, all required lifecycle/role functions, zero pending or processing intents, zero browser table grants, and zero browser-executable lifecycle RPCs. Roll back only after deploying code that no longer calls these RPCs. Preserve lifecycle intents and audit rows; disabling the UI/code path is safer than dropping durable intent history. If a schema rollback is unavoidable, first export the intent and audit evidence, then remove the guards/functions/table in dependency order.

---

## 2026-07-20 — My Hotel account and team security

### Migrations applied to prod (via `scripts/apply-migration.ts`)

| File | What | How to verify |
|---|---|---|
| `0328_invite_storage_service_role_only.sql` | Removes direct browser access to hotel account invitations and join-code capability rows; all use now goes through scoped server routes. | Browser roles have no table privileges; only the two explicit `*_deny_browser` policies remain. |
| `0329_guard_hotel_team_detach_snapshot.sql` | Adds an atomic, version-checked hotel-access removal function so a stale manager action cannot detach an account after its role or access changed. | `to_regprocedure('public.staxis_remove_property_access_guarded(uuid,uuid,text,timestamp with time zone)')` is present and only `service_role` can execute it. |

Applied in order with:

```text
npx tsx scripts/apply-migration.ts supabase/migrations/0328_invite_storage_service_role_only.sql
npx tsx scripts/apply-migration.ts supabase/migrations/0329_guard_hotel_team_detach_snapshot.sql
```

Post-apply verification: `npx tsx scripts/check-migrations-applied.ts` reported all 278 production-required migrations applied. Direct production checks confirmed both migration rows, browser-deny invite policies, service-role access, the guarded RPC, and zero hotels with duplicate usable staff join codes. Rollback requires first deploying code that no longer calls the guarded RPC; then drop that function and restore the former owner-scoped invite/code grants only if a trusted direct-browser flow is intentionally reintroduced.

---

## 2026-07-19 — Inventory monthly accounting

### Migrations applied to prod (via `scripts/apply-migration.ts`)

| File | What | How to verify |
|---|---|---|
| `0322_inventory_month_close.sql` | Adds immutable inventory baselines, ending snapshots, purchase evidence, opening adjustments, and the monthly close workflow (`beginning + purchases - ending = actual usage`). | `select version from applied_migrations where version = '0322'` returns one row; `inventory_month_closes` exists. |
| `0323_inventory_budget_integrity.sql` | Separates purchase budgets from usage budgets and freezes the usage-budget snapshot on each closed month. | `select version from applied_migrations where version = '0323'` returns one row; `inventory_budgets.basis` exists. |

Applied in order with:

```text
npx tsx scripts/apply-migration.ts supabase/migrations/0322_inventory_month_close.sql
npx tsx scripts/apply-migration.ts supabase/migrations/0323_inventory_budget_integrity.sql
```

Post-apply verification: `npx tsx scripts/check-migrations-applied.ts` reported all repository migrations applied. Roll back only after deploying code that does not use month-close accounting; preserve/export close evidence first, then reverse the 0323 budget columns/key/trigger and 0322 tables, functions, triggers, and inventory columns in dependency order. A database restore is safer once close data exists.

---

## 2026-05-15 — Round 18 hardening session

### Migrations applied to prod (via `scripts/apply-migration.ts`)

| File | What | How to verify |
|---|---|---|
| `0124_accounts_skip_2fa.sql` | `accounts.skip_2fa` bool column for the shared demo login | `select skip_2fa from accounts limit 1` |
| `0125_total_rooms_inventory_invariant.sql` | Trigger keeps `properties.total_rooms = array_length(room_inventory)` | `\d properties` shows trigger |
| `0126_staxis_api_limit_cleanup_recreate.sql` | Recreates `staxis_api_limit_cleanup()` that drifted from 0008 | `select staxis_api_limit_cleanup()` returns int |
| `0129_schedule_auto_fill_if_absent.sql` | RPC for atomic schedule-auto-fill insert | `\df staxis_schedule_auto_fill_if_absent` |
| `0130_model_runs_cold_start_flag.sql` | `model_runs.cold_start` boolean + backfill | `select count(*) from model_runs where cold_start = true` should be ≥14 |

Roll back: drop the columns/functions, then `delete from applied_migrations where version in ('0124', ..., '0130')`. Note that 0125's trigger guards an invariant — dropping it without a code change would let `total_rooms ≠ array_length(room_inventory)` drift back in.

### Data cleanups

| When | What | Why | Reversibility |
|---|---|---|---|
| 2026-05-15 ~05:30 UTC | `delete from inventory_rate_priors where prior_rate_per_room_per_day < 0.001 or > 10` | 11 poisoned priors from a single-hotel cohort with n=1 incident logs were skewing cold-start predictions for the entire `comfort-suites-south-medium` cohort | The trainer regenerates priors on its weekly run; deleted rows reappear iff the trainer thinks they're sane (post-fix, they won't) |

### Vercel env vars

| When | Var | Action | Why |
|---|---|---|---|
| 2026-05-15 ~18:00 UTC | `NEXT_PUBLIC_SENTRY_DSN` | Added on production (encrypted) + preview (initially plain, re-set as encrypted at 19:30 UTC via REST API) | Client-side browser errors were disappearing silently because the env var was missing |

DSN value lives in Sentry → `staxis.sentry.io/settings/projects/javascript-nextjs/keys/`. Recover via Vercel dashboard if accidentally cleared.

### GitHub Actions secrets

| When | Secret | Scope | Action |
|---|---|---|---|
| 2026-05-15 ~18:15 UTC | `SUPABASE_DB_HOST`, `SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_REF` | Repo-scoped | Added (for `check-migrations-applied` workflow) |
| 2026-05-15 ~19:30 UTC | Same 3 secrets | **Moved to `production` environment-scoped** | Limits blast radius: only workflows that opt-in to `environment: production` can read them |

Recover: `gh secret set --env production --repo Reeyenn/staxis ...` with values sourced from `~/.config/staxis/tokens.env`.

### Doctor / cron heartbeats: things to watch

After today's changes, the doctor's hourly run should report all-green with these warns:
- `stripe_billing_configured` (expected — trial-only mode)
- `inventory_priors_in_range` (may persist briefly if the deleted-row backfill didn't catch every outlier)

The `schedule-auto-fill` cron is new; first heartbeat lands when GH Actions next fires the 12:00 or 01:00 UTC slot.

---

## Template (copy + paste for new sessions)

```markdown
## YYYY-MM-DD — short title

### Migrations
| File | What | How to verify |
|---|---|---|

### Data cleanups
| When | What | Why | Reversibility |
|---|---|---|---|

### Env vars (Vercel / Railway / Fly)
| When | Var | Action | Why |
|---|---|---|---|

### Secrets (GitHub Actions / elsewhere)
| When | Secret | Scope | Action |
|---|---|---|---|

### Notes for the next on-call
- …
```
