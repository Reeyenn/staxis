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
import { supabaseAdmin } from '@/lib/supabase-admin';
import { readTwoFactorEnabledFresh } from '@/lib/two-factor';
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
  // Slimmed 2026-07-17 on the owner's order: three signals only —
  // "is the site up" (env + database + migrations), "is the robot OK"
  // (alive / cost-capped / stuck on 2FA). Every other check was deleted
  // as noise; re-add deliberately if a signal earns its place.
  ['env_vars',                    checkEnvVars],
  ['supabase_admin_auth',         checkSupabaseAdminAuth],
  ['supabase_migrations_applied', checkAppliedMigrations],
  ['cua_sessions_alive',          checkCuaSessionsAlive],
  ['cua_cost_cap_paused',         checkCuaCostCapPaused],
  ['cua_mfa_pending',             checkCuaMfaPending],
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
  // Ops alert phone (without this, alerts silently no-op — the exact failure mode we're trying to prevent)
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
  // OPENAI_API_KEY powers Whisper transcription (comms voice messages) and
  // knowledge-search embeddings — required for those surfaces even though
  // the ElevenLabs voice feature was removed 2026-07-15.
  { name: 'OPENAI_API_KEY',                    group: 'openai' },
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




async function checkSupabaseAdminAuth(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  // Cheapest authenticated query: read one row from `properties` (a stable
  // core table). If the service_role key is revoked/stale Supabase returns
  // an auth error that we surface with a specific fix.
  // (Was scraper_status pre-v4; that table is dropped now.)
  try {
    const { error } = await supabaseAdmin
      .from('properties')
      .select('id')
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
  'public_areas',
  'staff',
  'attendance_marks',
  'schedule_assignments',
  'scheduled_shifts',
  'shift_confirmations',
  'time_off_requests',
  'week_publications',
  'property_shift_presets',

  // Operations + housekeeping
  'cleaning_events',
  'daily_logs',
  'deep_clean_config',
  'deep_clean_records',
  'guest_requests',
  'handoff_logs',
  'manager_notifications',
  'preventive_tasks',
  'laundry_config',

  // Inventory
  'inventory',
  'inventory_budgets',
  'inventory_budget_sections',
  'inventory_custom_categories',
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

  // Fleet-wide AI Control Center (service-role only).
  'ai_model_catalog',
  'ai_feature_config_versions',
  'ai_recommendation_reports',

  // High-sensitivity backend tables — service-role only.
  // RLS off here would be catastrophic (plain-text PMS passwords, phone
  // numbers, webhook dedupe, Stripe events).
  'scraper_credentials',
  'sms_jobs',
  'pull_jobs',
  'onboarding_jobs',
  'idempotency_log',
  'stripe_processed_events',
  'processed_sentry_webhooks',
  'processed_twilio_webhooks',
];


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
  // 0328 — account onboarding capabilities are exposed only through scoped
  // server routes. Raw invite/code rows are never browser-readable.
  'account_invites',
  'hotel_join_codes',
  'join_requests',
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
  'scraper_session',
  // 0295 — public staff-link tokens (server-minted, capability-checked in routes).
  'staff_link_tokens',
  // 0300/0302/0303 — AI-assistant approval gate, reminders, recurring to-dos.
  // Deny-all service-role-only by design (the `-- @rls: service-role-only`
  // markers satisfy the lint-time twin; this runtime list must match it).
  'agent_pending_actions',
  'agent_reminders',
  'recurring_task_templates',
  // 0310 — global app settings singleton (the master 2FA switch). Service-role
  // only; the anon/authenticated clients are denied by app_settings_deny_browser.
  'app_settings',
  // 0313 — global AI provider catalog + immutable feature config history.
  'ai_model_catalog',
  'ai_feature_config_versions',
  // 0316 — saved recommendation reports.
  'ai_recommendation_reports',
]);


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


// (Plan v4 cleanup deleted checkSupabaseHeartbeat / checkSupabaseDashboard
// / checkDashboardFreshness / checkVercelWatchdogDegraded /
// checkScraperHealthCronLiveness — all five read scraper_status or
// dashboard_by_date, both dropped tables. They had no callers in the
// check registry; safe to remove.)









