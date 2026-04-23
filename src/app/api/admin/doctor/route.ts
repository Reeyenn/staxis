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
  ['env_vars',              checkEnvVars],
  ['supabase_admin_auth',   checkSupabaseAdminAuth],
  ['supabase_jwt_expiry',   checkSupabaseJwtExpiry],
  ['supabase_anon_key',     checkSupabaseAnonKeyShape],
  ['supabase_rls_enabled',  checkSupabaseRlsEnabled],
  ['supabase_heartbeat',    checkSupabaseHeartbeat],
  ['supabase_dashboard',    checkSupabaseDashboard],
  ['scraper_health_cron',   checkScraperHealthCronLiveness],
  ['twilio_credentials',    checkTwilioCredentials],
  ['alert_phone_shape',     checkAlertPhoneShape],
  ['cron_secret_shape',     checkCronSecretShape],
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
    summary,
    checks: results,
  };
}

export async function GET(req: NextRequest) {
  // Same auth pattern as cron routes. Permissive when CRON_SECRET is unset
  // so initial bootstrap works; strict once it's configured.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }
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
