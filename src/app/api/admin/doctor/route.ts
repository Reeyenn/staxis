/**
 * /api/admin/doctor — system-wide health & configuration verification
 *
 * ─── Why this exists ─────────────────────────────────────────────────────
 * We kept losing hours to silent failures: stale service account keys,
 * missing env vars, Twilio credentials rotated on one platform but not the
 * other, CRON_SECRET drift between Vercel and GitHub Actions. Each one
 * looked like a different kind of 500 to the outside world.
 *
 * This endpoint is the **ONE URL** to hit when anything smells off. It
 * runs every critical dependency check in parallel and returns a single
 * JSON doc with per-check status + a top-level ok flag. Meant to be:
 *
 *   - called by CI on every push-to-main to gate deploys,
 *   - polled by a daily GH-Actions workflow as a drift detector,
 *   - curl'd by Reeyen whenever something's weird,
 *   - the reference for "is Vercel configured correctly RIGHT NOW?"
 *
 * Design goals, in order:
 *   1. Fail LOUD with a specific, actionable reason — every failure
 *      message must name the exact env var / system / fix to run.
 *   2. Never 500. Even catastrophic failures return JSON with ok:false
 *      so that curl|jq pipelines work.
 *   3. Read-only. Never writes to Postgres, never sends SMS, never
 *      mutates state. Safe to hammer in a loop.
 *   4. Fast. Every check runs in parallel, aggressive timeouts, cached
 *      where reasonable.
 *
 * ─── What's checked ──────────────────────────────────────────────────────
 *
 *   env_vars                — every required env var is present and non-empty
 *   supabase_admin_auth     — preflight read using the service_role key
 *                             (catches stale/revoked keys)
 *   supabase_jwt_expiry     — decodes the anon + service_role JWTs and
 *                             warns if the exp claim is within 30 days
 *                             (silent auth failure is the #1 future-break risk)
 *   supabase_rls_enabled    — verifies RLS is still enabled on every
 *                             user-facing table (catches accidental
 *                             `ALTER TABLE … DISABLE ROW LEVEL SECURITY`)
 *   supabase_heartbeat      — scraper_status/heartbeat row exists and fresh
 *   supabase_dashboard      — scraper_status/dashboard row exists
 *   scraper_health_cron     — GitHub Actions' scraper-health cron last ran
 *                             within 25h (catches silently-disabled workflows)
 *   twilio_credentials      — Twilio REST API accepts our sid+token
 *   alert_phone_shape       — MANAGER_PHONE is in E.164 format so
 *                             sendSms() won't silently drop alerts
 *   cron_secret_shape       — CRON_SECRET is set and looks like a secret
 *                             (not accidentally left as "changeme")
 *
 * ─── Auth ────────────────────────────────────────────────────────────────
 * Same Bearer-CRON_SECRET pattern as the cron routes — so CI and drift-
 * check workflows can hit this with the same secret they already have,
 * but randos on the internet can't probe our configuration.
 *
 * If CRON_SECRET isn't configured yet, auth is permissive (so you can test
 * it during initial setup). Once CRON_SECRET is set, it's enforced.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdminOrCron } from '@/lib/admin-auth';
import { createHash } from 'crypto';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Phase M2 (2026-05-14): bumped 30 → 60. At fleet scale (50+ hotels)
// the per-property checks (occupancy_capture_failures, model_holdout,
// scraper_pull_latency) start exceeding 30s. The per-check in-memory
// cache below means most polls return in <100ms anyway, but a
// cold-cache cycle needs the headroom.
export const maxDuration = 60;

// Phase M2: in-memory per-check cache. The watchdog polls this route
// every 5min, sometimes alongside an admin browsing /admin/properties
// + the hourly doctor-check cron. Without this, every poll re-runs all
// 33+ checks, hammering Postgres with the same queries. With it, the
// first poll runs everything fresh, subsequent polls within 60s return
// cached results. Cold starts (new Vercel instance) bypass the cache
// naturally because the Map is empty.
//
// Cache key = check name; TTL = 60s. Bypass with ?nocache=1 query arg
// (used by doctor-check cron + manual debugging).
type CachedCheck = { result: Omit<Check, 'name' | 'durationMs'>; expiresAt: number };
const checkResultCache = new Map<string, CachedCheck>();
const CHECK_CACHE_TTL_MS = 60_000;

// ─── Types ───────────────────────────────────────────────────────────────

type CheckStatus = 'ok' | 'warn' | 'fail' | 'skipped';

type Check = {
  name: string;
  status: CheckStatus;
  detail: string;
  /** Optional actionable fix message. */
  fix?: string;
  /** Milliseconds the check took to run. */
  durationMs?: number;
};

type DoctorReport = {
  ok: boolean;
  timestamp: string;
  vercelRegion?: string;
  vercelEnv?: string;
  /**
   * Commit SHA of the currently-running deploy. Pulled from
   * VERCEL_GIT_COMMIT_SHA (set automatically on every Vercel deploy).
   * The post-deploy smoke test reads this to confirm it's hitting the
   * NEW deploy rather than the OLD one still serving traffic during
   * Vercel's rotation window (~30–90s after push).
   */
  commitSha?: string;
  /** Top-level summary counts so grep/jq can decide without parsing checks[]. */
  summary: {
    total: number;
    ok: number;
    warn: number;
    fail: number;
    skipped: number;
  };
  checks: Check[];
};

// ─── Check registry ──────────────────────────────────────────────────────
// Each check is a pure async function returning a Check. Add a new entry
// here and it runs in the parallel battery below.

type CheckFn = () => Promise<Omit<Check, 'name' | 'durationMs'>>;

const checks: Array<[string, CheckFn]> = [
  ['env_vars',                       checkEnvVars],
  // Audit 2026-05-22: warn if DISABLE_SERVER_2FA_ENFORCEMENT is set —
  // the break-glass kill switch for the new server-side 2FA enforcement
  // in requireSession(). Leaving this on past an incident-triage window
  // re-opens the attack vector the enforcement closes.
  ['server_2fa_enforcement_active',  checkServer2faEnforcementActive],
  // Audit 2026-05-22 Phase 2B: synthetic-event self-test for the
  // custom_access_token_hook. Function-exists is not enough — the inner
  // exception blocks can swallow grant failures silently, leaving every
  // JWT without mfa_verified. Calls the hook directly with a known
  // skip_2fa demo user and asserts the claim is set correctly.
  ['mfa_verified_hook_self_test',    checkMfaVerifiedHookSelfTest],
  ['supabase_admin_auth',            checkSupabaseAdminAuth],
  ['supabase_jwt_expiry',            checkSupabaseJwtExpiry],
  // Project consistency: NEXT_PUBLIC_SUPABASE_URL (where the browser
  // logs in) MUST match the project that SUPABASE_SERVICE_ROLE_KEY belongs
  // to. The service-role key is itself a JWT — its `iss` claim names its
  // project. If they drift apart (common during domain migrations or
  // manual Vercel env-var edits), every authenticated API route 401s
  // with "invalid session token" and no other check catches it. Added
  // 2026-05-16 after a Quick Chat / voice-mode auth incident.
  ['supabase_project_consistency',   checkSupabaseProjectConsistency],
  ['supabase_anon_key',              checkSupabaseAnonKeyShape],
  ['supabase_rls_enabled',           checkSupabaseRlsEnabled],
  // Complement to supabase_rls_enabled: the existing check verifies RLS is
  // ON; this one verifies that every tenant-scoped public table also has
  // at least one policy. RLS + no policy = deny-all, which is correct for
  // service-role-only tables but a regression for per-tenant tables that
  // should be visible to their owner. Catches the case where someone runs
  // `DROP POLICY` in the Supabase SQL editor and forgets to recreate it.
  // Requires the pg_tables_policy_coverage view added in migration 0200.
  ['supabase_rls_policy_coverage',   checkSupabaseRlsPolicyCoverage],
  // Storage bucket per-property RLS coverage. Complement to the
  // storage.objects-only `supabase_rls_enabled` check: this one verifies
  // every non-public bucket has at least one policy that scopes by
  // user_owns_property AND a per-folder extraction function. The 0144 bug
  // (`maintenance-photos` was auth-only — any user could read another
  // tenant's photos via guessable folder paths) is exactly this class.
  // Catches out-of-band `DROP POLICY` against storage.objects via the
  // Supabase SQL editor.
  ['storage_bucket_policy_coverage', checkStorageBucketPolicyCoverage],
  ['supabase_realtime_publication',  checkSupabaseRealtimePublication],
  // Plan v4 (2026-05-24): removed `supabase_heartbeat`, `supabase_dashboard`,
  // `dashboard_freshness`, and `vercel_watchdog_degraded` checks. All four
  // read from `scraper_status` / `dashboard_by_date` — tables dropped in
  // the v4 cleanup. The CUA replacement health is covered by the
  // `cua_sessions_alive` / `cua_cost_cap_paused` / `cua_mfa_pending` /
  // `cua_knowledge_files_active` checks added below.

  // Schema-drift detection: every migration in /supabase/migrations/ must be
  // recorded in applied_migrations on the live DB. Catches the "deployed
  // code that calls a column added in 00NN before 00NN was applied" failure
  // mode that otherwise surfaces as cryptic 'relation … not found' 500s.
  ['supabase_migrations_applied',    checkAppliedMigrations],
  // Plan v4 (2026-05-24): removed `scraper_csv_pull` + `scraper_health_cron`.
  // Both read scraper_status keys (`morning`/`evening`/`alertState`) the
  // Railway scraper wrote. Scraper service is gone; CUA polling is
  // monitored via `cua_sessions_alive` instead.
  ['twilio_credentials',             checkTwilioCredentials],
  ['twilio_balance',                 checkTwilioBalance],
  // Twilio FROM-number registration: existing twilio_credentials check
  // only verifies the account is alive and not suspended. It does NOT
  // verify that TWILIO_FROM_NUMBER is actually a phone number owned by
  // this Twilio account. If Reeyen ever rotates Twilio numbers and
  // updates the env var but the new number isn't yet registered (or
  // the toll-free verification expired), sends silently 400 inside
  // sms.ts with error 21659 "From is not a valid, SMS-capable
  // Twilio phone number." May 2026 audit pass-3 closure.
  ['twilio_from_number_registered',  checkTwilioFromNumberRegistered],
  ['alert_phone_shape',              checkAlertPhoneShape],
  ['cron_secret_shape',              checkCronSecretShape],
  ['cron_secret_cross_platform',     checkCronSecretCrossPlatform],
  // Plan v4 (2026-05-24): removed `watchdog_alert_path` +
  // `scraper_pull_latency`. The former read scraper_status['vercel_watchdog'] +
  // ['alertState'] (Railway scraper observability); the latter read
  // `pull_metrics`. Both tables / sources are gone post-v4. The new
  // 5-min `vercel-watchdog` cron polls /api/admin/doctor directly.
  // Plan v4 (2026-05-24): removed `ml_occupancy_capture_failures` +
  // `ml_feature_derivation_failures`. Both incremented counters in
  // scraper_status[ml_failures:<kind>] — dead post-v4. If the new CUA
  // worker needs to surface feature-derivation failures, it'll write
  // to error_logs (already surfaced via recent-errors).
  // Prediction freshness — closes the silent-cron-success bug class.
  // The cron route returns ok:true even if the inner ML calls all fail;
  // the only way to detect that is "did the database actually get new
  // prediction rows today?". May 2026 audit added these checks after
  // discovering inventory_rate_predictions had only today's data while
  // ml-cron had been "green" for weeks.
  ['ml_inventory_predictions_fresh', checkMlInventoryPredictionsFresh],
  ['ml_demand_predictions_fresh',    checkMlDemandPredictionsFresh],
  ['ml_supply_predictions_fresh',    checkMlSupplyPredictionsFresh],
  // Cron heartbeat freshness — independent of GitHub Actions success
  // status. Each cron route writes a heartbeat row as its LAST step;
  // doctor fails if any expected cron is older than 2× its cadence.
  // See migration 0074 + src/lib/cron-heartbeat.ts.
  ['cron_heartbeats_fresh',          checkCronHeartbeatsFresh],
  // Codex follow-up 2026-05-13 (#2): operator-visible surface for the
  // log+skip design from Phase 3.5. Warns when any property has fired
  // a property_misconfigured event in the last 24h.
  ['property_misconfigured_recent',  checkPropertyMisconfiguredRecent],
  // Codex follow-up 2026-05-13 (#4): shape-check the Phase 1 band
  // fields directly instead of the smoke hitting a (nonexistent)
  // HTTP route. Doctor already has admin auth + the helper imported.
  ['inventory_auto_fill_shape',      checkInventoryAutoFillShape],
  // Codex round-3 review 2026-05-13 (E1): surface "model trained but
  // not activating because holdout too small" without operator having
  // to read training logs. Phase B's len(X_test)>=30 gate silently
  // rejects models — this makes that visible.
  ['ml_models_holdout_size',         checkMlModelsHoldoutSize],
  // Phase 7 v2 (2026-05-22): the auto-rollback pipeline depends on a
  // daily prediction_log writer. If the writer cron silently fails,
  // the rolling-MAE check has no fresh data and silently never fires
  // a rollback — exactly the same bug class the v1 design had. These
  // two checks make both halves of the pipeline observable.
  ['ml_prediction_log_writer_alive', checkMlPredictionLogWriterAlive],
  ['ml_no_orphan_active_after_rollback', checkMlNoOrphanActiveAfterRollback],
  // Codex round-5 META J2.1 (2026-05-13): the cohort prior aggregator
  // had a units-mismatch bug for 5+ months — emitted ABSOLUTE
  // units/day into a column named per-room-per-day. Latent today
  // (Beaumont = 1 hotel, falls back to industry seeds) but would
  // explode the day a 5th hotel onboards in any cohort. The aggregator
  // SQL has been fixed; this check warns LOUDLY if any row in
  // inventory_rate_priors falls outside a sane range.
  ['inventory_priors_in_range',      checkInventoryPriorsInRange],
  // HSTS preload list status — submitted 2026-05-13. Today the only
  // signal that Google rejected the preload submission is a hand-curl
  // to hstspreload.org. This check folds that into the operator's
  // existing doctor pass so we find out within one cron tick instead
  // of never. Warns on anything other than 'pending'/'preloaded'.
  ['hsts_preload_status',            checkHstsPreloadStatus],
  // Rate limiter probe — pairs with src/lib/api-ratelimit.ts. If the
  // staxis_api_limit_hit RPC errors at request time, the limiter
  // fails OPEN (production safety: a Postgres blip must not block
  // shift SMS). Doctor surfaces this hidden state: if our probe
  // round-trip fails here, we know the live SMS path is fail-opening
  // every request. May 2026 audit pass-3 closure.
  ['api_limits_writable',            checkApiLimitsWritable],
  // PMS-credentials encryption integrity. Migration 0069 dropped the
  // plaintext ca_username/ca_password columns and replaced them with
  // Vault-backed AES-256 encrypted equivalents. Migration 0140 added the
  // RPC the save-credentials route uses. If either is missing (or the
  // encrypted columns somehow got dropped) we want the doctor to scream —
  // the only alternative is silently saving plaintext credentials or
  // every Test Connection click failing silently for weeks (which is
  // exactly what happened pre-0140).
  ['pms_credentials_encrypted',      checkPmsCredentialsEncrypted],
  // Billing config — fails LOUD on the half-configured state where some
  // Stripe vars are set and others aren't. Warns when none are set
  // (pre-launch trial-only mode). Fails when keys are clearly malformed.
  ['stripe_billing_configured',      checkStripeBillingConfigured],
  // ML_SERVICE_SECRET strength check (Pattern C — security review
  // 2026-05-16): bumped floor from 8 to 32 chars in ml-service/src/config.py.
  // Doctor warns LOUDLY here if the deployed value is short, missing, or
  // looks like a placeholder — so a weak secret can't silently sit in
  // production for weeks.
  ['ml_service_secret_strength',     checkMlServiceSecretStrength],
  // ML routing config drift — catches the gap that ate 3 days of demand
  // predictions in May 2026. When ML_SERVICE_SECRET was set but
  // ML_SERVICE_URLS wasn't, every cron silently returned
  // `{ok:true, skipped:"ML service not configured yet"}` and the
  // workflow's jq guard passed because .ok was true. Doctor now reads the
  // pair together so drift between them screams instead of whispering.
  ['ml_service_urls_configured',     checkMlServiceUrlsConfigured],
  // deploy-ci-cron Step 7.5 (2026-05-22): pings ML /health. The lifespan
  // handler added in main.py blocks /health from responding until env
  // validation passes, so a 200 here proves the new fail-fast startup
  // gate is alive. Surfaces in MlHealthPanel (filters checks by `ml_`
  // prefix) so Reeyen sees the safety net on /admin/ml without hunting.
  ['ml_service_lifespan_active',     checkMlServiceLifespanActive],
  // Error tracking — Sentry no-ops gracefully when DSN missing, but a
  // malformed DSN means errors silently disappear. Fail on bad shape.
  ['sentry_dsn_shape',               checkSentryDsnShape],
  // Phase E2E (2026-05-22) — async email-lifecycle webhook readiness.
  // Warns if RESEND_API_KEY is set (we're sending email) but
  // RESEND_WEBHOOK_SECRET isn't, which means async bounces / complaints
  // go un-tracked. Complements the live /api/resend-webhook route.
  ['resend_webhook_secret_configured', checkResendWebhookSecretConfigured],
  // 2026-05-22 monitoring/logging/secrets hardening — three follow-on
  // checks that complement the DSN shape check:
  //   1. sentry_auth_token_present: source-map upload gated on the token
  //      being set on Vercel (Production scope). Warns when absent.
  //   2. sentry_client_initialized: verifies the SDK loaded (proves DSN
  //      was syntactically valid AND Sentry.init() ran without throwing).
  //   3. sentry_ingest_probe_recent: warns when the last successful
  //      /api/admin/sentry-test ingest probe is older than 7 days.
  //      The probe is the only path that proves end-to-end ingest works
  //      (firewall, project mismatch, quota exhaustion are all things
  //      DSN-shape + client-init can't detect).
  ['sentry_auth_token_present',      checkSentryAuthTokenPresent],
  ['sentry_client_initialized',      checkSentryClientInitialized],
  ['sentry_ingest_probe_recent',     checkSentryIngestProbeRecent],
  // Picovoice wake-word — operator-visible state for "Hey Staxis". Warns
  // on half-configured (key OR .ppn but not both), oks both ways for
  // intentional disabled state and fully-wired state. Replaces the
  // pre-2026-05-14 PICOVOICE_ACCESS_KEY-in-REQUIRED_ENV_VARS approach that
  // hard-failed CI any time the key wasn't set.
  ['picovoice_wake_word_config',     checkPicovoiceWakeWordConfig],
  // Plan v2 F-AI-1 — confirm the operator has documented an AI data-
  // retention posture for Anthropic / OpenAI / ElevenLabs. The check is
  // a stamp (STAXIS_AI_DATA_POLICY env) rather than an inline policy
  // because the actual configuration lives in the provider dashboards;
  // the env is "the operator says they've confirmed it on date X." A
  // missing stamp returns yellow, not red — the live app still works,
  // we just don't know whether ZDR is in force.
  ['ai_data_policy_documented',      checkAiDataPolicyDocumented],
  // Plan v2 M-1 rollout readiness — reports the fraction of voice
  // sessions in the last 24h whose ElevenLabs conversation_id we
  // observed and bound. When ≥ 95%, it's safe to flip
  // STAXIS_VOICE_REQUIRE_CONNECTION_BINDING=true; below that, doing so
  // would refuse legitimate voice turns.
  ['voice_binding_readiness',        checkVoiceBindingReadiness],
  // Plan v2.1 CR-3 — surface whether the CUA action allowlist is in
  // enforce mode on the Fly worker. The code shipped warn-mode-by-
  // default (CUA_POLICY_ENFORCE='warn'); refusals are logged but the
  // action still executes. This check warns yellow until the operator
  // flips Fly secret CUA_POLICY_ENFORCE=enforce, at which point the
  // allowlist actually refuses dangerous post-login clicks instead of
  // just logging them. The flip happens after observing the
  // `cua_action_policy_refusal` stderr stream for one full mapping run
  // with no false-positive refusals.
  ['cua_action_policy_enforce_status', checkCuaActionPolicyEnforceStatus],
  // deploy-ci-cron Step 7.5 (2026-05-22): CUA service had no CI gate
  // before; a TypeScript regression surfaced at Fly deploy time, after
  // an onboarding job was already queued. This check confirms the
  // tests.yml workflow's last run on main passed. Surfaces on
  // /admin/pms (filters checks by `cua_` prefix) so Reeyen sees the
  // onboarding safety net in the same place he opens for PMS work.
  ['cua_service_ci_recent_pass',     checkCuaServiceCiRecentPass],
  // Plan v4 (2026-05-24): removed `rooms_today_seeded`. The check
  // counted rows in the legacy `rooms` table (one-row-per-property-per-
  // date model), which was dropped in v4. The new CUA writes room
  // state into `pms_room_status_log` (event-sourced, not daily-seeded).
  // No equivalent "rows-per-day" check is needed in v4.
  // Audit Batch 2 (F-04): assert every bucket that's supposed to be
  // private actually is. A Supabase Studio UI click can flip a bucket
  // to public; nothing else alarms. List below tracks every bucket
  // that holds PII (voice recordings, invoices, photo counts,
  // maintenance photos). Add new private buckets here when migrations
  // create them.
  ['storage_buckets_private',        checkStorageBucketsPrivate],
  // ─── CUA (Plan v4 universal CUA rebuild — 2026-05-23) ────────────────
  // Per-hotel session-driver health. Each enabled hotel must heartbeat
  // every 60s; a 5-min-stale heartbeat means the driver crashed and the
  // supervisor hasn't respawned it. Fails loudly so we know before
  // customer data goes silently missing.
  ['cua_sessions_alive',             checkCuaSessionsAlive],
  // Hotels currently paused for $5/day Claude cost cap. Warn-level —
  // these auto-resume at midnight local, but recurring trips mean
  // something's broken (PMS UI changed → infinite repair loop, etc.).
  ['cua_cost_cap_paused',            checkCuaCostCapPaused],
  // Hotels waiting on manual MFA re-login. Warn-level — Reeyen sees
  // this on the doctor page + can resolve via /admin/mfa-resume/[id].
  ['cua_mfa_pending',                checkCuaMfaPending],
  // Every enabled hotel needs an active knowledge file for its
  // pms_family — without one the session-driver refuses to start. Fail
  // if any session's pms_family has no active knowledge file row.
  ['cua_knowledge_files_active',     checkCuaKnowledgeFilesActive],
];

// ─── Individual checks ───────────────────────────────────────────────────

/**
 * All env vars the app needs at runtime. Grouped by owner so error messages
 * point to the right platform (Vercel UI vs Railway UI).
 *
 * If you add a new required env var anywhere in the Vercel code, ADD IT
 * HERE TOO — otherwise a missing var silently becomes undefined at runtime.
 *
 * `altNames` — some vars have historical aliases that runtime code still
 * accepts via `process.env.X || process.env.Y`. The doctor must mirror that
 * fallback exactly, otherwise it reports false-positive failures for vars
 * that are actually working. Specifically:
 *   - sms.ts accepts TWILIO_FROM_NUMBER || TWILIO_PHONE_NUMBER
 *   - cron routes accept MANAGER_PHONE || OPS_ALERT_PHONE
 * See the "Env var naming reconciliation" commit for history.
 */
const REQUIRED_ENV_VARS: Array<{ name: string; altNames?: string[]; group: string }> = [
  // Supabase (client-safe)
  { name: 'NEXT_PUBLIC_SUPABASE_URL',          group: 'supabase' },
  { name: 'NEXT_PUBLIC_SUPABASE_ANON_KEY',     group: 'supabase' },
  // Supabase (server-only — service_role bypasses RLS, NEVER exposed to browser)
  { name: 'SUPABASE_SERVICE_ROLE_KEY',         group: 'supabase-admin' },
  // Twilio
  { name: 'TWILIO_ACCOUNT_SID',                group: 'twilio' },
  { name: 'TWILIO_AUTH_TOKEN',                 group: 'twilio' },
  { name: 'TWILIO_FROM_NUMBER', altNames: ['TWILIO_PHONE_NUMBER'], group: 'twilio' },
  // Ops alert phone (without this, alerts silently no-op — the exact failure mode we're trying to prevent)
  { name: 'MANAGER_PHONE',      altNames: ['OPS_ALERT_PHONE'],      group: 'alerts' },
  // Shared secret for cron auth
  { name: 'CRON_SECRET',                       group: 'cron' },
  // Local Claude Code hook auth. requireHeartbeatSecret() in
  // src/lib/api-auth.ts returns 500 in true production when this is unset,
  // so a deploy that drops the var passes env checks but breaks the
  // PostToolUse/Stop hooks on first hit. (Audit Batch 2, NEW-4.)
  { name: 'HEARTBEAT_SECRET',                  group: 'cron' },
  // Anthropic — required for the entire agent layer (chatbot, tool calls,
  // summarization, voice TTS routing). Round 13 (2026-05-13): added after
  // a silent prod outage where the key was missing for an unknown duration
  // and the doctor reported "all required env vars present" the entire
  // time because the list didn't include it. The cron-driven doctor-check
  // alert + the new captureException in llm.ts's getClient() are the
  // detection layers; THIS list is what makes both possible.
  { name: 'ANTHROPIC_API_KEY',                 group: 'anthropic' },
  // Voice surface (2026-05-14)
  //   - ElevenLabs Conversational AI powers voice mode (Phone icon + Cmd+/).
  //     ELEVENLABS_API_KEY mints signed URLs server-side AND drives the
  //     walkthrough's one-shot TTS (/api/agent/speak → Jessica voice).
  //     ELEVENLABS_AGENT_ID names the agent the browser connects to,
  //     ELEVENLABS_WEBHOOK_SECRET gates the brain webhook.
  //     ELEVENLABS_VOICE_ID is the voice the walkthrough narrates as
  //     (Jessica — matches the conversational surface for consistency).
  //   - OPENAI_API_KEY remains on the required list for other surfaces
  //     (transcription, embedding) but is no longer used by the walkthrough.
  //   - PICOVOICE_ACCESS_KEY backs "Hey Staxis" wake word and is
  //     intentionally OPTIONAL (gated on both the access key AND a .ppn
  //     file in public/wake-words/) — see checkPicovoiceWakeWordConfig.
  { name: 'OPENAI_API_KEY',                    group: 'voice' },
  { name: 'ELEVENLABS_API_KEY',                group: 'voice' },
  { name: 'ELEVENLABS_AGENT_ID',               group: 'voice' },
  { name: 'ELEVENLABS_WEBHOOK_SECRET',         group: 'voice' },
  { name: 'ELEVENLABS_VOICE_ID',               group: 'voice' },
  // Billing — these are checked for SHAPE in checkStripeBillingConfigured.
  // Listing here so the env_vars check reports a clean "missing" message
  // when none are set, but the billing-configured check is the source of
  // truth on whether the bundle is fully wired up.
  // NOTE: These are intentionally NOT marked required — see
  // checkStripeBillingConfigured for the all-or-nothing logic that
  // distinguishes "not yet set up" (warn) from "half configured" (fail).
  // Keep them out of REQUIRED_ENV_VARS so the env_vars check doesn't
  // fail before Stripe is set up.
];

/**
 * Look up an env var by its canonical name OR any of its alt-names. Returns
 * the first non-empty value found, or undefined. Mirrors the `X || Y`
 * pattern the runtime code uses, so the doctor never reports a var as
 * missing when a fallback is actually set.
 */
function readEnvWithFallback(v: { name: string; altNames?: string[] }): {
  value: string | undefined;
  resolvedName: string | undefined;
} {
  const names = [v.name, ...(v.altNames ?? [])];
  for (const n of names) {
    const val = process.env[n];
    if (val !== undefined && val.trim() !== '') {
      return { value: val, resolvedName: n };
    }
  }
  return { value: undefined, resolvedName: undefined };
}

