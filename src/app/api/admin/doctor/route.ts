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
import { requireCronSecret } from '@/lib/api-auth';
import { createHash } from 'crypto';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

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
  ['supabase_admin_auth',            checkSupabaseAdminAuth],
  ['supabase_jwt_expiry',            checkSupabaseJwtExpiry],
  ['supabase_anon_key',              checkSupabaseAnonKeyShape],
  ['supabase_rls_enabled',           checkSupabaseRlsEnabled],
  ['supabase_realtime_publication',  checkSupabaseRealtimePublication],
  ['supabase_heartbeat',             checkSupabaseHeartbeat],
  ['supabase_dashboard',             checkSupabaseDashboard],
  // Schema-drift detection: every migration in /supabase/migrations/ must be
  // recorded in applied_migrations on the live DB. Catches the "deployed
  // code that calls a column added in 00NN before 00NN was applied" failure
  // mode that otherwise surfaces as cryptic 'relation … not found' 500s.
  ['supabase_migrations_applied',    checkAppliedMigrations],
  ['scraper_csv_pull',               checkScraperCsvPull],
  ['scraper_health_cron',            checkScraperHealthCronLiveness],
  ['twilio_credentials',             checkTwilioCredentials],
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
  ['watchdog_alert_path',            checkWatchdogAlertPath],
  ['scraper_pull_latency',           checkScraperPullLatency],
  // Smoke-detectors for silent ML feature failures. Both paths fall back
  // to NULL fields and let the housekeeper tap "succeed" — the only way
  // we know they fired is by reading these counters.
  ['ml_occupancy_capture_failures',  checkOccupancyCaptureFailures],
  ['ml_feature_derivation_failures', checkFeatureDerivationFailures],
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
  // Rate limiter probe — pairs with src/lib/api-ratelimit.ts. If the
  // staxis_api_limit_hit RPC errors at request time, the limiter
  // fails OPEN (production safety: a Postgres blip must not block
  // shift SMS). Doctor surfaces this hidden state: if our probe
  // round-trip fails here, we know the live SMS path is fail-opening
  // every request. May 2026 audit pass-3 closure.
  ['api_limits_writable',            checkApiLimitsWritable],
  // Billing config — fails LOUD on the half-configured state where some
  // Stripe vars are set and others aren't. Warns when none are set
  // (pre-launch trial-only mode). Fails when keys are clearly malformed.
  ['stripe_billing_configured',      checkStripeBillingConfigured],
  // Error tracking — Sentry no-ops gracefully when DSN missing, but a
  // malformed DSN means errors silently disappear. Fail on bad shape.
  ['sentry_dsn_shape',               checkSentryDsnShape],
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
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
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
 * Critical tables where a disabled RLS policy = data leak (anon users can
 * read every row across every property). If this check flips to fail, stop
 * everything and fix immediately.
 *
 * Adding a new user-facing table? Add it here too.
 */