// checkCronSecretCrossPlatform REMOVED (feature/pms-rooms-retire): it compared
// a Railway-published CRON_SECRET fingerprint stored in
// scraper_status[heartbeat], but Railway + the scraper were deleted in Plan v4
// — the check always returned 'skipped' (Railway never published a
// fingerprint), and scraper_status is dropped in migration 0272. Its siblings
// supabase_heartbeat / supabase_dashboard were already removed in the Plan-v4
// doctor cleanup. CRON_SECRET presence is still verified by env_vars /
// cron_secret_shape.

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
 *   - unknown extras in DB not in code → warn (someone applied a hand-rolled migration)
 *   - documented historical aliases/renumbered migrations → ignore
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

/**
 * Historical production rows that intentionally have no same-named file.
 *
 * These are not pending schema and must not keep the doctor permanently
 * yellow. Each row is already superseded by a canonical numbered migration:
 *
 * - 0205b: emergency post-cutover cleanup that became 0205/0206 follow-ups.
 * - 0234_status_log_changed_at_default: filename-style alias for 0234; both
 *   rows were recorded when the hotfix was applied before the file landed.
 * - 0264: parallel AI Agent Builder migration; 0265 documents the collision.
 * - 0273: one-off join-code reconciliation later represented in auth code.
 * - 0279: CUA human-loop migration renumbered after a reserved-slot collision.
 *
 * New entries require an operator-verified applied_migrations description and
 * a comment here. This must never become a blanket prefix/shape allowlist.
 */
export const ALLOWED_EXTRA_APPLIED_MIGRATIONS: ReadonlySet<string> = new Set([
  '0205b',
  '0234_status_log_changed_at_default',
  '0264',
  '0273',
  '0279',
]);

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
    const unexpected = [...applied].filter(
      v => !EXPECTED_MIGRATIONS.includes(v) && !ALLOWED_EXTRA_APPLIED_MIGRATIONS.has(v),
    );
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