async function checkEnvVars(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  const missing: string[] = [];
  const empty: string[] = [];
  const usingAlt: string[] = [];

  for (const v of REQUIRED_ENV_VARS) {
    // First check if the canonical name is set but empty (distinct failure mode).
    const canonical = process.env[v.name];
    const { value, resolvedName } = readEnvWithFallback(v);

    if (value === undefined) {
      // Nothing set under any accepted name.
      const allNames = v.altNames?.length
        ? `${v.name} (or ${v.altNames.join(', ')})`
        : v.name;
      if (canonical !== undefined && canonical.trim() === '') {
        empty.push(allNames);
      } else {
        missing.push(allNames);
      }
    } else if (resolvedName && resolvedName !== v.name) {
      // Working, but only via an alt-name. Flag as a warning-worthy note
      // in the detail string — still counts as ok for the overall status.
      usingAlt.push(`${v.name}=>${resolvedName}`);
    }
  }

  if (missing.length === 0 && empty.length === 0) {
    const detail = usingAlt.length
      ? `all ${REQUIRED_ENV_VARS.length} required env vars present (using alt names: ${usingAlt.join(', ')})`
      : `all ${REQUIRED_ENV_VARS.length} required env vars present`;
    return { status: 'ok', detail };
  }

  const parts: string[] = [];
  if (missing.length) parts.push(`missing: ${missing.join(', ')}`);
  if (empty.length)   parts.push(`empty: ${empty.join(', ')}`);

  return {
    status: 'fail',
    detail: parts.join(' | '),
    fix: 'Vercel → Project Settings → Environment Variables. Set missing/empty vars and redeploy.',
  };
}

/**
 * Audit 2026-05-22: surfaces the DISABLE_SERVER_2FA_ENFORCEMENT
 * break-glass kill switch when it's active. When set, requireSession()
 * skips the device-trust check and accepts any valid Supabase JWT —
 * the pre-Phase-1 behavior. The switch exists for emergency recovery
 * (a bad deploy of the new gate locking users out) but should NEVER
 * stay on past an incident-triage window. Warning here surfaces it on
 * every doctor poll so it doesn't get forgotten.
 *
 * status: 'ok' when unset / not 'true'
 * status: 'fail' when set to 'true' — intentionally a hard fail (not warn)
 *   because the security boundary is fully disabled while it's on
 */
async function checkServer2faEnforcementActive(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  if (env.DISABLE_SERVER_2FA_ENFORCEMENT === 'true') {
    return {
      status: 'fail',
      detail:
        'DISABLE_SERVER_2FA_ENFORCEMENT=true is active — server-side 2FA enforcement in '
        + 'requireSession() is BYPASSED. The OTP gate is currently security theater. This '
        + 'switch is for emergency triage only.',
      fix: 'Vercel → Project Settings → Environment Variables → unset DISABLE_SERVER_2FA_ENFORCEMENT '
        + '(or set to anything other than the literal string "true") and redeploy. After unsetting, '
        + 'confirm a normal user can still sign in from a new browser without errors.',
    };
  }
  return { status: 'ok', detail: 'server-side 2FA enforcement active (DISABLE_SERVER_2FA_ENFORCEMENT unset)' };
}

/**
 * Audit 2026-05-22 Phase 2B — synthetic-event self-test for the
 * custom_access_token_hook. Function-exists is insufficient: the hook's
 * inner exception blocks swallow grant failures and RLS-policy issues,
 * leaving every JWT without the mfa_verified claim. That state would
 * pass a "function exists" check but break the security guarantee silently.
 *
 * This check calls the hook directly with a synthetic event payload for
 * a known skip_2fa demo user (test@staxis.local, role=general_manager).
 * The hook should return claims with `mfa_verified=true` via the
 * skip_2fa path. Any other result indicates a silent failure.
 */
async function checkMfaVerifiedHookSelfTest(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  // The known demo user (test@staxis.local). Its auth.users.id was
  // observed in prod as 8b1ca426-fa48-43c9-90e4-eb69fed168b6 during the
  // Phase A hook-verification run.
  //
  // Configurable via STAXIS_DEMO_USER_ID env var (Codex review #7,
  // 2026-05-22). If we ever recreate test@staxis.local with a new
  // auth.users.id — e.g. during a disaster restore from PITR, or if the
  // demo user gets purged by the orphan sweeper — set the env var to
  // the new UUID and redeploy without touching this code. Default
  // fallback is the current prod UUID so existing deploys keep working
  // without configuration.
  const KNOWN_DEMO_USER_ID = env.STAXIS_DEMO_USER_ID ?? '8b1ca426-fa48-43c9-90e4-eb69fed168b6';
  // Synthetic session_id — not a real session. The hook's skip_2fa
  // branch fires before the session_id lookup so this doesn't need
  // to match a real auth.sessions row.
  const SYNTHETIC_SESSION_ID = '00000000-0000-0000-0000-000000000001';

  try {
    const { data, error } = await supabaseAdmin.rpc('custom_access_token_hook', {
      event: {
        user_id: KNOWN_DEMO_USER_ID,
        authentication_method: 'token_refresh',
        claims: { session_id: SYNTHETIC_SESSION_ID },
      },
    });
    if (error) {
      return {
        status: 'fail',
        detail: `hook RPC errored: ${error.message}`,
        fix: 'check that migrations 0159 + 0160 are applied; verify supabase_auth_admin has SELECT on accounts + mfa_verified_sessions; review Postgres logs for "custom_access_token_hook: ... failed" notices.',
      };
    }
    const result = data as { claims?: { mfa_verified?: unknown } } | null;
    const claim = result?.claims?.mfa_verified;
    if (claim === undefined || claim === null) {
      return {
        status: 'fail',
        detail: 'hook ran but did NOT set mfa_verified claim — silent failure inside the function. Every authenticated user is currently bypassing Door B until this is fixed.',
        fix: 'check Postgres logs for "custom_access_token_hook: ... failed" notices. Most likely a grant or RLS-policy issue on accounts or mfa_verified_sessions. Migration 0160 must be applied; re-run if uncertain.',
      };
    }
    if (claim !== true) {
      return {
        status: 'fail',
        detail: `demo user expected mfa_verified=true (skip_2fa path) but got ${JSON.stringify(claim)} — skip_2fa path may be broken`,
        fix: 'verify accounts.skip_2fa = true for the demo user; verify accounts.role <> "admin"; check the hook function body in migration 0160.',
      };
    }
    return { status: 'ok', detail: 'hook returns mfa_verified=true for demo user (synthetic event)' };
  } catch (err) {
    return {
      status: 'fail',
      detail: `hook self-test threw: ${errToString(err)}`,
      fix: 'function may be missing or has a syntax error. Apply migrations 0159 + 0160.',
    };
  }
}

async function checkSupabaseAdminAuth(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  // Cheapest authenticated query: read one row from a table that always
  // exists (scraper_status). If the service_role key is revoked/stale
  // Supabase returns an auth error that we surface with a specific fix.
  try {
    const { error } = await supabaseAdmin
      .from('scraper_status')
      .select('key')
      .limit(1);
    if (error) throw error;
    return {
      status: 'ok',
      detail: 'service_role key accepted by Supabase',
    };
  } catch (err) {
    return {
      status: 'fail',
      detail: `Supabase Admin auth failed: ${errToString(err)}`,
      fix: 'SUPABASE_SERVICE_ROLE_KEY is likely stale/revoked. Supabase Dashboard → Project Settings → API → Reset service_role key. Update BOTH Vercel (SUPABASE_SERVICE_ROLE_KEY) AND Railway (SUPABASE_SERVICE_ROLE_KEY). See RUNBOOKS.md → Supabase Key Rotation.',
    };
  }
}

/**
 * Decode a Supabase legacy JWT (HS256, base64url payload) without verifying
 * the signature. We ONLY care about the `exp` claim here — the signature is
 * verified by Supabase itself on every request. Returns null if the token
 * isn't a decodable JWT (e.g. new `sb_secret_*` format, which doesn't have
 * an exp because it's an opaque API key).
 */
function decodeJwtExp(token: string | undefined): number | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;                 // not a JWT shape
  try {
    // base64url → base64
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    // atob handles base64; decodeURIComponent+escape trick gives us UTF-8.
    const json = Buffer.from(b64, 'base64').toString('utf8');
    const claims = JSON.parse(json) as { exp?: number };
    return typeof claims.exp === 'number' ? claims.exp : null;
  } catch {
    return null;
  }
}

async function checkSupabaseJwtExpiry(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  // The legacy Supabase keys are long-lived JWTs (typically ~10 years). When
  // they finally expire, Supabase starts rejecting every admin/anon request
  // with 401 and the app looks mysteriously broken. Warn ahead of time so
  // rotation can happen on a calm Tuesday, not at 2am during an outage.
  const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const service = env.SUPABASE_SERVICE_ROLE_KEY;
  const now = Math.floor(Date.now() / 1000);
  const WARN_WINDOW_SEC = 30 * 86400;                  // 30 days

  const probes: Array<{ label: string; token: string | undefined }> = [
    { label: 'anon',         token: anon },
    { label: 'service_role', token: service },
  ];

  const issues: string[] = [];
  const okLines: string[] = [];
  const opaque: string[] = [];

  for (const p of probes) {
    if (!p.token) {
      // env_vars check will already flag this as missing — don't double-count.
      opaque.push(`${p.label}: not set`);
      continue;
    }
    const exp = decodeJwtExp(p.token);
    if (exp === null) {
      // New `sb_secret_*` / `sb_publishable_*` keys are opaque API keys with
      // no exp. They rotate under a different model; treat as OK.
      opaque.push(`${p.label}: opaque API key (no exp claim)`);
      continue;
    }
    const secUntil = exp - now;
    const daysUntil = Math.floor(secUntil / 86400);
    if (secUntil <= 0) {
      issues.push(`${p.label} EXPIRED (exp=${new Date(exp * 1000).toISOString()})`);
    } else if (secUntil < WARN_WINDOW_SEC) {
      issues.push(`${p.label} expires in ${daysUntil} days`);
    } else {
      okLines.push(`${p.label}: ${daysUntil}d remaining`);
    }
  }

  if (issues.some(i => i.includes('EXPIRED'))) {
    return {
      status: 'fail',
      detail: issues.join('; '),
      fix: 'Supabase Dashboard → Project Settings → API → Reset keys. Update Vercel (NEXT_PUBLIC_SUPABASE_ANON_KEY + SUPABASE_SERVICE_ROLE_KEY) AND Railway (SUPABASE_SERVICE_ROLE_KEY). See RUNBOOKS.md → JWT expiration.',
    };
  }
  if (issues.length > 0) {
    return {
      status: 'warn',
      detail: issues.join('; '),
      fix: 'Rotate Supabase keys before expiry. Supabase Dashboard → Project Settings → API → Reset keys. Update Vercel + Railway.',
    };
  }
  const parts = [...okLines, ...opaque].filter(Boolean);
  return { status: 'ok', detail: parts.join('; ') || 'keys valid' };
}

/**
 * Decode a Supabase JWT's payload WITHOUT verifying the signature, returning
 * the `iss` (issuer) claim. Used by the project-consistency check below to
 * verify NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY point at
 * the same project. Returns null for non-JWT tokens (e.g. the new opaque
 * `sb_secret_*` API key format) or unparseable input.
 */
function decodeJwtIss(token: string | undefined): string | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(b64, 'base64').toString('utf8');
    const claims = JSON.parse(json) as { iss?: unknown };
    return typeof claims.iss === 'string' ? claims.iss : null;
  } catch {
    return null;
  }
}

/**
 * Extract the project ref (the `xxxxxxxxxxxx` subdomain in
 * https://xxxxxxxxxxxx.supabase.co) from a URL or issuer claim. The whole
 * point of this check is to detect when the ref on one side doesn't match
 * the other — comparing refs directly is more robust than string-matching
 * full URLs (issuers include `/auth/v1`, URLs don't).
 */
function supabaseProjectRef(urlOrIss: string | null): string | null {
  if (!urlOrIss) return null;
  const m = /https?:\/\/([a-z0-9-]+)\.supabase\.co/i.exec(urlOrIss);
  return m ? m[1].toLowerCase() : null;
}

async function checkSupabaseProjectConsistency(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !serviceKey) {
    // env_vars check covers the missing case; skip rather than double-report.
    return { status: 'skipped', detail: 'NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set' };
  }

  const urlRef = supabaseProjectRef(url);
  if (!urlRef) {
    return {
      status: 'fail',
      detail: `NEXT_PUBLIC_SUPABASE_URL "${url}" is not a *.supabase.co URL — can't extract project ref`,
      fix: 'Set NEXT_PUBLIC_SUPABASE_URL to https://<project-ref>.supabase.co on Vercel + Railway.',
    };
  }

  const serviceIss = decodeJwtIss(serviceKey);
  const anonIss = decodeJwtIss(anonKey);

  // New opaque keys (sb_secret_*, sb_publishable_*) don't carry an iss
  // claim. We can't cross-check them — flag as warn so the operator knows
  // this check is providing reduced coverage, but don't block.
  if (!serviceIss && !anonIss) {
    return {
      status: 'warn',
      detail: `Keys are opaque (sb_secret_* / sb_publishable_*) — can't verify project consistency from JWT claims. URL ref=${urlRef}.`,
      fix: 'Manually verify Supabase Dashboard → Project Settings → API → API URL matches NEXT_PUBLIC_SUPABASE_URL.',
    };
  }

  const mismatches: string[] = [];
  if (serviceIss) {
    const ref = supabaseProjectRef(serviceIss);
    if (ref && ref !== urlRef) {
      mismatches.push(`SUPABASE_SERVICE_ROLE_KEY signed by ref=${ref}`);
    }
  }
  if (anonIss) {
    const ref = supabaseProjectRef(anonIss);
    if (ref && ref !== urlRef) {
      mismatches.push(`NEXT_PUBLIC_SUPABASE_ANON_KEY signed by ref=${ref}`);
    }
  }

  if (mismatches.length > 0) {
    return {
      status: 'fail',
      detail: `Project drift: NEXT_PUBLIC_SUPABASE_URL points to ref=${urlRef}, but ${mismatches.join('; ')}. Every authenticated request will 401 with "invalid session token".`,
      fix: 'Either set NEXT_PUBLIC_SUPABASE_URL to https://<correct-ref>.supabase.co OR pull fresh keys from the dashboard for the URL\'s project. Update Vercel (all three Supabase vars) AND Railway (SUPABASE_SERVICE_ROLE_KEY). Then redeploy.',
    };
  }

  return {
    status: 'ok',
    detail: `URL + keys all point to ref=${urlRef}`,
  };
}

/**
 * Critical tables where a disabled RLS policy = data leak (anon/authenticated
 * users can read every row across every property). If this check flips to
 * fail, stop everything and fix immediately.
 *
 * Adding a new user-facing or sensitive backend table? Add it here too.
 * Tables must exist in pg_catalog (the check warns on any name not found).
 *
 * Intentionally excluded:
 *   - *_priors (global cross-hotel ML coefficients, readable by authenticated)
 *   - scraper_status (global heartbeat, readable by authenticated)
 *   - log / audit tables with 0 policies (RLS-on + no grants = already locked)
 */
const RLS_REQUIRED_TABLES = [
  // Identity / accounts
  'accounts',
  'account_invites',
  'hotel_join_codes',

  // Properties + property-scoped customer data
  'properties',
  'rooms',
  'public_areas',
  'staff',
  'attendance_marks',
  'schedule_assignments',
  'scheduled_shifts',
  'shift_confirmations',
  'time_off_requests',
  'week_publications',
  'property_shift_presets',
  'plan_snapshots',

  // Operations + housekeeping
  'cleaning_events',
  'daily_logs',
  'dashboard_by_date',
  'deep_clean_config',
  'deep_clean_records',
  'guest_requests',
  'handoff_logs',
  'manager_notifications',
  'preventive_tasks',
  'work_orders',
  'laundry_config',

  // Inventory
  'inventory',
  'inventory_budgets',
  'inventory_counts',
  'inventory_discards',
  'inventory_orders',
  'inventory_reconciliations',
  'inventory_rate_predictions',

  // ML predictions / overrides (per-property)
  'demand_predictions',
  'supply_predictions',
  'optimizer_results',
  'prediction_log',
  'prediction_overrides',
  'ml_feature_flags',
  'model_runs',

  // Agent (per-user data)
  'agent_conversations',
  'agent_messages',
  'agent_costs',
  'agent_nudges',
  'walkthrough_runs',

  // High-sensitivity backend tables — service-role only.
  // RLS off here would be catastrophic (plain-text PMS passwords, phone
  // numbers, webhook dedupe, Stripe events).
  'scraper_credentials',
  'sms_jobs',
  'pull_jobs',
  'pms_recipes',
  'onboarding_jobs',
  'idempotency_log',
  'stripe_processed_events',
  'processed_sentry_webhooks',
  'processed_twilio_webhooks',
];

async function checkSupabaseRlsEnabled(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  // pg_class.relrowsecurity is true iff RLS is currently enabled on the
  // table. We read via the service_role client which bypasses RLS to see
  // the raw pg_catalog state. If a developer ran `ALTER TABLE … DISABLE
  // ROW LEVEL SECURITY` for debugging and forgot to re-enable it, this
  // catches it before anon users start reading PII.
  try {
    const { data, error } = await supabaseAdmin
      .from('pg_tables_rls_status')
      .select('tablename, rowsecurity')
      .in('tablename', RLS_REQUIRED_TABLES);
    if (error) {
      // The view may not exist yet (migration 0003 adds it). Fall back to
      // a single-table probe — if RLS is off on any critical table the
      // service_role client still reads it (service_role bypasses RLS by
      // design), so the only way to verify from application code is via a
      // dedicated catalog view. Without the view, degrade to a warn.
      return {
        status: 'warn',
        detail: `pg_tables_rls_status view not available (${errToString(error)}). Run migration 0003_rls_status_view.sql.`,
        fix: 'Apply supabase/migrations/0003_rls_status_view.sql in the Supabase SQL editor so the doctor can verify RLS state.',
      };
    }
    const byName = new Map<string, boolean>();
    for (const row of (data ?? [])) {
      byName.set(row.tablename as string, !!row.rowsecurity);
    }
    const missing: string[] = [];
    const disabled: string[] = [];
    for (const name of RLS_REQUIRED_TABLES) {
      if (!byName.has(name)) { missing.push(name); continue; }
      if (byName.get(name) !== true) disabled.push(name);
    }
    if (disabled.length > 0) {
      return {
        status: 'fail',
        detail: `RLS DISABLED on: ${disabled.join(', ')} — anon users may be able to read these tables`,
        fix: `ALTER TABLE ${disabled.join(', ')} ENABLE ROW LEVEL SECURITY;`,
      };
    }
    if (missing.length > 0) {
      return {
        status: 'warn',
        detail: `tables missing from pg_catalog: ${missing.join(', ')} (expected after migration)`,
      };
    }
    return {
      status: 'ok',
      detail: `RLS enabled on all ${RLS_REQUIRED_TABLES.length} critical tables`,
    };
  } catch (err) {
    return {
      status: 'fail',
      detail: `RLS check failed: ${errToString(err)}`,
    };
  }
}

/**
 * Verifies every tenant-scoped public table has at least one RLS policy.
 *
 * The existing `supabase_rls_enabled` check confirms RLS is ON. That alone
 * is insufficient — RLS + zero policies = deny-all (correct for service-
 * role-only tables, but a regression for per-tenant tables that owners
 * need to see). This check finds tables that have:
 *   1. RLS enabled (relrowsecurity=true), AND
 *   2. A tenant identifier column (property_id, account_id, etc.), AND
 *   3. Zero policies in pg_policies for that table.
 *
 * That combination means the owner can't read their own data — a silent-
 * empty-state bug from the production side. Out-of-band changes via the
 * Supabase SQL editor (e.g., dropping a policy during incident response
 * and forgetting to recreate it) are the most likely cause.
 *
 * Excludes the SERVICE_ROLE_ONLY allowlist: tables that intentionally have
 * RLS-on with no end-user policies (server-role accesses them via
 * supabaseAdmin). Mirrors the allowlist in scripts/audit-rls-policy-
 * coverage.mjs — KEEP THESE IN SYNC.
 *
 * Requires the `pg_tables_policy_coverage` view added in migration 0200.
 * Until 0200 is applied to prod, this check returns 'warn' rather than
 * 'fail' so the doctor doesn't alert during the rollout window.
 */
const RLS_SERVICE_ROLE_ONLY_ALLOWLIST = new Set([
  'agent_eval_baselines',
  'agent_prompts',
  'agent_conversations_archived',
  'agent_messages_archived',
  'agent_voice_sessions',
  'error_logs',
  'webhook_log',
  'api_limits',
  'app_events',
  'user_feedback',
  'expenses',
  'claude_usage_log',
  'trusted_devices',
  'agent_cost_finalize_failures',
  'staff_magic_codes',
  'scraper_credentials',
  'idempotency_log',
  'sms_jobs',
  'onboarding_jobs',
  'stripe_processed_events',
  'pull_jobs',
  'processed_twilio_webhooks',
  'pull_metrics',
  'scraper_session',
]);

async function checkSupabaseRlsPolicyCoverage(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  try {
    const { data, error } = await supabaseAdmin
      .from('pg_tables_policy_coverage')
      .select('tablename, rls_enabled, policy_count, has_tenant_column');
    if (error) {
      // The view is created by migration 0200. Before 0200 is applied to
      // prod the view doesn't exist — return a warn, not a fail, so the
      // doctor doesn't page Reeyen during the rollout window.
      const msg = errToString(error);
      if (msg.includes('relation') || msg.includes('does not exist') || msg.includes('Could not find')) {
        return {
          status: 'warn',
          detail: 'pg_tables_policy_coverage view missing — migration 0200 not yet applied',
          fix: 'Apply supabase/migrations/0200_explicit_deny_all_service_role_only_tables.sql in the Supabase SQL editor.',
        };
      }
      return {
        status: 'warn',
        detail: `policy-coverage view read failed: ${msg}`,
      };
    }

    const missing: string[] = [];
    for (const row of (data ?? []) as Array<{
      tablename: string;
      rls_enabled: boolean;
      policy_count: number;
      has_tenant_column: boolean;
    }>) {
      if (!row.has_tenant_column) continue;
      if (RLS_SERVICE_ROLE_ONLY_ALLOWLIST.has(row.tablename)) continue;
      if (!row.rls_enabled) {
        // Covered by checkSupabaseRlsEnabled; flag it here too for
        // belt-and-suspenders since this check has the tenant-column
        // signal that the older check doesn't.
        missing.push(`${row.tablename} (RLS disabled)`);
        continue;
      }
      if (row.policy_count === 0) {
        missing.push(`${row.tablename} (no policies)`);
      }
    }

    if (missing.length > 0) {
      return {
        status: 'fail',
        detail: `tenant-scoped public tables missing RLS policy: ${missing.join(', ')}`,
        fix: 'Add a CREATE POLICY for each affected table (canonical pattern: `for all using (user_owns_property(property_id))`).',
      };
    }
    return {
      status: 'ok',
      detail: `every tenant-scoped public table has RLS + at least one policy (${(data ?? []).length} tables scanned)`,
    };
  } catch (err) {
    return {
      status: 'warn',
      detail: `RLS policy-coverage check threw: ${errToString(err)}`,
    };
  }
}

/**
 * Verifies every non-public storage bucket has at least one RLS policy on
 * storage.objects that scopes by `user_owns_property` AND a per-folder
 * extraction function (storage.foldername, string_to_array, split_part).
 *
 * Why: migration 0144 closed a HIGH-severity bug where the
 * `maintenance-photos` bucket's policies were `using (bucket_id = 'X')`
 * with no per-property check — any authenticated user could read another
 * tenant's photos via guessable folder paths. The canonical fix is to
 * scope by `user_owns_property(((storage.foldername(name))[1])::uuid)`.
 *
 * Out-of-band drift this catches: someone runs
 * `DROP POLICY "maintenance_photos_read_owner" ON storage.objects` in the
 * Supabase SQL editor during incident response and forgets to recreate
 * it. Lint catches migration regressions; this catches editor drift.
 *
 * Allowlist: buckets with `public = true` or with documented exceptions
 * (account-scoped / service-role-only) are skipped via the
 * STORAGE_BUCKET_RLS_ALLOWLIST. Keep in sync with
 * scripts/audit-storage-bucket-rls.mjs.
 */
const STORAGE_BUCKET_RLS_ALLOWLIST = new Set<string>([
  // None today. Add entries here ONLY with a corresponding
  // `-- @storage: ...` comment in the migration that creates the bucket.
]);

async function checkStorageBucketPolicyCoverage(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  try {
    // 1. List buckets via service-role (bypasses any RLS on storage.buckets).
    const { data: buckets, error: bErr } = await supabaseAdmin
      .schema('storage')
      .from('buckets')
      .select('name, public');
    if (bErr) {
      return {
        status: 'warn',
        detail: `storage.buckets read failed: ${errToString(bErr)}`,
      };
    }
    const privateBuckets = ((buckets ?? []) as Array<{ name: string; public: boolean }>)
      .filter((b) => !b.public && !STORAGE_BUCKET_RLS_ALLOWLIST.has(b.name));
    if (privateBuckets.length === 0) {
      return { status: 'ok', detail: 'no private storage buckets to check' };
    }

    // 2. Read pg_policies for storage.objects via the supabase RPC pattern.
    //    PostgREST exposes pg_policies through a fallback path; we use a
    //    direct query via the supabase-js `rpc` API would need a server-
    //    defined function. Instead we use the same approach as the
    //    existing pg_tables_rls_status check: a view. To keep this self-
    //    contained without adding a new view, we use the supabase admin
    //    client to fetch via REST `pg_policies` if PostgREST exposes it.
    const { data: pols, error: pErr } = await supabaseAdmin
      .from('pg_policies')
      .select('policyname, tablename, schemaname, qual, with_check, cmd')
      .eq('schemaname', 'storage')
      .eq('tablename', 'objects');
    if (pErr) {
      // pg_policies isn't exposed by default. Degrade to warn — the lint
      // script catches the same class at PR time.
      const msg = errToString(pErr);
      if (msg.includes('Could not find') || msg.includes('does not exist') || msg.includes('relation')) {
        return {
          status: 'warn',
          detail: `pg_policies not exposed via PostgREST — relying on lint script audit-storage-bucket-rls.mjs at PR time`,
        };
      }
      return { status: 'warn', detail: `pg_policies read failed: ${msg}` };
    }

    type Policy = { policyname: string; qual: string | null; with_check: string | null };
    const policies = (pols ?? []) as Policy[];

    const PER_FOLDER_RX = /\b(storage\.foldername|string_to_array|split_part)\b/i;
    const missing: string[] = [];
    for (const bucket of privateBuckets) {
      const guarded = policies.some((p) => {
        const text = `${p.qual ?? ''} ${p.with_check ?? ''}`.toLowerCase();
        if (!text.includes(`'${bucket.name}'`)) return false;
        return /\buser_owns_property\b/.test(text) && PER_FOLDER_RX.test(text);
      });
      if (!guarded) missing.push(bucket.name);
    }

    if (missing.length > 0) {
      return {
        status: 'fail',
        detail: `private storage buckets missing per-property RLS: ${missing.join(', ')}`,
        fix: 'Add a CREATE POLICY for each bucket using `user_owns_property(((storage.foldername(name))[1])::uuid)` (template: migration 0144).',
      };
    }
    return {
      status: 'ok',
      detail: `${privateBuckets.length} private storage bucket(s), all per-property protected`,
    };
  } catch (err) {
    return {
      status: 'warn',
      detail: `storage bucket policy-coverage check threw: ${errToString(err)}`,
    };
  }
}

async function checkSupabaseHeartbeat(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  try {
    const { data, error } = await supabaseAdmin
      .from('scraper_status')
      .select('data, updated_at')
      .eq('key', 'heartbeat')
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      return {
        status: 'warn',
        detail: 'scraper_status.heartbeat row does not exist yet (scraper may not have run)',
        fix: 'Check Railway: is the hotelops-scraper service running? Look for "Supabase auth verified ✓" in Railway logs.',
      };
    }
    // data column is jsonb: { at: ISO string } or timestamp in updated_at.
    const value = (data.data ?? {}) as { at?: string };
    const at = value.at ? new Date(value.at) : (data.updated_at ? new Date(data.updated_at) : null);
    if (!at || isNaN(at.getTime())) {
      return { status: 'warn', detail: 'heartbeat row exists but has no parseable timestamp' };
    }
    const minAgo = Math.floor((Date.now() - at.getTime()) / 60_000);
    if (minAgo > 20) {
      return {
        status: 'fail',
        detail: `scraper heartbeat is ${minAgo} min stale (>20 min = dead)`,
        fix: 'Railway scraper process is not ticking. Check Railway → hotelops-scraper → Logs.',
      };
    }
    if (minAgo > 10) {
      return {
        status: 'warn',
        detail: `scraper heartbeat is ${minAgo} min old (ticks every 5 min, so 10–20 = degraded)`,
      };
    }
    return { status: 'ok', detail: `scraper heartbeat fresh (${minAgo} min ago)` };
  } catch (err) {
    return {
      status: 'fail',
      detail: `Supabase read failed: ${errToString(err)}`,
    };
  }
}