const RLS_REQUIRED_TABLES = [
  'accounts',
  'properties',
  'staff',
  'rooms',
  'shift_confirmations',
  'schedule_assignments',
  'plan_snapshots',
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
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const tok = process.env.TWILIO_AUTH_TOKEN;
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
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const tok = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER || process.env.TWILIO_PHONE_NUMBER;
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
  const phone = process.env.MANAGER_PHONE || process.env.OPS_ALERT_PHONE;
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
  const secret = process.env.CRON_SECRET;
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
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
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
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
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
  const REQUIRED_TABLES = [
    'staff', 'rooms', 'work_orders', 'preventive_tasks', 'landscaping_tasks',
    'inventory', 'inspections', 'handoff_logs', 'guest_requests', 'plan_snapshots',
    'schedule_assignments', 'shift_confirmations', 'manager_notifications', 'scraper_status',
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
 * so it can read process.env.CRON_SECRET locally; Railway writes the first
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
    const vercelSecret = process.env.CRON_SECRET;
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
 * `EXPECTED_MIGRATIONS` is the source of truth maintained alongside the
 * SQL files. Add a new entry whenever you add a new migration file.
 *
 * Behavior:
 *   - applied_migrations table missing entirely → warn (0015 itself not applied yet)
 *   - subset applied → fail with the specific missing version list
 *   - all applied → ok, with the count
 *   - extras in DB not in code → warn (someone applied a hand-rolled migration)
 */
export const EXPECTED_MIGRATIONS: ReadonlyArray<string> = [
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
  '0079', '0080', '0081', '0082', '0083',
  '0084', '0085', '0086', '0087', '0088', '0089',
  '0090', '0091', '0092', '0093', '0094',
  '0095', '0096', '0097', '0098',
];
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
    const missing = EXPECTED_MIGRATIONS.filter(v => !applied.has(v));
    const unexpected = [...applied].filter(v => !EXPECTED_MIGRATIONS.includes(v));
    if (missing.length > 0) {
      return {
        status: 'fail',
        detail: `${missing.length} migration(s) missing from live DB: ${missing.join(', ')}. Code expects all ${EXPECTED_MIGRATIONS.length} to be applied.`,
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
    const TZ = 'America/Chicago';
    const nowMs = Date.now();
    // Mirror scraper's localHour() exactly. Intl handles CDT/CST DST.
    const localHourNow = parseInt(
      new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: TZ }).format(new Date()),
      10,
    );
    const inScraperWindow = localHourNow >= SCRAPER_WINDOW_START && localHourNow < SCRAPER_WINDOW_END;
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
  return checkLayerPredictionsFresh({
    layer: 'supply',
    table: 'supply_predictions',
    dateCol: 'date',
    fix: 'No supply predictions for today. Likely root cause matches demand (shared training prereqs). See checkMlDemandPredictionsFresh "fix" guidance.',
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
  { name: 'scraper-health',          cadenceHours: 0.25, description: '15-min liveness watcher (Vercel native cron)' },
  { name: 'process-sms-jobs',        cadenceHours: 5 / 60, description: '5-min SMS jobs queue worker (Vercel native cron)' },
  { name: 'seal-daily',              cadenceHours: 1,    description: 'hourly per-property daily-seal' },
  // Daily
  { name: 'ml-run-inference',        cadenceHours: 24,   description: 'daily demand+supply+optimizer predictions' },
  { name: 'ml-predict-inventory',    cadenceHours: 24,   description: 'daily inventory predictions for tomorrow' },
  { name: 'ml-aggregate-priors',     cadenceHours: 24,   description: 'daily cross-fleet cohort prior aggregation' },
  { name: 'ml-shadow-evaluate',      cadenceHours: 24,   description: 'daily shadow-model promote/reject pass' },
  { name: 'purge-old-error-logs',    cadenceHours: 24,   description: 'daily error_logs retention sweep' },
  { name: 'expire-trials',           cadenceHours: 24,   description: 'daily trial-expiration flip' },
  // Weekly
  { name: 'ml-train-demand',         cadenceHours: 168,  description: 'weekly demand training (Sunday)' },
  { name: 'ml-train-supply',         cadenceHours: 168,  description: 'weekly supply training (Sunday)' },
  { name: 'ml-train-inventory',      cadenceHours: 168,  description: 'weekly inventory training (Sunday)' },
  { name: 'scraper-weekly-digest',   cadenceHours: 168,  description: 'weekly scraper health digest SMS' },
];

async function checkCronHeartbeatsFresh(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  try {
    const { data: rows, error } = await supabaseAdmin
      .from('cron_heartbeats')
      .select('cron_name, last_success_at');
    if (error) {
      return { status: 'warn', detail: `cron_heartbeats read failed: ${errToString(error)}` };
    }
    const byName = new Map<string, string>();
    for (const r of (rows ?? []) as Array<{ cron_name: string; last_success_at: string }>) {
      byName.set(r.cron_name, r.last_success_at);
    }
    const now = Date.now();
    const failed: string[] = [];  // hard-stale: >1.5× warn threshold → real problem
    const warned: string[] = [];  // soft-stale: between tolerance and 1.5× → likely transient
    const missing: string[] = [];
    for (const c of EXPECTED_CRONS) {
      const last = byName.get(c.name);
      if (!last) {
        missing.push(c.name);
        continue;
      }
      const ageHours = (now - new Date(last).getTime()) / (60 * 60 * 1000);
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
    return {
      status: 'ok',
      detail: `All ${EXPECTED_CRONS.length} expected crons have fresh heartbeats`,
    };
  } catch (err) {
    return { status: 'warn', detail: `cron-heartbeats check threw: ${errToString(err)}` };
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

// ─── Handler ─────────────────────────────────────────────────────────────

async function runAllChecks(): Promise<DoctorReport> {
  const startedAt = Date.now();

  // Run every check in parallel. Each check catches its own errors so one
  // exploding check can't kill the rest.
  const results = await Promise.all(
    checks.map(async ([name, fn]): Promise<Check> => {
      const t0 = Date.now();
      try {
        const res = await fn();
        return { name, durationMs: Date.now() - t0, ...res };
      } catch (err) {
        return {
          name,
          status: 'fail',
          detail: `check threw: ${errToString(err)}`,
          durationMs: Date.now() - t0,
        };
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
    vercelRegion: process.env.VERCEL_REGION,
    vercelEnv:    process.env.VERCEL_ENV,
    commitSha:    process.env.VERCEL_GIT_COMMIT_SHA,
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
  const sk = process.env.STRIPE_SECRET_KEY ?? '';
  const wh = process.env.STRIPE_WEBHOOK_SECRET ?? '';
  const pr = process.env.STRIPE_PRICE_ID ?? '';

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
  if (sk.startsWith('sk_test_') && process.env.VERCEL_ENV === 'production') {
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
 * sentry_dsn_shape — error tracking config check.
 *
 * Same all-or-nothing pattern as Stripe: missing is OK (Sentry no-ops
 * gracefully via the sentry.*.config.ts initializers), present-but-malformed
 * is a fail because errors then silently disappear into the void.
 */
async function checkSentryDsnShape(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  const dsnServer = process.env.SENTRY_DSN ?? '';
  const dsnClient = process.env.NEXT_PUBLIC_SENTRY_DSN ?? '';
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

export async function GET(req: NextRequest) {
  // Same auth pattern as cron routes. Permissive when CRON_SECRET is unset
  // so initial bootstrap works; strict once it's configured. Timing-safe
  // Bearer compare via the shared helper (crypto.timingSafeEqual).
  const unauth = requireCronSecret(req);
  if (unauth) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  try {
    const report = await runAllChecks();
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