// (Plan v4 cleanup: checkMLFailureCounter / checkOccupancyCaptureFailures /
// checkFeatureDerivationFailures all read scraper_status[ml_failures:<kind>]
// which is dropped. Their callers in room-action/complete-clean were also
// removed. ML feature derivation needs a rebuild against pms_* before
// failure-tracking can come back.)




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
  // 2026-07-19: run-scheduled-reports / run-daily-report / run-weekly-report
  // removed from this list — the automatic report emails were deleted
  // entirely (owner call), so their heartbeats will never land again.
  // 2026-07-19 (owner call, pre-launch trim): agent-nudges-check,
  // compliance-reminders, seal-daily, schedule-auto-fill, expire-trials,
  // pms-backfill-missing-feeds, run-rules-engine, run-auto-assign, and
  // lost-found-disposal-check unscheduled — they only matter once a hotel
  // is live on the PMS robot. Route code kept dormant; re-add here when
  // re-scheduling (see cron-schedule-registry.ts for the full checklist).
  // Tight cadences
  // Plan v4 (2026-05-24): removed `scraper-health` — Railway scraper cron,
  // service is gone. The new `vercel-watchdog` (5-min, listed at the
  // bottom) replaces it.
  // 2026-07-19: compliance-reminders + compliance-anomaly-sweep removed —
  // the engineering-compliance section was deleted entirely (owner call).
  { name: 'agent-sweep-reservations',      cadenceHours: 5/60,  description: 'every-5-min reserved-row sweeper (Vercel native cron, Codex round-5 R2)' },
  { name: 'agent-summarize-long-conversations', cadenceHours: 30/60, description: 'every-30-min summarization of long agent conversations (L4 part B)' },
  { name: 'agent-consolidate-memory',      cadenceHours: 24,    description: 'nightly per-hotel memory consolidation — auto-learns durable facts from conversations (self-learning Move #2)' },
  { name: 'walkthrough-heal-stale',        cadenceHours: 30/60, description: 'every-30-min walkthrough recovery (heals stale runs left mid-walkthrough by crashed clients)' },
  { name: 'sweep-orphan-auth-users',       cadenceHours: 24,    description: 'daily orphan auth-user reconciler — deletes auth.users rows with no matching accounts row (audit fix #4; slowed from 30-min 2026-07-19, owner call)' },
  { name: 'sweep-mfa-verified-sessions',   cadenceHours: 6,     description: 'every-6-hour sweep of mfa_verified_sessions rows older than 30 days — Phase 2B Door B fix' },
  // Plan v4 (2026-05-24): removed `seed-rooms-daily` — depended on the
  // legacy `rooms` table (dropped in v4). CUA writes room state to
  // pms_room_status_log (event-sourced, no per-day seeding needed).
  // Daily
  { name: 'ml-run-inference',              cadenceHours: 24,    description: 'daily demand+supply+optimizer predictions' },
  { name: 'ml-predict-inventory',          cadenceHours: 24,    description: 'daily inventory predictions for tomorrow' },
  // 2026-05-24: removed `ml-aggregate-priors` — cross-fleet cohort
  // aggregation is a no-op at N<5 hotels per cohort. Re-add when scale
  // makes the cron meaningful. (See route.ts for the matching log demote.)
  { name: 'ml-retention-purge',            cadenceHours: 24,    description: 'daily prediction_log/app_events retention purge (Phase 3.6)' },
  { name: 'purge-old-error-logs',          cadenceHours: 24,    description: 'daily error_logs retention sweep' },
  { name: 'agent-archive-stale-conversations', cadenceHours: 24, description: 'daily 3am archival of stale agent conversations (L4 part A)' },
  { name: 'claude-sessions-purge',         cadenceHours: 24,    description: 'daily 3:30am claude_sessions retention sweep — deletes rows older than 24h so random-sessionId floods can\'t grow the table (security audit M2)' },
  { name: 'agent-heal-counters',           cadenceHours: 24,    description: 'daily 4am counter-drift heal (Round 12 T12.12, invariant doctrine safety net)' },
  { name: 'webhook-dedup-purge',           cadenceHours: 24,    description: 'daily 4:15am purge of expired webhook-dedup keys (auth-storage-cookies-and-middleware)' },
  { name: 'pms-auth-codes-purge',          cadenceHours: 24,    description: 'daily 4:45am purge of pms_auth_codes older than 7 days (Okta 2FA inbox, migration 0274)' },
  // Weekly
  { name: 'ml-train-demand',               cadenceHours: 168,   description: 'weekly demand training (Sunday)' },
  { name: 'ml-train-supply',               cadenceHours: 168,   description: 'weekly supply training (Sunday)' },
  { name: 'ml-train-inventory',            cadenceHours: 168,   description: 'weekly inventory training (Sunday)' },
  // Plan v4 (2026-05-24): removed `scraper-weekly-digest` — Railway
  // scraper observability cron, scraper service is gone.
  // Plan v4 (2026-05-23): replaces the Railway-hosted vercel-watchdog.js.
  // Runs the doctor every 5 min, Sentry-alerts on fail with business-hours-only SMS bump.
  { name: 'vercel-watchdog',               cadenceHours: 5/60,  description: '5-min Vercel cron that polls /api/admin/doctor and alerts on fail (replaces scraper/vercel-watchdog.js post-v4)' },
  // 2026-05-24: cua-parity-diff retired — shadow gate removed alongside
  // legacy CA normalizers; new generic-table-writer is the only path now.
  // 2026-05-24: sick-callout coverage flow (feature #6). Sweeps callouts
  // whose redistribute_at has passed (or whose 'after_current_room'
  // gate is now satisfied) and fires the redistribute. Safety net for
  // inline failures on the report routes.
  // Plan v8 Phase B (migration 0217): 5-min Vercel cron that flips
  // mapping_help_requests past expires_at to 'expired' and deletes their
  // screenshots from the mapping-screenshots storage bucket. Without this
  // the 15-min TTL pending rows accumulate forever.
  { name: 'expire-help-requests',          cadenceHours: 5/60,  description: '5-min Vercel cron that expires stale mapping_help_requests + purges their screenshot storage objects (Plan v8 Phase B)' },
];









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
// A 'starting' session that never reaches 'alive' within this window is a
// stuck boot (Playwright wedged / crash-loop) — surfaced as a warn, never a
// 503. Generous so a normal cold boot across US timezones never trips it.
const CUA_STARTING_STUCK_MS = 15 * 60_000;