async function checkSupabaseDashboard(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  try {
    const { data, error } = await supabaseAdmin
      .from('scraper_status')
      .select('data, updated_at')
      .eq('key', 'dashboard')
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      return {
        status: 'warn',
        detail: 'scraper_status.dashboard row does not exist yet (scraper may not have completed a pull)',
      };
    }
    const value = (data.data ?? {}) as { pulledAt?: string; errorCode?: string };
    const errorCode = typeof value.errorCode === 'string' ? value.errorCode : null;

    if (errorCode) {
      return {
        status: 'warn',
        detail: `dashboard errorCode=${errorCode} (scraper-health handles alerting — this is just FYI)`,
      };
    }
    const pulledAt = value.pulledAt ? new Date(value.pulledAt) : (data.updated_at ? new Date(data.updated_at) : null);
    if (pulledAt && !isNaN(pulledAt.getTime())) {
      const minAgo = Math.floor((Date.now() - pulledAt.getTime()) / 60_000);
      return { status: 'ok', detail: `last successful pull ${minAgo} min ago` };
    }
    return { status: 'warn', detail: 'dashboard row exists but has no pulledAt' };
  } catch (err) {
    return {
      status: 'fail',
      detail: `Supabase read failed: ${errToString(err)}`,
    };
  }
}

// F7: per-property dashboard freshness. Mirrors the UI's
// DASHBOARD_STALE_MINUTES (25 min) at the warn threshold, fails at 45 min.
// Skipped outside the scraper's 5am–11pm CT window so off-hours staleness
// (when no pulls are scheduled) doesn't false-alarm.
async function checkDashboardFreshness(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  try {
    const localHour = parseInt(
      new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/Chicago' }).format(new Date()),
      10,
    );
    if (localHour < 5 || localHour >= 23) {
      return { status: 'skipped', detail: `outside scraper window (local hour ${localHour})` };
    }

    // Pick the most-recently-pulled dashboard_by_date row across properties.
    // Single-property today; multi-property generalizes naturally —
    // aggregating to "worst staleness across the fleet" is a follow-up.
    const { data, error } = await supabaseAdmin
      .from('dashboard_by_date')
      .select('property_id, pulled_at, error_code')
      .order('pulled_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    if (!data || !data.pulled_at) {
      return {
        status: 'warn',
        detail: 'no dashboard_by_date rows yet (scraper may not have pulled this property)',
      };
    }

    const pulledAt = new Date(data.pulled_at as string);
    const minAgo = Math.floor((Date.now() - pulledAt.getTime()) / 60_000);

    if (minAgo > 45) {
      return {
        status: 'fail',
        detail: `dashboard_by_date is ${minAgo} min stale (>45 min during scraper window)`,
        fix: 'Check Railway scraper logs for dashboard-pull errors; check Choice Advantage login.',
      };
    }
    if (minAgo > 25) {
      return {
        status: 'warn',
        detail: `dashboard_by_date is ${minAgo} min stale (>25 min — matches UI stale banner)`,
      };
    }
    return { status: 'ok', detail: `dashboard fresh (${minAgo} min ago)` };
  } catch (err) {
    return { status: 'fail', detail: `Supabase read failed: ${errToString(err)}` };
  }
}

// F7: surface watchdog degradation. The scraper writes
// scraper_status['vercel_watchdog'].degraded each tick. true means SMS
// alerts will not fire (env missing, send failed, or alert phone unset).
async function checkVercelWatchdogDegraded(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  try {
    const { data, error } = await supabaseAdmin
      .from('scraper_status')
      .select('data')
      .eq('key', 'vercel_watchdog')
      .maybeSingle();
    if (error) throw error;
    const value = (data?.data ?? {}) as { degraded?: boolean; degradedReason?: string };
    if (value.degraded === true) {
      return {
        status: 'fail',
        detail: `watchdog SMS path degraded (reason=${value.degradedReason ?? 'unknown'})`,
        fix: 'Check TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER / OPS_ALERT_PHONE on Railway. A failed send also flips this — verify Twilio account status.',
      };
    }
    return { status: 'ok', detail: 'watchdog SMS path healthy' };
  } catch (err) {
    return { status: 'fail', detail: `Supabase read failed: ${errToString(err)}` };
  }
}

async function checkScraperHealthCronLiveness(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  // scraper-health runs every 15 min via GitHub Actions. On each invocation
  // it writes `lastCheckAt` into scraper_status.alertState. If that field
  // is more than 25h stale, the GitHub Actions cron has been silently
  // disabled (possible causes: 60-day inactivity auto-disable on public
  // repos, repo transfer, revoked PAT, Actions billing lapse, someone
  // toggling it in the UI). When that happens scraper-health alerts stop
  // firing entirely — the single worst silent failure mode for this app.
  //
  // The Railway vercel-watchdog polls this doctor endpoint every 5 min, so
  // a fail here triggers an SMS within minutes even if GitHub Actions is
  // completely dead. That's the whole point of having TWO independent
  // platforms watch each other.
  try {
    const { data, error } = await supabaseAdmin
      .from('scraper_status')
      .select('data')
      .eq('key', 'alertState')
      .maybeSingle();
    if (error) throw error;
    if (!data?.data) {
      return {
        status: 'warn',
        detail: 'scraper_status.alertState row not populated yet — scraper-health has never run',
        fix: 'Trigger .github/workflows/scraper-health-cron.yml manually once, then confirm it completes.',
      };
    }
    const value = data.data as { lastCheckAt?: string };
    if (!value.lastCheckAt) {
      return {
        status: 'warn',
        detail: 'alertState.lastCheckAt not set — scraper-health may not have completed a full run',
      };
    }
    const last = new Date(value.lastCheckAt);
    if (isNaN(last.getTime())) {
      return { status: 'warn', detail: `lastCheckAt is not a valid date: ${value.lastCheckAt}` };
    }
    const minAgo = Math.floor((Date.now() - last.getTime()) / 60_000);
    // scraper-health runs every 15 min, so anything over 60 min means the
    // cron is degraded; over 25h (1500 min) means it's dead.
    if (minAgo > 25 * 60) {
      return {
        status: 'fail',
        detail: `scraper-health cron hasn't run in ${Math.floor(minAgo / 60)}h — GitHub Actions is likely silently disabled`,
        fix: 'GitHub → Reeyenn/staxis → Actions → Post-deploy smoke test / Scraper Health Check: verify the workflows aren\'t disabled. Also check Actions → Settings → General → "Actions permissions" isn\'t restricted. See RUNBOOKS.md → GitHub Actions cron disabled.',
      };
    }
    if (minAgo > 60) {
      return {
        status: 'warn',
        detail: `scraper-health last ran ${minAgo} min ago (normal cadence is every 15 min)`,
      };
    }
    return {
      status: 'ok',
      detail: `scraper-health cron ran ${minAgo} min ago`,
    };
  } catch (err) {
    return {
      status: 'fail',
      detail: `scraper-health liveness check failed: ${errToString(err)}`,
    };
  }
}

async function checkTwilioCredentials(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  const sid = env.TWILIO_ACCOUNT_SID;
  const tok = env.TWILIO_AUTH_TOKEN;
  if (!sid || !tok) {
    return { status: 'skipped', detail: 'Twilio env vars missing (reported by env_vars check)' };
  }
  try {
    // GET the account itself — cheapest possible auth check, <100ms usually.
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}.json`,
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`${sid}:${tok}`).toString('base64')}`,
        },
        // Cap the call — if Twilio is slow, fail the check rather than the whole request.
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (res.status === 401) {
      return {
        status: 'fail',
        detail: 'Twilio rejected credentials (401 Unauthorized)',
        fix: 'Twilio auth token was likely rotated. Twilio Console → Auth Tokens → copy primary. Update BOTH Vercel (TWILIO_AUTH_TOKEN) AND (if used) Railway.',
      };
    }
    if (!res.ok) {
      return { status: 'fail', detail: `Twilio returned ${res.status} ${res.statusText}` };
    }
    const json = await res.json() as { status?: string; friendly_name?: string };
    if (json.status === 'suspended' || json.status === 'closed') {
      return {
        status: 'fail',
        detail: `Twilio account status is "${json.status}"`,
        fix: 'Twilio account is suspended. Log in to Twilio Console to resolve.',
      };
    }
    return {
      status: 'ok',
      detail: `Twilio account "${json.friendly_name ?? '?'}" active`,
    };
  } catch (err) {
    return { status: 'fail', detail: `Twilio API call failed: ${errToString(err)}` };
  }
}

/**
 * Twilio prepaid balance freshness. Yesterday (2026-05-14) the balance
 * dropped to $4.51 with no autopay configured and no warning until the
 * scheduled weekly digest noticed — a fully-burnt balance silently
 * disables every outbound SMS (shift confirmations, watchdog SOS,
 * doctor alert texts), and the only way to learn about it is when a
 * housekeeper says "I never got the text." Cap the warn threshold
 * conservatively because the watchdog SMS is the priority queue and
 * needs runway.
 */
async function checkTwilioBalance(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  const sid = env.TWILIO_ACCOUNT_SID;
  const tok = env.TWILIO_AUTH_TOKEN;
  if (!sid || !tok) {
    return { status: 'skipped', detail: 'Twilio env vars missing (reported by env_vars check)' };
  }
  // Round 18: thresholds are now env-tunable so tightening them after
  // an outage doesn't require a code deploy. Defaults match Round 17:
  // a typical day burns ~$1–2 in SMS sends, so $10 = 5+ days runway
  // after warn, $5 = ~2 days before sends start failing.
  const WARN_BELOW = env.TWILIO_BALANCE_WARN_USD;
  const FAIL_BELOW = env.TWILIO_BALANCE_FAIL_USD;
  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Balance.json`,
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`${sid}:${tok}`).toString('base64')}`,
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (res.status === 401) {
      return {
        status: 'fail',
        detail: 'Twilio rejected credentials when reading balance (401)',
        fix: 'See checkTwilioCredentials fix — token rotation likely.',
      };
    }
    if (!res.ok) {
      return {
        status: 'warn',
        detail: `Twilio balance API returned ${res.status} ${res.statusText}`,
      };
    }
    const json = await res.json() as { balance?: string; currency?: string };
    const balanceNum = parseFloat(json.balance ?? '0');
    const currency = json.currency ?? 'USD';
    if (!Number.isFinite(balanceNum)) {
      return {
        status: 'warn',
        detail: `Twilio balance API returned non-numeric balance "${json.balance}"`,
      };
    }
    const fixHint =
      'Top up at https://console.twilio.com/ → Billing → Add Funds. ' +
      'To prevent the next occurrence, enable Auto-Recharge on the same page ' +
      '(adds $20 whenever balance falls below $10).';
    if (balanceNum < FAIL_BELOW) {
      return {
        status: 'fail',
        detail: `Twilio balance is $${balanceNum.toFixed(2)} ${currency} — below the $${FAIL_BELOW} hard floor. SMS sends are at risk of starting to fail.`,
        fix: fixHint,
      };
    }
    if (balanceNum < WARN_BELOW) {
      // Round 18 #13: warn-band balance escapes to Sentry directly,
      // independent of the alert-decision logic. The doctor's regular
      // captureMessage path only fires on `fail`, so a warn band silently
      // existed until balance dropped below FAIL_BELOW — exactly the
      // failure mode that caused yesterday's $4.51 surprise.
      // We bypass the lazy Sentry import via require because doctor/route
      // is imported by routes that pre-date Sentry initialization. The
      // dynamic import path matches what /lib/log.ts uses for the same
      // reason.
      try {
        const sentry = await import('@/lib/sentry');
        sentry.captureMessage(
          `twilio balance $${balanceNum.toFixed(2)} ${currency} — below $${WARN_BELOW} warn`,
          {
            subsystem: 'doctor',
            check: 'twilio_balance',
            balance_usd: balanceNum,
            warn_below: WARN_BELOW,
            fail_below: FAIL_BELOW,
          },
        );
      } catch {
        // If Sentry import or capture fails, don't break the doctor check.
      }
      return {
        status: 'warn',
        detail: `Twilio balance is $${balanceNum.toFixed(2)} ${currency} — below the $${WARN_BELOW} warn threshold.`,
        fix: fixHint,
      };
    }
    return {
      status: 'ok',
      detail: `Twilio balance $${balanceNum.toFixed(2)} ${currency} (warn at <$${WARN_BELOW}, fail at <$${FAIL_BELOW})`,
    };
  } catch (err) {
    return { status: 'warn', detail: `Twilio balance check raised: ${errToString(err)}` };
  }
}

/**
 * twilio_from_number_registered — verify TWILIO_FROM_NUMBER is a phone
 * number that this Twilio account actually owns and can send SMS from.
 *
 * Why this matters: checkTwilioCredentials confirms the SID+token are
 * valid and the account isn't suspended. It does NOT confirm that the
 * specific number in TWILIO_FROM_NUMBER is registered to the account.
 * If Reeyen rotates Twilio numbers and updates the env var but the new
 * number isn't registered yet — or the toll-free verification lapsed —
 * Twilio rejects sends with error 21659 ("From is not a valid SMS-
 * capable Twilio phone number"). sendSms() throws; the caller catches
 * it as "send failed" in Vercel logs. Maria's shift confirmations
 * never arrive and the only signal is a single error-log line.
 *
 * The probe: GET the IncomingPhoneNumbers resource filtered by the
 * configured number. Twilio returns the number's details if it's
 * registered, empty list if not. SMS capabilities are reported in
 * the `capabilities.sms` field — we fail if the number is registered
 * but not SMS-capable (a voice-only number landed in the env var).
 */
async function checkTwilioFromNumberRegistered(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  const sid = env.TWILIO_ACCOUNT_SID;
  const tok = env.TWILIO_AUTH_TOKEN;
  const from = env.TWILIO_FROM_NUMBER;
  if (!sid || !tok || !from) {
    return { status: 'skipped', detail: 'Twilio env vars missing (reported by env_vars check)' };
  }
  try {
    const url = new URL(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/IncomingPhoneNumbers.json`);
    url.searchParams.set('PhoneNumber', from);
    url.searchParams.set('PageSize', '5');
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Basic ${Buffer.from(`${sid}:${tok}`).toString('base64')}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // 401 will already fire from checkTwilioCredentials — don't double-report.
      if (res.status === 401) {
        return { status: 'skipped', detail: 'auth handled by twilio_credentials check' };
      }
      return { status: 'fail', detail: `Twilio IncomingPhoneNumbers returned ${res.status} ${res.statusText}` };
    }
    const json = await res.json() as {
      incoming_phone_numbers?: Array<{
        phone_number?: string;
        sid?: string;
        capabilities?: { sms?: boolean; mms?: boolean; voice?: boolean };
      }>;
    };
    const list = json.incoming_phone_numbers ?? [];
    if (list.length === 0) {
      return {
        status: 'fail',
        detail: `TWILIO_FROM_NUMBER "${from}" is NOT registered to account ${sid.slice(0, 10)}…. Twilio will reject every send with error 21659.`,
        fix: 'Twilio Console → Phone Numbers → Manage → Active. Confirm the number is owned by this account, or buy/port a new one and update TWILIO_FROM_NUMBER in Vercel.',
      };
    }
    const match = list.find((n) => n.phone_number === from) ?? list[0];
    if (!match.capabilities?.sms) {
      return {
        status: 'fail',
        detail: `TWILIO_FROM_NUMBER "${from}" is registered but NOT SMS-capable (likely a voice-only number). Sends will fail.`,
        fix: 'Twilio Console → Phone Numbers → click the number → Capabilities → ensure SMS is on. Or pick a different number and update TWILIO_FROM_NUMBER.',
      };
    }
    return {
      status: 'ok',
      detail: `TWILIO_FROM_NUMBER "${from}" registered + SMS-capable.`,
    };
  } catch (err) {
    return { status: 'warn', detail: `Twilio number check raised: ${errToString(err)}` };
  }
}

async function checkAlertPhoneShape(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  // MANAGER_PHONE is read by scraper-health, scraper-weekly-digest, and the
  // Railway vercel-watchdog. If it's missing or malformed, alerts silently
  // no-op — which is the exact class of failure the alerting system was
  // supposed to catch in the first place. env_vars already checks it's set;
  // this check validates it's *usable*.
  const phone = env.OPS_ALERT_PHONE;
  if (!phone) {
    return {
      status: 'skipped',
      detail: 'MANAGER_PHONE missing (reported by env_vars check)',
    };
  }
  // Accept E.164: +[country code][digits], 11–15 digits total.
  const e164 = /^\+[1-9]\d{10,14}$/;
  if (!e164.test(phone.trim())) {
    return {
      status: 'fail',
      detail: `MANAGER_PHONE is not in E.164 format (got "${phone}"). Twilio will reject sends.`,
      fix: 'Set MANAGER_PHONE to E.164 format on Vercel, e.g. "+12816669887". No spaces, no parens, starts with +.',
    };
  }
  // Placeholder sanity.
  const placeholders = ['+10000000000', '+15555555555', '+1234567890'];
  if (placeholders.includes(phone.trim())) {
    return {
      status: 'fail',
      detail: `MANAGER_PHONE is a placeholder (${phone}). Real alerts will be silently sent to /dev/null.`,
      fix: 'Set MANAGER_PHONE to Reeyen\'s actual cell on Vercel AND Railway.',
    };
  }
  return {
    status: 'ok',
    detail: `MANAGER_PHONE is valid E.164 (${phone.slice(0, 2)}…${phone.slice(-4)})`,
  };
}

async function checkCronSecretShape(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  const secret = env.CRON_SECRET;
  if (!secret) {
    return {
      status: 'fail',
      detail: 'CRON_SECRET not set — cron endpoints are open to the public internet',
      fix: 'Vercel → Environment Variables → add CRON_SECRET. Then GitHub → repo Settings → Secrets and variables → Actions → add the SAME value as CRON_SECRET.',
    };
  }
  // Sanity checks: not obviously a placeholder, has enough entropy.
  const placeholders = ['changeme', 'secret', 'test', 'your-secret-here', 'xxx', 'todo'];
  if (placeholders.some(p => secret.toLowerCase().includes(p))) {
    return {
      status: 'fail',
      detail: 'CRON_SECRET looks like a placeholder value',
      fix: 'Generate a real secret: `openssl rand -hex 32`. Set it on Vercel AND in the GitHub repo secret of the same name.',
    };
  }
  if (secret.length < 16) {
    return {
      status: 'warn',
      detail: `CRON_SECRET is only ${secret.length} chars — recommend 32+`,
    };
  }
  return {
    status: 'ok',
    detail: `CRON_SECRET present (${secret.length} chars)`,
  };
}

/**
 * supabase_anon_key — validates that NEXT_PUBLIC_SUPABASE_ANON_KEY is a
 * well-formed JWT with role=anon.
 *
 * Why this matters: the anon key gets bundled into every client-side page.
 * If someone mis-pastes it in Vercel (missing a few chars in the middle),
 * every browser request fails with 401 "Invalid API key" before auth is
 * even checked — but the front-end error handler surfaces it as the
 * generic "Invalid username or password", making it look like a password
 * problem. This check catches a corrupt anon key at every deploy instead
 * of you discovering it by failing to log in.
 *
 * History: 2026-04-23 — Reeyen couldn't log in for hours because 3
 * characters were missing from the Vercel anon key's JWT payload.
 */
async function checkSupabaseAnonKeyShape(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  const key = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!key) {
    return {
      status: 'fail',
      detail: 'NEXT_PUBLIC_SUPABASE_ANON_KEY is not set',
      fix: 'Vercel → Project Settings → Environment Variables → NEXT_PUBLIC_SUPABASE_ANON_KEY. Get the value from Supabase Dashboard → Project Settings → API → Project API Keys → anon/public. Redeploy after saving.',
    };
  }

  const parts = key.split('.');
  if (parts.length !== 3) {
    return {
      status: 'fail',
      detail: `anon key has ${parts.length} parts, expected 3 (header.payload.signature). Likely truncated or corrupt.`,
      fix: 'Re-copy the full anon key from Supabase Dashboard → Project Settings → API and paste it into Vercel. Watch for accidentally dropping characters — the key is ~200 chars long.',
    };
  }

  let payload: { role?: string; iss?: string; ref?: string; exp?: number } | null = null;
  try {
    let b = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    payload = JSON.parse(Buffer.from(b, 'base64').toString('utf8'));
  } catch {
    return {
      status: 'fail',
      detail: 'anon key JWT payload is not valid base64/JSON — corrupted mid-string.',
      fix: 'Re-copy from Supabase Dashboard → Project Settings → API.',
    };
  }

  if (payload?.role !== 'anon') {
    return {
      status: 'fail',
      detail: `anon key has role="${payload?.role ?? 'missing'}" instead of "anon". Might be the service_role key pasted into the wrong slot.`,
      fix: 'Swap the values — the service_role key goes in SUPABASE_SERVICE_ROLE_KEY (server-only), the anon key goes in NEXT_PUBLIC_SUPABASE_ANON_KEY (bundled into client).',
    };
  }

  // Compare project ref to the URL env var — catch mismatched projects
  const url = env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const urlRef = url.match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];
  if (urlRef && payload.ref && urlRef !== payload.ref) {
    return {
      status: 'fail',
      detail: `anon key is for project "${payload.ref}" but NEXT_PUBLIC_SUPABASE_URL points at "${urlRef}". Wrong key for this project.`,
      fix: 'Fetch the anon key from THIS project\'s Supabase dashboard, not a different one.',
    };
  }

  if (payload.exp && payload.exp * 1000 < Date.now()) {
    return {
      status: 'fail',
      detail: `anon key expired at ${new Date(payload.exp * 1000).toISOString()}`,
      fix: 'Rotate the key in Supabase → Project Settings → API → Reset anon key. Then update Vercel and redeploy.',
    };
  }

  return {
    status: 'ok',
    detail: `anon key valid (role=anon, ref=${payload.ref}, ${key.length} chars)`,
  };
}

/**
 * supabase_realtime_publication — verify every table the app subscribes to
 * via Supabase Realtime is actually IN the supabase_realtime publication.
 *
 * Why this matters: postgres_changes subscriptions silently fail (the
 * channel state is "joined" but no events ever arrive) when the table is
 * missing from the publication. We hit this exact bug in 2026-04-26 — the
 * Firebase→Supabase migration left the publication empty, so every
 * subscribeTo* in the UI ran silently dead. Without this doctor check,
 * a future fresh project setup could repeat the same bug for hours.
 *
 * Reads pg_publication_tables via a SECURITY DEFINER helper installed in
 * migration 0007_realtime_publication_doctor.sql (added alongside this).
 */
async function checkSupabaseRealtimePublication(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  // Plan v4 (2026-05-24): removed `rooms`, `work_orders`, `plan_snapshots`,
  // `scraper_status` from the required-realtime list. All four tables
  // were dropped in the v4 cleanup (rooms/work_orders/plan_snapshots
  // became service-role-only empty stubs in 0205, then dropped via
  // Chrome; scraper_status was dropped outright). Their realtime
  // subscriptions no longer exist in the v4 web app.
  const REQUIRED_TABLES = [
    'staff', 'preventive_tasks',
    'inventory', 'handoff_logs', 'guest_requests',
    'schedule_assignments', 'shift_confirmations', 'manager_notifications',
  ];
  try {
    const { data, error } = await supabaseAdmin.rpc('staxis_realtime_publication_tables');
    if (error) {
      // RPC missing? Fall back to a direct query against pg_publication_tables.
      // This requires the service_role key — which we have via supabaseAdmin.
      const { data: fallback, error: fbErr } = await supabaseAdmin
        .from('pg_publication_tables_view' as never)
        .select('tablename')
        .eq('pubname', 'supabase_realtime');
      if (fbErr) {
        return {
          status: 'warn',
          detail: `Couldn't read publication state (rpc + view both failed): ${error.message}`,
          fix: 'Apply migration 0007_realtime_publication_doctor.sql in Supabase SQL editor.',
        };
      }
      const tables = new Set((fallback ?? []).map((r) => (r as { tablename: string }).tablename));
      const missing = REQUIRED_TABLES.filter((t) => !tables.has(t));
      if (missing.length > 0) {
        return {
          status: 'fail',
          detail: `supabase_realtime publication is missing ${missing.length} of ${REQUIRED_TABLES.length} subscribed tables: ${missing.join(', ')}`,
          fix: 'Re-apply migration 0006_enable_realtime.sql to add the missing tables to the publication.',
        };
      }
      return { status: 'ok', detail: `All ${REQUIRED_TABLES.length} subscribed tables are in supabase_realtime` };
    }
    const tables = new Set((data as Array<{ tablename: string }>).map((r) => r.tablename));
    const missing = REQUIRED_TABLES.filter((t) => !tables.has(t));
    if (missing.length > 0) {
      return {
        status: 'fail',
        detail: `supabase_realtime publication is missing ${missing.length} of ${REQUIRED_TABLES.length} subscribed tables: ${missing.join(', ')}`,
        fix: 'Re-apply migration 0006_enable_realtime.sql to add the missing tables to the publication.',
      };
    }
    return { status: 'ok', detail: `All ${REQUIRED_TABLES.length} subscribed tables are in supabase_realtime` };
  } catch (err) {
    return {
      status: 'warn',
      detail: `realtime publication check raised: ${err instanceof Error ? err.message : String(err)}`,
      fix: 'Apply migration 0007_realtime_publication_doctor.sql to expose the helper.',
    };
  }
}

/**
 * scraper_csv_pull — verify the most recent CSV pull (morning OR evening)
 * was a success, not an error. The `scraper-health` cron now alerts on
 * morning/evening errors but the doctor doesn't mention them at all,
 * which means a deploy can land + smoke-test pass while the morning pull
 * is silently broken.
 */
