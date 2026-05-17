# Data Model Map

_Branch: `audit/data-model` &nbsp;·&nbsp; Generated: 2026-05-17 &nbsp;·&nbsp; Source: `supabase/migrations/0001`–`0131` (124 files)_

**Totals:** 83 tables &nbsp;·&nbsp; ~7 live views &nbsp;·&nbsp; 2 Supabase Storage buckets &nbsp;·&nbsp; 520 read call sites &nbsp;·&nbsp; 249 write call sites &nbsp;·&nbsp; 38 RPC functions called from app code.

## Scope

**In:** every public-schema table defined in `supabase/migrations/*.sql`, the live views, the two storage buckets (`invoices`, `counts`), and every read/write call site in `src/`, `cua-service/src/`, `ml-service/src/`, `scraper/`, `scripts/`, `tools/`.

**Out:** `auth.*` schema (Supabase-managed), test code under `__tests__/` and `tests/` (referenced separately as "test-only" where relevant), per-row data quality, performance.

## Methodology

Schema reconstructed by replaying all 124 migrations in numeric order — `CREATE TABLE`, then every `ALTER TABLE ADD/DROP/ALTER COLUMN`, `ADD CONSTRAINT`, `CREATE INDEX`. Final per-column type, nullability, default, and FK status reflect the state after `0131`.

Reads vs. writes classified by call shape:
- **Direct:** Supabase JS `.from('t').select|insert|update|upsert|delete(...)`, supabase-py `.table('t').<op>(...)`, and the project's Python helper `client.fetch_one/fetch_many/insert/upsert/update(table='t', ...)`.
- **Raw SQL:** SQL strings inside `client.execute_sql(...)` calls in `ml-service/`, and SQL backtick-strings in `src/` / `cua-service/`. Tables detected via `FROM`, `JOIN`, `UPDATE`, `INSERT INTO`, `DELETE FROM`.
- **RPC:** `.rpc('fn_name', ...)` calls; the named function's body is then scanned in migrations to find which tables it reads/writes.

Column-level **dead** / **write-only** flags are heuristic. They scan `.insert({...})` / `.update({...})` / `.upsert({...})` object literals and `.select('a, b')` projections. They will produce **false positives** when:
- The column is set or read via raw SQL (`execute_sql`) — heavy in `ml-service/src/training/` and `ml-service/src/inference/`.
- The column is touched by an RPC function body (the audit lists RPC readers/writers at the table level but not at the column level).
- The caller uses `.select('*')` or destructures `data: rows` rather than naming columns.
- The column is consumed by realtime subscribers (`supabase.channel().on('postgres_changes', ...)` — outside the static grep surface).
- The column is consumed by a Postgres view, trigger, or generated column — not by app code at all.

Treat per-column flags as **leads**, not proof. Validate any flagged column with `grep -rn '<col>' src/ ml-service/ cua-service/ scraper/` before deleting.

## Table index by domain

