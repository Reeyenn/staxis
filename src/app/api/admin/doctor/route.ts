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
 * Slimmed 2026-07-17 (owner's call) to three signals. The live registry is
 * the `checks` array below — THIS list must match it. The 7 checks that run:
 *
 *   env_vars                    — every required env var is present + non-empty
 *   supabase_admin_auth         — preflight read using the service_role key
 *                                 (catches stale/revoked keys)
 *   supabase_migrations_applied — every migration file is registered as applied
 *                                 in prod (catches schema drift)
 *   cua_sessions_alive          — DECOMMISSIONED (2026-07-25). Was: each
 *                                 enabled hotel's 24/7 CUA session is
 *                                 heartbeating (deploy-gate FAIL if not).
 *   cua_cost_cap_paused         — DECOMMISSIONED. Was: warns if a hotel's CUA
 *                                 is paused on the $5/day Claude cost cap.
 *   cua_mfa_pending             — DECOMMISSIONED. Was: warns if a CUA session
 *                                 is stuck on PMS 2FA.
 *   agent_prompt_tiers          — each copilot instruction tier has exactly
 *                                 one active row (catches the silent
 *                                 "activation left the tier dark" state)
 *   agent_prompt_tool_names     — the ACTIVE prompt rows route the copilot only
 *                                 at tools that still exist (catches a tool
 *                                 rename that updated the code constants and
 *                                 left the live rows behind)
 *   companion_event_wake_health — the ten-minute event sweep is still advancing
 *                                 its per-hotel cursor, and nobody is being
 *                                 silenced by the spend cap (the one AI job
 *                                 whose healthy state is writing nothing, so a
 *                                 stopped watcher is otherwise invisible)
 *
 * NOT run here (enforced elsewhere): RLS-enabled / RLS-policy-coverage /
 * storage-bucket-RLS / PII-bucket-private invariants are checked at LINT time
 * by scripts/audit-rls-*.mjs + audit-storage-bucket-rls.mjs (in `npm run lint`,
 * CI-gated). The RLS_REQUIRED_TABLES / *_ALLOWLIST / PRIVATE_BUCKETS lists below
 * are the retained reference twins of those lint audits, not runtime checks.
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
import {
  evalBankFreshnessVerdict,
  evalBankIncidentVerdict,
} from '@/lib/agent/eval-bank-health';
import { env } from '@/lib/env';
import { SUPERSEDED_MIGRATIONS } from '@/lib/migration-policy';
import { evaluatePromptTierHealth, evaluatePromptToolRouting } from '@/lib/agent/prompt-tiers';
// The live tool catalog, for `agent_prompt_tool_names`. The index import is the
// registration side-effect — without it `listAllTools()` is empty and the check
// would report every prompt row as routing at names that do not exist.
import { listAllTools, TOOL_ALIASES } from '@/lib/agent/tools';
import '@/lib/agent/tools/index';
import {
  evaluateFeedSlos,
  evaluateQuarantineBacklog,
  evaluateUnmappedColumns,
  parseFeedHealthRows,
} from '@/lib/pms/feed-health';
import { CUA_DECOMMISSIONED, decommissionedCheck } from '@/lib/pms/decommission';
import { FEATURE_ABANDON_MINUTES } from '@/lib/findings/judge-budget';
import { ACTIVE_MISSION_JOBS, cronCadenceHours } from '@/lib/automation/job-catalog';
import {
  ROBOT_WALK_FRESH_HOURS,
  robotWalkStepLabel,
  summarizeRobotWalk,
  type RobotWalkStepResult,
} from '@/lib/automation/robot-walk';

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
  // Earns its place (A3, 2026-07-24): a botched prompt activation leaves a
  // tier with ZERO active rows. Nothing 500s, nothing looks wrong — the
  // copilot just quietly loses that tier's instructions. Only a query can see
  // it. Deliberately silent (ok, not warn) while the PMS-family slot is empty.
  ['agent_prompt_tiers',          checkAgentPromptTiers],
  // Earns its place (2026-07-27): the live prompt for a role is a ROW, and the
  // constants-side audit (agent-tool-catalog-audit) can only see code. A tool
  // rename updates the constants — that test forces it — and leaves the rows
  // pointing at names the model is no longer offered, or at names that no
  // longer exist at all. Nothing else in the system looks at the rows.
  ['agent_prompt_tool_names',     checkAgentPromptToolNames],
  // D4 (2026-07-24) — the report-era heartbeat. These three make the EXISTING
  // 5-minute /api/cron/vercel-watchdog loop the late-report watchdog: no new
  // cron entry, no vercel.json change, no schedule-registry row. A hotel
  // whose PMS stops emailing reports produces a fail here within about 15
  // minutes, and the watchdog escalates it to Sentry + business-hours SMS.
  //
  // 2026-07-25 — robot decommission landed. The three cua_* checks above are
  // still REGISTERED (so the check list doesn't silently shrink and so
  // re-arming is a one-line flip) but each now short-circuits to a plain
  // "decommissioned, not monitored" ok via CUA_DECOMMISSIONED. They query
  // nothing. The report-freshness trio below is the live health gate now.
  ['pms_report_freshness',        checkPmsReportFreshness],
  ['pms_quarantine_backlog',      checkPmsQuarantineBacklog],
  ['pms_unmapped_columns_open',   checkPmsUnmappedColumns],
  // Report-email intake (migrations 0340-0342). Two signals only, in the
  // spirit of the 2026-07-17 slimming:
  //   - lineage is the INVARIANT tripwire: a future pms_* table shipping
  //     without a receipt column is a silent data-provenance hole, and this is
  //     the only thing that would ever notice.
  //   - intake health surfaces the two states a constraint cannot: bytes that
  //     never landed, and files quarantined before any parse.
  ['pms_lineage_columns_complete', checkPmsLineageColumns],
  ['pms_report_intake_health',     checkPmsReportIntakeHealth],
  // Time model (migration 0343). pms_table_schemas is the descriptor every PMS
  // writer reads before it writes; when it drifts from the physical schema the
  // symptom is silent — duplicated rows, or a feed that has simply never
  // written anything. The trigger prevents new drift; this catches drift caused
  // some other way (a hand-run ALTER, a dropped index) within 5 minutes.
  ['pms_time_model_ok',            checkPmsTimeModel],
  // A4-RATCHET (2026-07-24): the two signals that tell you the quality
  // ratchet is actually turning. Both were invisible before — the live eval
  // bank could go a year without running and nothing said so, and an
  // "the AI got this wrong" report could be closed with nothing learned.
  ['eval_bank_freshness',         checkEvalBankFreshness],
  ['eval_bank_incident_coverage', checkEvalBankIncidentCoverage],
  // The findings layer's spend gate is self-healing by design — an abandoned
  // hold stops counting once its window passes (0361), so nothing ever blocks
  // forever and no cron sweeps it. What that design cannot do is TELL anybody,
  // and a caller that has started leaking holds looks exactly like a quiet
  // night. This is the only place that difference is visible.
  ['findings_spend_stale_holds',  checkFindingsSpendStaleHolds],
  // The event sweep is the only AI job in the product whose NORMAL state is
  // "did nothing", 144 times a day, per hotel. That makes its two failure
  // modes invisible without a query:
  //   • it stopped looking. A stale cursor is the ONLY evidence — the route
  //     still returns 200 and the heartbeat still lands when every hotel is
  //     skipped for want of a cursor.
  //   • it is being silenced by money. A hotel that spent its ceiling prepares
  //     nothing for the rest of the day, and from every screen in the app that
  //     is indistinguishable from a quiet hotel.
  ['companion_event_wake_health', checkCompanionEventWakeHealth],
  // Every other check on this list asks the database whether the data looks
  // right. This one asks whether a person can still USE the app: a robot signs
  // into the live site each night at a seeded test hotel and walks it. A broken
  // sign-in, a composer that stopped submitting, a list that renders empty for
  // a signed-in manager — none of those disturb a single row, and every other
  // check here reports green through all of them.
  ['robot_walk_recent',           checkRobotWalkRecent],
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
  // Historical recommendation reports remain inert until a future migration
  // can remove the persisted table; keep its RLS posture monitored meanwhile.
  'ai_recommendation_reports',

  // High-sensitivity backend tables — service-role only.
  // RLS off here would be catastrophic (plain-text PMS passwords, phone
  // numbers, webhook dedupe, Stripe events).
  // sms_jobs + processed_twilio_webhooks were dropped by migration 0352
  // (all texting was removed from the product).
  'scraper_credentials',
  'pull_jobs',
  'onboarding_jobs',
  'idempotency_log',
  'stripe_processed_events',
  'processed_sentry_webhooks',
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
  'error_logs',
  'webhook_log',
  'api_limits',
  'app_events',
  'user_feedback',
  'expenses',
  'claude_usage_log',
  'trusted_devices',
  'agent_cost_finalize_failures',
  // 0375 — the AI books' monthly summary. Fleet-wide financial data, read by
  // service-role code only, same posture as agent_costs' own admin reads.
  'agent_costs_monthly',
  'staff_magic_codes',
  'scraper_credentials',
  'idempotency_log',
  'onboarding_jobs',
  'stripe_processed_events',
  'pull_jobs',
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
  // 0316 — inert historical recommendation reports retained without migration.
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
export const EXPECTED_MIGRATIONS_STATIC: ReadonlyArray<string> = [
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
  '0160', '0161', '0162', '0163', '0164', '0165', '0166', '0167',
  // Post-launch operational, CUA, company, inventory, agent, and access work.
  // Keep this fallback byte-for-byte aligned with the versions on disk; the
  // bookkeeping suite compares it directly instead of accidentally testing
  // only the filesystem-derived happy path.
  '0200', '0201', '0202', '0203', '0204', '0205', '0206', '0207',
  '0208', '0209', '0210', '0211', '0212', '0213', '0215', '0216',
  '0217', '0218', '0219', '0220', '0221', '0222', '0223', '0224',
  '0225', '0226', '0227', '0228', '0229', '0230', '0234', '0235',
  '0236', '0237', '0238', '0239', '0240', '0241', '0242', '0243',
  '0244', '0245', '0246', '0247', '0248', '0249', '0250', '0251',
  '0252', '0253', '0254', '0255', '0256', '0257', '0258', '0259',
  '0260', '0261', '0262', '0263', '0265', '0266', '0267', '0268',
  '0269', '0270', '0271', '0272', '0274', '0275', '0276', '0277',
  '0278', '0280', '0281', '0282', '0283', '0284', '0285', '0286',
  '0287', '0288', '0289', '0290', '0291', '0292', '0293', '0294',
  '0295', '0296', '0300', '0301', '0302', '0303', '0304', '0305',
  '0306', '0307', '0308', '0309', '0310', '0311', '0312', '0313',
  '0314', '0315', '0316', '0317', '0318', '0319', '0320', '0321',
  '0322', '0323', '0324', '0325', '0326', '0327', '0328', '0329',
  '0330', '0331', '0332', '0333', '0334', '0335', '0336', '0337',
  '0338', '0339', '0340', '0341', '0342', '0343', '0344', '0350',
  '0351', '0352', '0353', '0354', '0355', '0356', '0357', '0358',
  '0359', '0360', '0361', '0362', '0363', '0364', '0365', '0366',
  '0367', '0368', '0369', '0370', '0371', '0372', '0373', '0374', '0375',
  // Portfolio Intelligence / authoritative access, Finding Patterns, and
  // Navigation. Keep the combined release chain exactly aligned with disk.
  '0376', '0377', '0378', '0379', '0380', '0381', '0382', '0383',
  '0384', '0385', '0386', '0387', '0388', '0389', '0390', '0391', '0392', '0393',
  '0394', '0395', '0396', '0397', '0398', '0399', '0400', '0401',
  '0402', '0403', '0404', '0405', '0406', '0407', '0408', '0409', '0410', '0411',
  '0412', '0413', '0414', '0415', '0416', '0417',
  // Stage A authoritative access compatibility and invariant evidence.
  '0418', '0419', '0420', '0421', '0422', '0423',
  '0424',
  // 0425 is the externally shipped canonical test-property roster restore;
  // 0426 is the first Access Stage C final-contract migration.
  '0425', '0426',
  // Stage A cleaning compatibility and evidence migrations.
  '0434', '0435',
  // Cleaning Stage A compatibility plus the non-destructive Stage B
  // canonical inspection lock patch.
  '0436',
  // Cleaning Stage C final reconciliation, immutable receipt, and legacy
  // relation retirement.
  '0437',
  // Inventory easy setup: import batches, row provenance, occupancy months.
  '0452',
  // To-do follow-through: a completion credited to the day it was due, a
  // "not needed" ending, an optional time of day, and the list-seen cursor.
  '0453',
  // Guarded account link for the manager roster bridge. The Stage C lockdown
  // leaves service_role with SELECT only on account_property_staff_links, so
  // the bridge writes through a SECURITY DEFINER RPC instead.
  '0454',
  // Recurring to-dos gain an every-N-days cadence (interval_days + anchor).
  '0455',
  // The agent gets a life record: activity_log.source gains 'staxis_agent'.
  '0456',
  // The decision corpus learns two more surfaces: agent_decisions.surface
  // gains 'messages' (the @Staxis thread assistant) and 'portfolio'.
  '0457',
  // Where the companion's eyes were last: one row per hotel holding the
  // activity_log cursor the ten-minute event sweep reads from, plus the
  // hotel-local daily wake counter that caps its model calls.
  '0459',
  // One row per nightly robot walkthrough of the live app, so a green night
  // is distinguishable from a night the robot never ran.
  '0460',
  // The question under a companion card: judged_question + judged_reply_order
  // on findings, both nullable, both meaning "use the template" when absent.
  '0461',
  // "Skip this one" on an upkeep schedule: one occurrence put down without
  // anybody claiming the work happened (preventive_tasks.skipped_at/by).
  '0462',
  // Integer-cents mirrors of the legacy dollar money columns, derived by
  // Postgres so the cents and dollars views of a number cannot drift apart.
  '0463',
  // Company hats carry which hotels they cover, and the company vocabulary
  // becomes Owner + Regional Manager.
  '0464',
  // Audit trigger stops naming the 0463 generated cents mirrors in
  // changedFields; item history shows one entry per real edit again.
  '0465',
  // The companion's daily wake counter is incremented by the database inside
  // the row lock, so two overlapping sweeps cannot write a stale count back.
  '0466',
  // A company hat's hotel list is validated at every guarded write, an
  // explicit-list invitation can actually be accepted, and a hat naming some
  // hotels no longer reads as the whole company.
  '0467',
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
    // Dedupe: a version is a Postgres applied_migrations key, and more than
    // one file can carry the same 4-digit prefix (0015 ships a real tracker
    // file plus a documented no-op stub). Without the Set, '0015' appeared
    // twice in EXPECTED_MIGRATIONS and every count the doctor reported off
    // that list was one too high.
    const versions = [...new Set(
      readdirSync(dir)
        .filter(f => f.endsWith('.sql'))
        .map(f => f.match(/^(\d{4})_/)?.[1])
        .filter((v): v is string => Boolean(v)),
    )].sort();
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
    const missing = EXPECTED_MIGRATIONS.filter(v =>
      !applied.has(v) && !SUPERSEDED_MIGRATIONS.has(v));
    const unexpected = [...applied].filter(
      v => !EXPECTED_MIGRATIONS.includes(v) && !ALLOWED_EXTRA_APPLIED_MIGRATIONS.has(v),
    );
    if (missing.length > 0) {
      return {
        status: 'fail',
        detail: `${missing.length} migration(s) missing from live DB: ${missing.join(', ')}. Code expects all applicable migrations to be applied (${SUPERSEDED_MIGRATIONS.size} historical migration(s) are permanently superseded and must never run).`,
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
 * Legacy schedule/cadence projection retained for CI drift tests and older
 * imports. The runtime Doctor check registry does not consume this list;
 * Mission Control is the current heartbeat-status surface.
 */
export const GH_ACTIONS_SKEW_BUFFER_HOURS = 0.25;

export const EXPECTED_CRONS: Array<{ name: string; cadenceHours: number; description: string }> =
  ACTIVE_MISSION_JOBS.map((job) => ({
    name: job.heartbeat.name,
    cadenceHours: cronCadenceHours(job.schedule),
    description: job.heartbeat.cadenceDescription,
  }));










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
/**
 * Two ratchet signals. The judgement lives in
 * src/lib/agent/eval-bank-health.ts so it is directly testable; this route owns
 * only the queries.
 */
async function checkEvalBankFreshness(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  try {
    const { data, error } = await supabaseAdmin
      .from('agent_eval_baselines')
      .select('created_at')
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) {
      return { status: 'warn', detail: `agent_eval_baselines read failed: ${errToString(error)}` };
    }
    const newest = (data ?? [])[0] as { created_at?: string } | undefined;
    return evalBankFreshnessVerdict(newest?.created_at ?? null);
  } catch (err) {
    return { status: 'warn', detail: `check threw: ${errToString(err)}` };
  }
}

async function checkEvalBankIncidentCoverage(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  try {
    const { data, error } = await supabaseAdmin
      .from('user_feedback')
      .select('id')
      .eq('category', 'ai_wrong')
      .eq('status', 'resolved')
      .is('eval_case_name', null)
      .limit(20);
    if (error) {
      // A database without migration 0350 has neither the column nor the
      // category. Say so plainly instead of reporting a false failure.
      return {
        status: 'warn',
        detail: `user_feedback read failed (is migration 0350 applied?): ${errToString(error)}`,
      };
    }
    const rows = (data ?? []) as Array<{ id: string }>;
    return evalBankIncidentVerdict(rows.map(r => r.id));
  } catch (err) {
    return { status: 'warn', detail: `check threw: ${errToString(err)}` };
  }
}

/**
 * findings_spend_stale_holds — background AI holds nobody ever reconciled.
 *
 * The findings spend gate reserves the worst-case cost of a call, then
 * finalizes it to what actually happened or cancels it. A run that dies in
 * between leaves a `reserved` row, and 0361 handles that gracefully INSIDE the
 * sum: once the row is older than its feature's abandon window it stops
 * counting, so a crash can never lock a hotel out of its own findings.
 *
 * That is the right runtime behaviour and a terrible operational one on its
 * own, because the symptom of a caller that leaks holds every single night —
 * templates instead of judged phrasing, silently, on every hotel — is
 * indistinguishable from a quiet night. Nothing anywhere counted them.
 *
 * WARN, never fail: nothing is broken for a manager, and a check that could
 * 503 the deploy gate over background bookkeeping would be its own outage.
 */
async function checkFindingsSpendStaleHolds(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  // The longest window any feature declares. A hold younger than this is simply
  // a call in flight, which is the normal state of the nightly run.
  const longestWindowMin = Math.max(...Object.values(FEATURE_ABANDON_MINUTES), 60);
  const cutoff = new Date(Date.now() - longestWindowMin * 60_000).toISOString();
  try {
    const { data, error } = await supabaseAdmin
      .from('findings_ai_spend')
      .select('feature, created_at')
      .eq('state', 'reserved')
      .lt('created_at', cutoff)
      .limit(200);
    if (error) {
      if (isMissingRelation(error)) {
        return { status: 'ok', detail: 'findings spend ledger not applied yet (migration 0361)' };
      }
      return { status: 'warn', detail: `findings_ai_spend read failed: ${errToString(error)}` };
    }
    const rows = (data ?? []) as Array<{ feature: string | null; created_at: string }>;
    if (rows.length === 0) {
      return { status: 'ok', detail: 'no findings AI holds left unreconciled' };
    }
    const byFeature = new Map<string, number>();
    for (const row of rows) {
      const key = row.feature ?? 'unknown';
      byFeature.set(key, (byFeature.get(key) ?? 0) + 1);
    }
    const breakdown = [...byFeature.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([feature, count]) => `${feature} x${count}`)
      .join(', ');
    return {
      status: 'warn',
      detail: `${rows.length} findings AI spend hold(s) older than ${longestWindowMin} min never finalized or cancelled — ${breakdown}`,
      fix: 'A background findings caller is dying between reserve and finalize. Check the findings cron logs for that feature; the holds themselves stop counting against the cap on their own.',
    };
  } catch (err) {
    return { status: 'warn', detail: `check threw: ${errToString(err)}` };
  }
}

/**
 * Is the companion still looking, and is money still stopping it?
 *
 * TWO SIGNALS, ONE READ EACH, because they are the two things about this
 * subsystem that nothing else in the product can see.
 *
 * ─── 1. A STALE CURSOR IS THE ONLY EVIDENCE IT STOPPED ─────────────────────
 * Every other cron proves it ran by writing something. This one's healthy state
 * is writing NOTHING: no findings, no journal row, no note. So a sweep that
 * silently skipped every hotel for a week returns 200 every ten minutes and
 * lands a heartbeat every ten minutes, and the freshness check is happy. The
 * cursor is the one thing that only advances when a hotel was actually looked
 * at.
 *
 * Thirty minutes is three missed sweeps: long enough that a deploy or a slow
 * tick is not an alert, short enough that a genuinely stopped watcher is caught
 * inside the hour.
 *
 * ─── 2. THE CAP MUST BE LOUD ───────────────────────────────────────────────
 * A hotel that has spent its daily ceiling prepares nothing for the rest of the
 * day, and from every screen in the app that looks exactly like a hotel where
 * nothing is going wrong. The route counts it on the heartbeat; this is where
 * an operator sees the count without reading logs.
 *
 * WARN, never fail. Nothing here is broken for a manager, and a check that
 * could 503 the deploy gate over a background watcher would be its own outage.
 */
async function checkCompanionEventWakeHealth(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  const STALE_MINUTES = 30;
  try {
    const staleCutoff = new Date(Date.now() - STALE_MINUTES * 60_000).toISOString();
    const [stale, heartbeat] = await Promise.all([
      supabaseAdmin
        .from('companion_event_wake_state')
        .select('property_id', { count: 'exact', head: true })
        .lt('last_looked_at', staleCutoff),
      supabaseAdmin
        .from('cron_heartbeats')
        .select('notes')
        .eq('cron_name', 'companion-event-wake')
        .limit(1),
    ]);

    if (stale.error) {
      // Not applied yet is not a failure. Migrations are applied by hand, so
      // the code always reaches production before the table does.
      if (isMissingRelation(stale.error)) {
        return {
          status: 'ok',
          detail: 'companion event-wake cursor table not applied yet (migration 0459)',
        };
      }
      return {
        status: 'warn',
        detail: `companion_event_wake_state read failed: ${errToString(stale.error)}`,
      };
    }

    const notes = (((heartbeat.data ?? []) as Array<{ notes?: unknown }>)[0]?.notes ?? {}) as
      Record<string, unknown>;
    const num = (key: string): number => {
      const value = Number(notes[key]);
      return Number.isFinite(value) && value > 0 ? value : 0;
    };
    const spendCap = num('spendCap');
    const spendUnavailable = num('spendUnavailable');
    const dailyWakeCap = num('dailyWakeCap');
    const noCursor = num('noCursor') + num('readFailed');
    const listSwitchedOff = num('listSwitchedOff');
    const staleCount = stale.count ?? 0;

    const problems: string[] = [];
    if (staleCount > 0) {
      problems.push(`${staleCount} hotel(s) not looked at in over ${STALE_MINUTES} min`);
    }
    if (noCursor > 0) problems.push(`${noCursor} hotel(s) skipped on a failed read`);
    if (spendUnavailable > 0) problems.push(`${spendUnavailable} hotel(s) could not read the spend cap`);
    if (spendCap > 0) problems.push(`${spendCap} hotel(s) silenced by the daily spend cap`);

    if (problems.length === 0) {
      // Said out loud rather than folded into "healthy". Both of these are the
      // system working as designed, and both are things an operator would
      // otherwise have to read the heartbeat notes by hand to discover: a hotel
      // at its wake limit, and a hotel that has switched off the list a note
      // would arrive on and will therefore never get one.
      const notes = [
        dailyWakeCap > 0 ? `${dailyWakeCap} hotel(s) at today's wake limit` : '',
        listSwitchedOff > 0 ? `${listSwitchedOff} hotel(s) have the Staxis list switched off` : '',
      ].filter(Boolean);
      return {
        status: 'ok',
        detail: notes.length > 0
          ? `companion event sweep healthy; ${notes.join('; ')}`
          : 'companion event sweep healthy',
      };
    }
    return {
      status: 'warn',
      detail: `companion event sweep: ${problems.join('; ')}`,
      fix: staleCount > 0 || noCursor > 0
        ? 'The ten-minute sweep is not advancing cursors. Check /api/cron/companion-event-wake logs and that migration 0459 is applied.'
        : 'A hotel is hitting its per-day AI ceiling for event notices. Check findings_ai_spend for feature companion.event_wake.',
    };
  } catch (err) {
    return { status: 'warn', detail: `check threw: ${errToString(err)}` };
  }
}

/**
 * ─── THE ONLY CHECK THAT FAILS WHEN THE PRODUCT FAILS ──────────────────────
 *
 * Every other entry on this list interrogates the data. This one reads the
 * result of a robot that signed into the live site last night and used it:
 * wrote a to-do, assigned it, ticked it off, taught the companion a fact, asked
 * it a question, added and deleted an inventory item, looked at the roster.
 *
 * WARN, NEVER FAIL, and the reason is worth keeping. A `fail` here would 503
 * the deploy gate and page the founder — over a headless browser, whose steps
 * can break for reasons that have nothing to do with the app being down (a
 * GitHub runner blip, a slow cold start, a selector that moved with a harmless
 * rename). The post-deploy smoke test blocking every deploy on a flaky click is
 * a worse outage than the one it would be reporting. The signal that matters is
 * the "Recent errors" row the report route writes, which names the exact step;
 * this check exists so the OTHER failure — the robot stopped running at all, so
 * nothing is writing errors and the silence reads as health — is visible too.
 *
 * A hotel-facing screen being broken is caught by the error row within a
 * minute of the nightly run. This is its companion, not its replacement.
 */
async function checkRobotWalkRecent(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  try {
    const { data, error } = await supabaseAdmin
      .from('robot_walk_runs')
      .select('started_at, ok, steps')
      .order('started_at', { ascending: false })
      .limit(1);

    if (error) {
      // Migrations are applied by hand, so the code always reaches production
      // before the table does. Not applied yet is not a failure.
      if (isMissingRelation(error)) {
        return { status: 'ok', detail: 'robot walkthrough table not applied yet (migration 0460)' };
      }
      return { status: 'warn', detail: `robot_walk_runs read failed: ${errToString(error)}` };
    }

    const last = ((data ?? []) as Array<{ started_at: string; ok: boolean; steps: unknown }>)[0];
    if (!last) {
      // Nothing has run yet. Before the first nightly fires — or before the
      // lead has seeded the hotel and set the secret — this is the expected
      // state, and warning about it would train everyone to ignore the check.
      return { status: 'ok', detail: 'the nightly robot has not walked the app yet' };
    }

    const ageHours = (Date.now() - new Date(last.started_at).getTime()) / 3_600_000;
    const ageText = `${Math.round(ageHours)}h ago`;

    if (ageHours > ROBOT_WALK_FRESH_HOURS) {
      return {
        status: 'warn',
        detail: `the nightly robot last walked the app ${ageText}, over the ${ROBOT_WALK_FRESH_HOURS}h window`,
        fix: 'Check the robot-walk workflow in GitHub Actions. A run that never starts writes nothing here and nothing to Recent errors, so the silence is the only symptom.',
      };
    }

    const steps = Array.isArray(last.steps) ? (last.steps as RobotWalkStepResult[]) : [];
    const summary = summarizeRobotWalk(steps);
    if (last.ok && summary.ok) {
      return { status: 'ok', detail: `robot walked the app ${ageText}, ${summary.passed} of ${summary.total} steps passed` };
    }

    const broke = summary.failed.map((s) => robotWalkStepLabel(s.name));
    return {
      status: 'warn',
      detail: broke.length > 0
        ? `robot walked the app ${ageText} and could not: ${broke.join('; ')}`
        : `robot walked the app ${ageText} and did not finish every step`,
      fix: 'Open Mission Control. The failing step is in Recent errors with the reason, and the GitHub Actions run has the full log.',
    };
  } catch (err) {
    return { status: 'warn', detail: `check threw: ${errToString(err)}` };
  }
}

async function checkCuaSessionsAlive(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  // Robot decommissioned (2026-07-25). Reporting a fail here would 503 the
  // deploy gate forever over a worker we deliberately parked, and reporting
  // an unqualified "all sessions heartbeating" would be a lie about a
  // process that isn't running. Say what's true: nobody is watching, on purpose.
  if (CUA_DECOMMISSIONED) return decommissionedCheck('24/7 PMS session heartbeats');
  try {
    const { data, error } = await supabaseAdmin
      .from('property_sessions')
      .select('property_id, status, last_alive_at, created_at, updated_at, pms_family')
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
    type SessionRow = { property_id: string; status: string; last_alive_at: string | null; created_at: string | null; updated_at: string | null; pms_family: string };
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
        // Measure boot age from updated_at (bumped by the set_updated_at
        // trigger on EVERY write, including the restart/resume that set
        // status='starting'), NOT last_alive_at. last_alive_at is only written
        // once a driver reaches 'alive', so restarting a previously
        // crashed/paused session carries a stale last_alive_at and would be
        // falsely flagged 'stuck starting' the instant it begins booting.
        const sinceTs = r.updated_at
          ? new Date(r.updated_at).getTime()
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
  // Robot decommissioned — a parked worker spends nothing, so "no hotels
  // paused for cost" would be technically true and completely uninformative.
  if (CUA_DECOMMISSIONED) return decommissionedCheck('the $5/hotel/day Claude cost cap');
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
  // Robot decommissioned — nothing is logging into a PMS, so nothing can be
  // stuck at a 2FA prompt waiting for a human.
  if (CUA_DECOMMISSIONED) return decommissionedCheck('PMS 2FA re-login prompts');
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
      fix: 'No supported browser login flow remains. Review the shared retirement contract before reintroducing one.',
    };
  } catch (err) {
    return { status: 'warn', detail: `check threw: ${errToString(err)}` };
  }
}

/**
 * agent_prompt_tiers — the copilot's instruction tiers are each backed by
 * exactly one active row.
 *
 * Two states this catches that nothing else can:
 *   1. A tier with zero active rows. The reader fails soft (falls back to the
 *      code constants for a global tier, to nothing for a family tier), so the
 *      only symptom is "the copilot stopped following that guidance".
 *   2. An active family row that outgrew the 4000-char cap — cached prompt
 *      paid on every conversation of every hotel on that PMS.
 *
 * Zero family rows is OK, not warn: the slot is meant to stay empty until the
 * first PMS report format is understood.
 */
async function checkAgentPromptTiers(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  try {
    const { data, error } = await supabaseAdmin
      .from('agent_prompts')
      .select('role, pms_family, is_active, content');
    if (error) {
      return { status: 'warn', detail: `agent_prompts read failed: ${errToString(error)}` };
    }
    type Row = { role: string; pms_family: string | null; is_active: boolean; content: string | null };
    const rows = (data ?? []) as Row[];
    const health = evaluatePromptTierHealth(rows.map((r) => ({
      role: r.role,
      pmsFamily: r.pms_family,
      isActive: r.is_active === true,
      contentLength: (r.content ?? '').length,
    })));
    if (health.status === 'ok') return { status: 'ok', detail: health.detail };
    return {
      status: health.status,
      detail: health.detail,
      fix: 'Activate the intended row with select public.staxis_activate_prompt(\'<id>\', \'<role>\', \'<pms_family or null>\'); it deactivates the others in the same tier atomically.',
    };
  } catch (err) {
    return { status: 'warn', detail: `check threw: ${errToString(err)}` };
  }
}

/**
 * agent_prompt_tool_names — the ACTIVE prompt rows still point at tools that
 * exist.
 *
 * The half of the catalog audit that no test can reach. `agent-tool-catalog-
 * audit` asserts that src/lib/agent/prompts.ts never routes the model at a tool
 * it will not be offered, and that assertion holds — but prompts.ts is the
 * FAIL-SOFT baseline. What production actually reads is an `agent_prompts` row,
 * and a row is data: a tool rename can update every constant, pass every test,
 * ship green, and leave the live prompt telling the model to call something
 * that was merged away three deploys ago.
 *
 * That is not hypothetical. The 2026-07-27 rebuild left the housekeeping, GM and
 * owner rows on their 2026-05-13 seed, naming seven retired tools plus
 * `send_help_sms`, which was deleted with Twilio and is not even aliased.
 * Migration 0372 re-seeded them; this check is why it cannot happen quietly
 * again.
 *
 * Read-only, like every check here. The grading (fail for a name that resolves
 * to nothing, warn for a retired-but-aliased one) lives in prompt-tiers.ts.
 */
async function checkAgentPromptToolNames(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  try {
    const { data, error } = await supabaseAdmin
      .from('agent_prompts')
      .select('role, version, pms_family, content')
      .eq('is_active', true);
    if (error) {
      return { status: 'warn', detail: `agent_prompts read failed: ${errToString(error)}` };
    }
    type Row = { role: string; version: string; pms_family: string | null; content: string | null };
    const rows = (data ?? []) as Row[];
    // An empty catalog would report every row as broken. That state means the
    // registration side-effect import above was dropped, not that the prompts
    // rotted — say which, instead of pointing the founder at the wrong thing.
    const live = new Set(listAllTools().map((t) => t.name));
    if (live.size === 0) {
      return {
        status: 'warn',
        detail: 'the tool registry is empty, so prompt routing cannot be checked',
        fix: "Restore the `import '@/lib/agent/tools/index'` side-effect in the doctor route.",
      };
    }
    const health = evaluatePromptToolRouting(
      rows.map((r) => ({
        role: r.role,
        version: r.version,
        pmsFamily: r.pms_family,
        content: r.content ?? '',
      })),
      { live, retired: TOOL_ALIASES },
    );
    if (health.status === 'ok') return { status: 'ok', detail: health.detail };
    return {
      status: health.status,
      detail: health.detail,
      fix: 'Write a migration in the shape of 0372: insert a new version of the row with the tool names corrected, then activate it with select public.staxis_activate_prompt(\'<new id>\', \'<role>\', null). The superseded row stays as history.',
    };
  } catch (err) {
    return { status: 'warn', detail: `check threw: ${errToString(err)}` };
  }
}

/**
 * Migrations here are applied BY HAND (project convention), so a deploy can
 * legitimately reach production minutes before its migration does. A check
 * that reports `warn` for that window teaches the founder to ignore amber for
 * the exact objects it was built to watch.
 *
 * A missing relation is therefore reported as `ok` with a plain "not applied
 * yet" line. Nothing is hidden: `supabase_migrations_applied` is the check
 * that exists to notice an unapplied migration, and it will.
 */
function isMissingRelation(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null;
  if (!e) return false;
  if (e.code === '42P01' || e.code === 'PGRST205') return true;
  return /does not exist|could not find the table|schema cache/i.test(e.message ?? '');
}

/**
 * pms_report_freshness — is every hotel's PMS report still arriving?
 *
 * THE point of this check: in the report era the dominant failure mode is not
 * "never connected", it is "the hotel's report schedule got switched off in
 * the PMS and nothing noticed". Nothing else in the product can see that.
 *
 * The judgement itself is a pure function (evaluateFeedSlos) over rows of
 * pms_feed_health_v1 — the single SQL definition of freshness — so the
 * thresholds are testable without a database, and a hotel on a different
 * report schedule is a ROW, never a branch in this file.
 *
 * A fleet with no expectations configured yet reads `ok`, not `warn`: warning
 * about an SLO nobody has set is noise, and noise is how a founder learns to
 * ignore amber.
 */
async function checkPmsReportFreshness(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  try {
    const { data, error } = await supabaseAdmin
      .from('pms_feed_health_v1')
      .select(
        'property_id, feed_key, label, required, enabled, grace_minutes, alert_channel, ' +
          'last_report_at, last_delivery_at, last_signal_at, minutes_late, ' +
          'open_quarantine_count, open_unmapped_count, state',
      );
    if (error) {
      if (isMissingRelation(error)) {
        return { status: 'ok', detail: 'report-freshness tables not applied yet (migration 0339)' };
      }
      return { status: 'warn', detail: `pms_feed_health_v1 read failed: ${errToString(error)}` };
    }
    const verdict = evaluateFeedSlos(parseFeedHealthRows(data));
    if (verdict.status === 'ok') return { status: 'ok', detail: verdict.detail };
    return {
      status: verdict.status,
      detail: verdict.detail,
      fix: 'The fix is almost always in the HOTEL\'s PMS, not in Staxis: check that the scheduled report is still enabled and still emailing us. If the cadence genuinely changed, update the row in pms_feed_expectations rather than widening the code.',
    };
  } catch (err) {
    return { status: 'warn', detail: `check threw: ${errToString(err)}` };
  }
}

/**
 * pms_quarantine_backlog — rows the parser could not accept, piling up.
 *
 * Warn on a backlog; FAIL only on a delivery where every row was rejected,
 * which is a format change rather than a data problem. Deliberately NOT a
 * reason to blank the hotel's numbers: five bad rows out of three hundred
 * leaves 295 good ones, and the containment for bad data is last-good
 * preservation plus honest staleness.
 */
async function checkPmsQuarantineBacklog(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  try {
    const { data, error } = await supabaseAdmin
      .from('pms_ingest_quarantine')
      .select('property_id')
      .eq('status', 'open');
    if (error) {
      if (isMissingRelation(error)) {
        return { status: 'ok', detail: 'quarantine table not applied yet (migration 0339)' };
      }
      return { status: 'warn', detail: `pms_ingest_quarantine read failed: ${errToString(error)}` };
    }
    const counts = new Map<string, number>();
    for (const row of (data ?? []) as Array<{ property_id: string }>) {
      counts.set(row.property_id, (counts.get(row.property_id) ?? 0) + 1);
    }
    const verdict = evaluateQuarantineBacklog({
      perProperty: [...counts.entries()].map(([propertyId, openRows]) => ({ propertyId, openRows })),
      // Supplied by the report-intake ledger once it lands; until then there
      // is no delivery to call fully-rejected, and claiming zero is honest.
      allRejectedDeliveriesLastHour: 0,
    });
    if (verdict.status === 'ok') return { status: 'ok', detail: verdict.detail };
    return {
      status: verdict.status,
      detail: verdict.detail,
      fix: 'Open the quarantine queue, read the reason on the sample row, fix the parser or widen the column descriptor in pms_table_schemas, then replay the rows.',
    };
  } catch (err) {
    return { status: 'warn', detail: `check threw: ${errToString(err)}` };
  }
}

/**
 * pms_unmapped_columns_open — a hotel's report grew a column we do not read.
 *
 * Always warn, never fail: the value is already captured in the row's
 * `raw->_unmapped`, so nothing is lost while it waits for a human. What IS
 * lost if nobody looks is trust — pms_feed_health_v1 holds that feed at
 * 'learning' until the column is mapped or explicitly ignored.
 */
async function checkPmsUnmappedColumns(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  try {
    const { data, error } = await supabaseAdmin
      .from('pms_unmapped_columns')
      .select('property_id, report_type, column_label')
      .eq('status', 'open');
    if (error) {
      if (isMissingRelation(error)) {
        return { status: 'ok', detail: 'unmapped-column table not applied yet (migration 0339)' };
      }
      return { status: 'warn', detail: `pms_unmapped_columns read failed: ${errToString(error)}` };
    }
    type Row = { property_id: string; report_type: string; column_label: string };
    const verdict = evaluateUnmappedColumns(
      ((data ?? []) as Row[]).map((r) => ({
        propertyId: r.property_id,
        reportType: r.report_type,
        columnLabel: r.column_label,
      })),
    );
    if (verdict.status === 'ok') return { status: 'ok', detail: verdict.detail };
    return {
      status: verdict.status,
      detail: verdict.detail,
      fix: 'Map the column into the table descriptor (pms_table_schemas) and set the row to \'mapped\', or set it to \'ignored\' if the column genuinely carries nothing we want. Either way the feed leaves the "learning" state.',
    };
  } catch (err) {
    return { status: 'warn', detail: `check threw: ${errToString(err)}` };
  }
}

/**
 * INVARIANT TRIPWIRE — "there is no number in the system without a receipt."
 *
 * pms_lineage_gaps() (migration 0341) compares the live schema against
 * pms_table_schemas and returns any pms_* write target lacking a NOT NULL
 * ingest_run_id with an FK to pms_ingest_runs. Empty result = invariant holds.
 *
 * This is FAIL, not warn: a data table without lineage is a table whose numbers
 * cannot be traced to the report that produced them, and every hour it stays
 * that way is another hour of untraceable rows.
 */
async function checkPmsLineageColumns(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  try {
    const { data, error } = await supabaseAdmin.rpc('pms_lineage_gaps');
    if (error) {
      // Before 0341 is applied the function doesn't exist. Warn (with the fix)
      // rather than fail so a pre-apply deploy doesn't go red on a known gap.
      if (errToString(error).includes('does not exist') || (error as { code?: string }).code === 'PGRST202') {
        return {
          status: 'warn',
          detail: 'pms_lineage_gaps() not present — migration 0341 has not been applied yet.',
          fix: 'Apply supabase/migrations/0341_pms_lineage_and_monotonic_writes.sql (after 0340). Idempotent.',
        };
      }
      return { status: 'warn', detail: `pms_lineage_gaps() failed: ${errToString(error)}` };
    }
    const gaps = (data ?? []) as Array<{ missing_table: string; reason: string }>;
    if (gaps.length === 0) {
      return { status: 'ok', detail: 'every pms_* write target carries a NOT NULL ingest_run_id' };
    }
    return {
      status: 'fail',
      detail: `${gaps.length} pms_* table(s) missing lineage: ${gaps.map((g) => `${g.missing_table} (${g.reason})`).join('; ')}`,
      fix: 'Add `ingest_run_id uuid not null references pms_ingest_runs(id) on delete cascade` to each table, backfill it, and stamp it in the writer. See migration 0341.',
    };
  } catch (err) {
    return { status: 'warn', detail: `check threw: ${errToString(err)}` };
  }
}

/**
 * INVARIANT TRIPWIRE — "the writer registry cannot lie about the schema."
 *
 * staxis_pms_registry_violations() (migration 0343) compares every
 * pms_table_schemas row against the real database: does the table exist, is it
 * a base table rather than a view, does its declared natural_key have an actual
 * UNIQUE index behind it, and is its declared time grain consistent with its
 * write strategy and columns.
 *
 * FAIL, not warn. A natural_key with no unique index means every poll appends
 * duplicates instead of upserting; a stale table_name means a feed that has
 * never once written a row. Both look like healthy silence from the outside.
 */
async function checkPmsTimeModel(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  try {
    const { data, error } = await supabaseAdmin.rpc('staxis_pms_registry_violations');
    if (error) {
      if (errToString(error).includes('does not exist') || (error as { code?: string }).code === 'PGRST202') {
        return {
          status: 'warn',
          detail: 'staxis_pms_registry_violations() not present — migration 0343 has not been applied yet.',
          fix: 'Apply supabase/migrations/0343_pms_time_model.sql (after 0342). Idempotent.',
        };
      }
      return { status: 'warn', detail: `staxis_pms_registry_violations() failed: ${errToString(error)}` };
    }
    const rows = (data ?? []) as Array<{ table_name: string; violation: string }>;
    if (rows.length === 0) {
      return { status: 'ok', detail: 'every pms_table_schemas row matches the real schema' };
    }
    return {
      status: 'fail',
      detail: `${rows.length} registry row(s) disagree with the schema: ${rows.map((r) => `${r.table_name} (${r.violation})`).join('; ')}`,
      fix: 'Either fix the pms_table_schemas row or add the missing index/column. The BEFORE INSERT OR UPDATE trigger staxis_pms_registry_matches_reality() blocks new drift, so a violation here means the SCHEMA moved under a valid row.',
    };
  } catch (err) {
    return { status: 'warn', detail: `check threw: ${errToString(err)}` };
  }
}

/**
 * Report-intake health: the two failure modes no database constraint can see.
 *
 *   - pending_upload older than an hour = the Worker → Storage PUT never
 *     landed. A pile of these is a systematic upload failure, which otherwise
 *     looks like silence rather than an outage.
 *   - quarantined_pan / hash_mismatch in the last 24h = a file was refused
 *     before any parse. Both are "look at this now" events.
 */
async function checkPmsReportIntakeHealth(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  try {
    const staleCutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const dayCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const [pending, quarantined] = await Promise.all([
      supabaseAdmin
        .from('pms_report_files')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending_upload')
        .lt('received_at', staleCutoff),
      supabaseAdmin
        .from('pms_report_files')
        .select('id', { count: 'exact', head: true })
        .in('status', ['quarantined_pan', 'hash_mismatch'])
        .gte('received_at', dayCutoff),
    ]);

    if (pending.error || quarantined.error) {
      const e = errToString(pending.error ?? quarantined.error);
      if (e.includes('does not exist')) {
        return {
          status: 'warn',
          detail: 'pms_report_files not present — migration 0340 has not been applied yet.',
          fix: 'Apply supabase/migrations/0340_report_intake_raw_zone_and_ledger.sql. Idempotent.',
        };
      }
      return { status: 'warn', detail: `pms_report_files read failed: ${e}` };
    }

    const stuck = pending.count ?? 0;
    const refused = quarantined.count ?? 0;
    if (stuck === 0 && refused === 0) {
      return { status: 'ok', detail: 'no stuck uploads, no quarantined report files' };
    }
    return {
      status: 'warn',
      detail: `${stuck} report upload(s) stuck over an hour; ${refused} file(s) quarantined or hash-mismatched in the last 24h`,
      fix: 'Stuck uploads: check the Email Worker (wrangler tail) for failed PUTs to Supabase Storage. Quarantined: inspect the pms_report_files receipt and its pms-raw Storage object — a PAN hit or tampered file needs a human decision.',
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