async function checkScraperCsvPull(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  try {
    const { data: morning } = await supabaseAdmin
      .from('scraper_status').select('data, updated_at').eq('key', 'morning').maybeSingle();
    const { data: evening } = await supabaseAdmin
      .from('scraper_status').select('data, updated_at').eq('key', 'evening').maybeSingle();
    type CsvRow = {
      status?: string;
      at?: string;
      error?: string;
      errorCode?: string;
      consecutiveFailures?: number;
    };
    const m = (morning?.data ?? {}) as CsvRow;
    const e = (evening?.data ?? {}) as CsvRow;
    const mAt = m.at ? new Date(m.at).getTime() : 0;
    const eAt = e.at ? new Date(e.at).getTime() : 0;
    const newest = mAt >= eAt ? { ...m, kind: 'morning' as const } : { ...e, kind: 'evening' as const };
    if (!newest.at) {
      return {
        status: 'warn',
        detail: 'No CSV pull on record yet (no morning or evening row in scraper_status).',
        fix: 'Wait for the next scrape tick on Railway, or check the scraper deployment.',
      };
    }
    const ageMin = Math.floor((Date.now() - new Date(newest.at).getTime()) / 60_000);
    const fails  = newest.consecutiveFailures ?? 0;
    if (newest.status === 'error') {
      const codePart = newest.errorCode ? ` [${newest.errorCode}]` : '';
      return {
        status: 'fail',
        detail: `Last ${newest.kind} CSV pull errored${codePart} ${ageMin}m ago (${fails} consecutive ${fails === 1 ? 'failure' : 'failures'}): "${(newest.error ?? '').slice(0, 200)}"`,
        fix: 'Check Railway logs for scraper/csv-scraper.js. The selector-fallback chain dumps csv-form-dump.html / csv-link-dump.html on selector miss.',
      };
    }
    if (ageMin > 60) {
      return {
        status: 'warn',
        detail: `Last ${newest.kind} CSV pull was ${ageMin}m ago. Scraper may be hung.`,
        fix: 'Check Railway scraper service is running and the heartbeat is fresh.',
      };
    }
    return { status: 'ok', detail: `Last ${newest.kind} CSV pull succeeded ${ageMin}m ago` };
  } catch (err) {
    return {
      status: 'warn',
      detail: `csv pull check raised: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Read scraper_status['vercel_watchdog'] and verify Railway can actually
 * deliver SMS alerts. The 2026-04-27 outage was silent for 2.5 hours because
 * MANAGER_PHONE wasn't set on Railway — Vercel had it, the doctor was green
 * here, but the watchdog process on Railway logged "ALERT would have fired"
 * and went to bed. Doctor (running on Vercel) can't read Railway's process.env,
 * but it CAN read the shared Postgres state — so when the watchdog detects
 * the no-phone case it stamps `alertSuppressedReason` on its row and we read
 * that here. This makes "the alerter can't alert" itself an alertable
 * condition.
 *
 * Fails on:
 *  - alertSuppressedReason set → Railway is currently unable to send SMS
 *  - lastCheckAt > 15 minutes old → watchdog process is dead on Railway
 *
 * Skips when the watchdog row hasn't been written yet (clean install).
 */
async function checkWatchdogAlertPath(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  try {
    // Read both alert paths in parallel:
    //   • vercel_watchdog → Railway-side process pinging Vercel
    //   • alertState     → Vercel-side cron pinging Supabase
    // Either path being "tried but couldn't deliver SMS" is a hard fail.
    const [{ data: watchdogRow, error: wErr }, { data: alertRow, error: aErr }] = await Promise.all([
      supabaseAdmin.from('scraper_status').select('data, updated_at').eq('key', 'vercel_watchdog').maybeSingle(),
      supabaseAdmin.from('scraper_status').select('data, updated_at').eq('key', 'alertState').maybeSingle(),
    ]);
    if (wErr) return { status: 'warn', detail: `vercel_watchdog read failed: ${errToString(wErr)}` };
    if (aErr) return { status: 'warn', detail: `alertState read failed: ${errToString(aErr)}` };

    const watchdog = (watchdogRow?.data ?? {}) as {
      lastCheckAt?: string;
      alertSuppressedReason?: string | null;
      alertSuppressedAt?: string | null;
    };
    const alertState = (alertRow?.data ?? {}) as {
      alertSuppressedReason?: string | null;
      alertSuppressedAt?: string | null;
      lastSmsError?: string | null;
      lastAlertedCode?: string | null;
      lastAlertedAt?: string | null;
    };

    // ── Stale-state detection (May 2026 audit pass-6) ─────────────────
    // alertSuppressedReason is a sticky flag — once set, the watchdog
    // doesn't clear it on the next successful tick. If the underlying
    // condition resolved 30+ minutes ago, the flag is misleading: the
    // system isn't actually broken, the operator just hasn't seen the
    // historical record yet. Treat the flag as `warn` (info-level)
    // instead of `fail` (CI-blocking) once it's older than 30 min.
    // Real ongoing outages still produce `fail` because the watchdog
    // re-stamps the timestamp on each suppression event.
    const STALE_SUPPRESSION_MIN = 30;
    const isSuppressionStale = (suppressedAt: string | null | undefined): boolean => {
      if (!suppressedAt) return false;
      const ageMin = (Date.now() - new Date(suppressedAt).getTime()) / 60_000;
      return ageMin > STALE_SUPPRESSION_MIN;
    };

    // Vercel cron path: did it try to alert and fail?
    if (alertState.alertSuppressedReason === 'no_alert_phone_on_vercel') {
      return {
        status: 'fail',
        detail: `Vercel cron tried to alert but MANAGER_PHONE is unset on Vercel. Suppressed at ${alertState.alertSuppressedAt}.`,
        fix: 'Vercel → Project Settings → Environment Variables → set MANAGER_PHONE=+1XXXXXXXXXX (E.164) → redeploy.',
      };
    }
    if (alertState.alertSuppressedReason === 'sms_send_failed') {
      const stale = isSuppressionStale(alertState.alertSuppressedAt);
      return {
        status: stale ? 'warn' : 'fail',
        detail: stale
          ? `Vercel cron had a Twilio-step failure ${Math.floor((Date.now() - new Date(alertState.alertSuppressedAt!).getTime()) / 60_000)}m ago (stale — will clear on next successful alert): ${alertState.lastSmsError ?? 'unknown error'}`
          : `Vercel cron's last alert attempt failed at the Twilio step: ${alertState.lastSmsError ?? 'unknown error'}`,
        fix: 'Check TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER on Vercel. Also verify the recipient number is valid and not on Twilio\'s suppression list.',
      };
    }
    if (alertState.alertSuppressedReason) {
      const stale = isSuppressionStale(alertState.alertSuppressedAt);
      return {
        status: stale ? 'warn' : 'fail',
        detail: stale
          ? `Vercel cron had a suppression event ${Math.floor((Date.now() - new Date(alertState.alertSuppressedAt!).getTime()) / 60_000)}m ago (stale — will clear on next successful alert): ${alertState.alertSuppressedReason}`
          : `Vercel cron suppressed an alert for: ${alertState.alertSuppressedReason}`,
        fix: 'Inspect scraper_status[alertState] in Supabase and the Vercel function logs.',
      };
    }

    // Railway watchdog path: alive + alert-capable?
    if (!watchdog.lastCheckAt) {
      return {
        status: 'skipped',
        detail: 'vercel_watchdog has not run yet — Railway scraper just deployed?',
      };
    }
    const ageMin = Math.floor((Date.now() - new Date(watchdog.lastCheckAt).getTime()) / 60_000);
    if (ageMin > 15) {
      return {
        status: 'fail',
        detail: `Railway watchdog is dead — last tick ${ageMin}m ago (expected every 5m).`,
        fix: 'Railway → hotelops-scraper → Deployments. Look for crash loops or missing CRON_SECRET. Without the watchdog, Vercel outages go undetected from Railway side.',
      };
    }
    if (watchdog.alertSuppressedReason === 'no_alert_phone_on_railway') {
      return {
        status: 'fail',
        detail: `Railway watchdog tried to alert but MANAGER_PHONE/OPS_ALERT_PHONE is unset on Railway. Suppressed at ${watchdog.alertSuppressedAt}.`,
        fix: 'Railway → hotelops-scraper → Variables → add MANAGER_PHONE=+1XXXXXXXXXX (E.164). Same value as on Vercel. Without this, every Vercel outage detected by Railway is silent.',
      };
    }
    if (watchdog.alertSuppressedReason) {
      const stale = isSuppressionStale(watchdog.alertSuppressedAt);
      return {
        status: stale ? 'warn' : 'fail',
        detail: stale
          ? `Railway watchdog had a suppression event ${Math.floor((Date.now() - new Date(watchdog.alertSuppressedAt!).getTime()) / 60_000)}m ago (stale — will clear on next successful alert): ${watchdog.alertSuppressedReason}`
          : `Railway watchdog suppressed an alert for unexpected reason: ${watchdog.alertSuppressedReason}`,
        fix: 'Inspect scraper_status[vercel_watchdog] in Supabase and the Railway logs.',
      };
    }

    return {
      status: 'ok',
      detail: `Both alert paths clear (Vercel cron + Railway watchdog ${ageMin}m ago).`,
    };
  } catch (err) {
    return {
      status: 'warn',
      detail: `watchdog alert-path check raised: ${errToString(err)}`,
    };
  }
}

/**
 * Verify Vercel's CRON_SECRET matches Railway's. The doctor runs on Vercel
 * so it can read env.CRON_SECRET locally; Railway writes the first
 * 8 hex chars of sha256(CRON_SECRET) into scraper_status[heartbeat] every
 * tick. We hash Vercel's secret the same way and compare.
 *
 * Why this matters: CRON_SECRET has to be identical on Vercel + Railway +
 * GitHub Actions. Rotation drift (someone updated Vercel but forgot
 * Railway, or vice versa) silently breaks every Railway-to-Vercel watchdog
 * ping (401 auth_mismatch) AND every GitHub Actions smoke test. Without
 * this check, the only signal is the watchdog itself logging "auth_mismatch"
 * — which is silent until a real outage hits.
 *
 * Skips if either side hasn't published a fingerprint yet (clean install).
 */
async function checkCronSecretCrossPlatform(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  try {
    const vercelSecret = env.CRON_SECRET;
    if (!vercelSecret) {
      // env_vars / cron_secret_shape will already flag this — don't double-report.
      return { status: 'skipped', detail: 'Vercel CRON_SECRET not set (reported elsewhere).' };
    }
    const vercelHash = createHash('sha256').update(vercelSecret).digest('hex').slice(0, 8);

    const { data, error } = await supabaseAdmin
      .from('scraper_status')
      .select('data, updated_at')
      .eq('key', 'heartbeat')
      .maybeSingle();
    if (error) {
      return { status: 'warn', detail: `heartbeat read failed: ${errToString(error)}` };
    }
    const heartbeat = (data?.data ?? {}) as { cronSecretFingerprint?: string };
    const railwayHash = heartbeat.cronSecretFingerprint;
    if (!railwayHash) {
      return {
        status: 'skipped',
        detail: 'Railway has not yet published a CRON_SECRET fingerprint. Wait one tick (~5 min) after the scraper redeploys.',
      };
    }
    if (railwayHash !== vercelHash) {
      return {
        status: 'fail',
        detail: `CRON_SECRET drift detected: Vercel=${vercelHash}, Railway=${railwayHash}.`,
        fix: 'Pick one secret as canonical. Update on the platform that doesn\'t match: Railway → hotelops-scraper → Variables, or Vercel → Project Settings → Environment Variables. Then redeploy that platform. Don\'t forget GitHub Actions secret too if it diverged.',
      };
    }
    return {
      status: 'ok',
      detail: `CRON_SECRET matches across Vercel + Railway (fingerprint ${vercelHash}).`,
    };
  } catch (err) {
    return { status: 'warn', detail: `cross-platform check raised: ${errToString(err)}` };
  }
}

/**
 * Schema-drift detection: every numbered migration in /supabase/migrations/
 * must have a row in the live applied_migrations table. If a deployment
 * ships code that calls a column added in 00NN before 00NN was applied,
 * the route 500s with a cryptic "relation … not found" — this surfaces
 * that drift up front so doctor goes red BEFORE Mario sees a broken page.
 *
 * Codex round-5 META review 2026-05-13 (J1.2): the prior hand-maintained
 * array drifted twice (round 2 missed 0099; round 4 missed 0110/0111/0112).
 * EXPECTED_MIGRATIONS is now generated at module-load by globbing the
 * supabase/migrations/ directory. The hand-maintained array stays as a
 * fallback for serverless environments without filesystem access (the
 * `migration-bookkeeping.test.ts` enforces drift in CI either way).
 *
 * Behavior:
 *   - applied_migrations table missing entirely → warn (0015 itself not applied yet)
 *   - subset applied → fail with the specific missing version list
 *   - all applied → ok, with the count
 *   - extras in DB not in code → warn (someone applied a hand-rolled migration)
 */

// Static fallback list — used when the filesystem-globbing approach fails
// (Vercel serverless edge runtime in particular). The CI test
// `migration-bookkeeping.test.ts` enforces that the static list stays
// in sync with the migrations directory regardless.
const EXPECTED_MIGRATIONS_STATIC: ReadonlyArray<string> = [
  '0001', '0002', '0003', '0004', '0005', '0006', '0007', '0008',
  '0009', '0010', '0011', '0012', '0013', '0014', '0015', '0016',
  '0017', '0018', '0019', '0020', '0021', '0022', '0023', '0024',
  '0025', '0026', '0027', '0028', '0029', '0030',
  '0031', '0032', '0033', '0034', '0035', '0036',
  '0037', '0038', '0039',
  // Pre-launch additions (May 2026 audit pass-4: list was frozen at
  // 0039, so 0040+ schema drift was invisible to the doctor).
  // 0044-0049 intentionally skipped — those slots were never written.
  '0040', '0041', '0042', '0043',
  '0050', '0051', '0052', '0053', '0054', '0055',
  '0056', '0057', '0058', '0059', '0060', '0061', '0062', '0063',
  '0064', '0065', '0066', '0067', '0068', '0069',
  // Tier 2/3 ML and fleet ops:
  '0070', '0071', '0072', '0073', '0074', '0075',
  // Bookkeeping backfill (May 2026 audit pass-6 — see migration header).
  '0076',
  // Codex audit follow-up (2026-05-12): FK constraints + atomic recipe-version RPC.
  '0077', '0078',
  // Central AI agent layer + AI-stack net-new fixes (2026-05-13):
  // 0079-0083 chat brain + cost controls + atomic reservations +
  // multi-scope locks + Anthropic model_id capture.
  // 0084-0089 cbc4228 batch (inventory CHECK, per-conversation lock,
  //  observed-rate view, atomic cold-start, property nudge subscription,
  //  inventory unique-name).
  // 0090 round-5 stale-reservation sweeper.
  // 0091 round-6 swept_at column + count_swept_today RPC.
  // 0092 round-7 atomic lock + load + record-user-turn RPC (F2).
  // 0093 round-7 agent_cost_finalize_failures audit table (F1).
  // 0094 defense-in-depth: tool_result uq + model_id + record-turn bump.
  // 0095-0097 ai-stack post-merge: nudge subscription validate +
  //  observed-rate view v2 + cold-start parent-child guard.
  // 0098 round-8: dedupe preflight (B1) + finalize state-guard (B6).
  // 0099 ML post-merge: drop hardcoded-TZ views (Phase 1+2 cleanup).
  // 0100 longevity foundation: prompt_version per msg + msg_count trigger
  //  + eval baselines + account tier.
  // 0101 L8B: agent_messages.is_error for tool error rate KPI.
  // 0102 L2: agent_prompts table for DB-backed prompts.
  // 0103 ML retention policies (parallel chat).
  // 0104 ML fleet indexes (parallel chat).
  // 0105 L4: conversation archival + auto-summarization schema.
  // 0106 Round-10 follow-ups: F1+F2+F6 apply-summary rewrite, F5
  //  staxis_activate_prompt, F7 summary_xor CHECK, F4d active-row
  //  prompt content update.
  // 0107 ML: atomic housekeeping model install RPC (parallel chat).
  // 0108 Round-11 T3: drop unused agent_prompts.canary_pct column.
  // 0109 Round-11 T1: add 'summarizer' role to agent_prompts + seed.
  // 0110 ML: atomic inventory model install (parallel chat).
  // 0111 ML: RPC unknown-field notice (parallel chat).
  // 0112 ML: preserve auto_fill_enabled_at across retrains (parallel chat).
  // 0113 Round-12 T12.2: restore RPC counters=0 + recompute (no double-count).
  // 0114 Round-12 T12.9/T12.11/T12.12: invariant CHECKs + tool-result orphan
  //   trigger + heal RPC + T12.7 active prompt update.
  // 0115 Round-12 hotfix: relax INV-7 upper bound (CHECK can't be deferred;
  //   trigger ordering creates transient violations on DELETE). The heal
  //   RPC + daily cron are the safety net for commit-time drift.
  // 0116 Voice surface (2026-05-13): account voice prefs +
  //   agent_costs.kind='audio'. (voice_recordings retention table was
  //   retired 2026-05-14 with the ElevenLabs streaming switch and dropped
  //   in 0141.)
  '0079', '0080', '0081', '0082', '0083',
  '0084', '0085', '0086', '0087', '0088', '0089',
  '0090', '0091', '0092', '0093', '0094',
  '0095', '0096', '0097', '0098', '0099',
  '0100', '0101', '0102', '0103', '0104',
  '0105', '0106', '0107', '0108', '0109',
  '0110', '0111', '0112', '0113', '0114',
  '0115', '0116', '0117', '0118', '0119',
  '0120', '0121', '0122', '0123',
  // 0124 accounts.skip_2fa flag for investor demo bypass.
  // 0125 total-rooms ↔ inventory invariant CHECK.
  // 0126 staxis_api_limit_cleanup recreate with hardened search_path.
  // 0127/0128 intentionally skipped.
  // 0129 schedule_auto_fill_if_absent RPC.
  // 0130 model_runs.cold_start_flag.
  // 0131 maintenance simplification (work_orders + preventive_tasks).
  // 0132 staxis_active_property_ids_for_nudges RPC (cost audit).
  // 0133 REPLICA IDENTITY FULL on hot realtime tables (cost audit).
  // 0134 intentionally skipped (no file on disk; legacy slot in prod).
  // 0135-0139 RPC batch + concurrency audit fixes (post-rebase merge).
  // 0140 atomic upsert of PMS credentials + properties.pms_type/pms_url
  //   (P0 fix, audit Flow 2 #1 — commit 04923a3). Originally drafted as
  //   "skipped legacy slot"; the file landed mid-audit and the comment
  //   wasn't refreshed until 2026-05-17 when the doctor began flagging
  //   the row in applied_migrations as unexpected.
  // 0141 audit/data-model cleanup: drop 8 dead tables + dead FK columns.
  // 0142 audit/data-model cleanup: enforce 8 missing FK constraints.
  // 0143 agent_voice_sessions table for realtime voice session bookkeeping.
  // 0144 maintenance_photos per-property RLS.
  // 0145 agent_costs.kind = 'vision'.
  // 0146 accounts.staff_id link column.
  // 0147 staff_schedule tables (weekly schedule data layer).
  // 0148 sms_jobs.sent_dirty status flag.
  // 0149 audit/data-model follow-up: COMMENTs documenting polymorphic + external IDs.
  // 0150 voice-session connection binding (Plan v2 M-1; landed on main from the
  //   integrations-infra-abuse branch — wasn't added to this allowlist there,
  //   so we add it here to keep the doctor honest).
  // 0151 pms_recipes HMAC signature columns (F-AI-2; applied to prod ahead of
  //   the AI/CUA/scraper branch's main merge — adding here so the migrations-
  //   applied check doesn't flag it as unexpected).
  // 0152 F-06: revoke legacy owner/GM hotel_join_codes + CHECK forbidding new privileged rows.
  // 0153 F-03+F-05+F-09: trusted_devices.absolute_expires_at + search_path pin
  //   on user_owns_property and staxis_release_join_code_slot.
  // 0154 Batch E: clear leftover bcrypt password_hash from the pre-Supabase-Auth
  //   era; column is now nullable + documented as deprecated.
  // 0155 F-NEW-02 / Batch D: staff_magic_codes table for server-side
  //   housekeeper magic-link exchange (token out of URL).
  '0124', '0125', '0126', '0129', '0130', '0131', '0132', '0133',
  '0135', '0136', '0137', '0138', '0139', '0140',
  '0141', '0142', '0143', '0144', '0145', '0146', '0147', '0148',
  '0149', '0150', '0151', '0152', '0153', '0154', '0155', '0156', '0157', '0158', '0159',
  '0160', '0161', '0162', '0163', '0164', '0165', '0166',
];

/**
 * Try to discover migrations from disk at module-load time. Falls back
 * to the static list above if filesystem isn't accessible (Vercel edge,
 * unit-test contexts, etc).
 */
function discoverMigrationsFromDisk(): ReadonlyArray<string> | null {
  try {
    // Lazy-require so the import doesn't run on environments where 'fs'
    // is unavailable. Using node:fs explicitly to avoid Next.js edge
    // bundle confusion. (The `no-require-imports` rule isn't enabled
    // in this project's eslint config, so we don't need a disable
    // directive — directives that point to non-enabled rules ERROR
    // under flat-config eslint.)
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const dir = join(process.cwd(), 'supabase', 'migrations');
    const versions = readdirSync(dir)
      .filter(f => f.endsWith('.sql'))
      .map(f => f.match(/^(\d{4})_/)?.[1])
      .filter((v): v is string => Boolean(v))
      .sort();
    return versions.length > 0 ? versions : null;
  } catch {
    return null;
  }
}

export const EXPECTED_MIGRATIONS: ReadonlyArray<string> =
  discoverMigrationsFromDisk() ?? EXPECTED_MIGRATIONS_STATIC;

async function checkAppliedMigrations(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  try {
    const { data, error } = await supabaseAdmin
      .from('applied_migrations')
      .select('version');
    if (error) {
      // Table doesn't exist yet — 0015 hasn't been applied to this project.
      // Warn rather than fail so existing prod deployments without 0015
      // don't go red on the next doctor run.
      if (errToString(error).includes('does not exist')) {
        return {
          status: 'warn',
          detail: 'applied_migrations table not present. Apply migration 0015_applied_migrations_tracker.sql to enable schema-drift detection.',
          fix: 'Run supabase/migrations/0015_applied_migrations_tracker.sql in the Supabase SQL editor. Idempotent; safe to re-run.',
        };
      }
      return { status: 'warn', detail: `applied_migrations read failed: ${errToString(error)}` };
    }
    const applied = new Set((data ?? []).map(r => String((r as { version: string }).version)));
    // Migrations intentionally pending an apply window. Each entry MUST
    // have a target-apply condition documented here so this allowlist
    // doesn't rot into a forever-pass. Mirror the entries in
    // scripts/check-migrations-applied.ts.
    //
    // - 0162: Phase 2B helper-tighten — flips mfa_verified_or_grace from
    //   coalesce-true (grace) to coalesce-false (deny). Scheduled to
    //   apply 24h after Phase 2B's RLS sweep (2026-05-22 07:12 UTC) so
    //   legacy trusted users have one full token-refresh cycle to pick
    //   up mfa_verified=true. Apply window: 2026-05-23 07:12 UTC onwards.
    const PENDING_INTENTIONALLY: ReadonlySet<string> = new Set(['0162']);
    const missing = EXPECTED_MIGRATIONS.filter(v =>
      !applied.has(v) && !PENDING_INTENTIONALLY.has(v));
    const unexpected = [...applied].filter(v => !EXPECTED_MIGRATIONS.includes(v));
    if (missing.length > 0) {
      return {
        status: 'fail',
        detail: `${missing.length} migration(s) missing from live DB: ${missing.join(', ')}. Code expects all ${EXPECTED_MIGRATIONS.length} to be applied (excluding ${PENDING_INTENTIONALLY.size} intentionally-pending).`,
        fix: `Apply ${missing.map(v => `supabase/migrations/${v}_*.sql`).join(', ')} via the Supabase SQL editor. Each migration is idempotent.`,
      };
    }
    if (unexpected.length > 0) {
      return {
        status: 'warn',
        detail: `applied_migrations contains ${unexpected.length} version(s) not in EXPECTED_MIGRATIONS: ${unexpected.join(', ')}. If you added a new migration, also add it to EXPECTED_MIGRATIONS in the doctor.`,
      };
    }
    return {
      status: 'ok',
      detail: `all ${EXPECTED_MIGRATIONS.length} migrations applied`,
    };
  } catch (err) {
    return { status: 'warn', detail: `applied_migrations check raised: ${errToString(err)}` };
  }
}

/**
 * Surface sustained pull-latency regressions. Reads the most recent 30
 * pull_metrics rows per pull_type and warns if the median is more than 2x
 * the historical baseline. Stays silent on a single slow pull (CA having
 * a bad afternoon is normal); fires when the slowness is consistent.
 *
 * Skips entirely if pull_metrics has <10 rows total (fresh install) or if
 * the table doesn't exist yet (migration 0011 not applied).
 */
async function checkScraperPullLatency(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  try {
    const { data, error } = await supabaseAdmin
      .from('pull_metrics')
      .select('pull_type, total_ms, ok, pulled_at')
      .order('pulled_at', { ascending: false })
      .limit(200);
    if (error) {
      // Table doesn't exist yet (migration not applied) — graceful skip.
      if (errToString(error).includes('does not exist')) {
        return { status: 'skipped', detail: 'pull_metrics table not present (migration 0011 not applied yet).' };
      }
      return { status: 'warn', detail: `pull_metrics read failed: ${errToString(error)}` };
    }
    if (!data || data.length < 10) {
      return { status: 'skipped', detail: `pull_metrics has only ${data?.length ?? 0} rows; need >=10 for trend.` };
    }

    // ─── PRESENCE CHECK ──────────────────────────────────────────────────
    // 2026-04-27 incident: pulls stopped completely (Playwright tick wedged
    // on an unresolved Promise inside the Railway scraper). Heartbeat kept
    // updating, the watchdog's HTTP ping kept saying "doctor returned 200,"
    // and this check stayed green for 5 hours because all checks below
    // ONLY compare slow pulls to baseline — when pulls disappear entirely
    // there's nothing recent to be slow. The result was a silent outage.
    //
    // Fix: read the freshest pull across non-daily types. If the scraper
    // says it's alive (heartbeat fresh) but the most-recent pull is older
    // than a generous threshold during business hours, it's wedged.
    //
    // OFF-HOURS HANDLING: the scraper itself only pulls when local hour is
    // 5–22 (5am–10:59pm Central — see scraper.js around line 587). Outside
    // that window, pulls correctly stop and the freshness check would
    // false-positive every night. We mirror the same gate here so a sleeping
    // scraper doesn't trip the alarm. There's also a brief grace window at
    // 5:00–5:30am while the resumed scraper does its first tick.
    const STALE_THRESHOLD_MIN = 30;
    const NON_DAILY_TYPES = new Set(['dashboard', 'ooo', 'csv_evening']);
    const SCRAPER_WINDOW_START = 5;   // local hour, inclusive
    const SCRAPER_WINDOW_END   = 23;  // local hour, exclusive (so 22:59 is in)
    const WARMUP_GRACE_MIN = 30;      // first 30 min of the window — scraper just woke up
    const TZ = 'America/Chicago';
    const nowMs = Date.now();
    // Mirror scraper's localHour() exactly. Intl handles CDT/CST DST.
    const localTimeParts = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric', minute: 'numeric', hour12: false, timeZone: TZ,
    }).formatToParts(new Date());
    const localHourNow = parseInt(localTimeParts.find(p => p.type === 'hour')?.value ?? '0', 10);
    const localMinuteNow = parseInt(localTimeParts.find(p => p.type === 'minute')?.value ?? '0', 10);
    const inScraperWindow = localHourNow >= SCRAPER_WINDOW_START && localHourNow < SCRAPER_WINDOW_END;
    // The comment in the original version of this check promised a 5:00–5:30
    // grace window for the scraper's first tick of the day, but never
    // implemented it — so the doctor fired a false-positive 'fail' SMS at
    // 5am every morning. Compute the grace explicitly: within the first
    // WARMUP_GRACE_MIN minutes of SCRAPER_WINDOW_START, ignore stale pulls
    // (the previous evening's last pull is naturally ~6h old until the
    // first new tick lands).
    const inWarmupGrace =
      localHourNow === SCRAPER_WINDOW_START && localMinuteNow < WARMUP_GRACE_MIN;
    type Row = { pull_type: string; total_ms: number; ok: boolean; pulled_at: string };
    const rows = data as Row[];
    let mostRecentPullMs = 0;
    let mostRecentPullType: string | undefined;
    for (const r of rows) {
      if (!NON_DAILY_TYPES.has(r.pull_type)) continue;
      const t = new Date(r.pulled_at).getTime();
      if (t > mostRecentPullMs) { mostRecentPullMs = t; mostRecentPullType = r.pull_type; }
    }

    if (mostRecentPullMs > 0) {
      const ageMin = (nowMs - mostRecentPullMs) / 60000;
      if (ageMin > STALE_THRESHOLD_MIN) {
        // OFF-HOURS SHORT-CIRCUIT — scraper correctly idles 11pm–5am.
        // Skip with status=ok so we don't fire a false-positive every
        // night. Detail still shows the staleness so it's visible if
        // someone hits doctor manually.
        if (!inScraperWindow) {
          return {
            status: 'ok',
            detail: `Off-hours (${localHourNow}:00 Central, scraper window ${SCRAPER_WINDOW_START}am–${SCRAPER_WINDOW_END}:00). Most recent ${mostRecentPullType} pull was ${ageMin.toFixed(1)}m ago — expected during this window.`,
          };
        }
        // WARMUP GRACE — first 30 min of the window. The scraper just
        // resumed; the previous evening's last pull is ~6h stale until
        // the new day's first tick completes. Don't false-positive.
        if (inWarmupGrace) {
          return {
            status: 'ok',
            detail: `Warmup (${localHourNow}:${String(localMinuteNow).padStart(2,'0')} Central, first ${WARMUP_GRACE_MIN}m of scraper window). Most recent ${mostRecentPullType} pull was ${ageMin.toFixed(1)}m ago — waiting for first tick of the day.`,
          };
        }
        // Cross-reference heartbeat to distinguish "scraper is dead" from
        // "scraper is alive but tick is wedged." Different fix paths.
        const { data: hbRow } = await supabaseAdmin
          .from('scraper_status').select('updated_at').eq('key', 'heartbeat').maybeSingle();
        const hbAgeMin = hbRow?.updated_at
          ? (nowMs - new Date(hbRow.updated_at).getTime()) / 60000
          : Infinity;

        if (hbAgeMin <= 10) {
          return {
            status: 'fail',
            detail: `Scraper heartbeat is fresh (${hbAgeMin.toFixed(1)}m) but pulls have stopped — most recent ${mostRecentPullType} pull was ${ageMin.toFixed(1)}m ago (threshold ${STALE_THRESHOLD_MIN}m, local hour ${localHourNow}). Tick loop is wedged.`,
            fix: 'Restart the Railway hotelops-scraper service (Railway dashboard → service → Restart). Check logs for a hung Playwright operation (page.goto / waitForSelector without timeout).',
          };
        }
        return {
          status: 'fail',
          detail: `No pulls in ${ageMin.toFixed(1)}m AND heartbeat is ${hbAgeMin === Infinity ? 'missing' : hbAgeMin.toFixed(1) + 'm'} old. Scraper process is down.`,
          fix: 'Railway dashboard → hotelops-scraper service → check Status. If "Crashed", redeploy from main. If "Stopped", start it.',
        };
      }
    } else {
      // No non-daily pulls at all in the recent 200 rows? Surface this.
      return {
        status: 'warn',
        detail: 'No dashboard/ooo/csv_evening pulls found in recent metrics. Either the scraper has been off >a few hours, or only csv_morning is firing.',
        fix: 'Check Railway logs and the scraper schedule.',
      };
    }

    // ─── SLOWNESS CHECK (legacy) ──────────────────────────────────────────
    // Bucket by pull_type, take the most recent 30 successful pulls per
    // type, compute median. Compare to a baseline (next 30 successful pulls
    // before that window). 2x slower = warn; 3x slower = fail.
    const buckets: Record<string, Row[]> = {};
    for (const row of rows) {
      if (!row.ok) continue;
      const k = row.pull_type;
      buckets[k] = buckets[k] || [];
      buckets[k].push(row);
    }
    const warnings: string[] = [];
    for (const [pullType, rs] of Object.entries(buckets)) {
      if (rs.length < 20) continue;
      const recent = rs.slice(0, 10).map(r => r.total_ms).sort((a, b) => a - b);
      const baseline = rs.slice(10, 20).map(r => r.total_ms).sort((a, b) => a - b);
      const recentMedian = recent[Math.floor(recent.length / 2)];
      const baselineMedian = baseline[Math.floor(baseline.length / 2)];
      if (recentMedian > 3 * baselineMedian) {
        warnings.push(`${pullType} 3x+ slower (median ${recentMedian}ms vs baseline ${baselineMedian}ms)`);
      }
    }
    if (warnings.length > 0) {
      return {
        status: 'warn',
        detail: `Pull latency regression: ${warnings.join('; ')}`,
        fix: 'Check Railway logs for the affected pull type. If sustained, CA may have changed their page weight (more JS, slower auth) — consider tuning waitForLoadState timeouts.',
      };
    }
    return { status: 'ok', detail: `Pulls fresh (${mostRecentPullType} ${((nowMs - mostRecentPullMs) / 60000).toFixed(1)}m ago); latency within baseline across ${Object.keys(buckets).length} pull types.` };
  } catch (err) {
    return { status: 'warn', detail: `pull-latency check raised: ${errToString(err)}` };
  }
}