// Only an 'alive' session asserts "a polling driver is running and MUST
// heartbeat" — so it is the ONLY state that can produce the deploy-gate FAIL.
// Every other non-stopped state is human-gated or non-driver and is excluded
// from the 503 (2026-06-26 pre-onboarding audit fix):
//   paused_mfa / paused_cost_cap          — normal mid-onboarding; each has a
//                                            dedicated warn check below.
//   paused_no_knowledge_file / starting   — normal during onboarding.
//   paused_circuit_breaker / failed_restart — real problems, surfaced as WARN.
// Before this, ANY non-stopped row with a stale heartbeat hard-failed the
// doctor → the deploy smoke gate 503'd and paged the founder every time a
// hotel was paused for MFA/cost or mid-onboarding (a stale heartbeat is
// EXPECTED for a paused, non-running driver).
async function checkCuaSessionsAlive(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  try {
    const { data, error } = await supabaseAdmin
      .from('property_sessions')
      .select('property_id, status, last_alive_at, created_at, pms_family')
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
    type SessionRow = { property_id: string; status: string; last_alive_at: string | null; created_at: string | null; pms_family: string };
    const rows = data as SessionRow[];
    const aliveRows = rows.filter((r) => r.status === 'alive');

    // 1. Stale 'alive' sessions = a real driver crash → the ONLY fail path.
    const staleAlive = aliveRows.filter((r) => {
      const lastAlive = r.last_alive_at ? new Date(r.last_alive_at).getTime() : 0;
      return now - lastAlive > CUA_HEARTBEAT_STALE_MS;
    });
    if (staleAlive.length > 0) {
      return {
        status: 'fail',
        detail: `${staleAlive.length}/${aliveRows.length} live CUA session(s) missed heartbeat (>5min stale): ${staleAlive
          .slice(0, 5)
          .map((r) => `${r.property_id} (${r.pms_family}, last_alive=${r.last_alive_at ?? 'never'})`)
          .join('; ')}`,
        fix: 'Check Fly machine logs for the affected property. Likely a Playwright crash; supervisor should respawn within 30s.',
      };
    }

    // 2. Non-fatal attention states → WARN (never a 503): dead-letter
    //    (failed_restart), tripped circuit breaker, or a boot stuck in
    //    'starting' past the generous boot window.
    const attention = rows.filter((r) => {
      if (r.status === 'failed_restart' || r.status === 'paused_circuit_breaker') return true;
      if (r.status === 'starting') {
        const sinceTs = r.last_alive_at
          ? new Date(r.last_alive_at).getTime()
          : r.created_at
            ? new Date(r.created_at).getTime()
            : now;
        return now - sinceTs > CUA_STARTING_STUCK_MS;
      }
      return false;
    });
    if (attention.length > 0) {
      return {
        status: 'warn',
        detail: `${attention.length} CUA session(s) need attention (not a deploy-blocker): ${attention
          .slice(0, 5)
          .map((r) => `${r.property_id} (${r.pms_family}, status=${r.status})`)
          .join('; ')}`,
        fix: 'failed_restart → check Fly logs, restart via /admin/property-sessions. paused_circuit_breaker → repeated read failures; inspect the feed. stuck "starting" → driver never reached alive; check the worker.',
      };
    }

    const humanGated = rows.filter(
      (r) => r.status === 'paused_mfa' || r.status === 'paused_cost_cap' || r.status === 'paused_no_knowledge_file',
    );
    const note = humanGated.length > 0
      ? ` (${humanGated.length} human-gated/onboarding session(s) excluded — see cua_cost_cap_paused / cua_mfa_pending checks)`
      : '';
    return {
      status: 'ok',
      detail: `all ${aliveRows.length} live CUA session(s) heartbeating within ${CUA_HEARTBEAT_STALE_MS / 60_000} min${note}`,
    };
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

      // Plan v4: the canonical room list is pms_rooms_inventory (synced by
      // the persistent CUA), not a per-day `rooms` seed. Count it against the
      // expected floor size to catch a PMS inventory that hasn't fully synced.
      const { count, error: cntErr } = await supabaseAdmin
        .from('pms_rooms_inventory')
        .select('*', { count: 'exact', head: true })
        .eq('property_id', prop.id);
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
          fix: 'Check this property\'s CUA session is live and polling at /admin/property-sessions — room counts derive from the CUA\'s latest poll into pms_room_status_log.',
        };
      }
      // Fall through to warn-level if only minor gaps.
      const gapWarn = `Minor seeding drift in ${gaps.length} ${gaps.length === 1 ? 'property' : 'properties'}: ${summary}.`;
      if (missingInventory.length === 0) {
        return { status: 'warn', detail: `${gapWarn} The CUA's next poll should populate the missing rooms.` };
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