**Auth & Accounts** (5): [`account_invites`](#account-invites), [`accounts`](#accounts), [`applied_migrations`](#applied-migrations), [`hotel_join_codes`](#hotel-join-codes), [`trusted_devices`](#trusted-devices)

**Properties & Rooms** (5): [`deep_clean_config`](#deep-clean-config), [`deep_clean_records`](#deep-clean-records), [`properties`](#properties), [`public_areas`](#public-areas), [`rooms`](#rooms)

**Staff & Scheduling** (5): [`attendance_marks`](#attendance-marks), [`manager_notifications`](#manager-notifications), [`schedule_assignments`](#schedule-assignments), [`shift_confirmations`](#shift-confirmations), [`staff`](#staff)

**Cleaning & Ops** (11): [`cleaning_events`](#cleaning-events), [`daily_logs`](#daily-logs), [`dashboard_by_date`](#dashboard-by-date), [`guest_requests`](#guest-requests), [`handoff_logs`](#handoff-logs), [`inspections`](#inspections), [`landscaping_tasks`](#landscaping-tasks), [`laundry_config`](#laundry-config), [`plan_snapshots`](#plan-snapshots), [`preventive_tasks`](#preventive-tasks), [`pull_jobs`](#pull-jobs)

**Inventory** (10): [`equipment`](#equipment), [`inventory`](#inventory), [`inventory_budgets`](#inventory-budgets), [`inventory_counts`](#inventory-counts), [`inventory_discards`](#inventory-discards), [`inventory_orders`](#inventory-orders), [`inventory_rate_prediction_history`](#inventory-rate-prediction-history), [`inventory_rate_predictions`](#inventory-rate-predictions), [`inventory_rate_priors`](#inventory-rate-priors), [`inventory_reconciliations`](#inventory-reconciliations)

**Ml & Predictions** (10): [`demand_predictions`](#demand-predictions), [`demand_priors`](#demand-priors), [`ml_feature_flags`](#ml-feature-flags), [`model_runs`](#model-runs), [`optimizer_results`](#optimizer-results), [`prediction_disagreement`](#prediction-disagreement), [`prediction_log`](#prediction-log), [`prediction_overrides`](#prediction-overrides), [`supply_predictions`](#supply-predictions), [`supply_priors`](#supply-priors)

**Agent (Chat/Voice)** (11): [`agent_conversations`](#agent-conversations), [`agent_conversations_archived`](#agent-conversations-archived), [`agent_cost_finalize_failures`](#agent-cost-finalize-failures), [`agent_costs`](#agent-costs), [`agent_eval_baselines`](#agent-eval-baselines), [`agent_messages`](#agent-messages), [`agent_messages_archived`](#agent-messages-archived), [`agent_nudges`](#agent-nudges), [`agent_prompts`](#agent-prompts), [`voice_recordings`](#voice-recordings), [`walkthrough_runs`](#walkthrough-runs)

**Work Orders & Maintenance** (3): [`service_contracts`](#service-contracts), [`vendors`](#vendors), [`work_orders`](#work-orders)

**Pms Integration** (6): [`onboarding_jobs`](#onboarding-jobs), [`pms_recipes`](#pms-recipes), [`pull_metrics`](#pull-metrics), [`scraper_credentials`](#scraper-credentials), [`scraper_session`](#scraper-session), [`scraper_status`](#scraper-status)

**Billing & Expenses** (2): [`expenses`](#expenses), [`stripe_processed_events`](#stripe-processed-events)

**Admin / Logging / Metrics** (15): [`admin_audit_log`](#admin-audit-log), [`api_limits`](#api-limits), [`app_events`](#app-events), [`claude_sessions`](#claude-sessions), [`claude_usage_log`](#claude-usage-log), [`cron_heartbeats`](#cron-heartbeats), [`error_logs`](#error-logs), [`github_events`](#github-events), [`idempotency_log`](#idempotency-log), [`local_worktrees`](#local-worktrees), [`prospects`](#prospects), [`roadmap_items`](#roadmap-items), [`sms_jobs`](#sms-jobs), [`user_feedback`](#user-feedback), [`webhook_log`](#webhook-log)

## Tables

### Domain: auth & accounts

### `account_invites`

**Domain:** auth & accounts &nbsp;·&nbsp; **Defined:** 0064_team_roles_and_invites.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0064_team_roles_and_invites.sql]_ |
| `hotel_id` | uuid | no | — | FK→properties(id) · _[0064_team_roles_and_invites.sql]_ |
| `email` | text | no | — | _[0064_team_roles_and_invites.sql]_ |
| `role` | text | no | — | CHECK(role in ('owner','general_manager','front_desk','housekee...) · _[0064_team_roles_and_invites.sql]_ |
| `token_hash` | text | no | — | UNIQUE · _[0064_team_roles_and_invites.sql]_ |
| `expires_at` | timestamptz | no | — | _[0064_team_roles_and_invites.sql]_ |
| `invited_by` | uuid | no | — | FK→accounts(id) · _[0064_team_roles_and_invites.sql]_ |
| `created_at` | timestamptz | no | now() | _[0064_team_roles_and_invites.sql]_ |
| `accepted_at` | timestamptz | yes | — | _[0064_team_roles_and_invites.sql]_ |
| `accepted_by` | uuid | yes | — | FK→accounts(id) · _[0064_team_roles_and_invites.sql]_ |

**Indexes & table-level constraints:**

- index `account_invites_hotel_idx` on `(hotel_id)`  _[0064_team_roles_and_invites.sql]_
- index `account_invites_email_idx` on `(lower(email)`  _[0064_team_roles_and_invites.sql]_
- index `account_invites_expires_idx` on `(expires_at)`  _[0064_team_roles_and_invites.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/app/api/auth/accept-invite/route.ts:58` (select)
- `src/app/api/auth/invites/route.ts:45,135` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/app/api/auth/accept-invite/route.ts:128` (update)
- `src/app/api/auth/invites/route.ts:82,144` (delete,insert)

**Flags:** none.

---

### `accounts`

**Domain:** auth & accounts &nbsp;·&nbsp; **Defined:** 0001_initial_schema.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0001_initial_schema.sql]_ |
| `username` | text | no | — | UNIQUE · _[0001_initial_schema.sql]_ |
| `password_hash` | text | yes | — | _[0001_initial_schema.sql]_ |
| `display_name` | text | no | — | _[0001_initial_schema.sql]_ |
| `role` | text | no | 'staff' | _[0001_initial_schema.sql]_ |
| `property_access` | uuid[] | no | '{}' | _[0001_initial_schema.sql]_ |
| `data_user_id` | uuid | no | — | FK→auth(id) · _[0001_initial_schema.sql]_ |
| `created_at` | timestamptz | no | now() | _[0001_initial_schema.sql]_ |
| `updated_at` | timestamptz | no | now() | _[0001_initial_schema.sql]_ |
| `phone` | text | yes | — | _[0065_accounts_phone_and_simplified_join_codes.sql]_ |
| `ai_cost_tier` | text | no | 'free' | _[0100_agent_longevity_foundation.sql]_ |
| `voice_replies_enabled` | boolean | no | false | _[0117_voice_surface.sql]_ |
| `wake_word_enabled` | boolean | no | false | _[0117_voice_surface.sql]_ |
| `voice_onboarded_at` | timestamptz | yes | — | _[0117_voice_surface.sql]_ |
| `skip_2fa` | boolean | no | false | _[0124_accounts_skip_2fa.sql]_ |

**Indexes & table-level constraints:**

- index `accounts_username_idx` on `(username)`  _[0001_initial_schema.sql]_
- index `accounts_data_user_id_idx` on `(data_user_id)`  _[0001_initial_schema.sql]_
- index `accounts_property_access_gin_idx` on `(property_access)`  _[0121_property_access_gin_index.sql]_
- constraint: `add constraint accounts_role_check   check (role in ('admin','owner','staff'))`  _[0002_auth_bridge.sql]_
- constraint: `add constraint accounts_role_check   check (role in (     'admin',                'owner',                'general_manager',      'front_desk',           'housekeeping',         'maintenance',        `  _[0064_team_roles_and_invites.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `scripts/run-agent-evals.ts:34` (select)
- `scripts/run-summarizer-evals.ts:36` (select)
- `scripts/seed-supabase.js:305` (select)
- `src/app/api/admin/property-health/route.ts:93` (select)
- `src/app/api/agent/command/route.ts:116` (select)
- `src/app/api/agent/conversations/[id]/route.ts:23,56` (select)
- `src/app/api/agent/conversations/route.ts:21` (select)
- `src/app/api/agent/nudges/[id]/ack/route.ts:22` (select)
- `src/app/api/agent/nudges/route.ts:20` (select)
- `src/app/api/agent/speak/route.ts:94` (select)
- `src/app/api/agent/voice-preference/route.ts:38` (select)
- `src/app/api/agent/voice-session/route.ts:73` (select)
- `src/app/api/auth/accept-invite/route.ts:81,96` (select)
- `src/app/api/auth/accounts/route.ts:59,108,176,290,386` (select)
- `src/app/api/auth/check-trust/route.ts:38` (select)
- `src/app/api/auth/team/route.ts:49,118,236` (select)
- `src/app/api/auth/trust-device/route.ts:41` (select)
- `src/app/api/auth/use-join-code/route.ts:151` (select)
- `src/app/api/events/route.ts:55` (select)
- `src/app/api/feedback/route.ts:46` (select)
- `src/app/api/onboard/wizard/route.ts:202` (select)
- `src/app/api/staff-link/route.ts:87` (select)
- `src/app/api/walkthrough/end/route.ts:65` (select)
- `src/app/api/walkthrough/start/route.ts:63` (select)
- `src/app/api/walkthrough/step/route.ts:279` (select)
- `src/contexts/AuthContext.tsx:54,142` (select)
- `src/lib/admin-auth.ts:23` (select)
- `src/lib/agent/cost-controls.ts:116` (select)
- `src/lib/agent/nudges.ts:170,186` (select)
- `src/lib/api-auth.ts:407` (select)
- `src/lib/team-auth.ts:27` (select)

_Raw SQL (`execute_sql` / backtick / triple-quote):_
- `scripts/run-agent-invariant-evals.ts:37,122,264` (sql_read)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `scripts/seed-supabase.js:315,328` (insert,update)
- `src/app/api/agent/voice-preference/route.ts:112` (update)
- `src/app/api/auth/accept-invite/route.ts:113` (insert)
- `src/app/api/auth/accounts/route.ts:213,311,403` (delete,insert,update)
- `src/app/api/auth/team/route.ts:184,257` (update)
- `src/app/api/auth/use-join-code/route.ts:197` (insert)

_Test-only references: 1 reads, 0 writes (in `__tests__/` — excluded from coverage above)._

**Flags:** none.

---

### `applied_migrations`

**Domain:** auth & accounts &nbsp;·&nbsp; **Defined:** 0015_applied_migrations_tracker.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `version` | text | no | — | PK · _[0015_applied_migrations_tracker.sql]_ |
| `applied_at` | timestamptz | no | now() | _[0015_applied_migrations_tracker.sql]_ |
| `description` | text | yes | — | _[0015_applied_migrations_tracker.sql]_ |

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/app/api/admin/doctor/route.ts:1617` (select)

_Raw SQL (`execute_sql` / backtick / triple-quote):_
- `scripts/verify-migration-0116.ts:91` (sql_read)

**Writes:**

- _none detected_

**Flags:**

- **Read-only table** — never written by any service (read-only after seed/migration).

---

### `hotel_join_codes`

**Domain:** auth & accounts &nbsp;·&nbsp; **Defined:** 0064_team_roles_and_invites.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0064_team_roles_and_invites.sql]_ |
| `hotel_id` | uuid | no | — | FK→properties(id) · _[0064_team_roles_and_invites.sql]_ |
| `code` | text | no | — | UNIQUE · _[0064_team_roles_and_invites.sql]_ |
| `role` | text | yes | — | CHECK(role in ('owner','general_manager','front_desk','housekee...) · _[0064_team_roles_and_invites.sql]_ |
| `expires_at` | timestamptz | no | — | _[0064_team_roles_and_invites.sql]_ |
| `max_uses` | integer | no | 1 | _[0064_team_roles_and_invites.sql]_ |
| `used_count` | integer | no | 0 | _[0064_team_roles_and_invites.sql]_ |
| `created_by` | uuid | no | — | FK→accounts(id) · _[0064_team_roles_and_invites.sql]_ |
| `created_at` | timestamptz | no | now() | _[0064_team_roles_and_invites.sql]_ |
| `revoked_at` | timestamptz | yes | — | _[0064_team_roles_and_invites.sql]_ |

**Indexes & table-level constraints:**

- index `hotel_join_codes_hotel_idx` on `(hotel_id)`  _[0064_team_roles_and_invites.sql]_
- index `hotel_join_codes_expires_idx` on `(expires_at)`  _[0064_team_roles_and_invites.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/app/api/auth/join-codes/route.ts:43,115` (select)
- `src/app/api/auth/use-join-code/route.ts:91` (select)
- `src/app/api/onboard/wizard/route.ts:62` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/app/api/admin/properties/create/route.ts:358` (insert)
- `src/app/api/auth/join-codes/route.ts:79,122` (insert,update)
- `src/app/api/auth/use-join-code/route.ts:116,175` (update)

**Flags:** none.

---

### `trusted_devices`

**Domain:** auth & accounts &nbsp;·&nbsp; **Defined:** 0063_trusted_devices.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0063_trusted_devices.sql]_ |
| `account_id` | uuid | no | — | FK→accounts(id) · _[0063_trusted_devices.sql]_ |
| `token_hash` | text | no | — | _[0063_trusted_devices.sql]_ |
| `user_agent` | text | yes | — | _[0063_trusted_devices.sql]_ |
| `ip` | text | yes | — | _[0063_trusted_devices.sql]_ |
| `created_at` | timestamptz | no | now() | _[0063_trusted_devices.sql]_ |
| `last_seen_at` | timestamptz | no | now() | _[0063_trusted_devices.sql]_ |
| `expires_at` | timestamptz | no | — | _[0063_trusted_devices.sql]_ |

**Indexes & table-level constraints:**

- index `trusted_devices_account_idx` on `(account_id)`  _[0063_trusted_devices.sql]_
- index `trusted_devices_expires_idx` on `(expires_at)`  _[0063_trusted_devices.sql]_
- UNIQUE index `trusted_devices_account_token_uidx` on `(account_id, token_hash)`  _[0063_trusted_devices.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/app/api/auth/check-trust/route.ts:60` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/app/api/auth/check-trust/route.ts:78` (update)
- `src/app/api/auth/trust-device/route.ts:57` (insert)

**Flags:** none.

---

### Domain: properties & rooms

### `deep_clean_config`

**Domain:** properties & rooms &nbsp;·&nbsp; **Defined:** 0001_initial_schema.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `property_id` | uuid | no | — | PK · FK→properties(id) · _[0001_initial_schema.sql]_ |
| `frequency_days` | integer | no | 90 | _[0001_initial_schema.sql]_ |
| `minutes_per_room` | integer | no | 60 | _[0001_initial_schema.sql]_ |
| `target_per_week` | integer | no | 5 | _[0001_initial_schema.sql]_ |
| `updated_at` | timestamptz | no | now() | _[0001_initial_schema.sql]_ |

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/lib/db/deep-cleaning.ts:19` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/lib/db/deep-cleaning.ts:36` (upsert)

**Flags:** none.

---

### `deep_clean_records`

**Domain:** properties & rooms &nbsp;·&nbsp; **Defined:** 0001_initial_schema.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0001_initial_schema.sql]_ |
| `property_id` | uuid | no | — | FK→properties(id) · _[0001_initial_schema.sql]_ |
| `room_number` | text | no | — | _[0001_initial_schema.sql]_ |
| `last_deep_clean` | date | no | — | _[0001_initial_schema.sql]_ |
| `cleaned_by` | text | yes | — | _[0001_initial_schema.sql]_ |
| `cleaned_by_team` | text[] | yes | '{}' | _[0001_initial_schema.sql]_ |
| `notes` | text | yes | — | _[0001_initial_schema.sql]_ |
| `status` | text | yes | — | CHECK(status in ('in_progress','completed')) · _[0001_initial_schema.sql]_ |
| `assigned_at` | date | yes | — | _[0001_initial_schema.sql]_ |
| `completed_at` | date | yes | — | _[0001_initial_schema.sql]_ |
| `updated_at` | timestamptz | no | now() | _[0001_initial_schema.sql]_ |

**Indexes & table-level constraints:**

- index `deep_clean_records_property_idx` on `(property_id)`  _[0001_initial_schema.sql]_
- constraint: `unique (property_id, room_number)`  _[0001_initial_schema.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/lib/db/deep-cleaning.ts:42,94` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/lib/db/deep-cleaning.ts:60,78,114,132` (upsert)

**Flags:** none.

---

### `properties`

**Domain:** properties & rooms &nbsp;·&nbsp; **Defined:** 0001_initial_schema.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0001_initial_schema.sql]_ |
| `owner_id` | uuid | no | — | FK→auth(id) · _[0001_initial_schema.sql]_ |
| `name` | text | no | — | _[0001_initial_schema.sql]_ |
| `total_rooms` | integer | no | 0 | _[0001_initial_schema.sql]_ |
| `avg_occupancy` | numeric | no | 0 | _[0001_initial_schema.sql]_ |
| `hourly_wage` | numeric | no | 15 | _[0001_initial_schema.sql]_ |
| `checkout_minutes` | integer | no | 30 | _[0001_initial_schema.sql]_ |
| `stayover_minutes` | integer | no | 20 | _[0001_initial_schema.sql]_ |
| `stayover_day1_minutes` | integer | yes | 15 | _[0001_initial_schema.sql]_ |
| `stayover_day2_minutes` | integer | yes | 20 | _[0001_initial_schema.sql]_ |
| `prep_minutes_per_activity` | integer | no | 5 | _[0001_initial_schema.sql]_ |
| `shift_minutes` | integer | no | 480 | _[0001_initial_schema.sql]_ |
| `total_staff_on_roster` | integer | no | 0 | _[0001_initial_schema.sql]_ |
| `weekly_budget` | numeric | yes | — | _[0001_initial_schema.sql]_ |
| `morning_briefing_time` | text | yes | — | _[0001_initial_schema.sql]_ |
| `evening_forecast_time` | text | yes | — | _[0001_initial_schema.sql]_ |
| `pms_type` | text | yes | — | _[0001_initial_schema.sql]_ |
| `pms_url` | text | yes | — | _[0001_initial_schema.sql]_ |
| `pms_connected` | boolean | yes | false | _[0001_initial_schema.sql]_ |
| `last_synced_at` | timestamptz | yes | — | _[0001_initial_schema.sql]_ |
| `created_at` | timestamptz | no | now() | _[0001_initial_schema.sql]_ |
| `updated_at` | timestamptz | no | now() | _[0001_initial_schema.sql]_ |
| `timezone` | text | no | 'America/Chicago' | _[0016_properties_per_property_config.sql]_ |
| `dashboard_stale_minutes` | integer | no | 25 | _[0016_properties_per_property_config.sql]_ |
| `scraper_window_start_hour` | integer | no | 5 | _[0016_properties_per_property_config.sql]_ |
| `scraper_window_end_hour` | integer | no | 23 | _[0016_properties_per_property_config.sql]_ |
| `room_inventory` | text[] | no | '{}' | _[0025_property_room_inventory.sql]_ |
| `alert_phone` | text | yes | — | _[0026_inventory_intelligence.sql]_ |
| `subscription_status` | text | no | 'trial' | _[0034_signup_billing_services.sql]_ |
| `trial_ends_at` | timestamptz | yes | (now() + interval '14 days') | _[0034_signup_billing_services.sql]_ |
| `stripe_customer_id` | text | yes | — | _[0034_signup_billing_services.sql]_ |
| `stripe_subscription_id` | text | yes | — | _[0034_signup_billing_services.sql]_ |
| `services_enabled` | jsonb | no | jsonb_build_object( | _[0034_signup_billing_services.sql]_ |
| `property_kind` | text | no | 'limited_service' | _[0034_signup_billing_services.sql]_ |
| `onboarding_source` | text | no | 'admin' | _[0034_signup_billing_services.sql]_ |
| `inventory_ai_mode` | text | no | 'auto' | _[0062_inventory_ml_foundation.sql]_ |
| `brand` | text | yes | — | _[0062_inventory_ml_foundation.sql]_ |
| `region` | text | yes | — | _[0062_inventory_ml_foundation.sql]_ |
| `climate_zone` | text | yes | — | _[0062_inventory_ml_foundation.sql]_ |
| `size_tier` | text | yes | — | _[0062_inventory_ml_foundation.sql]_ |
| `is_test` | boolean | no | false | _[0068_properties_is_test.sql]_ |
| `nudge_subscription` | jsonb | yes | — | _[0088_property_nudge_subscription.sql]_ |
| `onboarding_state` | jsonb | no | '{}'::jsonb | _[0120_onboarding_state.sql]_ |
| `onboarding_completed_at` | timestamptz | yes | — | _[0120_onboarding_state.sql]_ |

**Indexes & table-level constraints:**

- index `properties_owner_id_idx` on `(owner_id)`  _[0001_initial_schema.sql]_
- index `properties_subscription_status_idx` on `(subscription_status)`  _[0034_signup_billing_services.sql]_
- index `properties_stripe_customer_idx` on `(stripe_customer_id)`  _[0034_signup_billing_services.sql]_
- UNIQUE index `properties_stripe_customer_id_unique_idx` on `(stripe_customer_id)`  _[0035_stripe_idempotency_and_constraints.sql]_
- index `properties_is_test_idx` on `(is_test)`  _[0068_properties_is_test.sql]_
- index `properties_nudge_disabled_idx` on `(id)`  _[0088_property_nudge_subscription.sql]_
- index `properties_onboarding_in_flight_idx` on `(created_at DESC)`  _[0120_onboarding_state.sql]_
- constraint: `add constraint properties_dashboard_stale_minutes_check   check (dashboard_stale_minutes >= 0 and dashboard_stale_minutes <= 1440)`  _[0016_properties_per_property_config.sql]_
- constraint: `add constraint properties_scraper_window_check   check (     scraper_window_start_hour >= 0 and scraper_window_start_hour <= 23     and scraper_window_end_hour >= 1 and scraper_window_end_hour <= 24  `  _[0016_properties_per_property_config.sql]_
- constraint: `add constraint properties_subscription_status_check   check (subscription_status in (     'trial',                      'active',                     'past_due',                   'canceled',         `  _[0038_subscription_status_normalize_and_trial_default.sql]_
- constraint: `add constraint properties_trial_has_end   check (subscription_status <> 'trial' or trial_ends_at is not null)`  _[0038_subscription_status_normalize_and_trial_default.sql]_
- constraint: `add constraint properties_total_rooms_positive check (total_rooms > 0)`  _[0116_properties_total_rooms_check.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `ml-service/src/optimizer/monte_carlo.py:189` (fetch_one)
- `ml-service/src/training/_cold_start.py:66` (fetch_one)
- `ml-service/src/training/demand_supply_priors.py:97,206` (fetch_many)
- `ml-service/src/training/inventory_priors.py:52` (fetch_many)
- `ml-service/src/training/inventory_rate.py:182` (fetch_one)
- `scripts/seed-supabase.js:272` (select)
- `src/app/admin/ml/page.tsx:168` (select)
- `src/app/api/admin/activity/route.ts:105` (select)
- `src/app/api/admin/alerts/route.ts:63,100` (select)
- `src/app/api/admin/doctor/route.ts:2928` (select)
- `src/app/api/admin/feedback/route.ts:44` (select)
- `src/app/api/admin/list-properties/route.ts:70` (select)
- `src/app/api/admin/ml-health/route.ts:129` (select)
- `src/app/api/admin/ml/housekeeping/cockpit-data/route.ts:174` (select)
- `src/app/api/admin/ml/inventory/cockpit-data/route.ts:177` (select)
- `src/app/api/admin/onboarding-jobs/route.ts:86` (select)
- `src/app/api/admin/overview-stats/route.ts:47,51` (select)
- `src/app/api/admin/per-hotel-economics/route.ts:55` (select)
- `src/app/api/admin/pms-coverage/route.ts:82` (select)
- `src/app/api/admin/property-health/route.ts:37` (select)
- `src/app/api/admin/scheduled-jobs/route.ts:88` (select)
- `src/app/api/admin/scraper-instances/route.ts:103` (select)
- `src/app/api/admin/sms-health/route.ts:92` (select)
- `src/app/api/admin/test-sms-flow/route.ts:117` (select)
- `src/app/api/agent/nudges/check/route.ts:25` (select)
- `src/app/api/auth/join-codes/route.ts:72` (select)
- `src/app/api/cron/enqueue-property-pulls/route.ts:53` (select)
- `src/app/api/cron/ml-predict-inventory/route.ts:50` (select)
- `src/app/api/cron/ml-run-inference/route.ts:55` (select)
- `src/app/api/cron/ml-train-demand/route.ts:64` (select)
- `src/app/api/cron/ml-train-inventory/route.ts:49` (select)
- `src/app/api/cron/ml-train-supply/route.ts:45` (select)
- `src/app/api/cron/schedule-auto-fill/route.ts:308` (select)
- `src/app/api/cron/seal-daily/route.ts:95` (select)
- `src/app/api/cron/seed-rooms-daily/route.ts:79` (select)
- `src/app/api/help-request/route.ts:106` (select)
- `src/app/api/inventory/ai-status/route.ts:50` (select)
- `src/app/api/inventory/check-alerts/route.ts:83` (select)
- `src/app/api/inventory/post-count-process/route.ts:72` (select)
- `src/app/api/morning-resend/route.ts:100` (select)
- `src/app/api/notify-backup/route.ts:79` (select)
- `src/app/api/onboard/wizard/route.ts:93,217` (select)
- `src/app/api/onboarding/complete/route.ts:75,174` (select)
- `src/app/api/pms/job-status/route.ts:53` (select)
- `src/app/api/pms/onboard/route.ts:53` (select)
- `src/app/api/pms/save-credentials/route.ts:126` (select)
- `src/app/api/refresh-from-pms/route.ts:256` (select)
- `src/app/api/send-shift-confirmations/route.ts:207` (select)
- `src/app/api/sms-reply/route.ts:348` (select)
- `src/app/api/stripe/create-checkout/route.ts:57` (select)
- `src/app/api/stripe/portal/route.ts:46` (select)
- `src/lib/agent/context.ts:90` (select)
- `src/lib/agent/nudges.ts:155,303` (select)
- `src/lib/agent/tools/queries.ts:166` (select)
- `src/lib/agent/tools/reports.ts:31` (select)
- `src/lib/db/ml-inventory-cockpit.ts:751,814` (select)
- `src/lib/db/properties.ts:10,16` (select)
- `src/lib/property-config.ts:77` (select)
- `src/lib/rooms/seed.ts:177` (select)

_Raw SQL (`execute_sql` / backtick / triple-quote):_
- `ml-service/src/training/inventory_priors.py:85` (sql_read)

_Via RPC function:_
- `staxis_merge_services()`  _[def: 0037_lock_down_security_definer_functions.sql]_

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `cua-service/src/data-loader.ts:64,145` (update)
- `cua-service/src/job-runner.ts:463` (update)
- `scripts/seed-supabase.js:283,290` (insert,update)
- `src/app/api/admin/properties/create/route.ts:253` (insert)
- `src/app/api/auth/use-join-code/route.ts:223` (update)
- `src/app/api/cron/expire-trials/route.ts:39` (update)
- `src/app/api/inventory/ai-mode/route.ts:56` (update)
- `src/app/api/onboard/wizard/route.ts:243` (update)
- `src/app/api/onboarding/complete/route.ts:180` (update)
- `src/app/api/pms/save-credentials/route.ts:184` (update)
- `src/app/api/stripe/create-checkout/route.ts:85` (update)
- `src/app/api/stripe/webhook/route.ts:149` (update)
- `src/lib/db/properties.ts:22` (update)

_Via RPC function:_
- `staxis_merge_services()`  _[def: 0037_lock_down_security_definer_functions.sql]_

**Flags:** none.

---

### `public_areas`

**Domain:** properties & rooms &nbsp;·&nbsp; **Defined:** 0001_initial_schema.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0001_initial_schema.sql]_ |
| `property_id` | uuid | no | — | FK→properties(id) · _[0001_initial_schema.sql]_ |
| `name` | text | no | — | _[0001_initial_schema.sql]_ |
| `floor` | text | no | — | _[0001_initial_schema.sql]_ |
| `locations` | integer | no | 1 | _[0001_initial_schema.sql]_ |
| `frequency_days` | integer | no | — | _[0001_initial_schema.sql]_ |
| `minutes_per_clean` | integer | no | — | _[0001_initial_schema.sql]_ |
| `start_date` | date | no | — | _[0001_initial_schema.sql]_ |
| `only_when_rented` | boolean | yes | false | _[0001_initial_schema.sql]_ |
| `is_rented_today` | boolean | yes | false | _[0001_initial_schema.sql]_ |
| `created_at` | timestamptz | no | now() | _[0001_initial_schema.sql]_ |

**Indexes & table-level constraints:**

- index `public_areas_property_id_idx` on `(property_id)`  _[0001_initial_schema.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `scripts/seed-supabase.js:418` (select)
- `src/app/api/laundry/bootstrap/route.ts:97` (select)
- `src/lib/db/public-areas.ts:11` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `scripts/seed-supabase.js:431` (insert)
- `src/lib/db/public-areas.ts:18,23,29` (delete,upsert)

**Flags:** none.

---

### `rooms`

**Domain:** properties & rooms &nbsp;·&nbsp; **Defined:** 0001_initial_schema.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0001_initial_schema.sql]_ |
| `property_id` | uuid | no | — | FK→properties(id) · _[0001_initial_schema.sql]_ |
| `number` | text | no | — | _[0001_initial_schema.sql]_ |
| `date` | date | no | — | _[0001_initial_schema.sql]_ |
| `type` | text | no | — | CHECK(type in ('checkout','stayover','vacant')) · _[0001_initial_schema.sql]_ |
| `priority` | text | no | 'standard' | CHECK(priority in ('standard','vip','early')) · _[0001_initial_schema.sql]_ |
| `status` | text | no | 'dirty' | CHECK(status in ('dirty','in_progress','clean','inspected')) · _[0001_initial_schema.sql]_ |
| `assigned_to` | uuid | yes | — | FK→staff(id) · _[0001_initial_schema.sql]_ |
| `assigned_name` | text | yes | — | _[0001_initial_schema.sql]_ |
| `started_at` | timestamptz | yes | — | _[0001_initial_schema.sql]_ |
| `completed_at` | timestamptz | yes | — | _[0001_initial_schema.sql]_ |
| `issue_note` | text | yes | — | _[0001_initial_schema.sql]_ |
| `inspected_by` | text | yes | — | _[0001_initial_schema.sql]_ |
| `inspected_at` | timestamptz | yes | — | _[0001_initial_schema.sql]_ |
| `is_dnd` | boolean | yes | false | _[0001_initial_schema.sql]_ |
| `dnd_note` | text | yes | — | _[0001_initial_schema.sql]_ |
| `arrival` | text | yes | — | _[0001_initial_schema.sql]_ |
| `stayover_day` | integer | yes | — | _[0023_ml_post_review_fixes.sql]_ |
| `stayover_minutes` | integer | yes | — | _[0001_initial_schema.sql]_ |
| `help_requested` | boolean | yes | false | _[0001_initial_schema.sql]_ |
| `checklist` | jsonb | yes | — | _[0001_initial_schema.sql]_ |
| `photo_url` | text | yes | — | _[0001_initial_schema.sql]_ |
| `created_at` | timestamptz | no | now() | _[0001_initial_schema.sql]_ |
| `updated_at` | timestamptz | no | now() | _[0001_initial_schema.sql]_ |
| `last_started_occupancy` | integer | yes | — | _[0021_ml_infrastructure.sql]_ |

**Indexes & table-level constraints:**

- index `rooms_property_date_idx` on `(property_id, date)`  _[0001_initial_schema.sql]_
- index `rooms_property_date_status_idx` on `(property_id, date, status)`  _[0001_initial_schema.sql]_
- index `rooms_assigned_to_idx` on `(assigned_to)`  _[0001_initial_schema.sql]_
- constraint: `unique (property_id, date, number)`  _[0001_initial_schema.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/app/api/admin/doctor/route.ts:2985` (select)
- `src/app/api/cron/schedule-auto-fill/route.ts:153` (select)
- `src/app/api/housekeeper/room-action/route.ts:216` (select)
- `src/app/api/housekeeper/rooms/route.ts:8,89` (select)
- `src/app/api/laundry/bootstrap/route.ts:99` (select)
- `src/app/api/morning-resend/route.ts:127,139,155` (select)
- `src/app/api/refresh-from-pms/route.ts:233` (select)
- `src/app/api/send-shift-confirmations/route.ts:240` (select)
- `src/app/api/sync-room-assignments/route.ts:153` (select)
- `src/lib/agent/context.ts:135,204` (select)
- `src/lib/agent/nudges.ts:232,266,328` (select)
- `src/lib/agent/tools/_helpers.ts:111,139` (select)
- `src/lib/agent/tools/management.ts:193` (select)
- `src/lib/agent/tools/queries.ts:30,73,180,248` (select)
- `src/lib/agent/tools/reports.ts:49` (select)
- `src/lib/db/rooms.ts:24,48,87` (select)
- `src/lib/feature-derivation.ts:83,110,226` (select)
- `src/lib/rooms/seed.ts:172` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `cua-service/src/pull-data-saver.ts:119` (update)
- `scraper/csv-scraper.js:861` (update)
- `src/app/api/housekeeper/room-action/route.ts:7,330,449,499,512,529,545` (update)
- `src/app/api/morning-resend/route.ts:203,215` (update)
- `src/app/api/refresh-from-pms/route.ts:329,352,426` (insert,update,upsert)
- `src/app/api/send-shift-confirmations/route.ts:279,296,309` (update,upsert)
- `src/app/api/sync-room-assignments/route.ts:187,215,225` (update,upsert)
- `src/app/housekeeper/[id]/page.tsx:369` (update)
- `src/lib/agent/tools/management.ts:39` (update)
- `src/lib/agent/tools/room-actions.ts:73,123,172,209,252` (update)
- `src/lib/db/rooms.ts:60,67,72,80` (delete,insert,update)
- `src/lib/rooms/seed.ts:231,246,272` (update,upsert)

**Flags:** none.

---

### Domain: staff & scheduling

### `attendance_marks`

**Domain:** staff & scheduling &nbsp;·&nbsp; **Defined:** 0021_ml_infrastructure.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `property_id` | uuid | no | — | FK→properties(id) · _[0021_ml_infrastructure.sql]_ |
| `date` | date | no | — | _[0021_ml_infrastructure.sql]_ |
| `staff_id` | uuid | no | — | FK→staff(id) · _[0021_ml_infrastructure.sql]_ |
| `attended` | boolean | no | — | _[0021_ml_infrastructure.sql]_ |
| `marked_at` | timestamptz | no | now() | _[0021_ml_infrastructure.sql]_ |
| `marked_by` | uuid | yes | — | _[0021_ml_infrastructure.sql]_ |
| `notes` | text | yes | — | _[0021_ml_infrastructure.sql]_ |

**Indexes & table-level constraints:**

- index `attendance_marks_property_date_idx` on `(property_id, date desc)`  _[0021_ml_infrastructure.sql]_
- constraint: `primary key (property_id, date, staff_id)`  _[0021_ml_infrastructure.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/app/api/cron/seal-daily/route.ts:241` (select)
- `src/lib/db/attendance.ts:95` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/app/api/cron/seal-daily/route.ts:296` (insert)
- `src/lib/db/attendance.ts:54` (upsert)

**Flags:** none.

---

### `manager_notifications`

**Domain:** staff & scheduling &nbsp;·&nbsp; **Defined:** 0001_initial_schema.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0001_initial_schema.sql]_ |
| `property_id` | uuid | no | — | FK→properties(id) · _[0001_initial_schema.sql]_ |
| `type` | text | no | — | CHECK(type in ('decline','no_response','all_confirmed','replace...) · _[0001_initial_schema.sql]_ |
| `message` | text | no | — | _[0001_initial_schema.sql]_ |
| `staff_name` | text | yes | — | _[0001_initial_schema.sql]_ |
| `replacement_name` | text | yes | — | _[0001_initial_schema.sql]_ |
| `shift_date` | date | no | — | _[0001_initial_schema.sql]_ |
| `read` | boolean | no | false | _[0001_initial_schema.sql]_ |
| `created_at` | timestamptz | no | now() | _[0001_initial_schema.sql]_ |

**Indexes & table-level constraints:**

- index `manager_notifications_property_created_idx` on `(property_id, created_at desc)`  _[0001_initial_schema.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/lib/db/manager-notifications.ts:18` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/lib/db/manager-notifications.ts:29,35` (update)

**Flags:** none.

---

### `schedule_assignments`

**Domain:** staff & scheduling &nbsp;·&nbsp; **Defined:** 0001_initial_schema.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `property_id` | uuid | no | — | FK→properties(id) · _[0001_initial_schema.sql]_ |
| `date` | date | no | — | _[0001_initial_schema.sql]_ |
| `room_assignments` | jsonb | no | '{}'::jsonb | _[0001_initial_schema.sql]_ |
| `crew` | uuid[] | no | '{}' | _[0001_initial_schema.sql]_ |
| `staff_names` | jsonb | no | '{}'::jsonb | _[0001_initial_schema.sql]_ |
| `csv_room_snapshot` | jsonb | yes | '[]'::jsonb | _[0001_initial_schema.sql]_ |
| `csv_pulled_at` | timestamptz | yes | — | _[0001_initial_schema.sql]_ |
| `updated_at` | timestamptz | no | now() | _[0001_initial_schema.sql]_ |

**Indexes & table-level constraints:**

- constraint: `primary key (property_id, date)`  _[0001_initial_schema.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `ml-service/src/inference/supply.py:322` (fetch_one)
- `src/app/api/admin/doctor/route.ts:1999` (select)
- `src/app/api/admin/ml/housekeeping/cockpit-data/route.ts:232` (select)
- `src/app/api/cron/schedule-auto-fill/route.ts:89` (select)
- `src/app/api/cron/seal-daily/route.ts:230` (select)
- `src/lib/db/ml-stubs.ts:229` (select)
- `src/lib/db/schedule-assignments.ts:50,88` (select)
- `src/lib/feature-derivation.ts:160` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/app/api/morning-resend/route.ts:272` (upsert)
- `src/app/api/send-shift-confirmations/route.ts:339` (upsert)
- `src/lib/db/schedule-assignments.ts:80` (upsert)

_Via RPC function:_
- `staxis_schedule_auto_fill_if_absent()`  _[def: 0129_schedule_auto_fill_if_absent.sql]_

**Flags:** none.

---

### `shift_confirmations`

**Domain:** staff & scheduling &nbsp;·&nbsp; **Defined:** 0001_initial_schema.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `token` | text | no | — | PK · _[0001_initial_schema.sql]_ |
| `property_id` | uuid | no | — | FK→properties(id) · _[0001_initial_schema.sql]_ |
| `staff_id` | uuid | no | — | FK→staff(id) · _[0001_initial_schema.sql]_ |
| `staff_name` | text | no | — | _[0001_initial_schema.sql]_ |
| `staff_phone` | text | no | — | _[0001_initial_schema.sql]_ |
| `shift_date` | date | no | — | _[0001_initial_schema.sql]_ |
| `status` | text | no | 'sent' | CHECK(status in ('sent','pending','confirmed','declined')) · _[0001_initial_schema.sql]_ |
| `language` | text | no | 'en' | CHECK(language in ('en','es')) · _[0001_initial_schema.sql]_ |
| `sent_at` | timestamptz | yes | — | _[0001_initial_schema.sql]_ |
| `responded_at` | timestamptz | yes | — | _[0001_initial_schema.sql]_ |
| `sms_sent` | boolean | no | false | _[0001_initial_schema.sql]_ |
| `sms_error` | text | yes | — | _[0001_initial_schema.sql]_ |
| `created_at` | timestamptz | no | now() | _[0001_initial_schema.sql]_ |

**Indexes & table-level constraints:**

- index `shift_confirmations_property_date_idx` on `(property_id, shift_date)`  _[0001_initial_schema.sql]_
- index `shift_confirmations_staff_date_idx` on `(staff_id, shift_date)`  _[0001_initial_schema.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/app/api/admin/diagnose/route.ts:94` (select)
- `src/app/api/admin/normalize-confirmation-phones/route.ts:38` (select)
- `src/app/api/admin/test-sms-flow/route.ts:191` (select)
- `src/app/api/morning-resend/route.ts:108` (select)
- `src/app/api/send-shift-confirmations/route.ts:407` (select)
- `src/app/api/sms-reply/route.ts:319` (select)
- `src/lib/db/shift-confirmations.ts:20,33` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/app/api/admin/normalize-confirmation-phones/route.ts:64` (update)
- `src/app/api/admin/test-sms-flow/route.ts:128,161` (insert,update)
- `src/app/api/send-shift-confirmations/route.ts:429,507` (update,upsert)
- `src/app/api/sms-reply/route.ts:372` (update)
- `src/lib/sms-jobs.ts:336,341` (update)

**Flags:** none.

---

### `staff`

**Domain:** staff & scheduling &nbsp;·&nbsp; **Defined:** 0001_initial_schema.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0001_initial_schema.sql]_ |
| `property_id` | uuid | no | — | FK→properties(id) · _[0001_initial_schema.sql]_ |
| `name` | text | no | — | _[0001_initial_schema.sql]_ |
| `phone` | text | yes | — | _[0001_initial_schema.sql]_ |
| `phone_lookup` | text | yes | — | _[0001_initial_schema.sql]_ |
| `language` | text | no | 'en' | CHECK(language in ('en','es')) · _[0001_initial_schema.sql]_ |
| `is_senior` | boolean | no | false | _[0001_initial_schema.sql]_ |
| `department` | text | yes | 'housekeeping' | CHECK(department in ('housekeeping','front_desk','maintenance',...) · _[0001_initial_schema.sql]_ |
| `hourly_wage` | numeric | yes | — | _[0001_initial_schema.sql]_ |
| `scheduled_today` | boolean | no | false | _[0001_initial_schema.sql]_ |
| `weekly_hours` | numeric | no | 0 | _[0001_initial_schema.sql]_ |
| `max_weekly_hours` | numeric | no | 40 | _[0001_initial_schema.sql]_ |
| `max_days_per_week` | integer | yes | 5 | _[0001_initial_schema.sql]_ |
| `days_worked_this_week` | integer | yes | 0 | _[0001_initial_schema.sql]_ |
| `vacation_dates` | text[] | yes | '{}' | _[0001_initial_schema.sql]_ |
| `is_active` | boolean | yes | true | _[0001_initial_schema.sql]_ |
| `schedule_priority` | text | yes | — | CHECK(schedule_priority in ('priority','normal','excluded')) · _[0001_initial_schema.sql]_ |
| `is_scheduling_manager` | boolean | yes | false | _[0001_initial_schema.sql]_ |
| `created_at` | timestamptz | no | now() | _[0001_initial_schema.sql]_ |
| `updated_at` | timestamptz | no | now() | _[0001_initial_schema.sql]_ |
| `last_paired_at` | timestamptz | yes | — | _[0010_staff_last_paired_at.sql]_ |
| `auth_user_id` | uuid | yes | — | _[0024_staff_magic_link_auth.sql]_ |

**Indexes & table-level constraints:**

- index `staff_property_id_idx` on `(property_id)`  _[0001_initial_schema.sql]_
- index `staff_phone_lookup_idx` on `(phone_lookup)`  _[0001_initial_schema.sql]_
- index `staff_auth_user_id_idx` on `(auth_user_id)`  _[0024_staff_magic_link_auth.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `cua-service/src/data-loader.ts:93` (select)
- `scripts/seed-supabase.js:350` (select)
- `src/app/api/admin/backfill-phonelookup/route.ts:33` (select)
- `src/app/api/admin/list-properties/route.ts:137` (select)
- `src/app/api/admin/ml/housekeeping/cockpit-data/route.ts:238` (select)
- `src/app/api/admin/property-health/route.ts:77,82` (select)
- `src/app/api/admin/test-sms-flow/route.ts:103` (select)
- `src/app/api/agent/command/route.ts:141` (select)
- `src/app/api/agent/voice-session/route.ts:103` (select)
- `src/app/api/cron/schedule-auto-fill/route.ts:111` (select)
- `src/app/api/help-request/route.ts:89,108` (select)
- `src/app/api/housekeeper/me/route.ts:6,48` (select)
- `src/app/api/housekeeper/room-action/route.ts:194` (select)
- `src/app/api/housekeeper/rooms/route.ts:68` (select)
- `src/app/api/laundry/bootstrap/route.ts:65` (select)
- `src/app/api/notify-backup/route.ts:81` (select)
- `src/app/api/onboarding/complete/route.ts:189` (select)
- `src/app/api/save-fcm-token/route.ts:58` (select)
- `src/app/api/sms-reply/route.ts:290,304` (select)
- `src/app/api/staff-link/route.ts:67` (select)
- `src/app/api/staff-list/route.ts:54` (select)
- `src/lib/agent/context.ts:182` (select)
- `src/lib/agent/nudges.ts:244` (select)
- `src/lib/agent/tools/_helpers.ts:199` (select)
- `src/lib/agent/tools/management.ts:212` (select)
- `src/lib/agent/tools/queries.ts:119` (select)
- `src/lib/db/housekeeper-helpers.ts:105` (select)
- `src/lib/db/ml-stubs.ts:242` (select)
- `src/lib/db/staff.ts:40,58,76` (select)
- `src/lib/staff-auth.ts:58` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `cua-service/src/data-loader.ts:130` (insert)
- `scripts/seed-supabase.js:386` (insert)
- `src/app/api/admin/backfill-phonelookup/route.ts:55` (update)
- `src/app/api/admin/test-sms-flow/route.ts:145` (update)
- `src/app/api/housekeeper/save-language/route.ts:8,65` (update)
- `src/app/api/onboarding/complete/route.ts:197` (insert)
- `src/app/api/save-fcm-token/route.ts:76` (update)
- `src/app/api/send-shift-confirmations/route.ts:452` (update)
- `src/app/api/sms-reply/route.ts:371` (update)
- `src/lib/db/housekeeper-helpers.ts:157` (update)
- `src/lib/db/staff.ts:91,99,106` (delete,insert,update)
- `src/lib/staff-auth.ts:126,136` (update)

**Flags:**

- **Implied-but-not-enforced FK:** `auth_user_id` (column ends in `_id` but has no `REFERENCES` clause).
- **Possibly-dead columns (no static write detected):** `property_id`, `name`, `phone`, `phone_lookup`, `hourly_wage`, `schedule_priority`, `last_paired_at`. _Caveat: write detection scans `.insert/.update/.upsert` object literals; columns set via raw SQL or RPC may be false positives._

---

### Domain: cleaning & ops

### `cleaning_events`

**Domain:** cleaning & ops &nbsp;·&nbsp; **Defined:** 0012_cleaning_events.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0012_cleaning_events.sql]_ |
| `property_id` | uuid | no | — | FK→properties(id) · _[0012_cleaning_events.sql]_ |
| `date` | date | no | — | _[0012_cleaning_events.sql]_ |
| `room_number` | text | no | — | _[0012_cleaning_events.sql]_ |
| `room_type` | text | no | — | CHECK(room_type in ('checkout','stayover')) · _[0012_cleaning_events.sql]_ |
| `stayover_day` | integer | yes | — | _[0012_cleaning_events.sql]_ |
| `staff_id` | uuid | yes | — | FK→staff(id) · _[0012_cleaning_events.sql]_ |
| `staff_name` | text | no | — | _[0012_cleaning_events.sql]_ |
| `started_at` | timestamptz | no | — | _[0012_cleaning_events.sql]_ |
| `completed_at` | timestamptz | no | — | _[0012_cleaning_events.sql]_ |
| `duration_minutes` | numeric(8,2) | no | — | CHECK(duration_minutes >= 0) · _[0012_cleaning_events.sql]_ |
| `status` | cleaning_event_status | no | 'recorded' | _[0012_cleaning_events.sql]_ |
| `flag_reason` | text | yes | — | _[0012_cleaning_events.sql]_ |
| `reviewed_by` | uuid | yes | — | _[0012_cleaning_events.sql]_ |
| `reviewed_at` | timestamptz | yes | — | _[0012_cleaning_events.sql]_ |
| `created_at` | timestamptz | no | now() | _[0012_cleaning_events.sql]_ |
| `day_of_week` | smallint | yes | — | _[0021_ml_infrastructure.sql]_ |
| `day_of_stay_raw` | integer | yes | — | _[0021_ml_infrastructure.sql]_ |
| `room_floor` | smallint | yes | — | _[0021_ml_infrastructure.sql]_ |
| `occupancy_at_start` | integer | yes | — | _[0021_ml_infrastructure.sql]_ |
| `total_checkouts_today` | integer | yes | — | _[0021_ml_infrastructure.sql]_ |
| `total_rooms_assigned_to_hk` | integer | yes | — | _[0021_ml_infrastructure.sql]_ |
| `route_position` | integer | yes | — | _[0021_ml_infrastructure.sql]_ |
| `minutes_since_shift_start` | integer | yes | — | _[0021_ml_infrastructure.sql]_ |
| `was_dnd_during_clean` | boolean | yes | — | _[0021_ml_infrastructure.sql]_ |
| `weather_class` | text | yes | — | _[0021_ml_infrastructure.sql]_ |
| `feature_set_version` | text | yes | 'v1' | _[0021_ml_infrastructure.sql]_ |

**Indexes & table-level constraints:**

- index `cleaning_events_property_date_idx` on `(property_id, date desc)`  _[0012_cleaning_events.sql]_
- index `cleaning_events_staff_idx` on `(property_id, staff_id, date desc)`  _[0012_cleaning_events.sql]_
- index `cleaning_events_flagged_idx` on `(property_id, created_at desc)`  _[0012_cleaning_events.sql]_
- constraint: `constraint cleaning_events_unique unique (property_id, date, room_number, started_at, completed_at)`  _[0012_cleaning_events.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/app/api/admin/ml/housekeeping/cockpit-data/route.ts:207,213,359` (select)
- `src/app/api/cron/seal-daily/route.ts:252,314` (select)
- `src/app/api/housekeeper/room-action/route.ts:124,295,465` (select)
- `src/lib/agent/nudges.ts:332` (select)
- `src/lib/agent/tools/management.ts:81` (select)
- `src/lib/agent/tools/queries.ts:187` (select)
- `src/lib/db/cleaning-events.ts:195,218,313` (select)
- `src/lib/db/ml-stubs.ts:112,175,235` (select)
- `src/lib/feature-derivation.ts:184,204` (select)
- `src/lib/inventory-estimate.ts:86` (select)
- `src/lib/inventory-predictions.ts:124` (select)

_Raw SQL (`execute_sql` / backtick / triple-quote):_
- `ml-service/src/training/demand_supply_priors.py:221` (sql_read)
- `ml-service/src/training/supply.py:107` (sql_read)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/app/api/housekeeper/room-action/route.ts:418,478` (update,upsert)
- `src/lib/db/cleaning-events.ts:159,251,281` (update,upsert)

**Flags:** none.

---

### `daily_logs`

**Domain:** cleaning & ops &nbsp;·&nbsp; **Defined:** 0001_initial_schema.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0001_initial_schema.sql]_ |
| `property_id` | uuid | no | — | FK→properties(id) · _[0001_initial_schema.sql]_ |
| `date` | date | no | — | _[0001_initial_schema.sql]_ |
| `occupied` | integer | yes | — | _[0001_initial_schema.sql]_ |
| `checkouts` | integer | yes | — | _[0001_initial_schema.sql]_ |
| `two_bed_checkouts` | integer | yes | — | _[0001_initial_schema.sql]_ |
| `stayovers` | integer | yes | — | _[0001_initial_schema.sql]_ |
| `vips` | integer | yes | — | _[0001_initial_schema.sql]_ |
| `early_checkins` | integer | yes | — | _[0001_initial_schema.sql]_ |
| `room_minutes` | integer | yes | — | _[0001_initial_schema.sql]_ |
| `public_area_minutes` | integer | yes | — | _[0001_initial_schema.sql]_ |
| `laundry_minutes` | integer | yes | — | _[0001_initial_schema.sql]_ |
| `total_minutes` | integer | yes | — | _[0001_initial_schema.sql]_ |
| `recommended_staff` | numeric | yes | — | _[0001_initial_schema.sql]_ |
| `actual_staff` | numeric | yes | — | _[0001_initial_schema.sql]_ |
| `hourly_wage` | numeric | yes | — | _[0001_initial_schema.sql]_ |
| `labor_cost` | numeric | yes | — | _[0001_initial_schema.sql]_ |
| `labor_saved` | numeric | yes | — | _[0001_initial_schema.sql]_ |
| `start_time` | text | yes | — | _[0001_initial_schema.sql]_ |
| `completion_time` | text | yes | — | _[0001_initial_schema.sql]_ |
| `public_areas_due_today` | text[] | yes | '{}' | _[0001_initial_schema.sql]_ |
| `laundry_loads` | jsonb | yes | — | _[0001_initial_schema.sql]_ |
| `rooms_completed` | integer | yes | — | _[0001_initial_schema.sql]_ |
| `avg_turnaround_minutes` | integer | yes | — | _[0001_initial_schema.sql]_ |
| `created_at` | timestamptz | no | now() | _[0001_initial_schema.sql]_ |
| `updated_at` | timestamptz | no | now() | _[0001_initial_schema.sql]_ |

**Indexes & table-level constraints:**

- index `daily_logs_property_date_idx` on `(property_id, date)`  _[0001_initial_schema.sql]_
- constraint: `unique (property_id, date)`  _[0001_initial_schema.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `ml-service/src/inference/inventory_rate.py:136` (fetch_many)
- `ml-service/src/training/inventory_rate.py:331` (fetch_many)
- `src/lib/db/daily-logs.ts:11,28` (select)
- `src/lib/db/inventory-accounting.ts:387` (select)
- `src/lib/inventory-estimate.ts:109` (select)
- `src/lib/inventory-predictions.ts:90` (select)

_Raw SQL (`execute_sql` / backtick / triple-quote):_
- `ml-service/src/training/inventory_rate.py:739` (sql_read)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/app/api/cron/seal-daily/route.ts:365` (upsert)
- `src/lib/db/daily-logs.ts:21` (upsert)

**Flags:** none.

---

### `dashboard_by_date`

**Domain:** cleaning & ops &nbsp;·&nbsp; **Defined:** 0001_initial_schema.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `date` | date | no | — | PK · _[0001_initial_schema.sql]_ |
| `in_house` | integer | yes | — | _[0001_initial_schema.sql]_ |
| `arrivals` | integer | yes | — | _[0001_initial_schema.sql]_ |
| `departures` | integer | yes | — | _[0001_initial_schema.sql]_ |
| `in_house_guests` | integer | yes | — | _[0001_initial_schema.sql]_ |
| `arrivals_guests` | integer | yes | — | _[0001_initial_schema.sql]_ |
| `departures_guests` | integer | yes | — | _[0001_initial_schema.sql]_ |
| `pulled_at` | timestamptz | yes | — | _[0001_initial_schema.sql]_ |
| `error_code` | text | yes | — | _[0001_initial_schema.sql]_ |
| `error_message` | text | yes | — | _[0001_initial_schema.sql]_ |
| `error_page` | text | yes | — | _[0001_initial_schema.sql]_ |
| `errored_at` | timestamptz | yes | — | _[0001_initial_schema.sql]_ |
| `property_id` | uuid | no | — | _[0041_dashboard_by_date_property_scoping.sql]_ |

**Indexes & table-level constraints:**

- index `dashboard_by_date_property_idx` on `(property_id, date desc)`  _[0066_property_id_indexes.sql]_
- constraint: `add primary key (date, property_id)`  _[0041_dashboard_by_date_property_scoping.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/app/api/admin/recent-errors/route.ts:80` (select)
- `src/lib/db/dashboard.ts:141,166` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `cua-service/src/pull-data-saver.ts:75` (upsert)
- `scraper/dashboard-pull.js:333` (upsert)

**Flags:**

- **Implied-but-not-enforced FK:** `property_id` (column ends in `_id` but has no `REFERENCES` clause).

---

### `guest_requests`

**Domain:** cleaning & ops &nbsp;·&nbsp; **Defined:** 0001_initial_schema.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0001_initial_schema.sql]_ |
| `property_id` | uuid | no | — | FK→properties(id) · _[0001_initial_schema.sql]_ |
| `room_number` | text | no | — | _[0001_initial_schema.sql]_ |
| `type` | text | no | — | CHECK(type in ('towels','pillows','blanket','iron','crib','toot...) · _[0001_initial_schema.sql]_ |
| `notes` | text | yes | — | _[0001_initial_schema.sql]_ |
| `status` | text | no | 'pending' | CHECK(status in ('pending','in_progress','done')) · _[0001_initial_schema.sql]_ |
| `assigned_to` | uuid | yes | — | FK→staff(id) · _[0001_initial_schema.sql]_ |
| `assigned_name` | text | yes | — | _[0001_initial_schema.sql]_ |
| `created_at` | timestamptz | no | now() | _[0001_initial_schema.sql]_ |
| `completed_at` | timestamptz | yes | — | _[0001_initial_schema.sql]_ |

**Indexes & table-level constraints:**

- index `guest_requests_property_created_idx` on `(property_id, created_at desc)`  _[0001_initial_schema.sql]_
- index `guest_requests_property_status_idx` on `(property_id, status)`  _[0001_initial_schema.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/lib/db/guest-requests.ts:18` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/lib/db/guest-requests.ts:34,42,47` (delete,insert,update)

**Flags:** none.

---

### `handoff_logs`

**Domain:** cleaning & ops &nbsp;·&nbsp; **Defined:** 0001_initial_schema.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0001_initial_schema.sql]_ |
| `property_id` | uuid | no | — | FK→properties(id) · _[0001_initial_schema.sql]_ |
| `shift_type` | text | no | — | CHECK(shift_type in ('morning','afternoon','night')) · _[0001_initial_schema.sql]_ |
| `author` | text | no | — | _[0001_initial_schema.sql]_ |
| `notes` | text | no | — | _[0001_initial_schema.sql]_ |
| `acknowledged` | boolean | no | false | _[0001_initial_schema.sql]_ |
| `acknowledged_by` | text | yes | — | _[0001_initial_schema.sql]_ |
| `acknowledged_at` | timestamptz | yes | — | _[0001_initial_schema.sql]_ |
| `created_at` | timestamptz | no | now() | _[0001_initial_schema.sql]_ |

**Indexes & table-level constraints:**

- index `handoff_logs_property_created_idx` on `(property_id, created_at desc)`  _[0001_initial_schema.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/lib/db/handoff-logs.ts:19` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/lib/db/handoff-logs.ts:43,52` (insert,update)

**Flags:** none.

---

### `inspections`

**Domain:** cleaning & ops &nbsp;·&nbsp; **Defined:** 0001_initial_schema.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0001_initial_schema.sql]_ |
| `property_id` | uuid | no | — | FK→properties(id) · _[0001_initial_schema.sql]_ |
| `name` | text | no | — | _[0001_initial_schema.sql]_ |
| `due_month` | text | no | — | _[0001_initial_schema.sql]_ |
| `frequency_months` | integer | no | — | _[0001_initial_schema.sql]_ |
| `frequency_days` | integer | yes | — | _[0001_initial_schema.sql]_ |
| `last_inspected_date` | date | yes | — | _[0001_initial_schema.sql]_ |
| `notes` | text | yes | — | _[0001_initial_schema.sql]_ |
| `created_at` | timestamptz | no | now() | _[0001_initial_schema.sql]_ |
| `updated_at` | timestamptz | no | now() | _[0001_initial_schema.sql]_ |

**Indexes & table-level constraints:**

- index `inspections_property_id_idx` on `(property_id)`  _[0001_initial_schema.sql]_

**Reads:**

- _none detected_

**Writes:**

- _none detected_

**Flags:**

- **Dead table** — no reads or writes detected anywhere in the codebase.

---

### `landscaping_tasks`

**Domain:** cleaning & ops &nbsp;·&nbsp; **Defined:** 0001_initial_schema.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0001_initial_schema.sql]_ |
| `property_id` | uuid | no | — | FK→properties(id) · _[0001_initial_schema.sql]_ |
| `name` | text | no | — | _[0001_initial_schema.sql]_ |
| `season` | text | no | — | CHECK(season in ('year-round','spring','summer','fall','winter')) · _[0001_initial_schema.sql]_ |
| `frequency_days` | integer | no | — | _[0001_initial_schema.sql]_ |
| `last_completed_at` | timestamptz | yes | — | _[0001_initial_schema.sql]_ |
| `last_completed_by` | text | yes | — | _[0001_initial_schema.sql]_ |
| `notes` | text | yes | — | _[0001_initial_schema.sql]_ |
| `created_at` | timestamptz | no | now() | _[0001_initial_schema.sql]_ |

**Indexes & table-level constraints:**

- index `landscaping_tasks_property_id_idx` on `(property_id)`  _[0001_initial_schema.sql]_

**Reads:**

- _none detected_

**Writes:**

- _none detected_

**Flags:**

- **Dead table** — no reads or writes detected anywhere in the codebase.

---

### `laundry_config`

**Domain:** cleaning & ops &nbsp;·&nbsp; **Defined:** 0001_initial_schema.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0001_initial_schema.sql]_ |
| `property_id` | uuid | no | — | FK→properties(id) · _[0001_initial_schema.sql]_ |
| `name` | text | no | — | _[0001_initial_schema.sql]_ |
| `units_per_checkout` | numeric | no | 0 | _[0001_initial_schema.sql]_ |
| `two_bed_multiplier` | numeric | no | 1 | _[0001_initial_schema.sql]_ |
| `stayover_factor` | numeric | no | 0 | _[0001_initial_schema.sql]_ |
| `room_equivs_per_load` | numeric | no | 1 | _[0001_initial_schema.sql]_ |
| `minutes_per_load` | integer | no | 60 | _[0001_initial_schema.sql]_ |
| `created_at` | timestamptz | no | now() | _[0001_initial_schema.sql]_ |

**Indexes & table-level constraints:**

- index `laundry_config_property_id_idx` on `(property_id)`  _[0001_initial_schema.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `scripts/seed-supabase.js:396` (select)
- `src/app/api/laundry/bootstrap/route.ts:98` (select)
- `src/lib/db/laundry.ts:10` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `scripts/seed-supabase.js:408` (insert)
- `src/lib/db/laundry.ts:17` (upsert)

**Flags:** none.

---

### `plan_snapshots`

**Domain:** cleaning & ops &nbsp;·&nbsp; **Defined:** 0001_initial_schema.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `property_id` | uuid | no | — | FK→properties(id) · _[0001_initial_schema.sql]_ |
| `date` | date | no | — | _[0001_initial_schema.sql]_ |
| `pulled_at` | timestamptz | no | now() | _[0001_initial_schema.sql]_ |
| `pull_type` | text | no | — | CHECK(pull_type in ('morning','evening')) · _[0001_initial_schema.sql]_ |
| `total_rooms` | integer | no | 0 | _[0001_initial_schema.sql]_ |
| `checkouts` | integer | no | 0 | _[0001_initial_schema.sql]_ |
| `stayovers` | integer | no | 0 | _[0001_initial_schema.sql]_ |
| `stayover_day1` | integer | no | 0 | _[0001_initial_schema.sql]_ |
| `stayover_day2` | integer | no | 0 | _[0001_initial_schema.sql]_ |
| `stayover_arrival_day` | integer | no | 0 | _[0001_initial_schema.sql]_ |
| `stayover_unknown` | integer | no | 0 | _[0001_initial_schema.sql]_ |
| `arrivals` | integer | no | 0 | _[0001_initial_schema.sql]_ |
| `vacant_clean` | integer | no | 0 | _[0001_initial_schema.sql]_ |
| `vacant_dirty` | integer | no | 0 | _[0001_initial_schema.sql]_ |
| `ooo` | integer | no | 0 | _[0001_initial_schema.sql]_ |
| `checkout_minutes` | integer | no | 0 | _[0001_initial_schema.sql]_ |
| `stayover_day1_minutes` | integer | no | 0 | _[0001_initial_schema.sql]_ |
| `stayover_day2_minutes` | integer | no | 0 | _[0001_initial_schema.sql]_ |
| `vacant_dirty_minutes` | integer | no | 0 | _[0001_initial_schema.sql]_ |
| `total_cleaning_minutes` | integer | no | 0 | _[0001_initial_schema.sql]_ |
| `recommended_hks` | numeric | no | 0 | _[0001_initial_schema.sql]_ |
| `checkout_room_numbers` | text[] | no | '{}' | _[0001_initial_schema.sql]_ |
| `stayover_day1_room_numbers` | text[] | no | '{}' | _[0001_initial_schema.sql]_ |
| `stayover_day2_room_numbers` | text[] | no | '{}' | _[0001_initial_schema.sql]_ |
| `stayover_arrival_room_numbers` | text[] | no | '{}' | _[0001_initial_schema.sql]_ |
| `arrival_room_numbers` | text[] | no | '{}' | _[0001_initial_schema.sql]_ |
| `vacant_clean_room_numbers` | text[] | no | '{}' | _[0001_initial_schema.sql]_ |
| `vacant_dirty_room_numbers` | text[] | no | '{}' | _[0001_initial_schema.sql]_ |
| `ooo_room_numbers` | text[] | no | '{}' | _[0001_initial_schema.sql]_ |
| `rooms` | jsonb | no | '[]'::jsonb | _[0001_initial_schema.sql]_ |

**Indexes & table-level constraints:**

- index `plan_snapshots_property_pulled_idx` on `(property_id, pulled_at desc)`  _[0001_initial_schema.sql]_
- constraint: `primary key (property_id, date)`  _[0001_initial_schema.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `ml-service/src/inference/inventory_rate.py:121` (fetch_one)
- `src/app/api/cron/schedule-auto-fill/route.ts:218` (select)
- `src/app/api/cron/seal-daily/route.ts:305` (select)
- `src/app/api/populate-rooms-from-plan/route.ts:71` (select)
- `src/app/api/send-shift-confirmations/route.ts:209` (select)
- `src/app/api/sync-room-assignments/route.ts:137` (select)
- `src/lib/db/plan-snapshots.ts:120` (select)
- `src/lib/feature-derivation.ts:144` (select)
- `src/lib/rooms/seed.ts:166` (select)

_Raw SQL (`execute_sql` / backtick / triple-quote):_
- `ml-service/src/inference/demand.py:122` (sql_read)
- `ml-service/src/inference/inventory_rate.py:197` (sql_read)
- `ml-service/src/inference/supply.py:341` (sql_read)
- `ml-service/src/training/demand.py:128` (sql_read)
- `src/app/api/admin/scraper-instances/route.ts:138` (sql_read)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `scraper/csv-scraper.js:824` (upsert)

**Flags:** none.

---

### `preventive_tasks`

**Domain:** cleaning & ops &nbsp;·&nbsp; **Defined:** 0001_initial_schema.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0001_initial_schema.sql]_ |
| `property_id` | uuid | no | — | FK→properties(id) · _[0001_initial_schema.sql]_ |
| `name` | text | no | — | _[0001_initial_schema.sql]_ |
| `frequency_days` | integer | no | — | _[0001_initial_schema.sql]_ |
| `last_completed_at` | timestamptz | yes | — | _[0001_initial_schema.sql]_ |
| `last_completed_by` | text | yes | — | _[0001_initial_schema.sql]_ |
| `notes` | text | yes | — | _[0001_initial_schema.sql]_ |
| `created_at` | timestamptz | no | now() | _[0001_initial_schema.sql]_ |
| `equipment_id` | uuid | yes | — | FK→equipment(id) · _[0030_work_orders_equipment_cost.sql]_ |
| `area` | text | yes | — | _[0131_maintenance_simplify.sql]_ |
| `completion_photo_path` | text | yes | — | _[0131_maintenance_simplify.sql]_ |

**Indexes & table-level constraints:**

- index `preventive_tasks_property_id_idx` on `(property_id)`  _[0001_initial_schema.sql]_
- index `preventive_tasks_equipment_idx` on `(equipment_id)`  _[0030_work_orders_equipment_cost.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/lib/db/preventive.ts:19` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/lib/db/preventive.ts:33,41,46,62` (delete,insert,update)

**Flags:** none.

---

### `pull_jobs`

**Domain:** cleaning & ops &nbsp;·&nbsp; **Defined:** 0042_pull_jobs_queue.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0042_pull_jobs_queue.sql]_ |
| `property_id` | uuid | no | — | FK→properties(id) · _[0042_pull_jobs_queue.sql]_ |
| `pms_type` | text | no | — | _[0042_pull_jobs_queue.sql]_ |
| `status` | text | no | 'queued' | CHECK(status in ('queued','running','complete','failed')) · _[0042_pull_jobs_queue.sql]_ |
| `recipe_id` | uuid | yes | — | FK→pms_recipes(id) · _[0042_pull_jobs_queue.sql]_ |
| `step` | text | yes | — | _[0042_pull_jobs_queue.sql]_ |
| `progress_pct` | int | no | 0 | CHECK(progress_pct between 0 and 100) · _[0042_pull_jobs_queue.sql]_ |
| `scheduled_for` | timestamptz | no | now() | _[0042_pull_jobs_queue.sql]_ |
| `result` | jsonb | yes | — | _[0042_pull_jobs_queue.sql]_ |
| `error` | text | yes | — | _[0042_pull_jobs_queue.sql]_ |
| `error_detail` | jsonb | yes | — | _[0042_pull_jobs_queue.sql]_ |
| `worker_id` | text | yes | — | _[0042_pull_jobs_queue.sql]_ |
| `started_at` | timestamptz | yes | — | _[0042_pull_jobs_queue.sql]_ |
| `completed_at` | timestamptz | yes | — | _[0042_pull_jobs_queue.sql]_ |
| `created_at` | timestamptz | no | now() | _[0042_pull_jobs_queue.sql]_ |
| `updated_at` | timestamptz | no | now() | _[0042_pull_jobs_queue.sql]_ |

**Indexes & table-level constraints:**

- index `pull_jobs_queue_idx` on `(created_at)`  _[0042_pull_jobs_queue.sql]_
- index `pull_jobs_property_recent_idx` on `(property_id, created_at desc)`  _[0042_pull_jobs_queue.sql]_
- index `pull_jobs_running_status_idx` on `(status, started_at)`  _[0042_pull_jobs_queue.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `cua-service/src/pull-job-runner.ts:164` (select)
- `src/app/api/admin/overview-stats/route.ts:63` (select)
- `src/app/api/admin/scheduled-jobs/route.ts:42` (select)

_Via RPC function:_
- `staxis_enqueue_property_pull()`  _[def: 0042_pull_jobs_queue.sql]_
- `staxis_claim_next_pull_job()`  _[def: 0042_pull_jobs_queue.sql]_

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `cua-service/src/pull-job-runner.ts:234,249,272` (update)

_Via RPC function:_
- `staxis_enqueue_property_pull()`  _[def: 0042_pull_jobs_queue.sql]_
- `staxis_claim_next_pull_job()`  _[def: 0042_pull_jobs_queue.sql]_
- `staxis_reap_stale_pull_jobs()`  _[def: 0042_pull_jobs_queue.sql]_

**Flags:** none.

---

### Domain: inventory

### `equipment`

**Domain:** inventory &nbsp;·&nbsp; **Defined:** 0029_equipment_registry.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0029_equipment_registry.sql]_ |
| `property_id` | uuid | no | — | FK→properties(id) · _[0029_equipment_registry.sql]_ |
| `name` | text | no | — | _[0029_equipment_registry.sql]_ |
| `category` | text | no | — | CHECK(category in
                             ('hvac','plumbin...) · _[0029_equipment_registry.sql]_ |
| `location` | text | yes | — | _[0029_equipment_registry.sql]_ |
| `model_number` | text | yes | — | _[0029_equipment_registry.sql]_ |
| `manufacturer` | text | yes | — | _[0029_equipment_registry.sql]_ |
| `install_date` | date | yes | — | _[0029_equipment_registry.sql]_ |
| `expected_lifetime_years` | numeric | yes | — | _[0029_equipment_registry.sql]_ |
| `purchase_cost` | numeric | yes | — | _[0029_equipment_registry.sql]_ |
| `replacement_cost` | numeric | yes | — | _[0029_equipment_registry.sql]_ |
| `status` | text | no | 'operational' | CHECK(status in
                             ('operational','de...) · _[0029_equipment_registry.sql]_ |
| `pm_interval_days` | integer | yes | — | _[0029_equipment_registry.sql]_ |
| `last_pm_at` | timestamptz | yes | — | _[0029_equipment_registry.sql]_ |
| `notes` | text | yes | — | _[0029_equipment_registry.sql]_ |
| `created_at` | timestamptz | no | now() | _[0029_equipment_registry.sql]_ |
| `updated_at` | timestamptz | no | now() | _[0029_equipment_registry.sql]_ |
| `vendor_id` | uuid | yes | — | FK→vendors(id) · _[0043_vendors_contracts.sql]_ |
| `warranty_end_date` | date | yes | — | _[0043_vendors_contracts.sql]_ |

**Indexes & table-level constraints:**

- index `equipment_property_idx` on `(property_id, category)`  _[0029_equipment_registry.sql]_
- index `equipment_status_idx` on `(property_id, status)`  _[0029_equipment_registry.sql]_
- index `equipment_vendor_idx` on `(vendor_id)`  _[0043_vendors_contracts.sql]_
- index `equipment_warranty_idx` on `(property_id, warranty_end_date)`  _[0043_vendors_contracts.sql]_

**Reads:**

- _none detected_

**Writes:**

- _none detected_

**Flags:**

- **Dead table** — no reads or writes detected anywhere in the codebase.

---

### `inventory`

**Domain:** inventory &nbsp;·&nbsp; **Defined:** 0001_initial_schema.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0001_initial_schema.sql]_ |
| `property_id` | uuid | no | — | FK→properties(id) · _[0001_initial_schema.sql]_ |
| `name` | text | no | — | _[0001_initial_schema.sql]_ |
| `category` | text | no | — | CHECK(category in ('housekeeping','maintenance','breakfast')) · _[0001_initial_schema.sql]_ |
| `current_stock` | numeric | no | 0 | _[0001_initial_schema.sql]_ |
| `par_level` | numeric | no | 0 | _[0001_initial_schema.sql]_ |
| `reorder_at` | numeric | yes | — | _[0001_initial_schema.sql]_ |
| `unit` | text | no | — | _[0001_initial_schema.sql]_ |
| `notes` | text | yes | — | _[0001_initial_schema.sql]_ |
| `usage_per_checkout` | numeric | yes | — | _[0001_initial_schema.sql]_ |
| `usage_per_stayover` | numeric | yes | — | _[0001_initial_schema.sql]_ |
| `reorder_lead_days` | integer | yes | 3 | _[0001_initial_schema.sql]_ |
| `vendor_name` | text | yes | — | _[0001_initial_schema.sql]_ |
| `last_ordered_at` | timestamptz | yes | — | _[0001_initial_schema.sql]_ |
| `updated_at` | timestamptz | no | now() | _[0001_initial_schema.sql]_ |
| `unit_cost` | numeric | yes | — | _[0026_inventory_intelligence.sql]_ |
| `last_alerted_at` | timestamptz | yes | — | _[0026_inventory_intelligence.sql]_ |
| `last_counted_at` | timestamptz | yes | — | _[0027_inventory_last_counted_at.sql]_ |
| `pack_size` | integer | yes | — | _[0061_inventory_packs.sql]_ |
| `case_unit` | text | yes | — | _[0061_inventory_packs.sql]_ |

**Indexes & table-level constraints:**

- index `inventory_property_category_idx` on `(property_id, category)`  _[0001_initial_schema.sql]_
- UNIQUE index `inventory_property_name_unique_idx` on `(property_id, lower(name)`  _[0089_inventory_unique_name.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `ml-service/src/inference/inventory_rate.py:270` (fetch_one)
- `ml-service/src/training/inventory_rate.py:164,170` (fetch_many)
- `src/app/api/admin/ml/inventory/cockpit-data/route.ts:223,384` (select)
- `src/app/api/inventory/ai-status/route.ts:62` (select)
- `src/app/api/inventory/check-alerts/route.ts:111` (select)
- `src/lib/agent/nudges.ts:373` (select)
- `src/lib/agent/tools/reports.ts:141` (select)
- `src/lib/db/inventory-accounting.ts:114` (select)
- `src/lib/db/inventory.ts:18` (select)
- `src/lib/db/ml-inventory-cockpit.ts:194,270,826` (select)

_Via RPC function:_
- `staxis_install_cold_start_model_run()`  _[def: 0097_cold_start_parent_check.sql]_

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/app/api/admin/properties/create/route.ts:305` (insert)
- `src/app/api/inventory/check-alerts/route.ts:144` (update)
- `src/lib/db/inventory-orders.ts:53` (update)
- `src/lib/db/inventory.ts:39,60,65` (delete,insert,update)

**Flags:** none.

---

### `inventory_budgets`

**Domain:** inventory &nbsp;·&nbsp; **Defined:** 0061_inventory_packs.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `property_id` | uuid | no | — | FK→properties(id) · _[0061_inventory_packs.sql]_ |
| `category` | text | no | — | CHECK(category in ('housekeeping','maintenance','breakfast')) · _[0061_inventory_packs.sql]_ |
| `month_start` | date | no | — | _[0061_inventory_packs.sql]_ |
| `budget_cents` | integer | no | — | CHECK(budget_cents >= 0) · _[0061_inventory_packs.sql]_ |
| `notes` | text | yes | — | _[0061_inventory_packs.sql]_ |
| `updated_at` | timestamptz | no | now() | _[0061_inventory_packs.sql]_ |
| `created_at` | timestamptz | no | now() | _[0061_inventory_packs.sql]_ |

**Indexes & table-level constraints:**

- index `inventory_budgets_property_month_idx` on `(property_id, month_start desc)`  _[0061_inventory_packs.sql]_
- constraint: `primary key (property_id, category, month_start)`  _[0061_inventory_packs.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/lib/db/inventory-accounting.ts:150` (select)
- `src/lib/db/inventory-budgets.ts:32` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/lib/db/inventory-budgets.ts:60,72` (delete,upsert)

**Flags:** none.

---

### `inventory_counts`

**Domain:** inventory &nbsp;·&nbsp; **Defined:** 0026_inventory_intelligence.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0026_inventory_intelligence.sql]_ |
| `property_id` | uuid | no | — | FK→properties(id) · _[0026_inventory_intelligence.sql]_ |
| `item_id` | uuid | no | — | FK→inventory(id) · _[0026_inventory_intelligence.sql]_ |
| `item_name` | text | no | — | _[0026_inventory_intelligence.sql]_ |
| `counted_stock` | numeric | no | — | _[0026_inventory_intelligence.sql]_ |
| `estimated_stock` | numeric | yes | — | _[0026_inventory_intelligence.sql]_ |
| `variance` | numeric | yes | — | _[0026_inventory_intelligence.sql]_ |
| `variance_value` | numeric | yes | — | _[0026_inventory_intelligence.sql]_ |
| `unit_cost` | numeric | yes | — | _[0026_inventory_intelligence.sql]_ |
| `counted_at` | timestamptz | no | now() | _[0026_inventory_intelligence.sql]_ |
| `counted_by` | text | yes | — | _[0026_inventory_intelligence.sql]_ |
| `notes` | text | yes | — | _[0026_inventory_intelligence.sql]_ |
| `created_at` | timestamptz | no | now() | _[0026_inventory_intelligence.sql]_ |

**Indexes & table-level constraints:**

- index `inventory_counts_property_date_idx` on `(property_id, counted_at desc)`  _[0026_inventory_intelligence.sql]_
- index `inventory_counts_item_idx` on `(item_id, counted_at desc)`  _[0026_inventory_intelligence.sql]_
- constraint: `add constraint inventory_counts_counted_stock_nonneg   check (counted_stock >= 0)`  _[0084_inventory_count_check.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `ml-service/src/inference/inventory_rate.py:392` (fetch_many)
- `ml-service/src/training/inventory_rate.py:262` (fetch_many)
- `src/app/api/admin/ml/inventory/cockpit-data/route.ts:215,258,379` (select)
- `src/app/api/inventory/ai-status/route.ts:55` (select)
- `src/app/api/inventory/post-count-process/route.ts:93` (select)
- `src/lib/db/inventory-counts.ts:51` (select)
- `src/lib/db/ml-inventory-cockpit.ts:115,159,203,429,819` (select)

_Raw SQL (`execute_sql` / backtick / triple-quote):_
- `ml-service/src/training/inventory_priors.py:85` (sql_read)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/lib/db/inventory-counts.ts:21,41` (insert)

**Flags:** none.

---

### `inventory_discards`

**Domain:** inventory &nbsp;·&nbsp; **Defined:** 0061_inventory_packs.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0061_inventory_packs.sql]_ |
| `property_id` | uuid | no | — | FK→properties(id) · _[0061_inventory_packs.sql]_ |
| `item_id` | uuid | no | — | FK→inventory(id) · _[0061_inventory_packs.sql]_ |
| `item_name` | text | no | — | _[0061_inventory_packs.sql]_ |
| `quantity` | integer | no | — | CHECK(quantity > 0) · _[0061_inventory_packs.sql]_ |
| `reason` | text | no | — | CHECK(reason in ('stained','damaged','lost','theft','other')) · _[0061_inventory_packs.sql]_ |
| `cost_value` | numeric | yes | — | _[0061_inventory_packs.sql]_ |
| `unit_cost` | numeric | yes | — | _[0061_inventory_packs.sql]_ |
| `discarded_at` | timestamptz | no | now() | _[0061_inventory_packs.sql]_ |
| `discarded_by` | text | yes | — | _[0061_inventory_packs.sql]_ |
| `notes` | text | yes | — | _[0061_inventory_packs.sql]_ |
| `created_at` | timestamptz | no | now() | _[0061_inventory_packs.sql]_ |

**Indexes & table-level constraints:**

- index `inventory_discards_property_date_idx` on `(property_id, discarded_at desc)`  _[0061_inventory_packs.sql]_
- index `inventory_discards_item_idx` on `(item_id, discarded_at desc)`  _[0061_inventory_packs.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `ml-service/src/inference/inventory_rate.py:436` (select)
- `ml-service/src/training/inventory_rate.py:322` (fetch_many)
- `src/lib/db/inventory-accounting.ts:131,266,342` (select)
- `src/lib/db/inventory-discards.ts:41,62,87` (select)

_Raw SQL (`execute_sql` / backtick / triple-quote):_
- `ml-service/src/training/inventory_priors.py:85` (sql_read)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/lib/db/inventory-discards.ts:30` (insert)

**Flags:** none.

---

### `inventory_orders`

**Domain:** inventory &nbsp;·&nbsp; **Defined:** 0026_inventory_intelligence.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0026_inventory_intelligence.sql]_ |
| `property_id` | uuid | no | — | FK→properties(id) · _[0026_inventory_intelligence.sql]_ |
| `item_id` | uuid | no | — | FK→inventory(id) · _[0026_inventory_intelligence.sql]_ |
| `item_name` | text | no | — | _[0026_inventory_intelligence.sql]_ |
| `quantity` | numeric | no | — | CHECK(quantity >= 0) · _[0026_inventory_intelligence.sql]_ |
| `unit_cost` | numeric | yes | — | _[0026_inventory_intelligence.sql]_ |
| `total_cost` | numeric | yes | — | _[0026_inventory_intelligence.sql]_ |
| `vendor_name` | text | yes | — | _[0026_inventory_intelligence.sql]_ |
| `ordered_at` | timestamptz | yes | — | _[0026_inventory_intelligence.sql]_ |
| `received_at` | timestamptz | no | now() | _[0026_inventory_intelligence.sql]_ |
| `notes` | text | yes | — | _[0026_inventory_intelligence.sql]_ |
| `created_at` | timestamptz | no | now() | _[0026_inventory_intelligence.sql]_ |
| `quantity_cases` | integer | yes | — | _[0061_inventory_packs.sql]_ |

**Indexes & table-level constraints:**

- index `inventory_orders_property_received_idx` on `(property_id, received_at desc)`  _[0026_inventory_intelligence.sql]_
- index `inventory_orders_item_idx` on `(item_id, received_at desc)`  _[0026_inventory_intelligence.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `ml-service/src/inference/inventory_rate.py:428` (select)
- `ml-service/src/training/inventory_rate.py:315` (fetch_many)
- `src/lib/db/inventory-accounting.ts:122,258,402` (select)
- `src/lib/db/inventory-budgets.ts:95` (select)
- `src/lib/db/inventory-orders.ts:68` (select)

_Raw SQL (`execute_sql` / backtick / triple-quote):_
- `ml-service/src/training/inventory_priors.py:85` (sql_read)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/lib/db/inventory-orders.ts:37` (insert)

**Flags:** none.

---

### `inventory_rate_prediction_history`

**Domain:** inventory &nbsp;·&nbsp; **Defined:** 0075_inventory_prediction_history.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0075_inventory_prediction_history.sql]_ |
| `source_prediction_id` | uuid | no | — | _[0075_inventory_prediction_history.sql]_ |
| `property_id` | uuid | no | — | _[0075_inventory_prediction_history.sql]_ |
| `item_id` | uuid | yes | — | _[0075_inventory_prediction_history.sql]_ |
| `item_name` | text | yes | — | _[0075_inventory_prediction_history.sql]_ |
| `predicted_for_date` | date | no | — | _[0075_inventory_prediction_history.sql]_ |
| `predicted_daily_rate` | numeric | yes | — | _[0075_inventory_prediction_history.sql]_ |
| `predicted_daily_rate_p10` | numeric | yes | — | _[0075_inventory_prediction_history.sql]_ |
| `predicted_daily_rate_p25` | numeric | yes | — | _[0075_inventory_prediction_history.sql]_ |
| `predicted_daily_rate_p50` | numeric | yes | — | _[0075_inventory_prediction_history.sql]_ |
| `predicted_daily_rate_p75` | numeric | yes | — | _[0075_inventory_prediction_history.sql]_ |
| `predicted_daily_rate_p90` | numeric | yes | — | _[0075_inventory_prediction_history.sql]_ |
| `predicted_current_stock` | numeric | yes | — | _[0075_inventory_prediction_history.sql]_ |
| `model_run_id` | uuid | yes | — | _[0075_inventory_prediction_history.sql]_ |
| `predicted_at` | timestamptz | yes | — | _[0075_inventory_prediction_history.sql]_ |
| `is_shadow` | boolean | yes | — | _[0075_inventory_prediction_history.sql]_ |
| `recorded_at` | timestamptz | no | now() | _[0075_inventory_prediction_history.sql]_ |

**Indexes & table-level constraints:**

- index `inventory_rate_prediction_history_property_date_idx` on `(property_id, predicted_for_date desc)`  _[0075_inventory_prediction_history.sql]_
- index `inventory_rate_prediction_history_recorded_at_idx` on `(recorded_at desc)`  _[0075_inventory_prediction_history.sql]_
- constraint: `add constraint inventory_rate_prediction_history_property_id_fkey   foreign key (property_id) references public.properties(id)   on delete cascade`  _[0077_codex_audit_fks.sql]_

**Reads:**

- _none detected_

**Writes:**

- _none detected_

**Flags:**

- **Dead table** — no reads or writes detected anywhere in the codebase.
- **Implied-but-not-enforced FK:** `source_prediction_id`, `property_id`, `item_id`, `model_run_id` (column ends in `_id` but has no `REFERENCES` clause).

---

### `inventory_rate_predictions`

**Domain:** inventory &nbsp;·&nbsp; **Defined:** 0062_inventory_ml_foundation.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0062_inventory_ml_foundation.sql]_ |
| `property_id` | uuid | no | — | FK→properties(id) · _[0062_inventory_ml_foundation.sql]_ |
| `item_id` | uuid | no | — | FK→inventory(id) · _[0062_inventory_ml_foundation.sql]_ |
| `item_name` | text | no | — | _[0062_inventory_ml_foundation.sql]_ |
| `predicted_for_date` | date | no | — | _[0062_inventory_ml_foundation.sql]_ |
| `predicted_daily_rate` | numeric(12,4) | no | — | _[0062_inventory_ml_foundation.sql]_ |
| `predicted_daily_rate_p10` | numeric(12,4) | yes | — | _[0062_inventory_ml_foundation.sql]_ |
| `predicted_daily_rate_p25` | numeric(12,4) | yes | — | _[0062_inventory_ml_foundation.sql]_ |
| `predicted_daily_rate_p50` | numeric(12,4) | yes | — | _[0062_inventory_ml_foundation.sql]_ |
| `predicted_daily_rate_p75` | numeric(12,4) | yes | — | _[0062_inventory_ml_foundation.sql]_ |
| `predicted_daily_rate_p90` | numeric(12,4) | yes | — | _[0062_inventory_ml_foundation.sql]_ |
| `predicted_current_stock` | numeric(12,4) | yes | — | _[0062_inventory_ml_foundation.sql]_ |
| `model_run_id` | uuid | no | — | FK→model_runs(id) · _[0062_inventory_ml_foundation.sql]_ |
| `predicted_at` | timestamptz | no | now() | _[0062_inventory_ml_foundation.sql]_ |
| `is_shadow` | boolean | no | false | _[0070_ml_shadow_mode.sql]_ |

**Indexes & table-level constraints:**

- index `inventory_rate_predictions_property_item_idx` on `(property_id, item_id, predicted_for_date desc)`  _[0062_inventory_ml_foundation.sql]_
- index `inventory_rate_predictions_property_date_idx` on `(property_id, predicted_for_date desc)`  _[0062_inventory_ml_foundation.sql]_
- index `inventory_rate_predictions_model_run_idx` on `(model_run_id)`  _[0062_inventory_ml_foundation.sql]_
- UNIQUE index `inventory_rate_predictions_active_unique_idx` on `(property_id, item_id, predicted_for_date)`  _[0070_ml_shadow_mode.sql]_
- UNIQUE index `inventory_rate_predictions_shadow_unique_idx` on `(property_id, item_id, predicted_for_date)`  _[0070_ml_shadow_mode.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/app/api/admin/doctor/route.ts:1940` (select)
- `src/app/api/admin/ml/inventory/cockpit-data/route.ts:239,394` (select)
- `src/app/api/inventory/ai-status/route.ts:73` (select)
- `src/app/api/inventory/post-count-process/route.ts:114` (select)
- `src/lib/db/ml-inventory-cockpit.ts:263,358,379,485,607,837` (select)
- `src/lib/inventory-predictions.ts:205` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `ml-service/src/inference/inventory_rate.py:282,291` (delete,insert)

**Flags:** none.

---

### `inventory_rate_priors`

**Domain:** inventory &nbsp;·&nbsp; **Defined:** 0062_inventory_ml_foundation.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0062_inventory_ml_foundation.sql]_ |
| `cohort_key` | text | no | — | _[0062_inventory_ml_foundation.sql]_ |
| `item_canonical_name` | text | no | — | _[0062_inventory_ml_foundation.sql]_ |
| `prior_rate_per_room_per_day` | numeric(10,4) | no | — | _[0062_inventory_ml_foundation.sql]_ |
| `n_hotels_contributing` | integer | no | 0 | _[0062_inventory_ml_foundation.sql]_ |
| `prior_strength` | numeric(6,2) | no | 1.0 | _[0062_inventory_ml_foundation.sql]_ |
| `source` | text | no | 'industry-benchmark' | _[0062_inventory_ml_foundation.sql]_ |
| `updated_at` | timestamptz | no | now() | _[0062_inventory_ml_foundation.sql]_ |

**Indexes & table-level constraints:**

- index `inventory_rate_priors_cohort_idx` on `(cohort_key, item_canonical_name)`  _[0062_inventory_ml_foundation.sql]_
- constraint: `unique (cohort_key, item_canonical_name)`  _[0062_inventory_ml_foundation.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `ml-service/src/training/inventory_rate.py:806` (fetch_many)
- `src/app/api/admin/doctor/route.ts:2543` (select)
- `src/lib/db/ml-inventory-cockpit.ts:753` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `ml-service/src/training/inventory_priors.py:329` (upsert)

**Flags:** none.

---

### `inventory_reconciliations`

**Domain:** inventory &nbsp;·&nbsp; **Defined:** 0061_inventory_packs.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0061_inventory_packs.sql]_ |
| `property_id` | uuid | no | — | FK→properties(id) · _[0061_inventory_packs.sql]_ |
| `item_id` | uuid | no | — | FK→inventory(id) · _[0061_inventory_packs.sql]_ |
| `item_name` | text | no | — | _[0061_inventory_packs.sql]_ |
| `reconciled_at` | timestamptz | no | now() | _[0061_inventory_packs.sql]_ |
| `physical_count` | integer | no | — | CHECK(physical_count >= 0) · _[0061_inventory_packs.sql]_ |
| `system_estimate` | integer | no | — | _[0061_inventory_packs.sql]_ |
| `discards_since_last` | integer | no | 0 | _[0061_inventory_packs.sql]_ |
| `unaccounted_variance` | integer | no | — | _[0061_inventory_packs.sql]_ |
| `unaccounted_variance_value` | numeric | yes | — | _[0061_inventory_packs.sql]_ |
| `unit_cost` | numeric | yes | — | _[0061_inventory_packs.sql]_ |
| `reconciled_by` | text | yes | — | _[0061_inventory_packs.sql]_ |
| `notes` | text | yes | — | _[0061_inventory_packs.sql]_ |
| `created_at` | timestamptz | no | now() | _[0061_inventory_packs.sql]_ |

**Indexes & table-level constraints:**

- index `inventory_reconciliations_property_date_idx` on `(property_id, reconciled_at desc)`  _[0061_inventory_packs.sql]_
- index `inventory_reconciliations_item_idx` on `(item_id, reconciled_at desc)`  _[0061_inventory_packs.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/lib/db/inventory-accounting.ts:140,348` (select)
- `src/lib/db/inventory-reconciliations.ts:49` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/lib/db/inventory-reconciliations.ts:38` (insert)

**Flags:** none.

---

### Domain: ml & predictions

### `demand_predictions`

**Domain:** ml & predictions &nbsp;·&nbsp; **Defined:** 0021_ml_infrastructure.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0021_ml_infrastructure.sql]_ |
| `property_id` | uuid | no | — | FK→properties(id) · _[0021_ml_infrastructure.sql]_ |
| `date` | date | no | — | _[0021_ml_infrastructure.sql]_ |
| `predicted_minutes_p10` | numeric(10,2) | yes | — | _[0021_ml_infrastructure.sql]_ |
| `predicted_minutes_p25` | numeric(10,2) | yes | — | _[0021_ml_infrastructure.sql]_ |
| `predicted_minutes_p50` | numeric(10,2) | no | — | _[0021_ml_infrastructure.sql]_ |
| `predicted_minutes_p75` | numeric(10,2) | yes | — | _[0021_ml_infrastructure.sql]_ |
| `predicted_minutes_p90` | numeric(10,2) | yes | — | _[0021_ml_infrastructure.sql]_ |
| `predicted_minutes_p95` | numeric(10,2) | yes | — | _[0021_ml_infrastructure.sql]_ |
| `predicted_headcount_p50` | numeric(6,2) | yes | — | _[0021_ml_infrastructure.sql]_ |
| `predicted_headcount_p80` | numeric(6,2) | yes | — | _[0021_ml_infrastructure.sql]_ |
| `predicted_headcount_p95` | numeric(6,2) | yes | — | _[0021_ml_infrastructure.sql]_ |
| `features_snapshot` | jsonb | yes | — | _[0021_ml_infrastructure.sql]_ |
| `model_run_id` | uuid | no | — | FK→model_runs(id) · _[0021_ml_infrastructure.sql]_ |
| `predicted_at` | timestamptz | no | now() | _[0021_ml_infrastructure.sql]_ |

**Indexes & table-level constraints:**

- index `demand_predictions_property_date_idx` on `(property_id, date desc)`  _[0021_ml_infrastructure.sql]_
- constraint: `unique (property_id, date, model_run_id)`  _[0021_ml_infrastructure.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `ml-service/src/optimizer/monte_carlo.py:197` (fetch_many)
- `src/app/api/admin/ml/housekeeping/cockpit-data/route.ts:306,370` (select)
- `src/lib/db/ml-stubs.ts:341,458` (select)
- `src/lib/ml-schedule-helpers.ts:105` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `ml-service/src/inference/demand.py:424` (upsert)

**Flags:** none.

---

### `demand_priors`

**Domain:** ml & predictions &nbsp;·&nbsp; **Defined:** 0122_demand_supply_priors.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0122_demand_supply_priors.sql]_ |
| `cohort_key` | text | no | — | _[0122_demand_supply_priors.sql]_ |
| `prior_minutes_per_room_per_day` | numeric(10,4) | no | — | _[0122_demand_supply_priors.sql]_ |
| `n_hotels_contributing` | integer | no | 0 | _[0122_demand_supply_priors.sql]_ |
| `prior_strength` | numeric(6,2) | no | 1.0 | _[0122_demand_supply_priors.sql]_ |
| `source` | text | no | 'industry-benchmark' | CHECK(source IN ('industry-benchmark', 'cohort-aggregate')) · _[0122_demand_supply_priors.sql]_ |
| `updated_at` | timestamptz | no | now() | _[0122_demand_supply_priors.sql]_ |

**Indexes & table-level constraints:**

- index `demand_priors_cohort_idx` on `(cohort_key)`  _[0122_demand_supply_priors.sql]_
- constraint: `UNIQUE (cohort_key)`  _[0122_demand_supply_priors.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `ml-service/src/training/demand.py:169` (fetch_one)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `ml-service/src/training/demand_supply_priors.py:175` (upsert)

**Flags:** none.

---

### `ml_feature_flags`

**Domain:** ml & predictions &nbsp;·&nbsp; **Defined:** 0021_ml_infrastructure.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `property_id` | uuid | no | — | PK · FK→properties(id) · _[0021_ml_infrastructure.sql]_ |
| `predictions_enabled` | boolean | no | true | _[0021_ml_infrastructure.sql]_ |
| `demand_layer_enabled` | boolean | no | true | _[0021_ml_infrastructure.sql]_ |
| `supply_layer_enabled` | boolean | no | true | _[0021_ml_infrastructure.sql]_ |
| `optimizer_enabled` | boolean | no | true | _[0021_ml_infrastructure.sql]_ |
| `shadow_mode_enabled` | boolean | no | true | _[0021_ml_infrastructure.sql]_ |
| `target_completion_prob` | numeric(4,3) | no | 0.95 | CHECK(target_completion_prob between 0.5 and 0.999) · _[0021_ml_infrastructure.sql]_ |
| `updated_at` | timestamptz | no | now() | _[0021_ml_infrastructure.sql]_ |
| `updated_by` | uuid | yes | — | _[0021_ml_infrastructure.sql]_ |
| `inventory_layer_enabled` | boolean | no | true | _[0062_inventory_ml_foundation.sql]_ |

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `ml-service/src/optimizer/monte_carlo.py:213` (fetch_one)

**Writes:**

- _none detected_

**Flags:**

- **Read-only table** — never written by any service (read-only after seed/migration).

---

### `model_runs`

**Domain:** ml & predictions &nbsp;·&nbsp; **Defined:** 0021_ml_infrastructure.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0021_ml_infrastructure.sql]_ |
| `property_id` | uuid | no | — | FK→properties(id) · _[0021_ml_infrastructure.sql]_ |
| `layer` | text | no | — | CHECK(layer in ('demand','supply','optimizer')) · _[0021_ml_infrastructure.sql]_ |
| `trained_at` | timestamptz | no | now() | _[0021_ml_infrastructure.sql]_ |
| `training_row_count` | integer | no | — | _[0021_ml_infrastructure.sql]_ |
| `feature_set_version` | text | no | 'v1' | _[0021_ml_infrastructure.sql]_ |
| `model_version` | text | no | — | _[0021_ml_infrastructure.sql]_ |
| `algorithm` | text | no | — | _[0021_ml_infrastructure.sql]_ |
| `model_blob_path` | text | yes | — | _[0023_ml_post_review_fixes.sql]_ |
| `hyperparameters` | jsonb | yes | — | _[0021_ml_infrastructure.sql]_ |
| `training_mae` | numeric(10,4) | yes | — | _[0021_ml_infrastructure.sql]_ |
| `validation_mae` | numeric(10,4) | yes | — | _[0021_ml_infrastructure.sql]_ |
| `baseline_mae` | numeric(10,4) | yes | — | _[0021_ml_infrastructure.sql]_ |
| `beats_baseline_pct` | numeric(8,4) | yes | — | _[0021_ml_infrastructure.sql]_ |
| `validation_holdout_n` | integer | yes | — | _[0021_ml_infrastructure.sql]_ |
| `is_active` | boolean | no | false | _[0021_ml_infrastructure.sql]_ |
| `activated_at` | timestamptz | yes | — | _[0021_ml_infrastructure.sql]_ |
| `deactivated_at` | timestamptz | yes | — | _[0021_ml_infrastructure.sql]_ |
| `deactivation_reason` | text | yes | — | _[0021_ml_infrastructure.sql]_ |
| `consecutive_passing_runs` | integer | no | 0 | _[0021_ml_infrastructure.sql]_ |
| `notes` | text | yes | — | _[0021_ml_infrastructure.sql]_ |
| `created_at` | timestamptz | no | now() | _[0021_ml_infrastructure.sql]_ |
| `posterior_params` | jsonb | yes | — | _[0023_ml_post_review_fixes.sql]_ |
| `auto_fill_enabled` | boolean | no | false | _[0062_inventory_ml_foundation.sql]_ |
| `auto_fill_enabled_at` | timestamptz | yes | — | _[0062_inventory_ml_foundation.sql]_ |
| `item_id` | uuid | yes | — | _[0062_inventory_ml_foundation.sql]_ |
| `is_shadow` | boolean | no | false | _[0070_ml_shadow_mode.sql]_ |
| `shadow_started_at` | timestamptz | yes | — | _[0070_ml_shadow_mode.sql]_ |
| `shadow_evaluation_mae` | numeric | yes | — | _[0070_ml_shadow_mode.sql]_ |
| `shadow_promoted_at` | timestamptz | yes | — | _[0070_ml_shadow_mode.sql]_ |
| `is_cold_start` | boolean | no | false | _[0123_demand_supply_cold_start_table_return.sql]_ |
| `cold_start` | boolean | no | false | _[0130_model_runs_cold_start_flag.sql]_ |

**Indexes & table-level constraints:**

- index `model_runs_property_layer_idx` on `(property_id, layer, trained_at desc)`  _[0021_ml_infrastructure.sql]_
- UNIQUE index `model_runs_one_active_per_layer_idx` on `(property_id, layer)`  _[0021_ml_infrastructure.sql]_
- UNIQUE index `model_runs_active_housekeeping_uq` on `(property_id, layer)`  _[0062_inventory_ml_foundation.sql]_
- UNIQUE index `model_runs_active_inventory_uq` on `(property_id, item_id)`  _[0062_inventory_ml_foundation.sql]_
- index `model_runs_shadow_pending_idx` on `(property_id, layer, shadow_started_at)`  _[0070_ml_shadow_mode.sql]_
- UNIQUE index `model_runs_one_active_per_item_idx` on `(property_id, layer, item_id)`  _[0072_harden_ml_shadow_and_exec_sql.sql]_
- UNIQUE index `model_runs_one_active_no_item_idx` on `(property_id, layer)`  _[0072_harden_ml_shadow_and_exec_sql.sql]_
- UNIQUE index `model_runs_one_shadow_per_item_idx` on `(property_id, layer, item_id)`  _[0072_harden_ml_shadow_and_exec_sql.sql]_
- UNIQUE index `model_runs_one_shadow_no_item_idx` on `(property_id, layer)`  _[0072_harden_ml_shadow_and_exec_sql.sql]_
- index `model_runs_is_cold_start_active_idx` on `(property_id, layer)`  _[0123_demand_supply_cold_start_table_return.sql]_
- constraint: `add constraint model_runs_layer_check   check (layer in ('demand','supply','optimizer','inventory_rate'))`  _[0062_inventory_ml_foundation.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `ml-service/src/inference/demand.py:99` (fetch_many)
- `ml-service/src/inference/inventory_rate.py:98` (fetch_many)
- `ml-service/src/inference/supply.py:239` (fetch_many)
- `ml-service/src/monitoring/shadow_mae.py:35,111,126,284` (fetch_many)
- `ml-service/src/training/demand.py:311` (fetch_many)
- `ml-service/src/training/inventory_rate.py:445,485` (fetch_many)
- `ml-service/src/training/supply.py:251` (fetch_many)
- `src/app/api/admin/doctor/route.ts:1922,2442,2600` (select)
- `src/app/api/admin/ml-health/route.ts:65` (select)
- `src/app/api/admin/ml/housekeeping/cockpit-data/route.ts:219,364` (select)
- `src/app/api/admin/ml/inventory/cockpit-data/route.ts:230,388` (select)
- `src/app/api/cron/ml-shadow-evaluate/route.ts:85,112` (select)
- `src/app/api/inventory/ai-status/route.ts:66` (select)
- `src/lib/db/ml-inventory-cockpit.ts:196,275,350,373,628,830` (select)
- `src/lib/db/ml-stubs.ts:305,334` (select)
- `src/lib/inventory-predictions.ts:196` (select)

_Via RPC function:_
- `staxis_install_inventory_model_run()`  _[def: 0112_preserve_graduation_timestamp.sql]_
- `staxis_install_cold_start_model_run()`  _[def: 0097_cold_start_parent_check.sql]_
- `staxis_install_demand_supply_cold_start()`  _[def: 0123_demand_supply_cold_start_table_return.sql]_

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `ml-service/src/monitoring/shadow_mae.py:372,404` (update)
- `src/app/api/cron/ml-shadow-evaluate/route.ts:253` (update)

_Via RPC function:_
- `promote_shadow_model_run()`  _[def: 0072_harden_ml_shadow_and_exec_sql.sql]_
- `staxis_install_housekeeping_model_run()`  _[def: 0111_rpc_unknown_field_notice.sql]_
- `staxis_install_inventory_model_run()`  _[def: 0112_preserve_graduation_timestamp.sql]_
- `staxis_install_cold_start_model_run()`  _[def: 0097_cold_start_parent_check.sql]_
- `staxis_install_demand_supply_cold_start()`  _[def: 0123_demand_supply_cold_start_table_return.sql]_

**Flags:**

- **Implied-but-not-enforced FK:** `item_id` (column ends in `_id` but has no `REFERENCES` clause).

---

### `optimizer_results`

**Domain:** ml & predictions &nbsp;·&nbsp; **Defined:** 0021_ml_infrastructure.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0021_ml_infrastructure.sql]_ |
| `property_id` | uuid | no | — | FK→properties(id) · _[0021_ml_infrastructure.sql]_ |
| `date` | date | no | — | _[0021_ml_infrastructure.sql]_ |
| `recommended_headcount` | integer | no | — | _[0021_ml_infrastructure.sql]_ |
| `target_completion_probability` | numeric(4,3) | no | 0.95 | _[0021_ml_infrastructure.sql]_ |
| `achieved_completion_probability` | numeric(4,3) | yes | — | _[0021_ml_infrastructure.sql]_ |
| `completion_probability_curve` | jsonb | no | — | _[0021_ml_infrastructure.sql]_ |
| `assignment_plan` | jsonb | yes | — | _[0021_ml_infrastructure.sql]_ |
| `sensitivity_analysis` | jsonb | yes | — | _[0021_ml_infrastructure.sql]_ |
| `inputs_snapshot` | jsonb | no | — | _[0021_ml_infrastructure.sql]_ |
| `monte_carlo_draws` | integer | no | 1000 | _[0021_ml_infrastructure.sql]_ |
| `ran_at` | timestamptz | no | now() | _[0021_ml_infrastructure.sql]_ |

**Indexes & table-level constraints:**

- index `optimizer_results_property_date_idx` on `(property_id, date desc)`  _[0021_ml_infrastructure.sql]_
- constraint: `unique (property_id, date)`  _[0021_ml_infrastructure.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/app/api/ml/override/route.ts:159` (select)
- `src/lib/db/ml-inventory-cockpit.ts:903` (select)
- `src/lib/ml-schedule-helpers.ts:55` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `ml-service/src/optimizer/monte_carlo.py:458` (upsert)

**Flags:** none.

---

### `prediction_disagreement`

**Domain:** ml & predictions &nbsp;·&nbsp; **Defined:** 0021_ml_infrastructure.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0021_ml_infrastructure.sql]_ |
| `property_id` | uuid | no | — | FK→properties(id) · _[0021_ml_infrastructure.sql]_ |
| `date` | date | no | — | _[0021_ml_infrastructure.sql]_ |
| `layer1_total_p50` | numeric(10,2) | no | — | _[0021_ml_infrastructure.sql]_ |
| `layer2_summed_p50` | numeric(10,2) | no | — | _[0021_ml_infrastructure.sql]_ |
| `disagreement_pct` | numeric(8,4) | no | — | _[0021_ml_infrastructure.sql]_ |
| `threshold_used` | numeric(8,4) | no | — | _[0021_ml_infrastructure.sql]_ |
| `layer1_model_run_id` | uuid | no | — | FK→model_runs(id) · _[0021_ml_infrastructure.sql]_ |
| `layer2_model_run_id` | uuid | no | — | FK→model_runs(id) · _[0021_ml_infrastructure.sql]_ |
| `detected_at` | timestamptz | no | now() | _[0021_ml_infrastructure.sql]_ |

**Indexes & table-level constraints:**

- index `prediction_disagreement_property_idx` on `(property_id, detected_at desc)`  _[0021_ml_infrastructure.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/lib/db/ml-stubs.ts:368` (select)

**Writes:**

- _none detected_

**Flags:**

- **Read-only table** — never written by any service (read-only after seed/migration).

---

### `prediction_log`

**Domain:** ml & predictions &nbsp;·&nbsp; **Defined:** 0021_ml_infrastructure.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0021_ml_infrastructure.sql]_ |
| `property_id` | uuid | no | — | FK→properties(id) · _[0021_ml_infrastructure.sql]_ |
| `layer` | text | no | — | CHECK(layer in ('demand','supply')) · _[0021_ml_infrastructure.sql]_ |
| `prediction_id` | uuid | no | — | _[0021_ml_infrastructure.sql]_ |
| `cleaning_event_id` | uuid | yes | — | FK→cleaning_events(id) · _[0021_ml_infrastructure.sql]_ |
| `date` | date | no | — | _[0021_ml_infrastructure.sql]_ |
| `predicted_value` | numeric(10,4) | no | — | _[0021_ml_infrastructure.sql]_ |
| `actual_value` | numeric(10,4) | no | — | _[0021_ml_infrastructure.sql]_ |
| `abs_error` | numeric(10,4) | yes | — | _[0021_ml_infrastructure.sql]_ |
| `squared_error` | numeric(12,4) | yes | — | _[0021_ml_infrastructure.sql]_ |
| `pinball_loss_p50` | numeric(10,4) | yes | — | _[0021_ml_infrastructure.sql]_ |
| `model_run_id` | uuid | no | — | FK→model_runs(id) · _[0021_ml_infrastructure.sql]_ |
| `logged_at` | timestamptz | no | now() | _[0021_ml_infrastructure.sql]_ |
| `inventory_count_id` | uuid | yes | — | _[0062_inventory_ml_foundation.sql]_ |

**Indexes & table-level constraints:**

- index `prediction_log_property_layer_logged_idx` on `(property_id, layer, logged_at desc)`  _[0021_ml_infrastructure.sql]_
- index `prediction_log_model_run_idx` on `(model_run_id, logged_at desc)`  _[0021_ml_infrastructure.sql]_
- constraint: `add constraint prediction_log_layer_check   check (layer in ('demand','supply','inventory_rate'))`  _[0062_inventory_ml_foundation.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/lib/db/ml-inventory-cockpit.ts:469` (select)
- `src/lib/db/ml-stubs.ts:348,424` (select)

_Raw SQL (`execute_sql` / backtick / triple-quote):_
- `ml-service/src/monitoring/shadow_mae.py:161` (sql_read)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/app/api/inventory/post-count-process/route.ts:200` (insert)

**Flags:**

- **Implied-but-not-enforced FK:** `prediction_id`, `inventory_count_id` (column ends in `_id` but has no `REFERENCES` clause).

---

### `prediction_overrides`

**Domain:** ml & predictions &nbsp;·&nbsp; **Defined:** 0021_ml_infrastructure.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0021_ml_infrastructure.sql]_ |
| `property_id` | uuid | no | — | FK→properties(id) · _[0021_ml_infrastructure.sql]_ |
| `date` | date | no | — | _[0021_ml_infrastructure.sql]_ |
| `optimizer_recommendation` | integer | no | — | _[0021_ml_infrastructure.sql]_ |
| `manual_headcount` | integer | no | — | _[0021_ml_infrastructure.sql]_ |
| `override_reason` | text | yes | — | _[0021_ml_infrastructure.sql]_ |
| `override_by` | uuid | yes | — | _[0021_ml_infrastructure.sql]_ |
| `optimizer_results_id` | uuid | yes | — | FK→optimizer_results(id) · _[0021_ml_infrastructure.sql]_ |
| `outcome_recorded_at` | timestamptz | yes | — | _[0021_ml_infrastructure.sql]_ |
| `outcome_actual_minutes_worked` | numeric(10,2) | yes | — | _[0021_ml_infrastructure.sql]_ |
| `outcome_completed_on_time` | boolean | yes | — | _[0021_ml_infrastructure.sql]_ |
| `outcome_overtime_minutes` | numeric(10,2) | yes | — | _[0021_ml_infrastructure.sql]_ |
| `override_at` | timestamptz | no | now() | _[0021_ml_infrastructure.sql]_ |

**Indexes & table-level constraints:**

- index `prediction_overrides_property_date_idx` on `(property_id, date desc)`  _[0021_ml_infrastructure.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/app/api/admin/ml/housekeeping/cockpit-data/route.ts:226` (select)
- `src/lib/db/ml-stubs.ts:393` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/app/api/ml/override/route.ts:186` (insert)

**Flags:** none.

---

### `supply_predictions`

**Domain:** ml & predictions &nbsp;·&nbsp; **Defined:** 0021_ml_infrastructure.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0021_ml_infrastructure.sql]_ |
| `property_id` | uuid | no | — | FK→properties(id) · _[0021_ml_infrastructure.sql]_ |
| `date` | date | no | — | _[0021_ml_infrastructure.sql]_ |
| `room_number` | text | no | — | _[0021_ml_infrastructure.sql]_ |
| `staff_id` | uuid | no | — | FK→staff(id) · _[0021_ml_infrastructure.sql]_ |
| `predicted_minutes_p25` | numeric(8,2) | yes | — | _[0021_ml_infrastructure.sql]_ |
| `predicted_minutes_p50` | numeric(8,2) | no | — | _[0021_ml_infrastructure.sql]_ |
| `predicted_minutes_p75` | numeric(8,2) | yes | — | _[0021_ml_infrastructure.sql]_ |
| `predicted_minutes_p90` | numeric(8,2) | yes | — | _[0021_ml_infrastructure.sql]_ |
| `features_snapshot` | jsonb | yes | — | _[0021_ml_infrastructure.sql]_ |
| `model_run_id` | uuid | no | — | FK→model_runs(id) · _[0021_ml_infrastructure.sql]_ |
| `predicted_at` | timestamptz | no | now() | _[0021_ml_infrastructure.sql]_ |

**Indexes & table-level constraints:**

- index `supply_predictions_property_date_idx` on `(property_id, date desc)`  _[0021_ml_infrastructure.sql]_
- index `supply_predictions_staff_idx` on `(property_id, staff_id, date desc)`  _[0021_ml_infrastructure.sql]_
- constraint: `unique (property_id, date, room_number, staff_id, model_run_id)`  _[0021_ml_infrastructure.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `ml-service/src/optimizer/monte_carlo.py:233` (fetch_many)
- `src/lib/ml-schedule-helpers.ts:146` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `ml-service/src/inference/supply.py:568` (upsert)

**Flags:** none.

---

### `supply_priors`

**Domain:** ml & predictions &nbsp;·&nbsp; **Defined:** 0122_demand_supply_priors.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0122_demand_supply_priors.sql]_ |
| `cohort_key` | text | no | — | _[0122_demand_supply_priors.sql]_ |
| `prior_minutes_per_event` | numeric(10,4) | no | — | _[0122_demand_supply_priors.sql]_ |
| `n_hotels_contributing` | integer | no | 0 | _[0122_demand_supply_priors.sql]_ |
| `prior_strength` | numeric(6,2) | no | 1.0 | _[0122_demand_supply_priors.sql]_ |
| `source` | text | no | 'industry-benchmark' | CHECK(source IN ('industry-benchmark', 'cohort-aggregate')) · _[0122_demand_supply_priors.sql]_ |
| `updated_at` | timestamptz | no | now() | _[0122_demand_supply_priors.sql]_ |

**Indexes & table-level constraints:**

- index `supply_priors_cohort_idx` on `(cohort_key)`  _[0122_demand_supply_priors.sql]_
- constraint: `UNIQUE (cohort_key)`  _[0122_demand_supply_priors.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `ml-service/src/training/supply.py:141` (fetch_one)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `ml-service/src/training/demand_supply_priors.py:281` (upsert)

**Flags:** none.

---

### Domain: agent (chat/voice)

### `agent_conversations`

**Domain:** agent (chat/voice) &nbsp;·&nbsp; **Defined:** 0079_agent_layer.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0079_agent_layer.sql]_ |
| `user_id` | uuid | no | — | FK→accounts(id) · _[0079_agent_layer.sql]_ |
| `property_id` | uuid | no | — | FK→properties(id) · _[0079_agent_layer.sql]_ |
| `role` | text | no | — | CHECK(role in (
    'admin', 'owner', 'general_manager', 'front...) · _[0079_agent_layer.sql]_ |
| `title` | text | yes | — | _[0079_agent_layer.sql]_ |
| `prompt_version` | text | yes | — | _[0079_agent_layer.sql]_ |
| `created_at` | timestamptz | no | now() | _[0079_agent_layer.sql]_ |
| `updated_at` | timestamptz | no | now() | _[0079_agent_layer.sql]_ |
| `message_count` | integer | no | 0 | _[0100_agent_longevity_foundation.sql]_ |
| `unsummarized_message_count` | integer | no | 0 | _[0105_agent_archival_and_summarization.sql]_ |
| `last_summarized_at` | timestamptz | yes | — | _[0105_agent_archival_and_summarization.sql]_ |

**Indexes & table-level constraints:**

- index `agent_conversations_user_updated_idx` on `(user_id, updated_at desc)`  _[0079_agent_layer.sql]_
- index `agent_conversations_property_idx` on `(property_id)`  _[0079_agent_layer.sql]_
- constraint: `ADD CONSTRAINT agent_conversations_unsummarized_nonneg   CHECK (unsummarized_message_count >= 0)`  _[0115_relax_unsummarized_upper_bound.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/app/api/agent/metrics/route.ts:168` (select)
- `src/lib/agent/archival.ts:75,106` (select)
- `src/lib/agent/memory.ts:58,80,216,235` (select)
- `src/lib/agent/summarizer.ts:156,340` (select)

_Raw SQL (`execute_sql` / backtick / triple-quote):_
- `scripts/run-agent-invariant-evals.ts:54,84` (sql_read)

_Via RPC function:_
- `staxis_heal_conversation_counters()`  _[def: 0114_agent_invariants_and_heal.sql]_
- `staxis_apply_conversation_summary()`  _[def: 0106_agent_round_10_followups.sql]_
- `staxis_archive_conversation()`  _[def: 0105_agent_archival_and_summarization.sql]_
- `staxis_lock_load_and_record_user_turn()`  _[def: 0105_agent_archival_and_summarization.sql]_

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/lib/agent/memory.ts:196,222,241` (delete,insert,update)

_Raw SQL:_
- `scripts/run-agent-invariant-evals.ts:37,122,162,264` (sql_write)

_Via RPC function:_
- `staxis_heal_conversation_counters()`  _[def: 0114_agent_invariants_and_heal.sql]_
- `staxis_apply_conversation_summary()`  _[def: 0106_agent_round_10_followups.sql]_
- `staxis_archive_conversation()`  _[def: 0105_agent_archival_and_summarization.sql]_
- `staxis_restore_conversation()`  _[def: 0113_restore_conversation_no_double_count.sql]_

**Flags:** none.

---

### `agent_conversations_archived`

**Domain:** agent (chat/voice) &nbsp;·&nbsp; **Defined:** 0105_agent_archival_and_summarization.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `LIKE` | public | yes | — | _[0105_agent_archival_and_summarization.sql]_ |
| `archived_at` | timestamptz | no | now() | _[0105_agent_archival_and_summarization.sql]_ |

**Indexes & table-level constraints:**

- index `agent_conversations_archived_at_idx` on `(archived_at DESC)`  _[0105_agent_archival_and_summarization.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/lib/agent/archival.ts:143,161,164` (select)

_Via RPC function:_
- `staxis_restore_conversation()`  _[def: 0113_restore_conversation_no_double_count.sql]_

**Writes:**


_Via RPC function:_
- `staxis_archive_conversation()`  _[def: 0105_agent_archival_and_summarization.sql]_
- `staxis_restore_conversation()`  _[def: 0113_restore_conversation_no_double_count.sql]_

**Flags:** none.

---

### `agent_cost_finalize_failures`

**Domain:** agent (chat/voice) &nbsp;·&nbsp; **Defined:** 0093_agent_cost_finalize_failures.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0093_agent_cost_finalize_failures.sql]_ |
| `reservation_id` | uuid | no | — | _[0093_agent_cost_finalize_failures.sql]_ |
| `conversation_id` | uuid | yes | — | _[0093_agent_cost_finalize_failures.sql]_ |
| `user_id` | uuid | no | — | _[0093_agent_cost_finalize_failures.sql]_ |
| `property_id` | uuid | no | — | _[0093_agent_cost_finalize_failures.sql]_ |
| `actual_cost_usd` | numeric(10, 6) | no | — | _[0093_agent_cost_finalize_failures.sql]_ |
| `model` | text | yes | — | _[0093_agent_cost_finalize_failures.sql]_ |
| `model_id` | text | yes | — | _[0093_agent_cost_finalize_failures.sql]_ |
| `tokens_in` | integer | yes | — | _[0093_agent_cost_finalize_failures.sql]_ |
| `tokens_out` | integer | yes | — | _[0093_agent_cost_finalize_failures.sql]_ |
| `cached_input_tokens` | integer | yes | — | _[0093_agent_cost_finalize_failures.sql]_ |
| `attempt_count` | integer | no | 1 | _[0093_agent_cost_finalize_failures.sql]_ |
| `last_error` | text | yes | — | _[0093_agent_cost_finalize_failures.sql]_ |
| `created_at` | timestamptz | no | now() | _[0093_agent_cost_finalize_failures.sql]_ |

**Indexes & table-level constraints:**

- index `agent_cost_finalize_failures_created_idx` on `(created_at desc)`  _[0093_agent_cost_finalize_failures.sql]_
- index `agent_cost_finalize_failures_user_idx` on `(user_id)`  _[0093_agent_cost_finalize_failures.sql]_

**Reads:**


_Via RPC function:_
- `staxis_count_finalize_failures_today()`  _[def: 0093_agent_cost_finalize_failures.sql]_

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/lib/agent/cost-controls.ts:280` (insert)

**Flags:**

- **Implied-but-not-enforced FK:** `reservation_id`, `conversation_id`, `user_id`, `property_id` (column ends in `_id` but has no `REFERENCES` clause).

---

### `agent_costs`

**Domain:** agent (chat/voice) &nbsp;·&nbsp; **Defined:** 0080_agent_cost_controls.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0080_agent_cost_controls.sql]_ |
| `user_id` | uuid | no | — | FK→accounts(id) · _[0080_agent_cost_controls.sql]_ |
| `property_id` | uuid | no | — | FK→properties(id) · _[0080_agent_cost_controls.sql]_ |
| `conversation_id` | uuid | yes | — | FK→agent_conversations(id) · _[0080_agent_cost_controls.sql]_ |
| `model` | text | no | — | _[0080_agent_cost_controls.sql]_ |
| `tokens_in` | integer | no | 0 | _[0080_agent_cost_controls.sql]_ |
| `tokens_out` | integer | no | 0 | _[0080_agent_cost_controls.sql]_ |
| `cached_input_tokens` | integer | no | 0 | _[0080_agent_cost_controls.sql]_ |
| `cost_usd` | numeric(10, 6) | no | — | _[0080_agent_cost_controls.sql]_ |
| `kind` | text | no | 'request' | CHECK(kind in ('request', 'eval', 'background')) · _[0080_agent_cost_controls.sql]_ |
| `created_at` | timestamptz | no | now() | _[0080_agent_cost_controls.sql]_ |
| `state` | text | no | 'finalized' | _[0081_agent_cost_atomicity.sql]_ |
| `model_id` | text | yes | — | _[0083_agent_costs_model_id.sql]_ |
| `swept_at` | timestamptz | yes | — | _[0091_agent_cost_swept_at.sql]_ |

**Indexes & table-level constraints:**

- index `agent_costs_user_day_idx` on `(user_id, created_at desc)`  _[0080_agent_cost_controls.sql]_
- index `agent_costs_property_day_idx` on `(property_id, created_at desc)`  _[0080_agent_cost_controls.sql]_
- index `agent_costs_day_idx` on `(created_at desc)`  _[0080_agent_cost_controls.sql]_
- index `agent_costs_user_state_idx` on `(user_id, state, created_at desc)`  _[0081_agent_cost_atomicity.sql]_
- index `agent_costs_property_state_idx` on `(property_id, state, created_at desc)`  _[0081_agent_cost_atomicity.sql]_
- index `agent_costs_swept_at_idx` on `(swept_at)`  _[0091_agent_cost_swept_at.sql]_
- constraint: `ADD CONSTRAINT agent_costs_kind_check   CHECK (kind IN ('request', 'eval', 'background', 'audio'))`  _[0117_voice_surface.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/app/api/agent/metrics/route.ts:109` (select)
- `src/app/api/cron/agent-weekly-digest/route.ts:59` (select)
- `src/lib/agent/cost-controls.ts:445,497` (select)

_Via RPC function:_
- `staxis_count_stale_reservations()`  _[def: 0090_agent_cost_stale_reservation_sweeper.sql]_
- `staxis_count_swept_today()`  _[def: 0091_agent_cost_swept_at.sql]_
- `staxis_sweep_stale_reservations()`  _[def: 0091_agent_cost_swept_at.sql]_
- `staxis_reserve_agent_spend()`  _[def: 0082_agent_cost_multi_scope_locks.sql]_

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/lib/agent/cost-controls.ts:371,388` (insert)

_Via RPC function:_
- `staxis_sweep_stale_reservations()`  _[def: 0091_agent_cost_swept_at.sql]_
- `staxis_reserve_agent_spend()`  _[def: 0082_agent_cost_multi_scope_locks.sql]_
- `staxis_finalize_agent_spend()`  _[def: 0098_agent_dedupe_preflight_and_finalize_guard.sql]_
- `staxis_cancel_agent_spend()`  _[def: 0081_agent_cost_atomicity.sql]_

**Flags:** none.

---

### `agent_eval_baselines`

**Domain:** agent (chat/voice) &nbsp;·&nbsp; **Defined:** 0100_agent_longevity_foundation.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0100_agent_longevity_foundation.sql]_ |
| `case_name` | text | no | — | _[0100_agent_longevity_foundation.sql]_ |
| `prompt_version` | text | no | — | _[0100_agent_longevity_foundation.sql]_ |
| `model` | text | no | — | _[0100_agent_longevity_foundation.sql]_ |
| `model_id` | text | yes | — | _[0100_agent_longevity_foundation.sql]_ |
| `passed` | boolean | no | — | _[0100_agent_longevity_foundation.sql]_ |
| `cost_usd` | numeric(10, 6) | no | — | _[0100_agent_longevity_foundation.sql]_ |
| `tokens_in` | integer | no | — | _[0100_agent_longevity_foundation.sql]_ |
| `tokens_out` | integer | no | — | _[0100_agent_longevity_foundation.sql]_ |
| `cached_input_tokens` | integer | no | 0 | _[0100_agent_longevity_foundation.sql]_ |
| `duration_ms` | integer | yes | — | _[0100_agent_longevity_foundation.sql]_ |
| `created_at` | timestamptz | no | now() | _[0100_agent_longevity_foundation.sql]_ |

**Indexes & table-level constraints:**

- index `agent_eval_baselines_case_created_idx` on `(case_name, created_at DESC)`  _[0100_agent_longevity_foundation.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/lib/agent/evals/runner.ts:222` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/lib/agent/evals/runner.ts:240` (insert)

**Flags:** none.

---

### `agent_messages`

**Domain:** agent (chat/voice) &nbsp;·&nbsp; **Defined:** 0079_agent_layer.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0079_agent_layer.sql]_ |
| `conversation_id` | uuid | no | — | FK→agent_conversations(id) · _[0079_agent_layer.sql]_ |
| `role` | text | no | — | CHECK(role in ('user', 'assistant', 'tool', 'system')) · _[0079_agent_layer.sql]_ |
| `content` | text | yes | — | _[0079_agent_layer.sql]_ |
| `tool_call_id` | text | yes | — | _[0079_agent_layer.sql]_ |
| `tool_name` | text | yes | — | _[0079_agent_layer.sql]_ |
| `tool_args` | jsonb | yes | — | _[0079_agent_layer.sql]_ |
| `tool_result` | jsonb | yes | — | _[0079_agent_layer.sql]_ |
| `tokens_in` | integer | yes | — | _[0079_agent_layer.sql]_ |
| `tokens_out` | integer | yes | — | _[0079_agent_layer.sql]_ |
| `model_used` | text | yes | — | _[0079_agent_layer.sql]_ |
| `cost_usd` | numeric(10, 6) | yes | — | _[0079_agent_layer.sql]_ |
| `created_at` | timestamptz | no | now() | _[0079_agent_layer.sql]_ |
| `model_id` | text | yes | — | _[0094_agent_messages_hardening.sql]_ |
| `prompt_version` | text | yes | — | _[0100_agent_longevity_foundation.sql]_ |
| `is_error` | boolean | yes | — | _[0101_agent_messages_is_error.sql]_ |
| `is_summarized` | boolean | no | false | _[0105_agent_archival_and_summarization.sql]_ |
| `is_summary` | boolean | no | false | _[0105_agent_archival_and_summarization.sql]_ |

**Indexes & table-level constraints:**

- index `agent_messages_conversation_created_idx` on `(conversation_id, created_at)`  _[0079_agent_layer.sql]_
- UNIQUE index `agent_messages_tool_result_uq` on `(conversation_id, tool_call_id)`  _[0094_agent_messages_hardening.sql]_
- UNIQUE index `agent_messages_tool_result_uq` on `(conversation_id, tool_call_id)`  _[0098_agent_dedupe_preflight_and_finalize_guard.sql]_
- index `agent_messages_conv_created_idx` on `(conversation_id, created_at)`  _[0100_agent_longevity_foundation.sql]_
- index `agent_messages_tool_errors_idx` on `(created_at DESC, conversation_id)`  _[0101_agent_messages_is_error.sql]_
- index `agent_messages_summarized_idx` on `(conversation_id)`  _[0105_agent_archival_and_summarization.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/app/api/agent/metrics/route.ts:177,202,208` (select)
- `src/app/api/cron/agent-weekly-digest/route.ts:76,84` (select)
- `src/lib/agent/cost-controls.ts:537` (select)
- `src/lib/agent/memory.ts:95` (select)
- `src/lib/agent/summarizer.ts:174` (select)

_Raw SQL (`execute_sql` / backtick / triple-quote):_
- `scripts/run-agent-invariant-evals.ts:183,207,234` (sql_read)

_Via RPC function:_
- `staxis_heal_conversation_counters()`  _[def: 0114_agent_invariants_and_heal.sql]_
- `staxis_apply_conversation_summary()`  _[def: 0106_agent_round_10_followups.sql]_
- `staxis_archive_conversation()`  _[def: 0105_agent_archival_and_summarization.sql]_
- `staxis_restore_conversation()`  _[def: 0113_restore_conversation_no_double_count.sql]_
- `staxis_lock_load_and_record_user_turn()`  _[def: 0105_agent_archival_and_summarization.sql]_

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/lib/agent/memory.ts:251,364` (insert,upsert)

_Raw SQL:_
- `scripts/run-agent-invariant-evals.ts:45,174,189,272` (sql_write)

_Via RPC function:_
- `staxis_apply_conversation_summary()`  _[def: 0106_agent_round_10_followups.sql]_
- `staxis_archive_conversation()`  _[def: 0105_agent_archival_and_summarization.sql]_
- `staxis_restore_conversation()`  _[def: 0113_restore_conversation_no_double_count.sql]_
- `staxis_record_assistant_turn()`  _[def: 0100_agent_longevity_foundation.sql]_
- `staxis_lock_load_and_record_user_turn()`  _[def: 0105_agent_archival_and_summarization.sql]_

**Flags:**

- **Implied-but-not-enforced FK:** `tool_call_id` (column ends in `_id` but has no `REFERENCES` clause).

---

### `agent_messages_archived`

**Domain:** agent (chat/voice) &nbsp;·&nbsp; **Defined:** 0105_agent_archival_and_summarization.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `LIKE` | public | yes | — | _[0105_agent_archival_and_summarization.sql]_ |
| `archived_at` | timestamptz | no | now() | _[0105_agent_archival_and_summarization.sql]_ |

**Indexes & table-level constraints:**

- index `agent_messages_archived_at_idx` on `(archived_at DESC)`  _[0105_agent_archival_and_summarization.sql]_
- index `agent_messages_archived_conv_idx` on `(conversation_id)`  _[0105_agent_archival_and_summarization.sql]_
- UNIQUE index `agent_messages_archived_tool_result_uq` on `(conversation_id, tool_call_id)`  _[0105_agent_archival_and_summarization.sql]_

**Reads:**


_Via RPC function:_
- `staxis_restore_conversation()`  _[def: 0113_restore_conversation_no_double_count.sql]_

**Writes:**


_Via RPC function:_
- `staxis_archive_conversation()`  _[def: 0105_agent_archival_and_summarization.sql]_
- `staxis_restore_conversation()`  _[def: 0113_restore_conversation_no_double_count.sql]_

**Flags:** none.

---

### `agent_nudges`

**Domain:** agent (chat/voice) &nbsp;·&nbsp; **Defined:** 0079_agent_layer.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0079_agent_layer.sql]_ |
| `user_id` | uuid | no | — | FK→accounts(id) · _[0079_agent_layer.sql]_ |
| `property_id` | uuid | no | — | FK→properties(id) · _[0079_agent_layer.sql]_ |
| `category` | text | no | — | CHECK(category in (
    'operational', 'daily_summary', 'invent...) · _[0079_agent_layer.sql]_ |
| `severity` | text | no | 'info' | CHECK(severity in ('info', 'warning', 'urgent')) · _[0079_agent_layer.sql]_ |
| `payload` | jsonb | no | — | _[0079_agent_layer.sql]_ |
| `dedupe_key` | text | yes | — | _[0079_agent_layer.sql]_ |
| `status` | text | no | 'pending' | CHECK(status in (
    'pending', 'acknowledged', 'dismissed', '...) · _[0079_agent_layer.sql]_ |
| `created_at` | timestamptz | no | now() | _[0079_agent_layer.sql]_ |
| `acknowledged_at` | timestamptz | yes | — | _[0079_agent_layer.sql]_ |

**Indexes & table-level constraints:**

- index `agent_nudges_user_status_idx` on `(user_id, status, created_at desc)`  _[0079_agent_layer.sql]_
- index `agent_nudges_property_status_idx` on `(property_id, status, created_at desc)`  _[0079_agent_layer.sql]_
- UNIQUE index `agent_nudges_active_dedupe_uq` on `(user_id, category, dedupe_key)`  _[0079_agent_layer.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/app/api/agent/metrics/route.ts:262` (select)
- `src/app/api/agent/nudges/[id]/ack/route.ts:33` (select)
- `src/app/api/agent/nudges/route.ts:29` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/app/api/agent/nudges/[id]/ack/route.ts:42` (update)
- `src/lib/agent/nudges.ts:207` (insert)
- `src/lib/agent/tools/management.ts:149` (insert)
- `src/lib/agent/tools/room-actions.ts:313` (insert)

**Flags:** none.

---

### `agent_prompts`

**Domain:** agent (chat/voice) &nbsp;·&nbsp; **Defined:** 0102_agent_prompts_table.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0102_agent_prompts_table.sql]_ |
| `role` | text | no | — | CHECK(role IN ('base', 'housekeeping', 'general_manager', 'owne...) · _[0102_agent_prompts_table.sql]_ |
| `version` | text | no | — | _[0102_agent_prompts_table.sql]_ |
| `content` | text | no | — | _[0102_agent_prompts_table.sql]_ |
| `is_active` | boolean | no | false | _[0102_agent_prompts_table.sql]_ |
| `parent_version` | text | yes | — | _[0102_agent_prompts_table.sql]_ |
| `notes` | text | yes | — | _[0102_agent_prompts_table.sql]_ |
| `created_at` | timestamptz | no | now() | _[0102_agent_prompts_table.sql]_ |
| `created_by` | uuid | yes | — | FK→accounts(id) · _[0102_agent_prompts_table.sql]_ |

**Indexes & table-level constraints:**

- UNIQUE index `agent_prompts_active_per_role_uq` on `(role)`  _[0102_agent_prompts_table.sql]_
- index `agent_prompts_role_created_idx` on `(role, created_at DESC)`  _[0102_agent_prompts_table.sql]_
- constraint: `ADD CONSTRAINT agent_prompts_role_check   CHECK (role IN ('base', 'housekeeping', 'general_manager', 'owner', 'admin', 'summarizer'))`  _[0109_agent_prompts_summarizer.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/app/api/admin/agent/prompts/[id]/activate/route.ts:40` (select)
- `src/app/api/admin/agent/prompts/route.ts:25` (select)
- `src/lib/agent/prompts-store.ts:61` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/app/api/admin/agent/prompts/[id]/route.ts:58` (update)
- `src/app/api/admin/agent/prompts/route.ts:72` (insert)

_Raw SQL:_
- `scripts/run-agent-invariant-evals.ts:293` (sql_write)

_Via RPC function:_
- `staxis_activate_prompt()`  _[def: 0106_agent_round_10_followups.sql]_

**Flags:** none.

---

### `voice_recordings`

**Domain:** agent (chat/voice) &nbsp;·&nbsp; **Defined:** 0117_voice_surface.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0117_voice_surface.sql]_ |
| `user_id` | uuid | no | — | FK→accounts(id) · _[0117_voice_surface.sql]_ |
| `property_id` | uuid | yes | — | FK→properties(id) · _[0117_voice_surface.sql]_ |
| `conversation_id` | uuid | yes | — | FK→agent_conversations(id) · _[0117_voice_surface.sql]_ |
| `storage_key` | text | no | — | _[0117_voice_surface.sql]_ |
| `duration_sec` | numeric(7, 2) | no | — | CHECK(duration_sec >= 0) · _[0117_voice_surface.sql]_ |
| `transcript` | text | yes | — | _[0117_voice_surface.sql]_ |
| `language` | text | yes | — | _[0117_voice_surface.sql]_ |
| `cost_usd` | numeric(10, 6) | no | 0 | CHECK(cost_usd >= 0) · _[0117_voice_surface.sql]_ |
| `created_at` | timestamptz | no | now() | _[0117_voice_surface.sql]_ |
| `expires_at` | timestamptz | no | (now() + interval '7 days') | _[0117_voice_surface.sql]_ |

**Indexes & table-level constraints:**

- index `voice_recordings_expires_idx` on `(expires_at)`  _[0117_voice_surface.sql]_
- index `voice_recordings_user_created_idx` on `(user_id, created_at DESC)`  _[0117_voice_surface.sql]_
- constraint: `CONSTRAINT voice_recordings_expires_after_created     CHECK (expires_at > created_at)`  _[0117_voice_surface.sql]_

**Reads:**

- _none detected_

**Writes:**

- _none detected_

**Flags:**

- **Dead table** — no reads or writes detected anywhere in the codebase.

---

### `walkthrough_runs`

**Domain:** agent (chat/voice) &nbsp;·&nbsp; **Defined:** 0118_walkthrough_runs.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0118_walkthrough_runs.sql]_ |
| `user_id` | uuid | no | — | FK→accounts(id) · _[0118_walkthrough_runs.sql]_ |
| `property_id` | uuid | no | — | FK→properties(id) · _[0118_walkthrough_runs.sql]_ |
| `task` | text | no | — | CHECK(length(task) between 1 and 200) · _[0118_walkthrough_runs.sql]_ |
| `step_count` | integer | no | 0 | CHECK(step_count >= 0 and step_count <= 12) · _[0118_walkthrough_runs.sql]_ |
| `status` | text | no | 'active' | CHECK(status in ('active', 'done', 'stopped', 'capped', 'errore...) · _[0118_walkthrough_runs.sql]_ |
| `started_at` | timestamptz | no | now() | _[0118_walkthrough_runs.sql]_ |
| `ended_at` | timestamptz | yes | — | _[0118_walkthrough_runs.sql]_ |

**Indexes & table-level constraints:**

- UNIQUE index `walkthrough_runs_one_active_per_user` on `(user_id)`  _[0118_walkthrough_runs.sql]_
- index `walkthrough_runs_user_started_idx` on `(user_id, started_at desc)`  _[0118_walkthrough_runs.sql]_
- index `walkthrough_runs_property_started_idx` on `(property_id, started_at desc)`  _[0118_walkthrough_runs.sql]_
- index `walkthrough_runs_active_started_idx` on `(started_at)`  _[0118_walkthrough_runs.sql]_
- constraint: `constraint walkthrough_runs_ended_at_matches_status     check ((status = 'active' and ended_at is null) or (status != 'active' and ended_at is not null))`  _[0118_walkthrough_runs.sql]_
- constraint: `add constraint walkthrough_runs_status_check     check (status in (       'active',       'done',       'stopped',       'capped',       'errored',       'timeout',       'cannot_help'     ))`  _[0119_walkthrough_cannot_help_status.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/app/api/cron/walkthrough-health-alert/route.ts:95` (select)
- `src/app/api/walkthrough/end/route.ts:73` (select)
- `src/app/api/walkthrough/start/route.ts:84` (select)

_Via RPC function:_
- `staxis_walkthrough_step()`  _[def: 0118_walkthrough_runs.sql]_
- `staxis_walkthrough_heal_stale()`  _[def: 0118_walkthrough_runs.sql]_

**Writes:**


_Via RPC function:_
- `staxis_walkthrough_step()`  _[def: 0118_walkthrough_runs.sql]_
- `staxis_walkthrough_end()`  _[def: 0119_walkthrough_cannot_help_status.sql]_
- `staxis_walkthrough_start()`  _[def: 0118_walkthrough_runs.sql]_
- `staxis_walkthrough_heal_stale()`  _[def: 0118_walkthrough_runs.sql]_

**Flags:** none.

---

### Domain: work orders & maintenance

### `service_contracts`

**Domain:** work orders & maintenance &nbsp;·&nbsp; **Defined:** 0043_vendors_contracts.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0043_vendors_contracts.sql]_ |
| `property_id` | uuid | no | — | FK→properties(id) · _[0043_vendors_contracts.sql]_ |
| `vendor_id` | uuid | yes | — | FK→vendors(id) · _[0043_vendors_contracts.sql]_ |
| `name` | text | no | — | _[0043_vendors_contracts.sql]_ |
| `category` | text | no | — | CHECK(category in
                     ('hvac','plumbing','elec...) · _[0043_vendors_contracts.sql]_ |
| `cadence` | text | no | — | CHECK(cadence in
                     ('weekly','biweekly','mon...) · _[0043_vendors_contracts.sql]_ |
| `last_serviced_at` | date | yes | — | _[0043_vendors_contracts.sql]_ |
| `next_due_at` | date | yes | — | _[0043_vendors_contracts.sql]_ |
| `monthly_cost` | numeric | yes | — | _[0043_vendors_contracts.sql]_ |
| `notes` | text | yes | — | _[0043_vendors_contracts.sql]_ |
| `created_at` | timestamptz | no | now() | _[0043_vendors_contracts.sql]_ |
| `updated_at` | timestamptz | no | now() | _[0043_vendors_contracts.sql]_ |

**Indexes & table-level constraints:**

- index `service_contracts_property_idx` on `(property_id, next_due_at)`  _[0043_vendors_contracts.sql]_

**Reads:**

- _none detected_

**Writes:**

- _none detected_

**Flags:**

- **Dead table** — no reads or writes detected anywhere in the codebase.

---

### `vendors`

**Domain:** work orders & maintenance &nbsp;·&nbsp; **Defined:** 0043_vendors_contracts.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0043_vendors_contracts.sql]_ |
| `property_id` | uuid | no | — | FK→properties(id) · _[0043_vendors_contracts.sql]_ |
| `name` | text | no | — | _[0043_vendors_contracts.sql]_ |
| `category` | text | no | — | CHECK(category in
                  ('hvac','plumbing','electri...) · _[0043_vendors_contracts.sql]_ |
| `contact_name` | text | yes | — | _[0043_vendors_contracts.sql]_ |
| `contact_email` | text | yes | — | _[0043_vendors_contracts.sql]_ |
| `contact_phone` | text | yes | — | _[0043_vendors_contracts.sql]_ |
| `notes` | text | yes | — | _[0043_vendors_contracts.sql]_ |
| `created_at` | timestamptz | no | now() | _[0043_vendors_contracts.sql]_ |
| `updated_at` | timestamptz | no | now() | _[0043_vendors_contracts.sql]_ |

**Indexes & table-level constraints:**

- index `vendors_property_idx` on `(property_id, category)`  _[0043_vendors_contracts.sql]_

**Reads:**

- _none detected_

**Writes:**

- _none detected_

**Flags:**

- **Dead table** — no reads or writes detected anywhere in the codebase.

---

### `work_orders`

**Domain:** work orders & maintenance &nbsp;·&nbsp; **Defined:** 0001_initial_schema.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0001_initial_schema.sql]_ |
| `property_id` | uuid | no | — | FK→properties(id) · _[0001_initial_schema.sql]_ |
| `room_number` | text | no | — | _[0001_initial_schema.sql]_ |
| `description` | text | no | — | _[0001_initial_schema.sql]_ |
| `severity` | text | no | — | CHECK(severity in ('low','medium','urgent')) · _[0001_initial_schema.sql]_ |
| `status` | text | no | — | CHECK(status in ('submitted','assigned','in_progress','resolved')) · _[0001_initial_schema.sql]_ |
| `submitted_by` | text | yes | — | _[0001_initial_schema.sql]_ |
| `submitted_by_name` | text | yes | — | _[0001_initial_schema.sql]_ |
| `assigned_to` | uuid | yes | — | FK→staff(id) · _[0001_initial_schema.sql]_ |
| `assigned_name` | text | yes | — | _[0001_initial_schema.sql]_ |
| `photo_url` | text | yes | — | _[0001_initial_schema.sql]_ |
| `notes` | text | yes | — | _[0001_initial_schema.sql]_ |
| `blocked_room` | boolean | yes | false | _[0001_initial_schema.sql]_ |
| `source` | text | yes | — | CHECK(source in ('manual','housekeeper','ca_ooo')) · _[0001_initial_schema.sql]_ |
| `ca_work_order_number` | text | yes | — | _[0001_initial_schema.sql]_ |
| `ca_from_date` | text | yes | — | _[0001_initial_schema.sql]_ |
| `ca_to_date` | text | yes | — | _[0001_initial_schema.sql]_ |
| `created_at` | timestamptz | no | now() | _[0001_initial_schema.sql]_ |
| `updated_at` | timestamptz | no | now() | _[0001_initial_schema.sql]_ |
| `resolved_at` | timestamptz | yes | — | _[0001_initial_schema.sql]_ |
| `equipment_id` | uuid | yes | — | FK→equipment(id) · _[0030_work_orders_equipment_cost.sql]_ |
| `repair_cost` | numeric | yes | — | _[0030_work_orders_equipment_cost.sql]_ |
| `parts_used` | text[] | no | '{}' | _[0030_work_orders_equipment_cost.sql]_ |
| `vendor_id` | uuid | yes | — | FK→vendors(id) · _[0043_vendors_contracts.sql]_ |
| `submitter_role` | text | yes | — | _[0131_maintenance_simplify.sql]_ |
| `submitter_photo_path` | text | yes | — | _[0131_maintenance_simplify.sql]_ |
| `completion_photo_path` | text | yes | — | _[0131_maintenance_simplify.sql]_ |
| `completion_note` | text | yes | — | _[0131_maintenance_simplify.sql]_ |
| `completed_by_name` | text | yes | — | _[0131_maintenance_simplify.sql]_ |

**Indexes & table-level constraints:**

- index `work_orders_property_status_idx` on `(property_id, status)`  _[0001_initial_schema.sql]_
- index `work_orders_property_created_idx` on `(property_id, created_at desc)`  _[0001_initial_schema.sql]_
- UNIQUE index `work_orders_ca_dedup_idx` on `(property_id, ca_work_order_number)`  _[0001_initial_schema.sql]_
- index `work_orders_equipment_idx` on `(equipment_id)`  _[0030_work_orders_equipment_cost.sql]_
- index `work_orders_vendor_idx` on `(vendor_id)`  _[0043_vendors_contracts.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `scraper/ooo-pull.js:168` (select)
- `src/lib/db/work-orders.ts:20` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `scraper/ooo-pull.js:217,228,236,249` (insert,update)
- `src/lib/db/work-orders.ts:37,47,53,66` (delete,insert,update)

**Flags:** none.

---

### Domain: pms integration

### `onboarding_jobs`

**Domain:** pms integration &nbsp;·&nbsp; **Defined:** 0031_pms_recipes_and_onboarding.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0031_pms_recipes_and_onboarding.sql]_ |
| `property_id` | uuid | no | — | FK→properties(id) · _[0031_pms_recipes_and_onboarding.sql]_ |
| `pms_type` | text | no | — | _[0031_pms_recipes_and_onboarding.sql]_ |
| `status` | text | no | 'queued' | CHECK(status in ('queued','running','mapping','extracting','com...) · _[0031_pms_recipes_and_onboarding.sql]_ |
| `step` | text | yes | — | _[0031_pms_recipes_and_onboarding.sql]_ |
| `progress_pct` | int | no | 0 | CHECK(progress_pct between 0 and 100) · _[0031_pms_recipes_and_onboarding.sql]_ |
| `result` | jsonb | yes | — | _[0031_pms_recipes_and_onboarding.sql]_ |
| `error` | text | yes | — | _[0031_pms_recipes_and_onboarding.sql]_ |
| `error_detail` | jsonb | yes | — | _[0031_pms_recipes_and_onboarding.sql]_ |
| `recipe_id` | uuid | yes | — | FK→pms_recipes(id) · _[0031_pms_recipes_and_onboarding.sql]_ |
| `worker_id` | text | yes | — | _[0031_pms_recipes_and_onboarding.sql]_ |
| `started_at` | timestamptz | yes | — | _[0031_pms_recipes_and_onboarding.sql]_ |
| `completed_at` | timestamptz | yes | — | _[0031_pms_recipes_and_onboarding.sql]_ |
| `created_at` | timestamptz | no | now() | _[0031_pms_recipes_and_onboarding.sql]_ |
| `updated_at` | timestamptz | no | now() | _[0031_pms_recipes_and_onboarding.sql]_ |
| `force_remap` | boolean | no | false | _[0039_atomic_recipe_swap_and_job_claim.sql]_ |

**Indexes & table-level constraints:**

- index `onboarding_jobs_queue_idx` on `(created_at)`  _[0031_pms_recipes_and_onboarding.sql]_
- index `onboarding_jobs_property_recent_idx` on `(property_id, created_at desc)`  _[0031_pms_recipes_and_onboarding.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `cua-service/src/job-runner.ts:271` (select)
- `src/app/api/admin/alerts/route.ts:67` (select)
- `src/app/api/admin/list-properties/route.ts:115` (select)
- `src/app/api/admin/onboarding-jobs/route.ts:62` (select)
- `src/app/api/admin/overview-stats/route.ts:59` (select)
- `src/app/api/admin/pms-coverage/route.ts:100` (select)
- `src/app/api/admin/property-health/route.ts:69` (select)
- `src/app/api/pms/job-status/route.ts:39` (select)
- `src/app/api/pms/onboard/route.ts:106` (select)

_Via RPC function:_
- `staxis_claim_next_job()`  _[def: 0039_atomic_recipe_swap_and_job_claim.sql]_

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `cua-service/src/job-runner.ts:416,430,489` (update)
- `src/app/api/admin/regenerate-recipe/route.ts:95` (insert)
- `src/app/api/pms/onboard/route.ts:121` (insert)

_Via RPC function:_
- `staxis_claim_next_job()`  _[def: 0039_atomic_recipe_swap_and_job_claim.sql]_
- `staxis_reap_stale_jobs()`  _[def: 0037_lock_down_security_definer_functions.sql]_

**Flags:** none.

---

### `pms_recipes`

**Domain:** pms integration &nbsp;·&nbsp; **Defined:** 0031_pms_recipes_and_onboarding.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0031_pms_recipes_and_onboarding.sql]_ |
| `pms_type` | text | no | — | _[0031_pms_recipes_and_onboarding.sql]_ |
| `version` | int | no | 1 | _[0031_pms_recipes_and_onboarding.sql]_ |
| `recipe` | jsonb | no | — | _[0031_pms_recipes_and_onboarding.sql]_ |
| `status` | text | no | 'draft' | CHECK(status in ('draft','active','deprecated')) · _[0031_pms_recipes_and_onboarding.sql]_ |
| `learned_by_property_id` | uuid | yes | — | FK→properties(id) · _[0031_pms_recipes_and_onboarding.sql]_ |
| `notes` | text | yes | — | _[0031_pms_recipes_and_onboarding.sql]_ |
| `created_at` | timestamptz | no | now() | _[0031_pms_recipes_and_onboarding.sql]_ |
| `updated_at` | timestamptz | no | now() | _[0031_pms_recipes_and_onboarding.sql]_ |

**Indexes & table-level constraints:**

- index `pms_recipes_active_lookup_idx` on `(pms_type, status, version desc)`  _[0031_pms_recipes_and_onboarding.sql]_
- UNIQUE index `pms_recipes_one_active_per_type_idx` on `(pms_type)`  _[0032_pms_recipes_one_active_per_type.sql]_
- constraint: `unique (pms_type, version, status)`  _[0031_pms_recipes_and_onboarding.sql]_
- constraint: `add constraint pms_recipes_pms_type_version_key   unique (pms_type, version)`  _[0033_pms_recipes_constraint_and_job_reaper.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `cua-service/src/job-runner.ts:297,349` (select)
- `cua-service/src/pull-job-runner.ts:187,199` (select)
- `src/app/api/admin/pms-coverage/route.ts:69` (select)
- `src/app/api/admin/property-health/route.ts:57` (select)
- `src/lib/pms/recipe-loader.ts:35,101` (select)

_Via RPC function:_
- `staxis_insert_draft_recipe()`  _[def: 0078_atomic_recipe_version.sql]_

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `cua-service/src/job-runner.ts:358` (insert)

_Via RPC function:_
- `staxis_insert_draft_recipe()`  _[def: 0078_atomic_recipe_version.sql]_
- `staxis_swap_active_recipe()`  _[def: 0039_atomic_recipe_swap_and_job_claim.sql]_

**Flags:** none.

---

### `pull_metrics`

**Domain:** pms integration &nbsp;·&nbsp; **Defined:** 0011_pull_metrics_and_session.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0011_pull_metrics_and_session.sql]_ |
| `property_id` | uuid | yes | — | FK→properties(id) · _[0011_pull_metrics_and_session.sql]_ |
| `pull_type` | text | no | — | CHECK(pull_type in ('csv_morning','csv_evening','dashboard','ooo')) · _[0011_pull_metrics_and_session.sql]_ |
| `ok` | boolean | no | — | _[0011_pull_metrics_and_session.sql]_ |
| `error_code` | text | yes | — | _[0011_pull_metrics_and_session.sql]_ |
| `total_ms` | integer | no | — | _[0011_pull_metrics_and_session.sql]_ |
| `login_ms` | integer | yes | — | _[0011_pull_metrics_and_session.sql]_ |
| `navigate_ms` | integer | yes | — | _[0011_pull_metrics_and_session.sql]_ |
| `download_ms` | integer | yes | — | _[0011_pull_metrics_and_session.sql]_ |
| `parse_ms` | integer | yes | — | _[0011_pull_metrics_and_session.sql]_ |
| `rows` | integer | yes | — | _[0011_pull_metrics_and_session.sql]_ |
| `pulled_at` | timestamptz | no | now() | _[0011_pull_metrics_and_session.sql]_ |
| `created_at` | timestamptz | no | now() | _[0011_pull_metrics_and_session.sql]_ |

**Indexes & table-level constraints:**

- index `pull_metrics_pulled_at_idx` on `(pulled_at desc)`  _[0011_pull_metrics_and_session.sql]_
- index `pull_metrics_pull_type_idx` on `(pull_type, pulled_at desc)`  _[0011_pull_metrics_and_session.sql]_
- index `pull_metrics_property_created_idx` on `(property_id, created_at desc)`  _[0066_property_id_indexes.sql]_
- constraint: `add constraint pull_metrics_pull_type_check   check (pull_type in (     'csv_morning',     'csv_evening',     'dashboard',     'ooo',     'hk_center_on_demand'   ))`  _[0014_pull_metrics_hk_center.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/app/api/admin/doctor/route.ts:1669` (select)
- `src/app/api/admin/recent-errors/route.ts:73` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `cua-service/src/pull-data-saver.ts:139` (insert)
- `scraper/supabase-helpers.js:148` (insert)

**Flags:** none.

---

### `scraper_credentials`

**Domain:** pms integration &nbsp;·&nbsp; **Defined:** 0018_scraper_credentials.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `property_id` | uuid | no | — | PK · FK→properties(id) · _[0018_scraper_credentials.sql]_ |
| `pms_type` | text | no | 'choice_advantage' | CHECK(pms_type in ('choice_advantage')) · _[0018_scraper_credentials.sql]_ |
| `ca_login_url` | text | no | 'https://www.choiceadvantage.com/choicehotels/W... | _[0018_scraper_credentials.sql]_ |
| `is_active` | boolean | no | true | _[0018_scraper_credentials.sql]_ |
| `scraper_instance` | text | no | 'default' | _[0018_scraper_credentials.sql]_ |
| `notes` | text | yes | — | _[0018_scraper_credentials.sql]_ |
| `created_at` | timestamptz | no | now() | _[0018_scraper_credentials.sql]_ |
| `updated_at` | timestamptz | no | now() | _[0018_scraper_credentials.sql]_ |
| `ca_username_encrypted` | text | yes | — | _[0069_encrypt_scraper_credentials.sql]_ |
| `ca_password_encrypted` | text | yes | — | _[0069_encrypt_scraper_credentials.sql]_ |

**Indexes & table-level constraints:**

- index `scraper_credentials_active_idx` on `(scraper_instance, is_active)`  _[0018_scraper_credentials.sql]_
- constraint: `add constraint scraper_credentials_pms_type_check   check (pms_type in (     'choice_advantage',     'opera_cloud',     'cloudbeds',     'roomkey',     'skytouch',     'webrezpro',     'hotelogix',   `  _[0031_pms_recipes_and_onboarding.sql]_
- constraint: `add constraint scraper_credentials_scraper_instance_format   check (     scraper_instance ~ '^[A-Za-z0-9._-]+$'     and char_length(scraper_instance) between 1 and 64   ) not valid`  _[0073_scraper_instance_check.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `cua-service/src/job-runner.ts:284` (select)
- `cua-service/src/pull-job-runner.ts:174` (select)
- `scraper/scraper.js:959` (select)
- `src/app/api/admin/property-health/route.ts:48` (select)
- `src/app/api/admin/regenerate-recipe/route.ts:77` (select)
- `src/app/api/admin/scraper-assign/route.ts:92` (select)
- `src/app/api/admin/scraper-instances/route.ts:88` (select)
- `src/app/api/pms/onboard/route.ts:73` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/app/api/admin/scraper-assign/route.ts:119` (update)
- `src/app/api/pms/save-credentials/route.ts:160` (upsert)

**Flags:** none.

---

### `scraper_session`

**Domain:** pms integration &nbsp;·&nbsp; **Defined:** 0011_pull_metrics_and_session.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `property_id` | uuid | no | — | PK · FK→properties(id) · _[0011_pull_metrics_and_session.sql]_ |
| `state` | jsonb | no | — | _[0011_pull_metrics_and_session.sql]_ |
| `refreshed_at` | timestamptz | no | now() | _[0011_pull_metrics_and_session.sql]_ |
| `created_at` | timestamptz | no | now() | _[0011_pull_metrics_and_session.sql]_ |

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `scraper/supabase-helpers.js:167` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `scraper/supabase-helpers.js:189` (upsert)

**Flags:** none.

---

### `scraper_status`

**Domain:** pms integration &nbsp;·&nbsp; **Defined:** 0001_initial_schema.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `key` | text | no | — | PK · _[0001_initial_schema.sql]_ |
| `data` | jsonb | no | '{}'::jsonb | _[0001_initial_schema.sql]_ |
| `updated_at` | timestamptz | no | now() | _[0001_initial_schema.sql]_ |

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `cua-service/src/supabase.ts:38` (select)
- `scraper/supabase-helpers.js:54,116` (select)
- `src/app/api/admin/doctor/route.ts:387,661,705,754,1252,1254,1324,1325,1458,1760,1848` (select)
- `src/app/api/admin/scraper-instances/route.ts:239` (select)
- `src/app/api/cron/scraper-health/route.ts:172` (select)
- `src/app/api/cron/scraper-weekly-digest/route.ts:58` (select)
- `src/lib/agent/tools/management.ts:239` (select)
- `src/lib/db/dashboard.ts:109` (select)
- `src/lib/db/plan-snapshots.ts:198` (select)
- `src/lib/feature-derivation.ts:124` (select)
- `src/lib/ml-failure-counters.ts:86` (select)
- `src/lib/supabase-admin.ts:67` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `scraper/supabase-helpers.js:77,102` (upsert)
- `src/app/api/cron/scraper-health/route.ts:201` (upsert)
- `src/app/api/cron/scraper-weekly-digest/route.ts:78` (upsert)
- `src/lib/ml-failure-counters.ts:113` (upsert)

**Flags:** none.

---

### Domain: billing & expenses

### `expenses`

**Domain:** billing & expenses &nbsp;·&nbsp; **Defined:** 0055_expenses.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0055_expenses.sql]_ |
| `category` | text | no | — | CHECK(category in (
      'claude_api','hosting','twilio','supa...) · _[0055_expenses.sql]_ |
| `amount_cents` | integer | no | — | _[0055_expenses.sql]_ |
| `description` | text | yes | — | _[0055_expenses.sql]_ |
| `vendor` | text | yes | — | _[0055_expenses.sql]_ |
| `incurred_on` | date | no | — | _[0055_expenses.sql]_ |
| `source` | text | no | 'manual' | CHECK(source in ('auto','manual')) · _[0055_expenses.sql]_ |
| `property_id` | uuid | yes | — | FK→properties(id) · _[0055_expenses.sql]_ |
| `metadata` | jsonb | no | '{}'::jsonb | _[0055_expenses.sql]_ |
| `created_at` | timestamptz | no | now() | _[0055_expenses.sql]_ |

**Indexes & table-level constraints:**

- index `expenses_incurred_idx` on `(incurred_on desc)`  _[0055_expenses.sql]_
- index `expenses_category_idx` on `(category, incurred_on desc)`  _[0055_expenses.sql]_
- index `expenses_property_idx` on `(property_id, incurred_on desc)`  _[0055_expenses.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/app/api/admin/expenses/route.ts:45` (select)
- `src/app/api/admin/per-hotel-economics/route.ts:67` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/app/api/admin/expenses/route.ts:74,126,156` (delete,insert,update)

**Flags:** none.

---

### `stripe_processed_events`

**Domain:** billing & expenses &nbsp;·&nbsp; **Defined:** 0035_stripe_idempotency_and_constraints.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `event_id` | text | no | — | PK · _[0035_stripe_idempotency_and_constraints.sql]_ |
| `event_type` | text | no | — | _[0035_stripe_idempotency_and_constraints.sql]_ |
| `property_id` | uuid | yes | — | FK→properties(id) · _[0035_stripe_idempotency_and_constraints.sql]_ |
| `processed_at` | timestamptz | no | now() | _[0035_stripe_idempotency_and_constraints.sql]_ |
| `metadata` | jsonb | yes | — | _[0035_stripe_idempotency_and_constraints.sql]_ |

**Indexes & table-level constraints:**

- index `stripe_processed_events_property_idx` on `(property_id, processed_at desc)`  _[0035_stripe_idempotency_and_constraints.sql]_
- index `stripe_processed_events_recent_idx` on `(processed_at desc)`  _[0035_stripe_idempotency_and_constraints.sql]_

**Reads:**

- _none detected_

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/app/api/stripe/webhook/route.ts:74,111,119` (delete,insert,update)

**Flags:**

- **Write-only table** — written to but never read in the codebase.

---

### Domain: admin / logging / metrics

### `admin_audit_log`

**Domain:** admin / logging / metrics &nbsp;·&nbsp; **Defined:** 0054_admin_audit_log.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0054_admin_audit_log.sql]_ |
| `ts` | timestamptz | no | now() | _[0054_admin_audit_log.sql]_ |
| `actor_user_id` | uuid | yes | — | FK→auth(id) · _[0054_admin_audit_log.sql]_ |
| `actor_email` | text | yes | — | _[0054_admin_audit_log.sql]_ |
| `action` | text | no | — | _[0054_admin_audit_log.sql]_ |
| `target_type` | text | yes | — | _[0054_admin_audit_log.sql]_ |
| `target_id` | text | yes | — | _[0054_admin_audit_log.sql]_ |
| `metadata` | jsonb | no | '{}'::jsonb | _[0054_admin_audit_log.sql]_ |

**Indexes & table-level constraints:**

- index `admin_audit_log_ts_idx` on `(ts desc)`  _[0054_admin_audit_log.sql]_
- index `admin_audit_log_actor_idx` on `(actor_user_id, ts desc)`  _[0054_admin_audit_log.sql]_
- index `admin_audit_log_action_idx` on `(action, ts desc)`  _[0054_admin_audit_log.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/app/api/admin/audit-log/route.ts:33` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/lib/admin-audit.ts:32` (insert)
- `src/lib/audit.ts:25` (insert)

**Flags:**

- **Implied-but-not-enforced FK:** `target_id` (column ends in `_id` but has no `REFERENCES` clause).

---

### `api_limits`

**Domain:** admin / logging / metrics &nbsp;·&nbsp; **Defined:** 0008_api_limits.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `property_id` | uuid | no | — | _[0008_api_limits.sql]_ |
| `endpoint` | text | no | — | _[0008_api_limits.sql]_ |
| `hour_bucket` | text | no | — | _[0008_api_limits.sql]_ |
| `count` | integer | no | 0 | _[0008_api_limits.sql]_ |

**Indexes & table-level constraints:**

- constraint: `primary key (property_id, endpoint, hour_bucket)`  _[0008_api_limits.sql]_
- constraint: `add constraint api_limits_property_id_fkey   foreign key (property_id) references public.properties(id)   on delete cascade`  _[0077_codex_audit_fks.sql]_

**Reads:**


_Via RPC function:_
- `staxis_api_limit_cleanup()`  _[def: 0126_staxis_api_limit_cleanup_recreate.sql]_

**Writes:**


_Via RPC function:_
- `staxis_api_limit_hit()`  _[def: 0008_api_limits.sql]_
- `staxis_api_limit_cleanup()`  _[def: 0126_staxis_api_limit_cleanup_recreate.sql]_

**Flags:**

- **Implied-but-not-enforced FK:** `property_id` (column ends in `_id` but has no `REFERENCES` clause).

---

### `app_events`

**Domain:** admin / logging / metrics &nbsp;·&nbsp; **Defined:** 0051_app_events.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0051_app_events.sql]_ |
| `property_id` | uuid | yes | — | FK→properties(id) · _[0051_app_events.sql]_ |
| `user_id` | uuid | yes | — | FK→auth(id) · _[0051_app_events.sql]_ |
| `user_role` | text | yes | — | _[0051_app_events.sql]_ |
| `event_type` | text | no | — | _[0051_app_events.sql]_ |
| `metadata` | jsonb | no | '{}'::jsonb | _[0051_app_events.sql]_ |
| `ts` | timestamptz | no | now() | _[0051_app_events.sql]_ |

**Indexes & table-level constraints:**

- index `app_events_property_ts_idx` on `(property_id, ts desc)`  _[0051_app_events.sql]_
- index `app_events_user_ts_idx` on `(user_id, ts desc)`  _[0051_app_events.sql]_
- index `app_events_type_ts_idx` on `(event_type, ts desc)`  _[0051_app_events.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `scripts/ml-smoke-test.ts:85` (select)
- `src/app/api/admin/activity/route.ts:50` (select)
- `src/app/api/admin/doctor/route.ts:2202` (select)
- `src/app/api/admin/ml/inventory/cockpit-data/route.ts:248` (select)
- `src/lib/db/ml-inventory-cockpit.ts:365,399` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/app/api/events/route.ts:66` (insert)
- `src/app/api/inventory/post-count-process/route.ts:225` (insert)
- `src/lib/ml-misconfigured-events.ts:71` (insert)

**Flags:** none.

---

### `claude_sessions`

**Domain:** admin / logging / metrics &nbsp;·&nbsp; **Defined:** 0058_claude_sessions.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `session_id` | text | no | — | PK · _[0058_claude_sessions.sql]_ |
| `branch` | text | yes | — | _[0058_claude_sessions.sql]_ |
| `current_tool` | text | yes | — | _[0058_claude_sessions.sql]_ |
| `started_at` | timestamptz | no | now() | _[0058_claude_sessions.sql]_ |
| `last_heartbeat` | timestamptz | no | now() | _[0058_claude_sessions.sql]_ |
| `cwd` | text | yes | — | _[0058_claude_sessions.sql]_ |
| `metadata` | jsonb | no | '{}'::jsonb | _[0058_claude_sessions.sql]_ |

**Indexes & table-level constraints:**

- index `claude_sessions_heartbeat_idx` on `(last_heartbeat desc)`  _[0058_claude_sessions.sql]_
- index `claude_sessions_branch_idx` on `(branch)`  _[0058_claude_sessions.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/app/api/admin/active-sessions/route.ts:40` (select)
- `src/app/api/local-worktrees/sync/route.ts:167` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/app/api/claude-heartbeat/route.ts:60,80` (update,upsert)

**Flags:** none.

---

### `claude_usage_log`

**Domain:** admin / logging / metrics &nbsp;·&nbsp; **Defined:** 0056_claude_usage_log.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0056_claude_usage_log.sql]_ |
| `ts` | timestamptz | no | now() | _[0056_claude_usage_log.sql]_ |
| `property_id` | uuid | yes | — | FK→properties(id) · _[0056_claude_usage_log.sql]_ |
| `workload` | text | no | — | _[0056_claude_usage_log.sql]_ |
| `model` | text | no | — | _[0056_claude_usage_log.sql]_ |
| `input_tokens` | integer | no | 0 | _[0056_claude_usage_log.sql]_ |
| `output_tokens` | integer | no | 0 | _[0056_claude_usage_log.sql]_ |
| `cache_read_tokens` | integer | no | 0 | _[0056_claude_usage_log.sql]_ |
| `cache_write_tokens` | integer | no | 0 | _[0056_claude_usage_log.sql]_ |
| `cost_micros` | bigint | no | 0 | _[0056_claude_usage_log.sql]_ |
| `job_id` | uuid | yes | — | _[0056_claude_usage_log.sql]_ |
| `metadata` | jsonb | no | '{}'::jsonb | _[0056_claude_usage_log.sql]_ |

**Indexes & table-level constraints:**

- index `claude_usage_log_ts_idx` on `(ts desc)`  _[0056_claude_usage_log.sql]_
- index `claude_usage_log_property_idx` on `(property_id, ts desc)`  _[0056_claude_usage_log.sql]_
- index `claude_usage_log_workload_idx` on `(workload, ts desc)`  _[0056_claude_usage_log.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `cua-service/src/usage-log.ts:128` (select)
- `src/app/api/admin/per-hotel-economics/route.ts:58` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `cua-service/src/usage-log.ts:161` (insert)

**Flags:**

- **Implied-but-not-enforced FK:** `job_id` (column ends in `_id` but has no `REFERENCES` clause).

---

### `cron_heartbeats`

**Domain:** admin / logging / metrics &nbsp;·&nbsp; **Defined:** 0074_cron_heartbeats.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `cron_name` | text | no | — | PK · _[0074_cron_heartbeats.sql]_ |
| `last_success_at` | timestamptz | no | now() | _[0074_cron_heartbeats.sql]_ |
| `last_request_id` | text | yes | — | _[0074_cron_heartbeats.sql]_ |
| `notes` | jsonb | no | '{}'::jsonb | _[0074_cron_heartbeats.sql]_ |
| `updated_at` | timestamptz | no | now() | _[0074_cron_heartbeats.sql]_ |

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/app/api/admin/doctor/route.ts:2085` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/lib/cron-heartbeat.ts:58` (upsert)

**Flags:** none.

---

### `error_logs`

**Domain:** admin / logging / metrics &nbsp;·&nbsp; **Defined:** 0001_initial_schema.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0001_initial_schema.sql]_ |
| `ts` | timestamptz | no | now() | _[0001_initial_schema.sql]_ |
| `source` | text | yes | — | _[0001_initial_schema.sql]_ |
| `message` | text | yes | — | _[0001_initial_schema.sql]_ |
| `stack` | text | yes | — | _[0001_initial_schema.sql]_ |
| `context` | jsonb | yes | — | _[0001_initial_schema.sql]_ |
| `property_id` | uuid | yes | — | FK→properties(id) · _[0001_initial_schema.sql]_ |

**Indexes & table-level constraints:**

- index `error_logs_ts_idx` on `(ts desc)`  _[0001_initial_schema.sql]_
- index `error_logs_property_recent_idx` on `(property_id, ts desc)`  _[0066_property_id_indexes.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/app/api/admin/alerts/route.ts:74` (select)
- `src/app/api/admin/overview-stats/route.ts:55` (select)
- `src/app/api/admin/recent-errors/route.ts:67` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/app/api/cron/purge-old-error-logs/route.ts:48` (delete)
- `src/app/api/ml/override/route.ts:214` (insert)
- `src/app/api/send-shift-confirmations/route.ts:570` (insert)
- `src/app/api/sync-room-assignments/route.ts:237` (insert)

**Flags:** none.

---

### `github_events`

**Domain:** admin / logging / metrics &nbsp;·&nbsp; **Defined:** 0057_github_events.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0057_github_events.sql]_ |
| `ts` | timestamptz | no | now() | _[0057_github_events.sql]_ |
| `event_type` | text | no | — | _[0057_github_events.sql]_ |
| `branch` | text | yes | — | _[0057_github_events.sql]_ |
| `metadata` | jsonb | no | '{}'::jsonb | _[0057_github_events.sql]_ |

**Indexes & table-level constraints:**

- index `github_events_ts_idx` on `(ts desc)`  _[0057_github_events.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/app/api/admin/build-status/route.ts:322` (select)
- `src/app/api/admin/last-github-event/route.ts:32` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/app/api/github-webhook/route.ts:81` (insert)

**Flags:** none.

---

### `idempotency_log`

**Domain:** admin / logging / metrics &nbsp;·&nbsp; **Defined:** 0019_idempotency_log.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `key` | text | no | — | PK · _[0019_idempotency_log.sql]_ |
| `route` | text | no | — | _[0019_idempotency_log.sql]_ |
| `response` | jsonb | no | — | _[0019_idempotency_log.sql]_ |
| `status_code` | integer | no | 200 | _[0019_idempotency_log.sql]_ |
| `property_id` | uuid | yes | — | FK→properties(id) · _[0019_idempotency_log.sql]_ |
| `created_at` | timestamptz | no | now() | _[0019_idempotency_log.sql]_ |
| `expires_at` | timestamptz | no | (now() + interval '24 hours') | _[0019_idempotency_log.sql]_ |

**Indexes & table-level constraints:**

- index `idempotency_log_expires_at_idx` on `(expires_at)`  _[0019_idempotency_log.sql]_
- index `idempotency_log_route_created_idx` on `(route, created_at desc)`  _[0019_idempotency_log.sql]_
- index `idempotency_log_property_idx` on `(property_id)`  _[0066_property_id_indexes.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/lib/idempotency.ts:77` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/lib/idempotency.ts:135` (insert)

**Flags:** none.

---

### `local_worktrees`

**Domain:** admin / logging / metrics &nbsp;·&nbsp; **Defined:** 0060_local_worktrees.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `host` | text | no | 'reeyen-mac' | _[0060_local_worktrees.sql]_ |
| `name` | text | no | — | _[0060_local_worktrees.sql]_ |
| `branch` | text | yes | — | _[0060_local_worktrees.sql]_ |
| `dirty_files` | int | no | 0 | _[0060_local_worktrees.sql]_ |
| `commits_ahead` | int | no | 0 | _[0060_local_worktrees.sql]_ |
| `commits_behind` | int | no | 0 | _[0060_local_worktrees.sql]_ |
| `head_committed_at` | timestamptz | yes | — | _[0060_local_worktrees.sql]_ |
| `head_message` | text | yes | — | _[0060_local_worktrees.sql]_ |
| `last_seen` | timestamptz | no | now() | _[0060_local_worktrees.sql]_ |

**Indexes & table-level constraints:**

- index `local_worktrees_last_seen_idx` on `(last_seen desc)`  _[0060_local_worktrees.sql]_
- constraint: `primary key (host, name)`  _[0060_local_worktrees.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/app/api/admin/build-status/route.ts:299` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/app/api/local-worktrees/sync/route.ts:131,145` (delete,upsert)

**Flags:** none.

---

### `prospects`

**Domain:** admin / logging / metrics &nbsp;·&nbsp; **Defined:** 0050_prospects.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0050_prospects.sql]_ |
| `hotel_name` | text | no | — | _[0050_prospects.sql]_ |
| `contact_name` | text | yes | — | _[0050_prospects.sql]_ |
| `contact_email` | text | yes | — | _[0050_prospects.sql]_ |
| `contact_phone` | text | yes | — | _[0050_prospects.sql]_ |
| `pms_type` | text | yes | — | _[0050_prospects.sql]_ |
| `expected_launch_date` | date | yes | — | _[0050_prospects.sql]_ |
| `status` | text | no | 'talking' | CHECK(status in ('talking','negotiating','committed','onboarded...) · _[0050_prospects.sql]_ |
| `notes` | text | yes | — | _[0050_prospects.sql]_ |
| `checklist` | jsonb | no | '{}'::jsonb | _[0050_prospects.sql]_ |
| `created_at` | timestamptz | no | now() | _[0050_prospects.sql]_ |
| `updated_at` | timestamptz | no | now() | _[0050_prospects.sql]_ |

**Indexes & table-level constraints:**

- index `prospects_status_idx` on `(status)`  _[0050_prospects.sql]_
- index `prospects_created_idx` on `(created_at desc)`  _[0050_prospects.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/app/api/admin/prospects/route.ts:29` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/app/api/admin/prospects/[id]/route.ts:50,77` (delete,update)
- `src/app/api/admin/prospects/route.ts:51` (insert)

**Flags:** none.

---

### `roadmap_items`

**Domain:** admin / logging / metrics &nbsp;·&nbsp; **Defined:** 0053_roadmap_items.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0053_roadmap_items.sql]_ |
| `title` | text | no | — | _[0053_roadmap_items.sql]_ |
| `description` | text | yes | — | _[0053_roadmap_items.sql]_ |
| `status` | text | no | 'idea' | CHECK(status in ('idea','planned','in_progress','done','dropped')) · _[0053_roadmap_items.sql]_ |
| `priority` | integer | no | 0 | _[0053_roadmap_items.sql]_ |
| `created_at` | timestamptz | no | now() | _[0053_roadmap_items.sql]_ |
| `updated_at` | timestamptz | no | now() | _[0053_roadmap_items.sql]_ |
| `done_at` | timestamptz | yes | — | _[0053_roadmap_items.sql]_ |

**Indexes & table-level constraints:**

- index `roadmap_items_status_idx` on `(status, priority desc)`  _[0053_roadmap_items.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/app/api/admin/roadmap/route.ts:32` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/app/api/admin/roadmap/route.ts:55,102,132` (delete,insert,update)

**Flags:** none.

---

### `sms_jobs`

**Domain:** admin / logging / metrics &nbsp;·&nbsp; **Defined:** 0020_sms_jobs.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0020_sms_jobs.sql]_ |
| `property_id` | uuid | no | — | FK→properties(id) · _[0020_sms_jobs.sql]_ |
| `to_phone` | text | no | — | _[0020_sms_jobs.sql]_ |
| `body` | text | no | — | _[0020_sms_jobs.sql]_ |
| `status` | text | no | 'queued' | CHECK(status in ('queued','sending','sent','failed','dead')) · _[0020_sms_jobs.sql]_ |
| `attempts` | integer | no | 0 | _[0020_sms_jobs.sql]_ |
| `max_attempts` | integer | no | 3 | _[0020_sms_jobs.sql]_ |
| `next_attempt_at` | timestamptz | no | now() | _[0020_sms_jobs.sql]_ |
| `started_at` | timestamptz | yes | — | _[0020_sms_jobs.sql]_ |
| `sent_at` | timestamptz | yes | — | _[0020_sms_jobs.sql]_ |
| `twilio_sid` | text | yes | — | _[0020_sms_jobs.sql]_ |
| `error_code` | text | yes | — | _[0020_sms_jobs.sql]_ |
| `error_message` | text | yes | — | _[0020_sms_jobs.sql]_ |
| `idempotency_key` | text | no | — | _[0020_sms_jobs.sql]_ |
| `created_at` | timestamptz | no | now() | _[0020_sms_jobs.sql]_ |
| `updated_at` | timestamptz | no | now() | _[0020_sms_jobs.sql]_ |
| `metadata` | jsonb | no | '{}'::jsonb | _[0020_sms_jobs.sql]_ |

**Indexes & table-level constraints:**

- index `sms_jobs_claim_idx` on `(next_attempt_at)`  _[0020_sms_jobs.sql]_
- index `sms_jobs_property_status_idx` on `(property_id, status, created_at desc)`  _[0020_sms_jobs.sql]_
- index `sms_jobs_sending_idx` on `(started_at)`  _[0020_sms_jobs.sql]_
- constraint: `unique (property_id, idempotency_key)`  _[0020_sms_jobs.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/app/api/admin/per-hotel-economics/route.ts:62` (select)
- `src/app/api/admin/sms-health/route.ts:56` (select)
- `src/lib/sms-jobs.ts:117` (select)

_Via RPC function:_
- `staxis_claim_sms_jobs()`  _[def: 0020_sms_jobs.sql]_

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/lib/sms-jobs.ts:104,223,255,281` (insert,update)

_Via RPC function:_
- `staxis_claim_sms_jobs()`  _[def: 0020_sms_jobs.sql]_
- `staxis_reset_stuck_sms_jobs()`  _[def: 0020_sms_jobs.sql]_

**Flags:** none.

---

### `user_feedback`

**Domain:** admin / logging / metrics &nbsp;·&nbsp; **Defined:** 0052_user_feedback.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0052_user_feedback.sql]_ |
| `property_id` | uuid | yes | — | FK→properties(id) · _[0052_user_feedback.sql]_ |
| `user_id` | uuid | yes | — | FK→auth(id) · _[0052_user_feedback.sql]_ |
| `user_email` | text | yes | — | _[0052_user_feedback.sql]_ |
| `user_display_name` | text | yes | — | _[0052_user_feedback.sql]_ |
| `message` | text | no | — | _[0052_user_feedback.sql]_ |
| `category` | text | no | 'general' | CHECK(category in ('bug','feature_request','general','complaint...) · _[0052_user_feedback.sql]_ |
| `status` | text | no | 'new' | CHECK(status in ('new','in_progress','resolved','wontfix')) · _[0052_user_feedback.sql]_ |
| `admin_note` | text | yes | — | _[0052_user_feedback.sql]_ |
| `resolved_at` | timestamptz | yes | — | _[0052_user_feedback.sql]_ |
| `created_at` | timestamptz | no | now() | _[0052_user_feedback.sql]_ |

**Indexes & table-level constraints:**

- index `user_feedback_status_idx` on `(status, created_at desc)`  _[0052_user_feedback.sql]_
- index `user_feedback_property_idx` on `(property_id, created_at desc)`  _[0052_user_feedback.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/app/api/admin/feedback/route.ts:32` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/app/api/admin/feedback/route.ts:96` (update)
- `src/app/api/feedback/route.ts:68` (insert)

**Flags:** none.

---

### `webhook_log`

**Domain:** admin / logging / metrics &nbsp;·&nbsp; **Defined:** 0001_initial_schema.sql

**Schema:**

| Column | Type | Nullable | Default | Constraints / Notes |
|---|---|---|---|---|
| `id` | uuid | no | gen_random_uuid() | PK · _[0001_initial_schema.sql]_ |
| `ts` | timestamptz | no | now() | _[0001_initial_schema.sql]_ |
| `source` | text | yes | — | _[0001_initial_schema.sql]_ |
| `payload` | jsonb | no | '{}'::jsonb | _[0001_initial_schema.sql]_ |

**Indexes & table-level constraints:**

- index `webhook_log_ts_idx` on `(ts desc)`  _[0001_initial_schema.sql]_

**Reads:**

_Direct (`.from`/`.table`/`.fetch_*`):_
- `src/app/api/admin/diagnose/route.ts:89` (select)

**Writes:**

_Direct (`.from`/`.table`/`.insert`/`.upsert`/`.update`/`.delete`):_
- `src/app/api/sms-reply/route.ts:145` (insert)

**Flags:** none.

---

## Views

Defined in migrations:

- `cleaning_minutes_per_day_view` — aggregates `cleaning_events` to one row per `(property_id, date)` with `total_recorded_minutes`. Defined: `0022_cleaning_minutes_view.sql`. Read by: `ml-service/src/training/demand.py:128`, `ml-service/src/training/supply.py`, `ml-service/src/training/demand_supply_priors.py`.
- `headcount_actuals_view` — aggregates `attendance_marks` to one row per `(property_id, date)` with `actual_headcount`, `labels_complete`. Defined: `0014_pull_metrics_hk_center.sql`. Read by: `ml-service/src/training/demand.py:128`, `ml-service/src/training/supply.py`, `ml-service/src/training/demand_supply_priors.py`.
- `inventory_observed_rate_v` — observed daily-rate aggregate from `inventory_counts`. Defined: `0086_inventory_count_observed_rate_view.sql`, hardened in `0096_observed_rate_view_v2.sql`. Read by: `ml-service/src/training/inventory_priors.py`.
- `item_canonical_name_view` — canonicalises inventory item names. Read by inventory helpers in `src/lib/db/inventory*.ts`.
- `pg_tables_rls_status` — Supabase doctor view (RLS on/off per table). Read by `src/app/api/admin/doctor/route.ts`.
- `pg_publication_tables_view` — realtime publication membership view. Read by `staxis_realtime_publication_tables()` RPC.
- `scraper_credentials_decrypted` — security-invoker view exposing decrypted `scraper_credentials` rows. Read by `cua-service/src/` and `scraper/`.

Dropped views (history): `predictions_active_demand`, `predictions_active_supply`, `predictions_active_optimizer` (all dropped in `0099_drop_hardcoded_tz_views.sql`); `walkthrough_runs_daily` (dropped in `0119_walkthrough_cannot_help_status.sql`).

## Supabase Storage buckets

Defined in `0028_inventory_storage_buckets.sql`:

- **`invoices`** — private bucket, 10 MB limit, `image/*` and `application/pdf`. Used for vendor invoice uploads from the inventory hero. Access from `src/app/api/inventory/invoices/*` and `src/app/api/admin/inventory-invoices/*`.
- **`counts`** — private bucket, 10 MB limit, `image/*`. Shelf photos uploaded from Count Mode. Access from `src/app/api/inventory/counts/*`.

- **`voice-recordings`** — referenced in `scripts/ensure-voice-recordings-bucket.ts`. Confirm via Supabase UI whether the bucket exists in prod.

## Summary

### Dead tables (no reads, no writes, no RPC, no raw SQL)

- `equipment` — 19 columns wasted. Defined in 0029_equipment_registry.sql.
- `inspections` — 10 columns wasted. Defined in 0001_initial_schema.sql.
- `inventory_rate_prediction_history` — 17 columns wasted. Defined in 0075_inventory_prediction_history.sql.
- `landscaping_tasks` — 9 columns wasted. Defined in 0001_initial_schema.sql.
- `service_contracts` — 12 columns wasted. Defined in 0043_vendors_contracts.sql.
- `vendors` — 10 columns wasted. Defined in 0043_vendors_contracts.sql.
- `voice_recordings` — 11 columns wasted. Defined in 0117_voice_surface.sql.

### Write-only tables (written but never read)

- `stripe_processed_events`

### Read-only tables (never written by any service)

- `applied_migrations`
- `ml_feature_flags`
- `prediction_disagreement`

### Tables with implied-but-not-enforced foreign keys

- `admin_audit_log`: `target_id`
- `agent_cost_finalize_failures`: `reservation_id`, `conversation_id`, `user_id`, `property_id`
- `agent_messages`: `tool_call_id`
- `api_limits`: `property_id`
- `claude_usage_log`: `job_id`
- `dashboard_by_date`: `property_id`
- `inventory_rate_prediction_history`: `source_prediction_id`, `property_id`, `item_id`, `model_run_id`
- `model_runs`: `item_id`
- `prediction_log`: `prediction_id`, `inventory_count_id`
- `staff`: `auth_user_id`

### RPC functions called from app code (38)

- `exec_sql()` — defined `0072_harden_ml_shadow_and_exec_sql.sql`. (no public-schema table refs)
- `promote_shadow_model_run()` — defined `0072_harden_ml_shadow_and_exec_sql.sql`. writes `model_runs`
- `staxis_activate_prompt()` — defined `0106_agent_round_10_followups.sql`. writes `agent_prompts`
- `staxis_api_limit_cleanup()` — defined `0126_staxis_api_limit_cleanup_recreate.sql`. reads `api_limits`; writes `api_limits`
- `staxis_api_limit_hit()` — defined `0008_api_limits.sql`. writes `api_limits`
- `staxis_apply_conversation_summary()` — defined `0106_agent_round_10_followups.sql`. reads `agent_conversations,agent_messages`; writes `agent_conversations,agent_messages`
- `staxis_archive_conversation()` — defined `0105_agent_archival_and_summarization.sql`. reads `agent_conversations,agent_messages`; writes `agent_conversations,agent_conversations_archived,agent_messages,agent_messages_archived`
- `staxis_cancel_agent_spend()` — defined `0081_agent_cost_atomicity.sql`. writes `agent_costs`
- `staxis_claim_next_job()` — defined `0039_atomic_recipe_swap_and_job_claim.sql`. reads `onboarding_jobs`; writes `onboarding_jobs`
- `staxis_claim_next_pull_job()` — defined `0042_pull_jobs_queue.sql`. reads `pull_jobs`; writes `pull_jobs`
- `staxis_claim_sms_jobs()` — defined `0020_sms_jobs.sql`. reads `sms_jobs`; writes `sms_jobs`
- `staxis_count_finalize_failures_today()` — defined `0093_agent_cost_finalize_failures.sql`. reads `agent_cost_finalize_failures`
- `staxis_count_stale_reservations()` — defined `0090_agent_cost_stale_reservation_sweeper.sql`. reads `agent_costs`
- `staxis_count_swept_today()` — defined `0091_agent_cost_swept_at.sql`. reads `agent_costs`
- `staxis_enqueue_property_pull()` — defined `0042_pull_jobs_queue.sql`. reads `pull_jobs`; writes `pull_jobs`
- `staxis_finalize_agent_spend()` — defined `0098_agent_dedupe_preflight_and_finalize_guard.sql`. writes `agent_costs`
- `staxis_heal_conversation_counters()` — defined `0114_agent_invariants_and_heal.sql`. reads `agent_conversations,agent_messages`; writes `agent_conversations`
- `staxis_insert_draft_recipe()` — defined `0078_atomic_recipe_version.sql`. reads `pms_recipes`; writes `pms_recipes`
- `staxis_install_cold_start_model_run()` — defined `0097_cold_start_parent_check.sql`. reads `inventory,model_runs`; writes `model_runs`
- `staxis_install_demand_supply_cold_start()` — defined `0123_demand_supply_cold_start_table_return.sql`. reads `model_runs`; writes `model_runs`
- `staxis_install_housekeeping_model_run()` — defined `0111_rpc_unknown_field_notice.sql`. writes `model_runs`
- `staxis_install_inventory_model_run()` — defined `0112_preserve_graduation_timestamp.sql`. reads `model_runs`; writes `model_runs`
- `staxis_lock_load_and_record_user_turn()` — defined `0105_agent_archival_and_summarization.sql`. reads `agent_conversations,agent_messages`; writes `agent_messages`
- `staxis_merge_services()` — defined `0037_lock_down_security_definer_functions.sql`. reads `properties`; writes `properties`
- `staxis_realtime_publication_tables()` — defined `0007_realtime_publication_doctor.sql`. (no public-schema table refs)
- `staxis_reap_stale_jobs()` — defined `0037_lock_down_security_definer_functions.sql`. writes `onboarding_jobs`
- `staxis_reap_stale_pull_jobs()` — defined `0042_pull_jobs_queue.sql`. writes `pull_jobs`
- `staxis_record_assistant_turn()` — defined `0100_agent_longevity_foundation.sql`. writes `agent_messages`
- `staxis_reserve_agent_spend()` — defined `0082_agent_cost_multi_scope_locks.sql`. reads `agent_costs`; writes `agent_costs`
- `staxis_reset_stuck_sms_jobs()` — defined `0020_sms_jobs.sql`. writes `sms_jobs`
- `staxis_restore_conversation()` — defined `0113_restore_conversation_no_double_count.sql`. reads `agent_conversations_archived,agent_messages,agent_messages_archived`; writes `agent_conversations,agent_conversations_archived,agent_messages,agent_messages_archived`
- `staxis_schedule_auto_fill_if_absent()` — defined `0129_schedule_auto_fill_if_absent.sql`. writes `schedule_assignments`
- `staxis_swap_active_recipe()` — defined `0039_atomic_recipe_swap_and_job_claim.sql`. writes `pms_recipes`
- `staxis_sweep_stale_reservations()` — defined `0091_agent_cost_swept_at.sql`. reads `agent_costs`; writes `agent_costs`
- `staxis_walkthrough_end()` — defined `0119_walkthrough_cannot_help_status.sql`. writes `walkthrough_runs`
- `staxis_walkthrough_heal_stale()` — defined `0118_walkthrough_runs.sql`. reads `walkthrough_runs`; writes `walkthrough_runs`
- `staxis_walkthrough_start()` — defined `0118_walkthrough_runs.sql`. writes `walkthrough_runs`
- `staxis_walkthrough_step()` — defined `0118_walkthrough_runs.sql`. reads `walkthrough_runs`; writes `walkthrough_runs`

### History (drops, renames)

- **Dropped tables:** none in 124 migrations. (One false positive — a comment in `0009_realtime_column_filter.sql` mentions `DROP TABLE` but it's in a code comment, not actual DDL.)
- **Renamed tables:** none.
- **Dropped views:** `predictions_active_demand`, `predictions_active_supply`, `predictions_active_optimizer` (in `0099`); `walkthrough_runs_daily` (in `0119`).

## Type-inconsistency notes

Cross-checking SQL column types against TypeScript shapes in `src/types/index.ts` (501 LOC) and `src/lib/db-mappers.ts` (765 LOC):

- `db-mappers.ts` is the canonical conversion layer — it maps every snake_case DB column to camelCase TS field, with explicit type coercions. Any mismatch should surface here. **Spot-check the mapper file before flagging a column as a real type bug.**
- The audit did not find any clear runtime-blocking type mismatches in the spot-checked tables (`attendance_marks`, `agent_messages`, `properties`). A full per-column TS-vs-SQL diff was not feasible at audit scale; the recommended follow-up is a `pnpm tsc --strict` pass plus a targeted Zod-vs-SQL audit against the mapper.