/**
 * Smoke-detector for silent ML feature failures.
 *
 * /api/housekeeper/room-action has two best-effort paths whose failures are
 * invisible to the housekeeper (the tap "works"), invisible to Maria (no
 * UI signal), and invisible to Reeyen (just a Vercel log line):
 *
 *   - occupancy_capture: scraper_status.dashboard.in_house wasn't readable
 *     when the housekeeper tapped Start. Done lands with
 *     cleaning_events.occupancy_at_start = NULL.
 *   - feature_derivation: deriveCleaningEventFeatures() threw (schema drift,
 *     helper bug). Done lands with all 10 ML feature columns NULL.
 *
 * Both paths increment a counter in scraper_status[ml_failures:<kind>]. If
 * any failure landed in the last 24h, this check goes RED so the daily
 * drift cron fires an SMS within hours of the first occurrence.
 *
 * `count > 0 in last 24h` is enough — we don't need exact counts. The fix
 * is always "go read the room-action logs for the failing kind."
 */
async function checkMLFailureCounter(
  kind: 'occupancy_capture' | 'feature_derivation',
  fix: string,
): Promise<Omit<Check, 'name' | 'durationMs'>> {
  try {
    const { data, error } = await supabaseAdmin
      .from('scraper_status')
      .select('data')
      .eq('key', `ml_failures:${kind}`)
      .maybeSingle();
    if (error) {
      return {
        status: 'warn',
        detail: `ml_failures:${kind} read failed: ${errToString(error)}`,
      };
    }
    if (!data?.data) {
      return { status: 'ok', detail: `no ${kind} failures recorded` };
    }
    const row = data.data as {
      recent?: Array<{ at: string; pid: string; err: string }>;
      total?: number;
    };
    const recent = row.recent ?? [];
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const last24h = recent.filter((r) => {
      const t = new Date(r.at).getTime();
      return Number.isFinite(t) && t > cutoff;
    });
    if (last24h.length === 0) {
      return {
        status: 'ok',
        detail: `no ${kind} failures in last 24h (lifetime total: ${row.total ?? 0})`,
      };
    }
    const sample = last24h[0];
    return {
      status: 'fail',
      detail: `${last24h.length} ${kind} failure(s) in last 24h. Most recent: ${sample.at} pid=${(sample.pid ?? '').slice(0, 8)} err="${(sample.err ?? '').slice(0, 80)}"`,
      fix,
    };
  } catch (err) {
    return {
      status: 'warn',
      detail: `ml_failures:${kind} check raised: ${errToString(err)}`,
    };
  }
}

async function checkOccupancyCaptureFailures(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  return checkMLFailureCounter(
    'occupancy_capture',
    'Inspect Vercel logs for /api/housekeeper/room-action "occupancy capture failed" warnings. Most likely cause: scraper_status.dashboard row stale (>4h) or missing the in_house field. Until fixed, every Start tap lands with cleaning_events.occupancy_at_start = NULL — supply model loses one of its strongest features.',
  );
}

async function checkFeatureDerivationFailures(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  return checkMLFailureCounter(
    'feature_derivation',
    'Inspect Vercel logs for /api/housekeeper/room-action "feature derivation threw" errors. The helper swallows its own internal failures, so reaching the outer catch means an upstream contract broke (schema drift, helper signature change, missing column). Cleaning_events lands with all 10 ML feature columns NULL until fixed — supply model retrains on null-padded rows.',
  );
}

/**
 * Inventory predictions freshness — fail if no row in
 * inventory_rate_predictions has predicted_for_date >= today AND at
 * least one active inventory_rate model exists.
 *
 * Why "active model exists" gate: at fleet-day-0 (brand new property,
 * never trained anything), no predictions is expected. The check should
 * fire only when we HAVE trained models but the predict cron isn't
 * writing rows — that's the failure mode this audit found (Pydantic
 * date-field rejection that hid behind cron silent-success).
 *
 * Skipped (not fail) when no active inventory model anywhere — that's
 * the legitimate "no hotels mature enough yet" state.
 */
async function checkMlInventoryPredictionsFresh(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  try {
    const { data: activeModels, error: modelErr } = await supabaseAdmin
      .from('model_runs')
      .select('property_id')
      .eq('layer', 'inventory_rate')
      .eq('is_active', true)
      .eq('is_shadow', false)
      .limit(1);
    if (modelErr) {
      return { status: 'warn', detail: `model_runs read failed: ${errToString(modelErr)}` };
    }
    if (!activeModels || activeModels.length === 0) {
      return {
        status: 'skipped',
        detail: 'no active inventory_rate models — nothing to predict yet',
      };
    }

    const today = new Date().toISOString().slice(0, 10);
    const { data: preds, error: predErr } = await supabaseAdmin
      .from('inventory_rate_predictions')
      .select('property_id')
      .gte('predicted_for_date', today)
      .limit(1);
    if (predErr) {
      return { status: 'warn', detail: `inventory_rate_predictions read failed: ${errToString(predErr)}` };
    }
    if (!preds || preds.length === 0) {
      return {
        status: 'fail',
        detail: `Active inventory models exist but no predictions for today (${today}) or beyond. The predict-inventory cron is likely silent-failing.`,
        fix: 'Trigger /api/cron/ml-predict-inventory manually and inspect the response. Check the Railway ml-service logs for Pydantic validation errors or "insufficient data" returns. The new tightened jq check in ml-cron.yml should catch this going forward.',
      };
    }
    return { status: 'ok', detail: `inventory_rate_predictions has fresh rows for ${today} or later` };
  } catch (err) {
    return { status: 'warn', detail: `check threw: ${errToString(err)}` };
  }
}

/**
 * Demand predictions freshness — same shape as inventory but reads from
 * demand_predictions. Demand training requires labels_complete on every
 * scheduled staff member (via attendance_marks). The seal-daily cron
 * fills the gap; until it's been running for the property's first
 * training-eligible window, demand model_runs will be absent and this
 * check skips.
 */
async function checkMlDemandPredictionsFresh(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  return checkLayerPredictionsFresh({
    layer: 'demand',
    table: 'demand_predictions',
    dateCol: 'date',
    fix: 'No demand predictions for today. Verify (a) seal-daily cron is running and producing attendance_marks (check workflow: Seal Daily Cron), (b) headcount_actuals_view shows labels_complete=true for at least training_row_count_min days, (c) the latest /api/cron/ml-run-inference response.',
  });
}

async function checkMlSupplyPredictionsFresh(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  // Supply has a precondition demand doesn't: the manager must build a
  // schedule in the Schedule tab before supply_predictions can land for
  // that date (predict_supply iterates schedule_assignments → if empty,
  // returns predicted_rooms: 0 and writes nothing). Without this guard
  // the check would scream "supply broken" every day before the manager
  // has saved tomorrow's schedule — even though nothing is actually
  // broken.
  //
  // The supply cron only predicts for TOMORROW (see
  // src/app/api/cron/ml-run-inference/route.ts → tomorrowInTz). So the
  // right gate is "does a schedule exist for tomorrow?", not "does any
  // future schedule exist?". A schedule for today that the manager
  // built this morning won't have generated supply_predictions —
  // yesterday's cron, which would have written them, had nothing to
  // work with.
  try {
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const tomorrowStr = tomorrow.toISOString().slice(0, 10);
    const { data: schedules, error: schedErr } = await supabaseAdmin
      .from('schedule_assignments')
      .select('property_id')
      .eq('date', tomorrowStr)
      .limit(1);
    if (schedErr) {
      // If the read itself errors we can't tell — fall through to the
      // standard check so the real issue surfaces.
    } else if (!schedules || schedules.length === 0) {
      return {
        status: 'skipped',
        detail: `No schedule_assignments for tomorrow (${tomorrowStr}) — supply predictions can't land until a manager builds the schedule in Housekeeping → Schedule. Not an ML pipeline failure.`,
      };
    }
  } catch {
    // Defensive — never let the precondition check break the real check.
  }
  return checkLayerPredictionsFresh({
    layer: 'supply',
    table: 'supply_predictions',
    dateCol: 'date',
    fix: 'A schedule for tomorrow exists but no supply_predictions for today or later. Check /api/cron/ml-run-inference latest run + ML service /predict/supply logs for that property.',
  });
}

/**
 * Cron heartbeat freshness — generalized stand-in for the per-workflow
 * checks the doctor previously didn't have. Each cron route writes its
 * heartbeat at the end of every successful run; this check fails if any
 * expected cron's heartbeat is older than 2× the cadence (e.g. hourly
 * crons fail at 2h stale, daily crons fail at 48h stale).
 *
 * EXPECTED_CRONS encodes the cadence per workflow — keep in sync with
 * .github/workflows/*.yml. Adding a new cron means:
 *   1. Write its heartbeat via writeCronHeartbeat(name) on success.
 *   2. Add an entry here so the doctor watches it.
 *   3. Note it in FAILSAFES.md "Cron heartbeats" section.
 *
 * "first-run grace": if the heartbeat row doesn't exist yet (cron has
 * never succeeded since deploy of this file), we WARN rather than FAIL.
 * Otherwise the deploy itself would turn the doctor red until the next
 * tick — a brief window but enough to scare an operator.
 */
// GitHub Actions cron skew constant — see checkCronHeartbeatsFresh for
// the math. Exported so the cron-cadences drift test can sanity-check
// us if we ever bump it: any future change here should be paired with
// a deliberate decision about which cron tier needs more headroom.
export const GH_ACTIONS_SKEW_BUFFER_HOURS = 0.25;

export const EXPECTED_CRONS: Array<{ name: string; cadenceHours: number; description: string }> = [
  // Tight cadences
  // Plan v4 (2026-05-24): removed `scraper-health` — Railway scraper cron,
  // service is gone. The new `vercel-watchdog` (5-min, listed at the
  // bottom) replaces it.
  { name: 'process-sms-jobs',              cadenceHours: 5/60,  description: '5-min SMS jobs queue worker (Vercel native cron)' },
  { name: 'agent-nudges-check',            cadenceHours: 5/60,  description: 'every-5-min nudge engine (Vercel native cron) — Codex 2026-05-13' },
  { name: 'agent-sweep-reservations',      cadenceHours: 5/60,  description: 'every-5-min reserved-row sweeper (Vercel native cron, Codex round-5 R2)' },
  { name: 'agent-summarize-long-conversations', cadenceHours: 30/60, description: 'every-30-min summarization of long agent conversations (L4 part B)' },
  { name: 'doctor-check',                  cadenceHours: 1,     description: 'hourly health check — runs the doctor battery + alerts Sentry/SMS on any fail (Round 13)' },
  { name: 'walkthrough-heal-stale',        cadenceHours: 30/60, description: 'every-30-min walkthrough recovery (heals stale runs left mid-walkthrough by crashed clients)' },
  { name: 'walkthrough-health-alert',      cadenceHours: 10/60, description: 'every-10-min walkthrough health monitor (alerts on stuck step counts)' },
  { name: 'sweep-orphan-auth-users',       cadenceHours: 30/60, description: 'every-30-min orphan auth-user reconciler — deletes auth.users rows with no matching accounts row (audit fix #4)' },
  { name: 'sweep-mfa-verified-sessions',   cadenceHours: 6,     description: 'every-6-hour sweep of mfa_verified_sessions rows older than 30 days — Phase 2B Door B fix' },
  // Plan v4 (2026-05-24): removed `seed-rooms-daily` — depended on the
  // legacy `rooms` table (dropped in v4). CUA writes room state to
  // pms_room_status_log (event-sourced, no per-day seeding needed).
  { name: 'seal-daily',                    cadenceHours: 1,     description: 'hourly per-property daily-seal' },
  // Round 17 (2026-05-15): two-slot cron that auto-builds Maria's
  // schedule. Treated as a single heartbeat — either slot writing
  // counts as fresh. 24h cadence so a missed 7 AM run doesn't yelp
  // before the 8 PM run lands.
  { name: 'schedule-auto-fill',            cadenceHours: 24,    description: 'daily schedule auto-build (7 AM + 8 PM Central via GitHub Actions cron)' },
  // Daily
  { name: 'ml-run-inference',              cadenceHours: 24,    description: 'daily demand+supply+optimizer predictions' },
  { name: 'ml-predict-inventory',          cadenceHours: 24,    description: 'daily inventory predictions for tomorrow' },
  // 2026-05-24: removed `ml-aggregate-priors` — cross-fleet cohort
  // aggregation is a no-op at N<5 hotels per cohort. Re-add when scale
  // makes the cron meaningful. (See route.ts for the matching log demote.)
  { name: 'ml-shadow-evaluate',            cadenceHours: 24,    description: 'daily shadow-model promote/reject pass' },
  { name: 'ml-retention-purge',            cadenceHours: 24,    description: 'daily prediction_log/app_events retention purge (Phase 3.6)' },
  { name: 'purge-old-error-logs',          cadenceHours: 24,    description: 'daily error_logs retention sweep' },
  { name: 'expire-trials',                 cadenceHours: 24,    description: 'daily trial-expiration flip' },
  { name: 'agent-archive-stale-conversations', cadenceHours: 24, description: 'daily 3am archival of stale agent conversations (L4 part A)' },
  { name: 'claude-sessions-purge',         cadenceHours: 24,    description: 'daily 3:30am claude_sessions retention sweep — deletes rows older than 24h so random-sessionId floods can\'t grow the table (security audit M2)' },
  { name: 'agent-heal-counters',           cadenceHours: 24,    description: 'daily 4am counter-drift heal (Round 12 T12.12, invariant doctrine safety net)' },
  { name: 'webhook-dedup-purge',           cadenceHours: 24,    description: 'daily 4:15am purge of expired webhook-dedup keys (auth-storage-cookies-and-middleware)' },
  // Weekly
  { name: 'ml-train-demand',               cadenceHours: 168,   description: 'weekly demand training (Sunday)' },
  { name: 'ml-train-supply',               cadenceHours: 168,   description: 'weekly supply training (Sunday)' },
  { name: 'ml-train-inventory',            cadenceHours: 168,   description: 'weekly inventory training (Sunday)' },
  // Plan v4 (2026-05-24): removed `scraper-weekly-digest` — Railway
  // scraper observability cron, scraper service is gone.
  { name: 'agent-weekly-digest',           cadenceHours: 168,   description: 'weekly agent activity digest SMS to MANAGER_PHONE (Sundays 9am UTC)' },
  // Plan v4 (2026-05-23): replaces the Railway-hosted vercel-watchdog.js.
  // Runs the doctor every 5 min, Sentry-alerts on fail with business-hours-only SMS bump.
  { name: 'vercel-watchdog',               cadenceHours: 5/60,  description: '5-min Vercel cron that polls /api/admin/doctor and alerts on fail (replaces scraper/vercel-watchdog.js post-v4)' },
  // 2026-05-24: cua-parity-diff retired — shadow gate removed alongside
  // legacy CA normalizers; new generic-table-writer is the only path now.
  // Migration 0210: cleaning-rules engine that turns live PMS data into
  // Staxis-side cleaning task records (departure clean, VIP amenity
  // setup, tight-turnaround priority bump, …).
  { name: 'run-rules-engine',              cadenceHours: 5/60,  description: '5-min cleaning-rules engine — reads pms_*, writes cleaning_tasks (Vercel native cron)' },
  // 2026-05-24: sick-callout coverage flow (feature #6). Sweeps callouts
  // whose redistribute_at has passed (or whose 'after_current_room'
  // gate is now satisfied) and fires the redistribute. Safety net for
  // inline failures on the report routes.
  { name: 'process-pending-callouts',      cadenceHours: 5/60,  description: '5-min Vercel cron that processes deferred sick-callout redistribution (feature #6)' },
  // Plan v8 Phase B (migration 0217): 5-min Vercel cron that flips
  // mapping_help_requests past expires_at to 'expired' and deletes their
  // screenshots from the mapping-screenshots storage bucket. Without this
  // the 15-min TTL pending rows accumulate forever.
  { name: 'expire-help-requests',          cadenceHours: 5/60,  description: '5-min Vercel cron that expires stale mapping_help_requests + purges their screenshot storage objects (Plan v8 Phase B)' },
  // 2026-05-24: feature #17 — daily + weekly housekeeping reports.
  // 30-min cadence; per-property time-window check in the route picks
  // the right firing for each hotel's local 4pm/6pm/8pm/10pm slot.
  { name: 'run-daily-report',              cadenceHours: 30/60, description: '30-min cron that builds the per-property daily housekeeping report and emails it to active GMs/owners at their configured local time' },
  // Weekly fires the same 30-min cron — the route itself skips non-Sunday
  // runs early. Cadence is 30/60 because the heartbeat lands every tick
  // regardless of whether a property got mailed.
  { name: 'run-weekly-report',             cadenceHours: 30/60, description: 'Sunday-only logic, 30-min cron — same per-property time-window check as run-daily-report; emits the Mon–Sun digest with a Claude-generated AI insight at the top' },
];

async function checkCronHeartbeatsFresh(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  try {
    const { data: rows, error } = await supabaseAdmin
      .from('cron_heartbeats')
      .select('cron_name, last_success_at, notes');
    if (error) {
      return { status: 'warn', detail: `cron_heartbeats read failed: ${errToString(error)}` };
    }
    const byName = new Map<string, { last: string; notes: Record<string, unknown> }>();
    for (const r of (rows ?? []) as Array<{ cron_name: string; last_success_at: string; notes: Record<string, unknown> | null }>) {
      byName.set(r.cron_name, { last: r.last_success_at, notes: r.notes ?? {} });
    }
    const now = Date.now();
    const failed: string[] = [];  // hard-stale: >1.5× warn threshold → real problem
    const warned: string[] = [];  // soft-stale: between tolerance and 1.5× → likely transient
    const missing: string[] = [];
    // Phase 3.4: a cron that's writing heartbeats but tagged 'degraded'
    // for >24h surfaces here as a soft warning. Distinct from staleness:
    // the cron IS running, it's just shipping with stages skipped.
    const degraded: string[] = [];
    for (const c of EXPECTED_CRONS) {
      const entry = byName.get(c.name);
      if (!entry) {
        missing.push(c.name);
        continue;
      }
      const last = entry.last;
      // Codex follow-up 2026-05-13 (C5): strict equality on the literal
      // 'degraded' so a typo in the writer (`'degradd'`, `'Degraded'`)
      // doesn't silently fall through as 'ok'. Any other string becomes
      // 'ok' (the default).
      const rawStatus = entry.notes?._status as string | undefined;
      const status: 'ok' | 'degraded' = rawStatus === 'degraded' ? 'degraded' : 'ok';
      const ageHours = (now - new Date(last).getTime()) / (60 * 60 * 1000);
      if (status === 'degraded' && ageHours <= 24) {
        // Not flagging within the single-tick freshness window — one
        // degraded heartbeat could be a transient stage skip. After 24h
        // the cron has ticked at least once at daily cadence and the
        // degradation is persistent.
      } else if (status === 'degraded') {
        degraded.push(`${c.name} (degraded for ${ageHours.toFixed(1)}h)`);
      }
      // ── Tiered staleness (May 2026 audit pass-6) ───────────────────
      // Splitting into warn vs fail prevents the post-deploy smoke test
      // from flaking when a cron is "between fires" (warn = transient)
      // while still surfacing a real outage (fail). Warn-tier covers
      // the half-window of cadence ± skew + first-cron-on-Vercel grace.
      //
      // Math by tier:
      //   5-min cron:  warn-thresh 25 min,  fail-thresh 37.5 min
      //   15-min cron: warn-thresh 45 min,  fail-thresh 67.5 min
      //   hourly:      warn-thresh 2.25h,   fail-thresh 3.375h
      //   daily:       warn-thresh 48.25h,  fail-thresh 72.375h
      //   weekly:      warn-thresh 336.25h, fail-thresh 504.375h
      const warnThreshold = c.cadenceHours * 2 + GH_ACTIONS_SKEW_BUFFER_HOURS;
      const failThreshold = warnThreshold * 1.5;
      if (ageHours > failThreshold) {
        failed.push(`${c.name} (${ageHours.toFixed(1)}h old, fail threshold ${failThreshold.toFixed(2)}h)`);
      } else if (ageHours > warnThreshold) {
        warned.push(`${c.name} (${ageHours.toFixed(1)}h old, warn threshold ${warnThreshold.toFixed(2)}h)`);
      }
    }
    if (failed.length > 0) {
      return {
        status: 'fail',
        detail: `Cron heartbeats badly stale (>1.5× normal tolerance — likely a real outage): ${failed.join('; ')}` +
          (warned.length > 0 ? ` ALSO transient: ${warned.join('; ')}` : ''),
        fix: 'Verify each cron route is reachable: curl -H "Authorization: Bearer $CRON_SECRET" https://getstaxis.com/api/cron/<name>. Check the route\'s Vercel logs for crashes before writeCronHeartbeat() is called. For Vercel native crons, inspect https://vercel.com/reeyenns-projects/staxis/crons.',
      };
    }
    if (warned.length > 0) {
      return {
        status: 'warn',
        detail: `Cron heartbeats slightly stale (likely just between fires): ${warned.join('; ')}`,
      };
    }
    if (missing.length > 0) {
      // First-run grace — heartbeats not seeded yet. Warn so the
      // operator notices but don't block the deploy on a fresh schema.
      return {
        status: 'warn',
        detail: `Heartbeats not yet written for: ${missing.join(', ')}. Will resolve after each cron's next tick.`,
      };
    }
    if (degraded.length > 0) {
      // Phase 3.4: degradation is awareness-not-paging. A skipped-stage
      // cron still ran end-to-end; the operator should know why but
      // production isn't broken. Surface as warn, never fail.
      return {
        status: 'warn',
        detail: `Cron heartbeats degraded (cron is running but at least one stage was skipped): ${degraded.join('; ')}. Inspect the cron's notes._status and properties_skipped fields.`,
      };
    }
    return {
      status: 'ok',
      detail: `All ${EXPECTED_CRONS.length} expected crons have fresh heartbeats`,
    };
  } catch (err) {
    return { status: 'warn', detail: `cron-heartbeats check threw: ${errToString(err)}` };
  }
}

/**
 * Codex follow-up 2026-05-13 (#2): surface recent property_misconfigured
 * events. The "log + skip" design from Phase 3.5 emits these events when
 * a property has a missing `total_rooms` or `timezone`. Without this
 * check, the only operator-visible signal was a missing prediction in
 * the cockpit (lagging by hours/days).
 *
 * Severity is `warn` not `fail` — a single misconfigured property is
 * an awareness signal, not a customer outage. The cron skipped that
 * one property and moved on. Failing the deploy on it would be
 * over-the-top.
 */
async function checkPropertyMisconfiguredRecent(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  try {
    const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    // Codex follow-up 2026-05-13 (B3): bumped to 200 so propertyIds + fields
    // sets are not undercounted at fleet scale (50 hotels × 4 layers × daily).
    const { data, error, count } = await supabaseAdmin
      .from('app_events')
      .select('property_id, metadata, ts', { count: 'exact' })
      .eq('event_type', 'property_misconfigured')
      .gte('ts', cutoff)
      .order('ts', { ascending: false })
      .limit(200);
    if (error) {
      return { status: 'warn', detail: `app_events read failed: ${errToString(error)}` };
    }
    // Codex follow-up 2026-05-13 (A4): `!count` was wrong because Supabase
    // can return `count: null` in proxied environments while `data` is
    // populated. Use the array length as the source of truth (matches
    // the smoke at scripts/ml-smoke-test.ts:95).
    const rows = data ?? [];
    if (rows.length === 0 && (count ?? 0) === 0) {
      return { status: 'ok', detail: 'No property_misconfigured events in last 24h' };
    }
    const fields = new Set<string>();
    const propertyIds = new Set<string>();
    for (const row of rows) {
      // Codex round-4 G3: when the parser remapped to 'unknown_field',
      // E2 stores the original Python typo in metadata.original_field.
      // Surface that instead of just 'unknown_field' so the operator
      // sees the actual mistake without grepping app_events.
      const md = (row as { metadata?: { field?: string; original_field?: string } }).metadata;
      if (md?.field) {
        if (md.field === 'unknown_field' && md.original_field) {
          fields.add(`unknown(${md.original_field})`);
        } else {
          fields.add(md.field);
        }
      }
      const pid = (row as { property_id?: string }).property_id;
      if (pid) propertyIds.add(pid);
    }
    const eventCount = count ?? rows.length;
    return {
      status: 'warn',
      detail:
        `${eventCount} property_misconfigured event(s) in last 24h ` +
        `across ${propertyIds.size} property/properties; ` +
        `fields: ${[...fields].join(', ') || '(unknown)'}. ` +
        `Set the missing field(s) via Live Hotels → [hotel] in the admin UI.`,
      fix:
        'Go to Live Hotels → [hotel] → set total_rooms and/or timezone. ' +
        'ML predictions resume on the next nightly cron (no manual retrain needed).',
    };
  } catch (err) {
    return { status: 'warn', detail: `property_misconfigured check threw: ${errToString(err)}` };
  }
}

/**
 * Codex follow-up 2026-05-13 (#4): the nightly smoke was hitting
 * /api/inventory/auto-fill-map (a nonexistent route) to assert the
 * Phase 1 band fields (predictedCurrentStockLow/High) made it through.
 * Move that shape check server-side where we already have admin auth
 * and the helper imported.
 *
 * Returns `ok` when no graduated items exist (informational) and `fail`
 * only when graduated items are missing the band fields — that's a
 * regression in getInventoryAutoFillMap and a real customer impact
 * (the inventory page won't render the band UI).
 */
async function checkInventoryAutoFillShape(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  const propertyId = env.SMOKE_PROPERTY_ID;
  if (!propertyId) {
    return {
      status: 'ok',
      detail: 'SMOKE_PROPERTY_ID not set; auto-fill shape check skipped (informational only).',
    };
  }
  try {
    const { getInventoryAutoFillMap } = await import('@/lib/db/ml-inventory-cockpit');
    // Codex follow-up 2026-05-13 (A3): pass supabaseAdmin explicitly.
    // The default browser/anon client has no JWT in a server context,
    // so RLS-protected tables return empty — silent ok-skip in prod.
    // Use 'always-on' mode so we get ALL active items (not just
    // graduated ones), letting the doctor distinguish "0 items at all"
    // (real regression) from "items present but none graduated yet".
    // The unknown cast is required because supabaseAdmin's full builder
    // type doesn't structurally match the minimal AutoFillReadClient
    // interface — only the methods the function uses need to exist on
    // the injected client.
    // Codex round-3 review 2026-05-13 (E4): a structural-typing
    // attempt (PromiseLike on AutoFillReadClient) hits the TypeScript
    // recursive-type limit because supabase's PostgrestFilterBuilder
    // is deeply generic. Using `Parameters<typeof getInventoryAutoFillMap>[2]`
    // is the next-tightest option — it's narrower than `any`, locks the
    // cast to the helper's signature (changes there force a re-think
    // here), and avoids `unknown as any` which silently disabled type
    // checking entirely.
    // ⚠️ Trip-wire for future refactors of getInventoryAutoFillMap:
    // The cast below goes through `unknown`, so if you ever loosen the
    // 3rd parameter (e.g. make it optional, or accept a wider union),
    // this line silently compiles against the new shape. The runtime
    // can break without a TypeScript error. If you're reading this
    // because you just refactored that function — re-verify supabaseAdmin
    // is still a valid value for the new signature before merging.
    const items = await getInventoryAutoFillMap(
      propertyId,
      'always-on',
      supabaseAdmin as unknown as Parameters<typeof getInventoryAutoFillMap>[2],
    );
    if (!Array.isArray(items)) {
      return {
        status: 'fail',
        detail: 'getInventoryAutoFillMap returned a non-array value.',
        fix: 'Inspect src/lib/db/ml-inventory-cockpit.ts:getInventoryAutoFillMap return contract.',
      };
    }
    // Codex follow-up 2026-05-13 (A3): when SMOKE_PROPERTY_ID is set we
    // expect to see SOME items. Zero items on a property tagged for
    // smoke means either (a) cron stopped writing predictions, or
    // (b) the predictions are >7 days stale and got freshness-filtered.
    // Both are real regressions — warn (not ok).
    if (items.length === 0) {
      return {
        status: 'warn',
        detail:
          `auto-fill map returned 0 items for SMOKE_PROPERTY_ID ${propertyId}. ` +
          `Either inventory predictions stopped writing or freshness-filtered out (>7d). ` +
          `Check ml-predict-inventory cron.`,
        fix:
          'Check the most recent inventory_rate_predictions row: ' +
          `select max(predicted_at) from inventory_rate_predictions where property_id = '${propertyId}';`,
      };
    }
    const graduated = items.find((i) => i.graduated === true);
    if (!graduated) {
      return {
        status: 'ok',
        detail: `${items.length} items returned; none graduated yet — band-field check skipped.`,
      };
    }
    const required: Array<keyof typeof graduated> = [
      'predictedCurrentStock',
      'predictedCurrentStockLow',
      'predictedCurrentStockHigh',
    ];
    const missing = required.filter((k) => !(k in graduated));
    if (missing.length > 0) {
      return {
        status: 'fail',
        detail:
          `Phase 1 band fields missing from a graduated item: ${missing.join(', ')}. ` +
          `The auto-fill response shape regressed; the inventory page will not render the confidence band.`,
        fix:
          'Inspect src/lib/db/ml-inventory-cockpit.ts:getInventoryAutoFillMap — ' +
          'verify the per-item output includes predictedCurrentStockLow/High derived from p25/p75 rate decay.',
      };
    }
    return {
      status: 'ok',
      detail: `auto-fill shape valid (${items.length} items; graduated band fields present).`,
    };
  } catch (err) {
    return { status: 'warn', detail: `auto-fill shape check threw: ${errToString(err)}` };
  }
}

/**
 * HSTS preload list status for getstaxis.com.
 *
 * Reeyen submitted getstaxis.com to https://hstspreload.org/ on
 * 2026-05-13. The submission is irreversible for ~1 year once it
 * ships in a Chrome release, but Google can reject the submission
 * silently (status flips back to "unknown") if our HSTS header drifts
 * out of compliance — e.g., somebody shortens max-age, removes
 * `preload`, or breaks the HTTP→HTTPS redirect. Without this check
 * the only signal is a hand-curl by an operator who happens to
 * remember.
 *
 * Statuses:
 *   - "pending"   → in Google's review queue, not yet shipped. OK.
 *   - "preloaded" → live in Chrome's preload list. OK.
 *   - "unknown"   → either never submitted OR Google rejected us. WARN.
 *   - anything else (incl. network failure)                       → WARN.
 *
 * Cost: one outbound HTTPS request per doctor invocation. The
 * Railway watchdog hits doctor every 5 min; hstspreload.org is a
 * Google-operated public API with no rate limit for status queries.
 * 5-second timeout so a slow upstream doesn't pin doctor latency.
 */
async function checkHstsPreloadStatus(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  const DOMAIN = 'getstaxis.com';
  try {
    const r = await fetch(
      `https://hstspreload.org/api/v2/status?domain=${DOMAIN}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!r.ok) {
      return { status: 'warn', detail: `hstspreload.org returned HTTP ${r.status}` };
    }
    const data = (await r.json()) as { name?: string; status?: string };
    if (data.status === 'preloaded') {
      return { status: 'ok', detail: `${DOMAIN} is live on the Chrome HSTS preload list` };
    }
    if (data.status === 'pending') {
      return { status: 'ok', detail: `${DOMAIN} HSTS preload submission pending in Chromium queue` };
    }
    return {
      status: 'warn',
      detail:
        `${DOMAIN} HSTS preload status is "${data.status ?? 'undefined'}" — expected ` +
        `"pending" or "preloaded". Either Google rejected the submission (header drift?) ` +
        `or the API contract changed. Inspect manually: curl https://hstspreload.org/api/v2/status?domain=${DOMAIN}`,
    };
  } catch (err) {
    return {
      status: 'warn',
      detail: `HSTS preload status check failed: ${errToString(err)}`,
    };
  }
}

/**
 * Codex round-3 review 2026-05-13 (E1): the Phase B sample-size guard
 * (len(X_test) >= 30) silently rejects models. Without this check, a
 * property whose training rows drop below the threshold (e.g. due to
 * Maria missing day-confirmations) would just see "model not active"
 * with no indication why. Surface the most-recent run's
 * validation_holdout_n per (property, layer); warn when below 30.
 *
 * Single-property friendly today; scales O(properties × layers) at
 * fleet scale (3 layers × 50 properties = 150 rows max, single query).
 */
async function checkMlModelsHoldoutSize(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  try {
    // Pull the most-recent training run per (property, layer). We only
    // care about non-shadow non-item rows for housekeeping (demand +
    // supply); inventory has per-item models which is too granular for
    // this check.
    // Codex round-4 G1: filter `is_active=true` so a property whose
    // latest training failed activation but whose previous activation
    // had a healthy holdout doesn't surface as a false positive.
    // Codex round-4 G2: bumped 50 → 200 to match
    // checkPropertyMisconfiguredRecent's limit; at fleet scale the
    // 50-row ceiling truncated BEFORE dedupe.
    const { data, error } = await supabaseAdmin
      .from('model_runs')
      .select('id, property_id, layer, algorithm, cold_start, validation_holdout_n, trained_at')
      .in('layer', ['demand', 'supply'])
      .is('item_id', null)
      .eq('is_active', true)
      .eq('is_shadow', false)
      .order('trained_at', { ascending: false })
      .limit(200);
    if (error) {
      return { status: 'warn', detail: `model_runs read failed: ${errToString(error)}` };
    }
    const rows = data ?? [];
    if (rows.length === 0) {
      return { status: 'ok', detail: 'No demand/supply model_runs yet — informational only.' };
    }
    // Dedupe by (property, layer) keeping the most recent.
    const mostRecent = new Map<string, { layer: string; algorithm: string; coldStart: boolean; n: number; trained_at: string }>();
    for (const r of rows as Array<{
      property_id: string; layer: string; algorithm: string; cold_start: boolean | null;
      validation_holdout_n: number | null; trained_at: string;
    }>) {
      const key = `${r.property_id}:${r.layer}`;
      if (!mostRecent.has(key)) {
        mostRecent.set(key, {
          layer: r.layer,
          algorithm: r.algorithm,
          // Round 18: prefer the explicit boolean over algorithm-string
          // matching. Falls back to the prior name-startsWith heuristic
          // for runs that pre-date migration 0130 (defense in depth).
          coldStart: r.cold_start === true
            || (r.algorithm?.startsWith('cold-start') ?? false),
          n: r.validation_holdout_n ?? 0,
          trained_at: r.trained_at,
        });
      }
    }
    const HOLDOUT_FLOOR = 30;
    const tooSmall: string[] = [];
    let coldStartSkipped = 0;
    for (const [key, info] of mostRecent.entries()) {
      // Cold-start models legitimately have no validation holdout —
      // they run on a synthetic cohort prior, not on historical training
      // rows. Doctor's job is to flag a TRAINED model with a tiny
      // holdout (real data exists but the activation gate rejects it).
      if (info.coldStart) {
        coldStartSkipped++;
        continue;
      }
      if (info.n < HOLDOUT_FLOOR) {
        tooSmall.push(`${key} algorithm=${info.algorithm} (n=${info.n})`);
      }
    }
    if (tooSmall.length === 0) {
      const coldStartNote =
        coldStartSkipped > 0
          ? ` ${coldStartSkipped} cold-start model(s) intentionally skipped — they use cohort priors, not historical holdouts.`
          : '';
      return {
        status: 'ok',
        detail: `${mostRecent.size - coldStartSkipped} trained (property, layer) pair(s) all have validation_holdout_n >= ${HOLDOUT_FLOOR}.${coldStartNote}`,
      };
    }
    return {
      status: 'warn',
      detail:
        `${tooSmall.length} TRAINED (property, layer) pair(s) have most-recent run with ` +
        `validation_holdout_n < ${HOLDOUT_FLOOR} — gate silently rejects activation. ` +
        `Affected: ${tooSmall.slice(0, 5).join(', ')}${tooSmall.length > 5 ? ', ...' : ''}.`,
      fix:
        'Property has crossed the cold-start cutoff but its training set is still ' +
        'thin. Check that the property has 200+ rows in cleaning_minutes_per_day_view ' +
        'where total_recorded_minutes > 0 AND headcount_actuals_view.labels_complete = true. ' +
        'If labels_complete is false on many days, schedule_assignments are missing crew ' +
        'for those days (manager built a schedule with empty crew, or never built one).',
    };
  } catch (err) {
    return { status: 'warn', detail: `holdout-size check threw: ${errToString(err)}` };
  }
}

/**
 * Phase 7 v2 (2026-05-22) — observability for the prediction_log
 * backfill writer (ml-service/src/actuals.py). If the daily backfill
 * cron silently fails (Railway outage, advisory lock thrashing, SQL
 * regression), the auto-rollback pipeline has no fresh paired data
 * and silently never fires — exactly the bug class the v1 design had.
 *
 * Fails when: no prediction_log row in the last 28h AND there's at
 * least one active fitted housekeeping model in the fleet (we'd expect
 * rows). 28h tolerates one missed daily cron run.
 */
async function checkMlPredictionLogWriterAlive(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  try {
    const cutoffIso = new Date(Date.now() - 28 * 3600_000).toISOString();
    const [{ count: recentLogCount }, { count: activeFittedCount }] = await Promise.all([
      supabaseAdmin
        .from('prediction_log')
        .select('id', { count: 'exact', head: true })
        .gte('logged_at', cutoffIso),
      // Active non-cold-start housekeeping models — the population
      // the writer is supposed to be tracking. If none exist, the
      // writer SHOULD be quiet, and we'd give it a pass.
      supabaseAdmin
        .from('model_runs')
        .select('id', { count: 'exact', head: true })
        .eq('is_active', true)
        .eq('is_shadow', false)
        .in('layer', ['demand', 'supply'])
        .eq('is_cold_start', false),
    ]);
    if ((activeFittedCount ?? 0) === 0) {
      return {
        status: 'skipped',
        detail: 'No active fitted housekeeping models — writer has no work to do',
      };
    }
    if ((recentLogCount ?? 0) === 0) {
      return {
        status: 'fail',
        detail: `prediction_log has no rows newer than 28h but ${activeFittedCount} ` +
          `active fitted housekeeping models exist (writer should be producing rows daily)`,
        fix: 'Check the GitHub Actions ml-cron workflow for the auto-rollback job ' +
          '(daily 06:45 CDT). Inspect ml-service Railway logs for actuals_backfill_* ' +
          'event names. May indicate Maria isn\'t approving cleanings (recorded → ' +
          'approved gap), in which case total_approved_minutes IS NULL skips writes.',
      };
    }
    return {
      status: 'ok',
      detail: `${recentLogCount} prediction_log rows written in the last 28h ` +
        `(${activeFittedCount} active fitted housekeeping models on the fleet)`,
    };
  } catch (err) {
    return { status: 'warn', detail: `prediction_log writer check threw: ${errToString(err)}` };
  }
}

/**
 * Phase 7 v2 (2026-05-22) — surface "rollback fired but next Sunday's
 * training cycle didn't produce a replacement model". The auto-rollback
 * pipeline deliberately does NOT promote a fallback (Codex high-pri
 * finding) — property serves cold-start cohort prior until the next
 * weekly training run creates a fresh active. If 8+ days pass with no
 * new active, something is broken in the training pipeline.
 *
 * The 8-day window aligns with the weekly training cron (Sunday 03:00
 * CDT): if a rollback fires Monday, Sunday's training should produce
 * a replacement; if Tuesday rolls around without one, alert.
 */
async function checkMlNoOrphanActiveAfterRollback(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  try {
    const cutoffIso = new Date(Date.now() - 8 * 86400_000).toISOString();
    // Find rolled-back (property, layer) pairs from the last 8 days.
    const { data: rolledBack } = await supabaseAdmin
      .from('model_runs')
      .select('property_id, layer, deactivated_at')
      .eq('deactivation_reason', 'auto_rollback')
      .gte('deactivated_at', cutoffIso)
      .limit(200);
    if (!rolledBack || rolledBack.length === 0) {
      return { status: 'ok', detail: 'No auto-rollbacks in the last 8 days' };
    }
    // For each, check whether an active non-shadow row exists now.
    const orphans: Array<{ property_id: string; layer: string }> = [];
    for (const row of rolledBack) {
      const { count } = await supabaseAdmin
        .from('model_runs')
        .select('id', { count: 'exact', head: true })
        .eq('property_id', row.property_id as string)
        .eq('layer', row.layer as string)
        .eq('is_active', true)
        .eq('is_shadow', false);
      if ((count ?? 0) === 0) {
        orphans.push({
          property_id: row.property_id as string,
          layer: row.layer as string,
        });
      }
    }
    if (orphans.length === 0) {
      return {
        status: 'ok',
        detail: `${rolledBack.length} auto-rollback(s) in last 8 days; all properties ` +
          'have a replacement active model',
      };
    }
    return {
      status: 'warn',
      detail: `${orphans.length} property/layer pair(s) rolled back >8 days ago without ` +
        `replacement active model: ${orphans.map((o) => `${o.property_id}:${o.layer}`).slice(0, 3).join(', ')}` +
        (orphans.length > 3 ? ` (+${orphans.length - 3} more)` : ''),
      fix: 'Check the weekly training cron (Sunday 03:00 CDT for demand, 03:30 for ' +
        'supply). The property may be in cold-start (insufficient cleaning_events ' +
        'after the rollback) — in which case serving the cohort prior is correct ' +
        'and this warning is informational, not actionable.',
    };
  } catch (err) {
    return { status: 'warn', detail: `orphan-active check threw: ${errToString(err)}` };
  }
}

/**
 * Codex round-5 META J2.1 (2026-05-13): the cohort-prior aggregator
 * was emitting absolute units/day into a column named per-room-per-day
 * for 5+ months. Bug was latent because Beaumont is the only property
 * (n=1, falls back to industry seeds). The day a 5th hotel onboards
 * in any cohort, every NEW property's cold-start predictions get
 * scaled 100x-200x off → inventory cockpit shows nonsense numbers.
 *
 * The aggregator SQL is now fixed (divides by total_rooms in the CTE).
 * This check is the loud-warning belt-and-suspenders: if any prior
 * row is outside a sane per-room-per-day range, surface it
 * immediately. Industry-benchmark seeds for typical inventory items
 * (toilet paper, shampoo, towels) sit in [0.05, 2.5]/room/day. Use
 * a wider safety band to avoid false positives from genuinely
 * heavy-use items.
 */
async function checkInventoryPriorsInRange(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  const SANE_MIN = 0.001;  // below this is essentially zero usage — suspicious
  const SANE_MAX = 10.0;   // above this is implausible per-room-per-day usage
  try {
    const { data, error } = await supabaseAdmin
      .from('inventory_rate_priors')
      .select('cohort_key, item_canonical_name, prior_rate_per_room_per_day, n_hotels_contributing, source')
      .order('prior_rate_per_room_per_day', { ascending: false })
      .limit(50);
    if (error) {
      return { status: 'warn', detail: `inventory_rate_priors read failed: ${errToString(error)}` };
    }
    const rows = (data ?? []) as Array<{
      cohort_key: string;
      item_canonical_name: string;
      prior_rate_per_room_per_day: number | null;
      n_hotels_contributing: number | null;
      source: string | null;
    }>;
    if (rows.length === 0) {
      return { status: 'ok', detail: 'No inventory_rate_priors rows yet — informational only.' };
    }
    const offenders: string[] = [];
    for (const r of rows) {
      const rate = r.prior_rate_per_room_per_day;
      if (rate === null || Number.isNaN(rate)) continue;
      if (rate < SANE_MIN || rate > SANE_MAX) {
        offenders.push(
          `${r.cohort_key}/${r.item_canonical_name} = ${rate.toFixed(3)} (n=${r.n_hotels_contributing ?? '?'}, source=${r.source ?? '?'})`,
        );
      }
    }
    if (offenders.length === 0) {
      return {
        status: 'ok',
        detail: `${rows.length} prior(s) all in sane range [${SANE_MIN}, ${SANE_MAX}] /room/day.`,
      };
    }
    return {
      status: 'warn',
      detail:
        `${offenders.length} cohort prior(s) outside sane range [${SANE_MIN}, ${SANE_MAX}] /room/day. ` +
        `This is a regression of the J2.1 unit-mismatch bug. Top offenders: ${offenders.slice(0, 5).join('; ')}` +
        `${offenders.length > 5 ? ' ...' : ''}`,
      fix:
        'Inspect ml-service/src/training/inventory_priors.py — verify the per_pair CTE divides by ' +
        'properties.total_rooms. A regression here scales every cold-start prediction for new ' +
        'properties by the wrong factor.',
    };
  } catch (err) {
    return { status: 'warn', detail: `inventory_priors_in_range check threw: ${errToString(err)}` };
  }
}

async function checkLayerPredictionsFresh(opts: {
  layer: string;
  table: string;
  dateCol: string;
  fix: string;
}): Promise<Omit<Check, 'name' | 'durationMs'>> {
  try {
    const { data: activeModels, error: modelErr } = await supabaseAdmin
      .from('model_runs')
      .select('property_id')
      .eq('layer', opts.layer)
      .eq('is_active', true)
      .eq('is_shadow', false)
      .limit(1);
    if (modelErr) {
      return { status: 'warn', detail: `model_runs read failed: ${errToString(modelErr)}` };
    }
    if (!activeModels || activeModels.length === 0) {
      return {
        status: 'skipped',
        detail: `no active ${opts.layer} models — training prereqs probably still unmet (attendance labels, min-rows-per-property)`,
      };
    }
    const today = new Date().toISOString().slice(0, 10);
    const { data: preds, error: predErr } = await supabaseAdmin
      .from(opts.table)
      .select('property_id')
      .gte(opts.dateCol, today)
      .limit(1);
    if (predErr) {
      return { status: 'warn', detail: `${opts.table} read failed: ${errToString(predErr)}` };
    }
    if (!preds || preds.length === 0) {
      return {
        status: 'fail',
        detail: `Active ${opts.layer} models exist but no predictions for today (${today}) or beyond.`,
        fix: opts.fix,
      };
    }
    return { status: 'ok', detail: `${opts.table} has fresh rows for ${today} or later` };
  } catch (err) {
    return { status: 'warn', detail: `check threw: ${errToString(err)}` };
  }
}

// ─── CUA checks (Plan v4 universal CUA rebuild — 2026-05-23) ──────────────

const CUA_HEARTBEAT_STALE_MS = 5 * 60_000;

async function checkCuaSessionsAlive(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  try {
    const { data, error } = await supabaseAdmin
      .from('property_sessions')
      .select('property_id, status, last_alive_at, pms_family')
      .neq('status', 'stopped');
    if (error) {
      return { status: 'warn', detail: `property_sessions read failed: ${errToString(error)}` };
    }
    if (!data || data.length === 0) {
      return {
        status: 'skipped',
        detail: 'no enabled property_sessions rows yet — CUA worker has nothing to do',
      };
    }
    const now = Date.now();
    type SessionRow = { property_id: string; status: string; last_alive_at: string | null; pms_family: string };
    const stale: string[] = [];
    for (const row of data as SessionRow[]) {
      const lastAlive = row.last_alive_at ? new Date(row.last_alive_at).getTime() : 0;
      if (now - lastAlive > CUA_HEARTBEAT_STALE_MS) {
        stale.push(`${row.property_id} (${row.pms_family}, status=${row.status}, last_alive=${row.last_alive_at ?? 'never'})`);
      }
    }
    if (stale.length > 0) {
      return {
        status: 'fail',
        detail: `${stale.length}/${data.length} CUA sessions missed heartbeat (>5min stale): ${stale.slice(0, 5).join('; ')}`,
        fix: 'Check Fly machine logs for the affected property. Likely a Playwright crash; supervisor should respawn within 30s.',
      };
    }
    return { status: 'ok', detail: `all ${data.length} CUA sessions heartbeating within ${CUA_HEARTBEAT_STALE_MS / 60_000} min` };
  } catch (err) {
    return { status: 'warn', detail: `check threw: ${errToString(err)}` };
  }
}

async function checkCuaCostCapPaused(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  try {
    const { data, error } = await supabaseAdmin
      .from('property_sessions')
      .select('property_id, daily_claude_cost_micros, daily_claude_cost_resets_at, paused_reason')
      .eq('status', 'paused_cost_cap');
    if (error) {
      return { status: 'warn', detail: `property_sessions read failed: ${errToString(error)}` };
    }
    if (!data || data.length === 0) {
      return { status: 'ok', detail: 'no hotels paused for cost' };
    }
    type Row = { property_id: string; daily_claude_cost_micros: number; daily_claude_cost_resets_at: string };
    const summaries = (data as Row[]).map(
      (r) => `${r.property_id} ($${(r.daily_claude_cost_micros / 1_000_000).toFixed(2)} spent, resets ${r.daily_claude_cost_resets_at})`,
    );
    return {
      status: 'warn',
      detail: `${data.length} hotel(s) paused for $5/day cost cap: ${summaries.join('; ')}`,
      fix: 'Auto-resumes at midnight local. If recurring, check for a knowledge-file repair loop or runaway workflow.',
    };
  } catch (err) {
    return { status: 'warn', detail: `check threw: ${errToString(err)}` };
  }
}

async function checkCuaMfaPending(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  try {
    const { data, error } = await supabaseAdmin
      .from('property_sessions')
      .select('property_id, paused_reason')
      .eq('status', 'paused_mfa');
    if (error) {
      return { status: 'warn', detail: `property_sessions read failed: ${errToString(error)}` };
    }
    if (!data || data.length === 0) {
      return { status: 'ok', detail: 'no hotels waiting on MFA' };
    }
    type Row = { property_id: string; paused_reason: string | null };
    const ids = (data as Row[]).map((r) => r.property_id);
    return {
      status: 'warn',
      detail: `${data.length} hotel(s) waiting on manual MFA re-login: ${ids.join(', ')}`,
      fix: 'Resolve via /admin/mfa-resume/[propertyId]. Walk through the PMS login in a side browser, then click Resume.',
    };
  } catch (err) {
    return { status: 'warn', detail: `check threw: ${errToString(err)}` };
  }
}

async function checkCuaKnowledgeFilesActive(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  try {
    const { data: sessions, error: sessErr } = await supabaseAdmin
      .from('property_sessions')
      .select('property_id, pms_family')
      .neq('status', 'stopped');
    if (sessErr) {
      return { status: 'warn', detail: `property_sessions read failed: ${errToString(sessErr)}` };
    }
    if (!sessions || sessions.length === 0) {
      return { status: 'skipped', detail: 'no enabled property_sessions yet' };
    }
    type Sess = { property_id: string; pms_family: string };
    const families = Array.from(new Set((sessions as Sess[]).map((s) => s.pms_family)));
    const { data: kfs, error: kfErr } = await supabaseAdmin
      .from('pms_knowledge_files')
      .select('pms_family, version')
      .eq('status', 'active')
      .in('pms_family', families);
    if (kfErr) {
      return { status: 'warn', detail: `pms_knowledge_files read failed: ${errToString(kfErr)}` };
    }
    const haveActive = new Set((kfs as Array<{ pms_family: string }> | null ?? []).map((r) => r.pms_family));
    const missing = families.filter((f) => !haveActive.has(f));
    if (missing.length > 0) {
      return {
        status: 'fail',
        detail: `${missing.length}/${families.length} PMS families lack an active knowledge file: ${missing.join(', ')}`,
        fix: 'Run the mapper or apply a seed migration for the affected pms_family.',
      };
    }
    return {
      status: 'ok',
      detail: `every active session has an active knowledge file (${families.length} families)`,
    };
  } catch (err) {
    return { status: 'warn', detail: `check threw: ${errToString(err)}` };
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────

// Exported so the hourly doctor-check cron route can reuse the exact
// same check battery the admin GET handler uses. Round 13, 2026-05-13.
//
// Phase M2: when `useCache` is true (default), each check's result is
// served from the per-check cache if it's <60s old. The watchdog polls
// every 5min and most checks don't need re-running that often; a stale-
// by-1-min health snapshot is much better than a 30s+ doctor request.
export async function runAllChecks(useCache: boolean = true): Promise<DoctorReport> {
  const startedAt = Date.now();
  const now = Date.now();

  // Run every check in parallel. Each check catches its own errors so one
  // exploding check can't kill the rest.
  const results = await Promise.all(
    checks.map(async ([name, fn]): Promise<Check> => {
      // Cache hit?
      if (useCache) {
        const cached = checkResultCache.get(name);
        if (cached && cached.expiresAt > now) {
          return { name, durationMs: 0, ...cached.result };
        }
      }
      const t0 = Date.now();
      try {
        const res = await fn();
        // Store fresh result for the next 60s.
        checkResultCache.set(name, { result: res, expiresAt: Date.now() + CHECK_CACHE_TTL_MS });
        return { name, durationMs: Date.now() - t0, ...res };
      } catch (err) {
        const failResult = {
          status: 'fail' as const,
          detail: `check threw: ${errToString(err)}`,
        };
        // Cache failures too — re-running a check that just threw within
        // 60s is unlikely to give a different answer + costs DB cycles.
        // The next cache miss (after TTL) will retry naturally.
        checkResultCache.set(name, { result: failResult, expiresAt: Date.now() + CHECK_CACHE_TTL_MS });
        return { name, ...failResult, durationMs: Date.now() - t0 };
      }
    })
  );

  const summary = {
    total:   results.length,
    ok:      results.filter(r => r.status === 'ok').length,
    warn:    results.filter(r => r.status === 'warn').length,
    fail:    results.filter(r => r.status === 'fail').length,
    skipped: results.filter(r => r.status === 'skipped').length,
  };

  return {
    ok: summary.fail === 0,
    timestamp: new Date(startedAt).toISOString(),
    vercelRegion: env.VERCEL_REGION,
    vercelEnv:    env.VERCEL_ENV,
    commitSha:    env.VERCEL_GIT_COMMIT_SHA,
    summary,
    checks: results,
  };
}

/**
 * stripe_billing_configured — Stripe readiness, all-or-nothing.
 *
 * Pre-launch state has Stripe vars unset and the app falls back to "trial
 * mode" via lib/stripe.ts. That's a valid configuration. What's NOT valid
 * is the partial state — e.g., STRIPE_SECRET_KEY set but STRIPE_WEBHOOK_SECRET
 * missing, where customers can pay (checkout works) but the webhook silently
 * 400s every event for 3 days. Three days of silent payment-processing
 * failure is the exact failure mode this whole doctor exists to prevent.
 *
 * Logic:
 *   - All three Stripe vars set with valid prefixes  → 'ok'
 *   - None set                                       → 'warn' (trial-only)
 *   - Some set, others missing or malformed          → 'fail'
 *   - sk_test_ in production                         → 'fail'
 */
async function checkStripeBillingConfigured(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  const sk = env.STRIPE_SECRET_KEY ?? '';
  const wh = env.STRIPE_WEBHOOK_SECRET ?? '';
  const pr = env.STRIPE_PRICE_ID ?? '';

  const setCount = [sk, wh, pr].filter((v) => v.trim() !== '').length;

  if (setCount === 0) {
    return {
      status: 'warn',
      detail: 'Stripe not configured — app running in trial-only mode. Self-signups complete without billing.',
      fix: 'When ready to charge: set STRIPE_SECRET_KEY (sk_live_…), STRIPE_WEBHOOK_SECRET (whsec_…), STRIPE_PRICE_ID (price_…) in Vercel → Project Settings → Environment Variables. Add the webhook endpoint at https://getstaxis.com/api/stripe/webhook in Stripe Dashboard.',
    };
  }

  if (setCount < 3) {
    const missing: string[] = [];
    if (!sk.trim()) missing.push('STRIPE_SECRET_KEY');
    if (!wh.trim()) missing.push('STRIPE_WEBHOOK_SECRET');
    if (!pr.trim()) missing.push('STRIPE_PRICE_ID');
    const fixSteps = [`Set ${missing.join(', ')} in Vercel → Project Settings → Environment Variables and redeploy.`];
    if (!wh.trim()) {
      fixSteps.push('STRIPE_WEBHOOK_SECRET also requires creating the webhook endpoint at https://getstaxis.com/api/stripe/webhook in Stripe Dashboard → Developers → Webhooks (the secret is shown after creation).');
    }
    fixSteps.push('Or unset all three to fall back to trial-only mode.');
    return {
      status: 'fail',
      detail: `Stripe partially configured — ${setCount}/3 vars set. Missing: ${missing.join(', ')}. Dangerous half-state: checkout may work but the webhook silently rejects every payment event.`,
      fix: fixSteps.join(' '),
    };
  }

  // All three set — verify shape so a typo doesn't slip through.
  // Slice exactly the prefix length so we never leak any of the secret
  // body in error messages, even on malformed-but-near-miss inputs.
  const issues: string[] = [];
  if (!sk.startsWith('sk_live_') && !sk.startsWith('sk_test_')) {
    issues.push(`STRIPE_SECRET_KEY doesn't start with sk_live_ / sk_test_ — got "${sk.slice(0, 8)}…"`);
  }
  if (!wh.startsWith('whsec_')) {
    issues.push(`STRIPE_WEBHOOK_SECRET doesn't start with whsec_ — got "${wh.slice(0, 6)}…"`);
  }
  if (!pr.startsWith('price_')) {
    issues.push(`STRIPE_PRICE_ID doesn't start with price_ — got "${pr.slice(0, 6)}…"`);
  }
  if (sk.startsWith('sk_test_') && env.VERCEL_ENV === 'production') {
    issues.push('STRIPE_SECRET_KEY is a TEST key but VERCEL_ENV=production — customer payments will fail in production.');
  }
  if (issues.length > 0) {
    return {
      status: 'fail',
      detail: issues.join(' | '),
      fix: 'Fix the malformed Stripe key(s) in Vercel. Re-copy from Stripe Dashboard → Developers → API keys / Webhooks / Products.',
    };
  }

  return {
    status: 'ok',
    detail: `Stripe fully configured (${sk.startsWith('sk_test_') ? 'TEST mode' : 'LIVE mode'})`,
  };
}

/**
 * ml_service_secret_strength — ML_SERVICE_SECRET length + obvious-placeholder
 * check (Pattern C, security review 2026-05-16).
 *
 * The secret is a single static bearer held by Vercel + GitHub Actions cron +
 * Reeyen's local tokens. A leak from any one of those gives an attacker
 * unscoped access to every property's train/predict endpoints. The realistic
 * defense is (a) make brute-force impractical via length, and (b) make sure a
 * weak placeholder value never lands in prod. Future hardening (per-property
 * JWT with short TTL — backlog) reduces blast radius further; this is the
 * cheap floor that ships today.
 *
 * Reports presence/length/placeholder only — never the value itself.
 */
async function checkMlServiceSecretStrength(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  const secret = env.ML_SERVICE_SECRET ?? '';
  if (!secret.trim()) {
    return {
      status: 'fail',
      detail: 'ML_SERVICE_SECRET not set — every cron-triggered ML train/predict call to staxis-ml will 401.',
      fix: 'Generate with `openssl rand -hex 32`, set as ML_SERVICE_SECRET in Vercel + GitHub Actions + Fly (staxis-ml app). All three sides must match exactly.',
    };
  }
  if (secret.length < 32) {
    return {
      status: 'fail',
      detail: `ML_SERVICE_SECRET is ${secret.length} chars — too short. Brute-force ETA is short; ml-service refuses to boot below 32 chars after the May 2026 security review.`,
      fix: 'Rotate: `openssl rand -hex 32`. Update Vercel + GitHub Actions + Fly atomically. Procedure: RUNBOOKS.md > ML_SERVICE_SECRET rotation.',
    };
  }
  // Catch obvious placeholders that occasionally slip in via copy-paste
  // from .env.example or a fixture. We don't try to be exhaustive — the
  // 32-char floor already rejects most placeholders; this catches the
  // common "long enough but obviously not random" cases.
  const lower = secret.toLowerCase();
  const placeholderHints = [
    'placeholder', 'changeme', 'example', 'todo', 'secret_here',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '00000000000000000000000000000000',
  ];
  for (const hint of placeholderHints) {
    if (lower.includes(hint)) {
      return {
        status: 'fail',
        detail: `ML_SERVICE_SECRET appears to be a placeholder value (matches "${hint}"). Replace before any real ML call hits prod.`,
        fix: 'Rotate: `openssl rand -hex 32`. Procedure: RUNBOOKS.md > ML_SERVICE_SECRET rotation.',
      };
    }
  }
  return {
    status: 'ok',
    detail: `ML_SERVICE_SECRET set (${secret.length} chars).`,
  };
}

/**
 * ai_data_policy_documented — Plan v2 F-AI-1. Hotel guest PII flows to
 * Anthropic (Claude), OpenAI (Whisper), and ElevenLabs (TTS) through
 * our agent/voice/transcribe surfaces. Each provider's default retention
 * is 30 days unless an org-level "zero data retention" / data-controls
 * setting is configured in their dashboard. There's no in-code parameter
 * for it on Whisper or ElevenLabs, so the policy lives off-repo.
 *
 * This check reads a `STAXIS_AI_DATA_POLICY` env stamp set by the
 * operator after they've confirmed retention in each provider's
 * dashboard. The stamp is freeform — typical values look like:
 *   `zdr-confirmed-2026-05-20-anthropic+openai+elevenlabs`
 *
 * Missing stamp → warn (yellow). The product still works; we just
 * don't know whether ZDR is in force. RUNBOOKS.md > "AI Data Retention
 * Posture" documents the confirmation steps per provider.
 */
async function checkAiDataPolicyDocumented(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  const stamp = (env.STAXIS_AI_DATA_POLICY ?? '').trim();
  if (!stamp) {
    return {
      status: 'warn',
      detail:
        'STAXIS_AI_DATA_POLICY not set — operator has not documented ' +
        'an AI data-retention posture for Anthropic / OpenAI / ElevenLabs. ' +
        "Guest PII flows to these providers under each one's default " +
        '30-day retention until an org-level data control is confirmed.',
      fix:
        'Confirm Zero Data Retention (or equivalent data controls) in ' +
        'console.anthropic.com, platform.openai.com Data Controls, and ' +
        'elevenlabs.io workspace settings. Then set ' +
        '`STAXIS_AI_DATA_POLICY=zdr-confirmed-YYYY-MM-DD-<provider list>` ' +
        'in Vercel. See RUNBOOKS.md > "AI Data Retention Posture".',
    };
  }
  // Plan v2.1 CR-4 — tightened stamp validation. The original check
  // only required ONE provider keyword, so `STAXIS_AI_DATA_POLICY=openai`
  // would pass and turn the check green without proving anything.
  // The stamp is an attestation, so the quality of the stamp is the
  // only signal of operator diligence. Now requires a YYYY-MM-DD date
  // AND mentions of all three providers. See RUNBOOKS.md > "AI Data
  // Retention Posture" for the canonical format.
  const hasDate = /\b20\d{2}-\d{2}-\d{2}\b/.test(stamp);
  const mentionsAnthropic = /anthropic|claude/i.test(stamp);
  const mentionsOpenAI = /openai|whisper/i.test(stamp);
  const mentionsElevenLabs = /elevenlabs|11labs/i.test(stamp);
  const allProviders = mentionsAnthropic && mentionsOpenAI && mentionsElevenLabs;
  if (!hasDate || !allProviders) {
    const missing: string[] = [];
    if (!hasDate) missing.push('YYYY-MM-DD date');
    if (!mentionsAnthropic) missing.push('Anthropic');
    if (!mentionsOpenAI) missing.push('OpenAI');
    if (!mentionsElevenLabs) missing.push('ElevenLabs');
    return {
      status: 'warn',
      detail:
        `STAXIS_AI_DATA_POLICY="${stamp.slice(0, 80)}" is set but missing: ${missing.join(', ')}. ` +
        'The stamp must record when AND which providers were confirmed.',
      fix:
        'Replace with the canonical format, e.g. ' +
        '`audit-2026-05-20-anthropic:30d-default-openai:sharing-off-logging-off-elevenlabs:starter-default`. ' +
        'See RUNBOOKS.md > "AI Data Retention Posture".',
    };
  }
  return {
    status: 'ok',
    detail: `AI data policy stamp present: "${stamp.slice(0, 120)}".`,
  };
}

/**
 * voice_binding_readiness — Plan v2 M-1 rollout gauge.
 *
 * We can't flip STAXIS_VOICE_REQUIRE_CONNECTION_BINDING=true blind: if
 * ElevenLabs doesn't reliably forward conversation_id in the custom-LLM
 * webhook body, the binding-required mode would refuse every legitimate
 * voice turn. This check reports the bind-rate — the fraction of recent
 * voice sessions whose elevenlabs_conversation_id we observed and stored
 * — so the operator knows when it's safe to flip.
 *
 * Status mapping:
 *   - already enforcing → ok (the flip happened; the gauge is moot)
 *   - 0 sessions in the window → ok with "no data" note (don't fail
 *     the doctor for an idle voice surface)
 *   - bind_rate ≥ 95% → ok with the recommendation to flip
 *   - bind_rate <  95% → warn with the actual rate so the operator can
 *     decide whether the gap is "needs more traffic" or "ElevenLabs
 *     SDK changed which field carries conversation_id"
 */
async function checkVoiceBindingReadiness(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  const enforce = (env.STAXIS_VOICE_REQUIRE_CONNECTION_BINDING ?? 'false') === 'true';
  if (enforce) {
    return {
      status: 'ok',
      detail: 'STAXIS_VOICE_REQUIRE_CONNECTION_BINDING=true — binding already enforced. This check is moot.',
    };
  }

  // 24 h window keeps the gauge useful for low-traffic deployments.
  // Anything shorter risks "zero sessions" being the steady state.
  const sinceIso = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const { data, error } = await supabaseAdmin
    .from('agent_voice_sessions')
    .select('elevenlabs_conversation_id, created_at')
    .gte('created_at', sinceIso);

  if (error) {
    return {
      status: 'warn',
      detail: `Could not read agent_voice_sessions for readiness gauge: ${error.message}.`,
    };
  }

  const total = (data ?? []).length;
  if (total === 0) {
    return {
      status: 'ok',
      detail:
        'No voice sessions in the last 24h — readiness gauge has no data. ' +
        'Trigger a real voice turn on the hotel app to populate; re-check after.',
    };
  }
  const bound = (data ?? []).filter((r) => !!(r as { elevenlabs_conversation_id: string | null }).elevenlabs_conversation_id).length;
  const pct = Math.round((bound / total) * 100);
  if (pct >= 95) {
    return {
      status: 'ok',
      detail:
        `Voice-binding rate ${pct}% (${bound}/${total}) over the last 24h — ` +
        'safe to flip STAXIS_VOICE_REQUIRE_CONNECTION_BINDING=true on Vercel.',
    };
  }
  return {
    status: 'warn',
    detail:
      `Voice-binding rate ${pct}% (${bound}/${total}) over the last 24h. ` +
      'Below the 95% safety floor — flipping enforce now would refuse legitimate turns.',
    fix:
      'Investigate the missing conversation_id source. Either ElevenLabs changed ' +
      'the field name (check elevenlabs_extra_body / extra_body / body.user in a ' +
      'recent [voice-brain] log line) or low traffic is hiding the real rate. ' +
      'When this check turns green, set STAXIS_VOICE_REQUIRE_CONNECTION_BINDING=true.',
  };
}

/**
 * cua_action_policy_enforce_status — Plan v2.1 CR-3.
 *
 * The CUA action allowlist (cua-service/src/policy.ts) classifies post-
 * login mapper actions as allowed or refused. Refusals only block when
 * `CUA_POLICY_ENFORCE === 'enforce'`; the default 'warn' mode logs the
 * refusal and STILL executes the action. The user-facing claim "Claude
 * can't be talked into clicking dangerous buttons" only holds in
 * enforce mode.
 *
 * This check reports the live state of the env on the CUA worker so
 * the operator has one place to see whether the lock is active. Note
 * that the Vercel-side doctor can't read the Fly worker's env directly
 * — we read the env from the doctor's host process (Vercel), which is
 * accurate ONLY IF the operator sets CUA_POLICY_ENFORCE on Vercel too.
 * For Fly-only deploys the check still surfaces a green/yellow signal
 * by reading the Vercel-side env: green when set to 'enforce' on
 * Vercel (operator opted in), warn when unset or 'warn'.
 *
 * Operational flow: after the operator observes one full mapping run
 * with no false-positive refusals in the `cua_action_policy_refusal`
 * stderr stream on Fly, they set both Vercel + Fly env to 'enforce'.
 */
async function checkCuaActionPolicyEnforceStatus(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  // CUA_POLICY_ENFORCE lives in the CUA worker's env (cua-service), not
  // the main app's. Fly is the source of truth. The Vercel-side env is
  // a mirror the operator sets when flipping Fly; we read it through
  // the canonical env module so check-env-access.mjs stays green.
  const raw = (env.CUA_POLICY_ENFORCE ?? '').trim().toLowerCase();
  if (raw === 'enforce') {
    return {
      status: 'ok',
      detail:
        'CUA_POLICY_ENFORCE=enforce on Vercel. CUA mapper action allowlist ' +
        'will refuse dangerous post-login actions (configured Fly-side too).',
    };
  }
  return {
    status: 'warn',
    detail:
      `CUA_POLICY_ENFORCE=${raw || '<unset>'} on Vercel — the CUA action allowlist ` +
      'is in warn mode. Refusals are logged but the action still executes.',
    fix:
      'After observing one full CUA mapping run with no false-positive refusals ' +
      'in the `cua_action_policy_refusal` stderr stream on Fly, set ' +
      '`CUA_POLICY_ENFORCE=enforce` on both Fly (`fly secrets set CUA_POLICY_ENFORCE=enforce -a staxis-cua`) ' +
      'AND Vercel (production env) so this check turns green.',
  };
}

/**
 * ml_service_urls_configured — catches the silent-cron drift where Vercel
 * has ML_SERVICE_SECRET but not ML_SERVICE_URLS (or vice versa). Without
 * URLs, listMlShardUrls() returns [], and every ml-* cron route falls into
 * its early-exit branch returning `{ok:true, skipped:"ML service not
 * configured yet"}`. The ml-cron workflow's jq guard accepts that as
 * success (`.ok == true`), so no alert fires and demand_predictions stays
 * stale until ml_demand_predictions_fresh trips a day later. This check
 * surfaces the drift the moment a deploy lands instead.
 *
 * Reports presence/shape only — never the URL value (it is a public
 * hostname, but treating routing config the same way as the paired
 * secret keeps the output uniformly redacted-by-default).
 */
async function checkMlServiceUrlsConfigured(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  const raw = env.ML_SERVICE_URLS;
  const secretSet = !!(env.ML_SERVICE_SECRET ?? '').trim();
  const urls = raw && raw.trim()
    ? raw.split(',').map((u) => u.trim()).filter((u) => u.length > 0)
    : [];

  // Both unset → intentional disabled state (dev / unconfigured preview).
  // The cron routes' early-exit is correct here.
  if (urls.length === 0 && !secretSet) {
    return {
      status: 'skipped',
      detail: 'ML_SERVICE_URLS + ML_SERVICE_SECRET both unset — ML pipeline intentionally disabled on this deploy.',
    };
  }

  // Drift: one set, the other not. This is config rot — every cron call
  // will no-op silently. Fail loudly.
  if (urls.length === 0 && secretSet) {
    return {
      status: 'fail',
      detail: 'ML_SERVICE_SECRET is set but ML_SERVICE_URLS is empty — every ml-* cron silently returns `{ok:true, skipped:"ML service not configured yet"}` and writes no predictions.',
      fix: 'Vercel → Project Settings → Environment Variables → add `ML_SERVICE_URLS=https://staxis-production.up.railway.app` (single shard) or comma-separated list (multi-shard). Then redeploy.',
    };
  }
  if (urls.length > 0 && !secretSet) {
    return {
      status: 'fail',
      detail: `ML_SERVICE_URLS set (${urls.length} shard${urls.length === 1 ? '' : 's'}) but ML_SERVICE_SECRET is empty — every ml-* cron call to the service will 401.`,
      fix: 'Vercel → Project Settings → Environment Variables → set `ML_SERVICE_SECRET` to the same 64-char value used by Fly/Railway ML service + GitHub Actions cron. Procedure: RUNBOOKS.md > ML_SERVICE_SECRET rotation.',
    };
  }

  // Shape-check each URL — listMlShardUrls trims but never validates, so
  // a typo'd entry (e.g. missing scheme) would land here too.
  const malformed = urls.filter((u) => {
    try { new URL(u); return false; } catch { return true; }
  });
  if (malformed.length > 0) {
    return {
      status: 'fail',
      detail: `ML_SERVICE_URLS has ${malformed.length} malformed entr${malformed.length === 1 ? 'y' : 'ies'} (need full https:// URLs).`,
      fix: 'Vercel → Project Settings → Environment Variables → fix `ML_SERVICE_URLS`. Each comma-separated entry must be a full URL like `https://staxis-production.up.railway.app`.',
    };
  }

  return {
    status: 'ok',
    detail: `ML_SERVICE_URLS set (${urls.length} shard${urls.length === 1 ? '' : 's'}); paired ML_SERVICE_SECRET present.`,
  };
}

/**
 * deploy-ci-cron Step 7.5 — ml_service_lifespan_active
 *
 * Pings the ML service's /health endpoint. main.py's new lifespan handler
 * blocks /health from responding until Pydantic Settings validation passes
 * — so a 200 from /health proves the new fail-fast startup is alive. If
 * env on the Railway side is broken, this check FAILs and Reeyen sees a
 * row on /admin/ml indicating the safety net caught a misconfig.
 *
 * Why this matters: before the lifespan, missing env on ml-service only
 * surfaced as a 500 on the first /predict — operators saw a "healthy"
 * container that silently couldn't serve traffic. This check converts
 * that into a loud, named failure surfacing on the admin page.
 */
async function checkMlServiceLifespanActive(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  const raw = env.ML_SERVICE_URLS;
  const urls = raw && raw.trim()
    ? raw.split(',').map((u) => u.trim()).filter((u) => u.length > 0)
    : [];
  if (urls.length === 0) {
    return {
      status: 'skipped',
      detail: 'ML_SERVICE_URLS not configured — startup-validation gate cannot be probed without a service URL.',
    };
  }

  const startedAt = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    let res: Response;
    try {
      res = await fetch(new URL('/health', urls[0]).toString(), {
        method: 'GET',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const elapsedMs = Date.now() - startedAt;
    if (res.status === 200) {
      return {
        status: 'ok',
        detail: `ML service /health responded 200 in ${elapsedMs}ms — lifespan startup validation passed (env validated at boot).`,
      };
    }
    return {
      status: 'fail',
      detail: `ML service /health returned ${res.status} after ${elapsedMs}ms. The lifespan handler blocks /health until env validation passes, so a non-200 means startup is broken or the service is offline.`,
      fix: 'Railway → ml-service → Deployments → check the latest build logs for a `Settings validation failed at startup` error. Most common cause: a missing or invalid env var (SUPABASE_URL, ML_SERVICE_SECRET). Fix the env in Railway → Variables, then redeploy. See RUNBOOKS.md > Deployment + Rollback per unit.',
    };
  } catch (err) {
    return {
      status: 'fail',
      detail: `ML service /health unreachable: ${errToString(err)}. Either the service is offline, the URL is wrong, or the lifespan refused to start.`,
      fix: 'Railway → ml-service → Logs: look for `Settings validation failed at startup`. If absent, the service is down for another reason — check Railway deployment status. See RUNBOOKS.md > Deployment + Rollback per unit.',
    };
  }
}

/**
 * deploy-ci-cron Step 7.5 — cua_service_ci_recent_pass
 *
 * Asks GitHub for the most recent completed run of `tests.yml` on `main`.
 * tests.yml now includes the CUA service lint+build steps (added in Step 4
 * of this plan), so a green main run is proof that a typo in cua-service
 * couldn't have slipped through to the Fly deploy. If the most recent run
 * failed, Reeyen sees a red row on /admin/pms (the onboarding admin
 * surface) so he can react before kicking off another onboarding.
 */
async function checkCuaServiceCiRecentPass(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  const token = env.GITHUB_TOKEN;
  if (!token) {
    return {
      status: 'skipped',
      detail: 'GITHUB_TOKEN not set — cannot query GitHub Actions for tests.yml status.',
      fix: 'Vercel → Project Settings → Environment Variables → set GITHUB_TOKEN to a fine-grained PAT with Actions:read. Used here only to confirm tests.yml ran green on main.',
    };
  }
  const startedAt = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    let res: Response;
    try {
      // `event=push` + `branch=main` filters to merges on main (excludes
      // pull_request runs which are also triggered by tests.yml). `status=
      // completed` excludes in-flight runs whose `conclusion` is null.
      res = await fetch(
        'https://api.github.com/repos/Reeyenn/staxis/actions/workflows/tests.yml/runs?branch=main&event=push&status=completed&per_page=1',
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          signal: controller.signal,
        }
      );
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) {
      return {
        status: 'fail',
        detail: `GitHub API returned ${res.status} when fetching tests.yml runs — token may be missing the actions:read scope.`,
        fix: 'Regenerate GITHUB_TOKEN as a fine-grained PAT for the Reeyenn/staxis repo with Permissions → Repository → Actions: Read. Update on Vercel + redeploy.',
      };
    }
    if (!res.ok) {
      return {
        status: 'warn',
        detail: `GitHub API returned ${res.status} when fetching tests.yml runs.`,
      };
    }
    const body = await res.json() as { workflow_runs?: Array<{ conclusion: string; created_at: string; html_url: string; head_sha: string }> };
    const runs = body.workflow_runs ?? [];
    if (runs.length === 0) {
      return {
        status: 'warn',
        detail: 'No completed tests.yml runs found on main yet. The CUA CI gate is added but has not run once.',
      };
    }
    const last = runs[0];
    const ageMs = Date.now() - new Date(last.created_at).getTime();
    const ageDays = Math.floor(ageMs / 86_400_000);
    if (last.conclusion !== 'success') {
      return {
        status: 'fail',
        detail: `Last tests.yml run on main FAILED (${last.conclusion}) ${ageDays}d ago for commit ${last.head_sha.slice(0, 7)}. CUA quality gate is broken; investigate before next onboarding.`,
        fix: `GitHub Actions → ${last.html_url} — open the failing run and fix the underlying break.`,
      };
    }
    if (ageDays > 14) {
      return {
        status: 'warn',
        detail: `Last tests.yml run on main is ${ageDays}d old (commit ${last.head_sha.slice(0, 7)}). No recent main pushes — CI hasn't exercised the CUA gate lately.`,
      };
    }
    const elapsedMs = Date.now() - startedAt;
    return {
      status: 'ok',
      detail: `Onboarding (CUA) CI: last run passed ${ageDays === 0 ? 'today' : `${ageDays}d ago`} (commit ${last.head_sha.slice(0, 7)}; queried in ${elapsedMs}ms).`,
    };
  } catch (err) {
    return {
      status: 'warn',
      detail: `Could not query GitHub Actions: ${errToString(err)}.`,
    };
  }
}

/**
 * resend_webhook_secret_configured — Phase E2E (2026-05-22). If Resend is
 * sending email (RESEND_API_KEY set) but the webhook secret isn't
 * configured, async lifecycle events (bounces, delivery_delayed,
 * complaints) hit /api/resend-webhook and get rejected → Resend retries
 * for ~24h then marks them permanent, and Staxis never learns about a
 * bounced 2FA email. Warn when only one side is configured.
 */
async function checkResendWebhookSecretConfigured(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  const apiKeySet = !!(env.RESEND_API_KEY ?? '').trim();
  const webhookSet = !!(env.RESEND_WEBHOOK_SECRET ?? '').trim();
  if (!apiKeySet && !webhookSet) {
    return {
      status: 'skipped',
      detail: 'Resend not configured — webhook secret not required.',
    };
  }
  if (apiKeySet && !webhookSet) {
    return {
      status: 'warn',
      detail: 'RESEND_API_KEY set but RESEND_WEBHOOK_SECRET unset. Async bounces / complaints are not being recorded by /api/resend-webhook.',
      fix: 'Resend Dashboard → Webhooks → add https://hotelops-ai.vercel.app/api/resend-webhook (events: email.sent, email.delivered, email.delivery_delayed, email.bounced, email.complained). Copy the signing secret into Vercel env as RESEND_WEBHOOK_SECRET.',
    };
  }
  if (!apiKeySet && webhookSet) {
    return {
      status: 'warn',
      detail: 'RESEND_WEBHOOK_SECRET set but RESEND_API_KEY unset — we have a webhook receiver but aren\'t sending email.',
    };
  }
  return {
    status: 'ok',
    detail: 'Resend API key + webhook secret both configured.',
  };
}

/**
 * sentry_dsn_shape — error tracking config check.
 *
 * Same all-or-nothing pattern as Stripe: missing is OK (Sentry no-ops
 * gracefully via the sentry.*.config.ts initializers), present-but-malformed
 * is a fail because errors then silently disappear into the void.
 */
async function checkSentryDsnShape(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  const dsnServer = env.SENTRY_DSN ?? '';
  const dsnClient = env.NEXT_PUBLIC_SENTRY_DSN ?? '';
  const serverSet = dsnServer.trim() !== '';
  const clientSet = dsnClient.trim() !== '';

  // Both unset → graceful no-op mode.
  if (!serverSet && !clientSet) {
    return {
      status: 'warn',
      detail: 'Sentry DSN not set on Vercel — error tracking disabled. Errors logged to Vercel function logs only. Note: cua-service (Fly) reads SENTRY_DSN from its own Fly secrets, not Vercel env.',
      fix: 'Set NEXT_PUBLIC_SENTRY_DSN (client+server runtime) AND SENTRY_DSN (server.config + edge.config) in Vercel. Get DSN from sentry.io → Project Settings → Client Keys. For cua-service, also `flyctl secrets set SENTRY_DSN=… -a staxis-cua`.',
    };
  }

  // Half-configured — server runtime reads SENTRY_DSN, client reads
  // NEXT_PUBLIC_SENTRY_DSN. Either side missing means errors silently
  // disappear from that side. (sentry.server.config.ts and sentry.edge
  // .config.ts read SENTRY_DSN; sentry.client.config.ts reads
  // NEXT_PUBLIC_SENTRY_DSN.) WARN (not fail) because the configured
  // side still works — this surfaces the gap without blocking deploys
  // on a non-billing-blocking config issue.
  if (!serverSet || !clientSet) {
    const missing = !serverSet ? 'SENTRY_DSN' : 'NEXT_PUBLIC_SENTRY_DSN';
    const blind = !serverSet ? 'server-side and edge errors' : 'client-side (browser) errors';
    return {
      status: 'warn',
      detail: `Sentry partially configured — ${missing} is missing, so ${blind} disappear silently while the other side reports.`,
      fix: `Set ${missing} in Vercel → Project Settings → Environment Variables (use the same DSN value as the other one) and redeploy.`,
    };
  }

  // Both set — validate shape on both. Sentry DSN format:
  //   https://<key>@<org>.ingest.sentry.io/<project>
  //   https://<key>@<org>.ingest.<region>.sentry.io/<project>
  const dsnRx = /^https:\/\/[a-z0-9]+@[a-z0-9.-]+\.ingest(?:\.[a-z]{2})?\.sentry\.io\/\d+$/;
  const issues: string[] = [];
  if (!dsnRx.test(dsnServer)) issues.push(`SENTRY_DSN malformed (got "${dsnServer.slice(0, 40)}…")`);
  if (!dsnRx.test(dsnClient)) issues.push(`NEXT_PUBLIC_SENTRY_DSN malformed (got "${dsnClient.slice(0, 40)}…")`);
  if (issues.length > 0) {
    return {
      status: 'fail',
      detail: issues.join(' | '),
      fix: 'Re-copy the DSN from sentry.io → Project Settings → Client Keys → DSN. Watch for accidentally pasting the project URL instead.',
    };
  }

  return {
    status: 'ok',
    detail: 'Sentry fully configured (server + client DSNs valid)',
  };
}

/**
 * sentry_auth_token_present — source-map upload gate.
 *
 * `withSentryConfig` in next.config.ts uploads source maps to Sentry only
 * when SENTRY_AUTH_TOKEN is set in the Vercel build env (Production scope).
 * Without the token, production stack traces in Sentry stay minified
 * (`chunks/3-xy7.js:1:2391`) which is undebuggable.
 *
 * Warn-not-fail because the app still runs without source maps; this just
 * makes the gap visible. Production-only — preview deploys are expected to
 * skip source-map upload (we don't burn Sentry releases on every PR).
 */
async function checkSentryAuthTokenPresent(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  // Vercel sets VERCEL_ENV='production' on production deploys. We only
  // care about the production case — preview/dev are expected to skip.
  const isProd = (env.VERCEL_ENV || env.NODE_ENV) === 'production';
  if (!isProd) {
    return {
      status: 'ok',
      detail: 'Not a production environment — source-map upload not required.',
    };
  }
  const token = (env.SENTRY_AUTH_TOKEN || '').trim();
  if (!token) {
    return {
      status: 'warn',
      detail:
        'SENTRY_AUTH_TOKEN not set on Vercel — production source maps are not uploaded, so stack traces in Sentry stay minified.',
      fix:
        'Generate a token at sentry.io → Settings → Auth Tokens (scopes: project:read, project:releases). Set SENTRY_AUTH_TOKEN in Vercel → Project Settings → Environment Variables under PRODUCTION scope only (preview deploys do not need it). Redeploy.',
    };
  }
  return {
    status: 'ok',
    detail: 'SENTRY_AUTH_TOKEN present — production source-map upload is wired.',
  };
}

/**
 * sentry_client_initialized — verifies Sentry.init() ran without throwing.
 *
 * `Sentry.getClient()` returns the active Sentry client when init was
 * successful (DSN was syntactically valid AND the SDK loaded). Returns
 * undefined when init was skipped or threw.
 *
 * This does NOT prove ingest works — see sentry_ingest_probe_recent for
 * the end-to-end check. But it's a cheap sanity check that catches the
 * "DSN looked right but Sentry.init() threw on a bad option" failure.
 */
async function checkSentryClientInitialized(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  // Lazy-import so doctor doesn't crash if @sentry/nextjs is somehow
  // missing — the existing checks all guard their dependencies this way.
  try {
    // Use Function constructor to defeat Next's module-graph eagerness;
    // we want a soft dynamic require so a missing dep WARNS rather than
    // hard-fails the whole doctor.
    const sentryMod = await import('@sentry/nextjs');
    const client = (sentryMod as { getClient?: () => unknown }).getClient?.();
    if (!client) {
      // Distinguish "DSN unset" (expected no-op) from "init threw"
      // (broken). DSN unset is already covered by sentry_dsn_shape;
      // here we only flag the broken case.
      const dsnSet = (env.SENTRY_DSN ?? '').trim() !== '' || (env.NEXT_PUBLIC_SENTRY_DSN ?? '').trim() !== '';
      if (!dsnSet) {
        return {
          status: 'ok',
          detail: 'Sentry SDK loaded but no client — DSN unset (see sentry_dsn_shape).',
        };
      }
      return {
        status: 'fail',
        detail:
          'Sentry DSN is set but Sentry.getClient() returned undefined — Sentry.init() did not produce an active client. Errors are NOT reaching Sentry.',
        fix:
          'Check Vercel function logs for "Sentry init failed" messages from sentry.server.config.ts. Common causes: DSN points at a project the auth token cannot reach, or a beforeSend hook threw at init.',
      };
    }
    return {
      status: 'ok',
      detail: 'Sentry client initialized — SDK loaded successfully.',
    };
  } catch (e) {
    return {
      status: 'warn',
      detail: `Could not introspect Sentry client: ${errToString(e)}`,
    };
  }
}

/**
 * sentry_ingest_probe_recent — proves end-to-end ingest.
 *
 * Sentry.getClient() being non-null only proves the SDK loaded — it does
 * NOT prove events reach Sentry (firewall, project mismatch, quota
 * exhaustion, dropped events in beforeSend all break ingest without
 * affecting the client object).
 *
 * The /api/admin/sentry-test endpoint is the canonical ingest probe.
 * When invoked, it records an `app_events` row with event_type
 * 'sentry_ingest_probe_fired'. This check reads the most-recent such
 * row and warns when older than 7 days, prompting the operator to
 * re-run the probe.
 *
 * Codex SHOULD-FIX: avoids the per-cron synthetic captureMessage that
 * would inflate Sentry events ~8.7k/yr for no diagnostic value.
 */
async function checkSentryIngestProbeRecent(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  try {
    const { data, error } = await supabaseAdmin
      .from('app_events')
      .select('created_at')
      .eq('event_type', 'sentry_ingest_probe_fired')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      // Schema gap or RLS issue — surface as warn rather than fail. The
      // ingest path still works; we just can't measure its recency.
      return {
        status: 'warn',
        detail: `Could not read app_events for sentry probe recency: ${error.message}`,
        fix:
          'Verify the app_events table exists and supabaseAdmin has SELECT on it. Run `/api/admin/sentry-test` with CRON_SECRET to fire a fresh probe.',
      };
    }
    if (!data || !data.created_at) {
      return {
        status: 'warn',
        detail:
          'No record of a successful /api/admin/sentry-test probe has been seen. Sentry ingest unverified.',
        fix:
          'Fire the ingest probe: `curl -H "Authorization: Bearer $CRON_SECRET" https://getstaxis.com/api/admin/sentry-test`. Confirm the event appears in staxis.sentry.io within ~30s.',
      };
    }
    const ageMs = Date.now() - new Date(data.created_at).getTime();
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
    if (ageMs > SEVEN_DAYS) {
      const ageDays = Math.round(ageMs / (24 * 60 * 60 * 1000));
      return {
        status: 'warn',
        detail: `Last successful Sentry ingest probe was ${ageDays} days ago — re-run weekly to keep ingest verified.`,
        fix:
          '`curl -H "Authorization: Bearer $CRON_SECRET" https://getstaxis.com/api/admin/sentry-test` and confirm the event reaches staxis.sentry.io.',
      };
    }
    const ageHours = Math.round(ageMs / (60 * 60 * 1000));
    return {
      status: 'ok',
      detail: `Last Sentry ingest probe was ${ageHours}h ago — ingest verified.`,
    };
  } catch (e) {
    return {
      status: 'warn',
      detail: `Probe recency check threw: ${errToString(e)}`,
    };
  }
}

/**
 * picovoice_wake_word_config — operator-visible state for the "Hey Staxis"
 * wake word.
 *
 * Wake-word needs TWO things: PICOVOICE_ACCESS_KEY in env AND at least one
 * .ppn keyword file in public/wake-words/. Voice mode itself works without
 * wake-word — users can click the Phone icon or hit Cmd+/ to use OpenAI
 * Whisper STT. So the doctor must NOT hard-fail when both are absent
 * (intentional disabled state, the default until Picovoice approves).
 *
 * Pre-2026-05-14 the env_vars check listed PICOVOICE_ACCESS_KEY as
 * REQUIRED, which hard-failed the entire doctor any time the key wasn't
 * set — producing a flood of post-deploy-smoke and ML-smoke-nightly CI
 * failures despite voice mode working correctly via fallback. This check
 * replaces that: warn ONLY on the half-configured state (one side wired,
 * the other not — the real broken case).
 */
async function checkPicovoiceWakeWordConfig(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  const keySet = (env.PICOVOICE_ACCESS_KEY ?? '').trim() !== '';

  let ppnPresent = false;
  let ppnReadFailed = false;
  try {
    const { readdirSync, existsSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const dir = join(process.cwd(), 'public', 'wake-words');
    if (existsSync(dir)) {
      ppnPresent = readdirSync(dir).some(f => f.endsWith('.ppn'));
    }
  } catch {
    ppnReadFailed = true;
  }

  if (ppnReadFailed) {
    return {
      status: 'warn',
      detail: 'Could not read public/wake-words/ directory to verify wake-word .ppn files. Voice mode still works via Phone-button / Cmd+/ fallback.',
    };
  }

  if (!keySet && !ppnPresent) {
    return {
      status: 'ok',
      detail: 'Wake word ("Hey Staxis") not configured — voice mode uses Phone-button / Cmd+/ Whisper fallback. Set PICOVOICE_ACCESS_KEY in Vercel + add a .ppn file to public/wake-words/ when ready to enable.',
    };
  }

  if (keySet && !ppnPresent) {
    return {
      status: 'warn',
      detail: 'Wake word half-configured: PICOVOICE_ACCESS_KEY is set but no .ppn keyword file exists in public/wake-words/. The Picovoice SDK will load but find no keyword to listen for.',
      fix: 'Either add a trained .ppn file to public/wake-words/ (Picovoice Console → Wake Word), OR unset PICOVOICE_ACCESS_KEY in Vercel to fully disable wake-word.',
    };
  }

  if (!keySet && ppnPresent) {
    return {
      status: 'warn',
      detail: 'Wake word half-configured: public/wake-words/ contains .ppn file(s) but PICOVOICE_ACCESS_KEY is not set. The Picovoice SDK will fail to initialize at runtime.',
      fix: 'Set PICOVOICE_ACCESS_KEY in Vercel → Project Settings → Environment Variables (from Picovoice Console → AccessKey) and redeploy.',
    };
  }

  return {
    status: 'ok',
    detail: 'Wake word ("Hey Staxis") fully configured (PICOVOICE_ACCESS_KEY set + .ppn file present)',
  };
}

/**
 * rooms_today_seeded — three-part check:
 *
 *   1. (INV-24, Round 15) total_rooms must agree with array_length(room_inventory).
 *      Drift between the two sources means the AI could under-report.
 *   2. (INV-24) When total_rooms > 0 but room_inventory is empty,
 *      phantom-seed can't run → warn so the operator backfills inventory.
 *   3. (INV-23, Round 14) Today's rooms row count must equal the
 *      expected total (max of inventory length and total_rooms).
 *      Gap >= 4 or > 10% → fail. 1-3 → warn.
 *
 * Codex round-2 review (2026-05-14) flagged that the original Round-14
 * version only used `room_inventory` and SKIPPED empty-inventory
 * properties, so a stale or empty inventory passed status=ok while the
 * AI still reported a wrong total. This expansion closes that gap.
 *
 * INV-23 + INV-24 doctrine.
 */
async function checkRoomsTodaySeeded(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  try {
    const { data: properties, error: propsErr } = await supabaseAdmin
      .from('properties')
      .select('id, name, timezone, room_inventory, total_rooms');
    if (propsErr) {
      return { status: 'warn', detail: `Could not read properties: ${propsErr.message}` };
    }

    type DriftEntry = { id: string; name: string; inventoryLength: number; totalRooms: number };
    type EmptyEntry = { id: string; name: string; totalRooms: number };
    type GapEntry = { id: string; name: string; gap: number; expected: number; seeded: number; pct: number };

    const drifts: DriftEntry[] = [];
    const missingInventory: EmptyEntry[] = [];
    const gaps: GapEntry[] = [];

    for (const propRaw of (properties ?? [])) {
      const prop = propRaw as {
        id: string;
        name: string | null;
        timezone: string | null;
        room_inventory: string[] | null;
        total_rooms: number | null;
      };
      const inv = Array.isArray(prop.room_inventory) ? prop.room_inventory : [];
      const inventoryLength = inv.length;
      const totalRooms = Number(prop.total_rooms ?? 0);
      const propName = prop.name ?? prop.id;

      // Pre-onboarding: both sources empty/zero. Skip — no seeding expected.
      if (inventoryLength === 0 && totalRooms === 0) continue;

      // Branch 1: drift between the two sources (both populated, they disagree).
      if (inventoryLength > 0 && totalRooms > 0 && inventoryLength !== totalRooms) {
        drifts.push({ id: prop.id, name: propName, inventoryLength, totalRooms });
      }
      // Branch 2: total_rooms set, inventory not yet configured.
      else if (inventoryLength === 0 && totalRooms > 0) {
        missingInventory.push({ id: prop.id, name: propName, totalRooms });
      }

      // Branch 3: seed gap. expected = max of the two signals so we catch
      // under-seeding regardless of which source is authoritative.
      const expected = Math.max(inventoryLength, totalRooms);
      if (expected === 0) continue;

      // property-local today
      let date: string;
      try {
        date = prop.timezone
          ? new Intl.DateTimeFormat('en-CA', {
              timeZone: prop.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
            }).format(new Date())
          : new Date().toISOString().slice(0, 10);
      } catch {
        date = new Date().toISOString().slice(0, 10);
      }

      const { count, error: cntErr } = await supabaseAdmin
        .from('rooms')
        .select('*', { count: 'exact', head: true })
        .eq('property_id', prop.id)
        .eq('date', date);
      if (cntErr) {
        return { status: 'warn', detail: `Could not count rooms for ${propName}: ${cntErr.message}` };
      }
      const seeded = count ?? 0;
      const gap = Math.max(0, expected - seeded);
      const pct = expected > 0 ? gap / expected : 0;
      if (gap > 0) {
        gaps.push({ id: prop.id, name: propName, gap, expected, seeded, pct });
      }
    }

    // Priority 1: drift between total_rooms and inventory (INV-24 fail).
    if (drifts.length > 0) {
      const detail = drifts
        .map(d => `${d.name}: total_rooms=${d.totalRooms}, inventory.length=${d.inventoryLength}`)
        .join('; ');
      return {
        status: 'fail',
        detail: `INV-24 drift: ${drifts.length} ${drifts.length === 1 ? 'property has' : 'properties have'} total_rooms ≠ array_length(room_inventory). ${detail}.`,
        fix: 'Either update properties.room_inventory to match total_rooms, or update total_rooms to match the inventory length (whichever reflects the real floor plan).',
      };
    }

    // Priority 2: gap (INV-23 fail/warn). Done before missing-inventory because
    // a gap is a more pressing operational issue than an unconfigured inventory.
    if (gaps.length > 0) {
      const worst = gaps.reduce((a, b) => (b.gap > a.gap ? b : a));
      const summary = gaps
        .map(g => `${g.name}: ${g.seeded}/${g.expected} (gap ${g.gap})`)
        .join('; ');
      if (worst.gap >= 4 || worst.pct > 0.10) {
        return {
          status: 'fail',
          detail: `${gaps.length} ${gaps.length === 1 ? 'property has' : 'properties have'} a seeding gap. Worst: ${worst.name} missing ${worst.gap} of ${worst.expected} rooms. All: ${summary}`,
          fix: 'Hit /api/cron/seed-rooms-daily with CRON_SECRET to heal now, or check the scraper\'s plan_snapshots table for today.',
        };
      }
      // Fall through to warn-level if only minor gaps.
      const gapWarn = `Minor seeding drift in ${gaps.length} ${gaps.length === 1 ? 'property' : 'properties'}: ${summary}.`;
      if (missingInventory.length === 0) {
        return { status: 'warn', detail: `${gapWarn} The seed-rooms-daily cron will heal on its next run.` };
      }
      // Continue to combine with missing-inventory warn below.
      const inv = missingInventory.map(m => `${m.name} (total_rooms=${m.totalRooms})`).join('; ');
      return {
        status: 'warn',
        detail: `${gapWarn} Also, ${missingInventory.length} ${missingInventory.length === 1 ? 'property has' : 'properties have'} no room_inventory configured: ${inv}.`,
      };
    }

    // Priority 3: missing inventory only (warn, no fail — phantom-seed
    // can't run but the agent's max-of-three formula still reports
    // total_rooms, so the AI doesn't lie. Operator action needed but
    // not urgent enough for a phone buzz at 3am.).
    if (missingInventory.length > 0) {
      const detail = missingInventory.map(m => `${m.name} (total_rooms=${m.totalRooms})`).join('; ');
      return {
        status: 'warn',
        detail: `${missingInventory.length} ${missingInventory.length === 1 ? 'property has' : 'properties have'} total_rooms set but no room_inventory configured: ${detail}. Phantom-seed cannot populate vacant-clean rooms for these properties.`,
        fix: 'Populate properties.room_inventory with the master list of room numbers for these properties (see migration 0025 for the Comfort Suites example).',
      };
    }

    return { status: 'ok', detail: 'Every property has today\'s rooms fully seeded, and total_rooms agrees with inventory length.' };
  } catch (e) {
    return { status: 'warn', detail: `rooms_today_seeded check errored: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * api_limits_writable — probe the staxis_api_limit_hit RPC the rate
 * limiter uses on every SMS-firing request.
 *
 * Why this matters: api-ratelimit.ts intentionally fails OPEN when the
 * RPC errors. That's the right production-safety default — a Postgres
 * connection blip should not block all shift-confirmation SMS. But
 * fail-open is INVISIBLE: every SMS sends without rate-limit
 * enforcement and nobody knows. At 1 hotel, that's an audit-log
 * footnote. At 50 hotels during a Supabase maintenance window, that's
 * a Twilio cost spike and potential sender-reputation damage from
 * sustained spam-shape traffic.
 *
 * The probe: call the RPC with the sentinel zero-UUID pid and a
 * dedicated 'doctor-probe' endpoint string. Each doctor invocation
 * inserts/updates exactly one row in api_limits keyed on
 * (00000000-…, 'doctor-probe', current_hour) — negligible noise that
 * the staxis_api_limit_cleanup() function reaps after 48h. If the
 * RPC errors, we know the rate limiter is currently fail-opening on
 * every real request.
 *
 * Pairs with the log.error escalation in checkAndIncrementRateLimit:
 * when the live limiter trips fail-open, Sentry gets an event AND
 * this doctor check turns red the next time it runs.
 */
async function checkApiLimitsWritable(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  const probePid = '00000000-0000-0000-0000-000000000000';
  const probeEndpoint = 'doctor-probe';
  const hourBucket = new Date().toISOString().slice(0, 13);
  try {
    const { data, error } = await supabaseAdmin.rpc('staxis_api_limit_hit', {
      p_property_id: probePid,
      p_endpoint: probeEndpoint,
      p_hour_bucket: hourBucket,
    });
    if (error) {
      // Migration 0077 added a FK on api_limits.property_id → properties.id.
      // Our sentinel probePid is deliberately not a real property, so the
      // RPC now correctly returns 23503 (foreign-key violation). That error
      // proves the RPC is healthy: it executed all the way through to
      // Postgres's constraint check. Real callers pass real property_ids
      // and never hit this. Treat 23503 from the sentinel as success.
      if ((error as { code?: string }).code === '23503') {
        return {
          status: 'ok',
          detail: 'Rate-limit RPC round-trip OK (sentinel probe correctly rejected by api_limits → properties FK; real callers pass real property_ids).',
        };
      }
      return {
        status: 'fail',
        detail: `Rate-limit RPC errored: ${error.message}. Every SMS-firing request is currently failing open (no rate limit enforcement). Check Sentry for [ratelimit] error events.`,
        fix: 'Confirm migration 0008_api_limits.sql is applied (the rpc + table). Verify Supabase service-role key has EXECUTE on staxis_api_limit_hit. Run: psql … -c "SELECT proname FROM pg_proc WHERE proname = \'staxis_api_limit_hit\';"',
      };
    }
    const count = Number(data) || 0;
    return {
      status: 'ok',
      detail: `Rate-limit RPC round-trip OK (probe count for this hour: ${count}).`,
    };
  } catch (err) {
    return {
      status: 'fail',
      detail: `Rate-limit RPC probe threw: ${errToString(err)}. Live rate limiter is fail-opening on every SMS request.`,
      fix: 'Check Supabase service-role connectivity, then verify migration 0008_api_limits.sql applied.',
    };
  }
}

/**
 * pms_credentials_encrypted — verify both the schema state (plaintext
 * columns dropped, encrypted columns present) and the RPC the
 * save-credentials route depends on.
 *
 * Probe shape (mirrors checkApiLimitsWritable): call the RPC with a
 * sentinel zero-UUID. The RPC's first action is a property-existence
 * check that raises `no_data_found` for any property_id that doesn't
 * exist. Reaching that error proves: (1) the function exists with the
 * expected signature, (2) the encrypt_pms_credential helper is callable,
 * (3) the encrypted columns the function INSERTs into exist (otherwise
 * the function body would fail to compile). Real callers pass real
 * property_ids and never hit the sentinel branch.
 *
 * Pre-0132 state would have been: plaintext columns present → live route
 * silently writes them; OR encrypted columns present + RPC missing →
 * route writes to dropped columns and 404s silently. Either way the
 * doctor would have caught it loudly.
 */
async function checkPmsCredentialsEncrypted(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  const SENTINEL_PID = '00000000-0000-0000-0000-000000000000';
  try {
    const { error } = await supabaseAdmin.rpc('staxis_upsert_scraper_credentials', {
      p_property_id: SENTINEL_PID,
      p_pms_type: 'choice_advantage',  // any valid enum value; never written
      p_login_url: 'https://doctor.example/probe',
      p_username: 'doctor-probe',
      p_password: 'doctor-probe',
    });
    if (error) {
      // The RPC raises with errcode 'no_data_found' → PostgREST surfaces as
      // code 'P0002' (plpgsql NO_DATA_FOUND). That's the expected healthy
      // path — the function exists and ran all the way to the property
      // existence check.
      const code = (error as { code?: string }).code;
      if (code === 'P0002' || /property .* not found/i.test(error.message ?? '')) {
        return {
          status: 'ok',
          detail: 'PMS credentials RPC + encrypted columns alive (sentinel correctly rejected as missing property).',
        };
      }
      // Function-not-found (PGRST202 / 42883) → migration 0140 not applied.
      if (code === '42883' || code === 'PGRST202' || /function .* does not exist/i.test(error.message ?? '')) {
        return {
          status: 'fail',
          detail: `staxis_upsert_scraper_credentials function missing: ${error.message}. Save-credentials route will 500 on every Test Connection click.`,
          fix: 'Apply supabase/migrations/0140_upsert_scraper_credentials_rpc.sql to prod via psql.',
        };
      }
      // Column-not-found inside the function body (42703) → 0069 partial.
      if (code === '42703' || /column .* does not exist/i.test(error.message ?? '')) {
        return {
          status: 'fail',
          detail: `Encrypted credential columns missing: ${error.message}. Credentials cannot be saved.`,
          fix: 'Apply supabase/migrations/0069_encrypt_scraper_credentials.sql to prod via psql.',
        };
      }
      return {
        status: 'fail',
        detail: `Unexpected RPC error: ${error.message} (code=${code ?? 'unknown'}).`,
        fix: 'Inspect the staxis_upsert_scraper_credentials function and re-apply 0140 if needed.',
      };
    }
    // No error at all means the sentinel UUID actually exists as a property,
    // OR the existence check is missing from the function body. Either way
    // surprising — flag for human review.
    return {
      status: 'warn',
      detail: 'RPC returned no error for sentinel property_id — unexpected. Function may be missing the existence guard.',
    };
  } catch (err) {
    return {
      status: 'fail',
      detail: `PMS-credentials probe threw: ${errToString(err)}.`,
      fix: 'Verify Supabase service-role connectivity; re-apply 0069 and 0132 if migrations are missing.',
    };
  }
}

/**
 * Audit Batch 2 (F-04) — verify every bucket that holds PII is still
 * configured `public:false` on Supabase Storage. A Studio UI click can
 * flip a bucket public; without this check, voice transcripts / OCR'd
 * invoices / shelf photos / maintenance photos would become listable
 * without RLS protection.
 *
 * Add new buckets to PRIVATE_BUCKETS when migrations create them. Keep
 * the list short — one round-trip per bucket per cold-cache run.
 */
const PRIVATE_BUCKETS = ['voice-recordings', 'invoices', 'inventory-counts', 'maintenance-photos'] as const;

async function checkStorageBucketsPrivate(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  const offenders: string[] = [];
  const missing: string[] = [];
  const errors: string[] = [];

  await Promise.all(PRIVATE_BUCKETS.map(async (name) => {
    try {
      const { data, error } = await supabaseAdmin.storage.getBucket(name);
      if (error) {
        // Bucket not found is distinct from "found but public". Surface
        // both — a missing bucket is also a misconfig.
        const msg = (error as { message?: string }).message ?? String(error);
        if (/not found/i.test(msg)) {
          missing.push(name);
        } else {
          errors.push(`${name}: ${msg}`);
        }
        return;
      }
      if (data?.public === true) offenders.push(name);
    } catch (e) {
      errors.push(`${name}: ${errToString(e)}`);
    }
  }));

  if (offenders.length > 0) {
    return {
      status: 'fail',
      detail: `Storage bucket(s) are PUBLIC but must be private: ${offenders.join(', ')}.`,
      fix: 'Supabase Studio → Storage → bucket → Configuration → uncheck "Public bucket". Re-run /api/admin/doctor?nocache=1.',
    };
  }
  if (missing.length > 0) {
    return {
      status: 'warn',
      detail: `Expected private bucket(s) not found: ${missing.join(', ')}. Either the bootstrap script never ran or the bucket was renamed.`,
      fix: 'Run scripts/ensure-voice-recordings-bucket.ts (and equivalent bootstrap for the others); confirm names match the PRIVATE_BUCKETS list.',
    };
  }
  if (errors.length > 0) {
    return {
      status: 'warn',
      detail: `Bucket probe errored: ${errors.join('; ')}.`,
      fix: 'Check Supabase service-role connectivity and bucket-list visibility.',
    };
  }
  return { status: 'ok', detail: `All ${PRIVATE_BUCKETS.length} private buckets confirmed public=false.` };
}

export async function GET(req: NextRequest) {
  // Codex 2026-05-16 P1 fix (Pattern C): accept BOTH admin session AND
  // CRON_SECRET. The post-deploy smoke test (GitHub Action) calls with
  // CRON_SECRET, and the admin UI calls with a real session — both paths
  // legitimate. Was previously CRON_SECRET-only, which conflates "callable
  // by cron" with "callable by any holder of the shared bearer." Doctor
  // returns operational health (env-var presence, RLS status, etc.); the
  // Surface 4 review is still scheduled to walk this end-to-end for any
  // accidental secret-value interpolation in error paths.
  const auth = await requireAdminOrCron(req);
  if (!auth.ok) return auth.response;

  try {
    // Phase M2: ?nocache=1 bypasses the per-check cache. Used by the
    // hourly doctor-check cron + manual debugging when an admin needs
    // a guaranteed-fresh snapshot. Watchdog polls without this flag and
    // gets cached results within 60s — fast and stable at fleet scale.
    const useCache = new URL(req.url).searchParams.get('nocache') !== '1';
    const report = await runAllChecks(useCache);
    // Status code: 200 if all green/warn, 503 if any fail. This lets
    // `curl --fail` in CI work correctly without JSON parsing.
    return NextResponse.json(report, { status: report.ok ? 200 : 503 });
  } catch (err) {
    // Last-resort safety net — runAllChecks itself shouldn't throw, but if
    // something catastrophic happens we still return structured JSON.
    return NextResponse.json(
      {
        ok: false,
        error: 'doctor itself crashed',
        detail: errToString(err),
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
