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
 *   supabase_heartbeat      — scraper_status/heartbeat row exists and fresh
 *   supabase_dashboard      — scraper_status/dashboard row exists
 *   twilio_credentials      — Twilio REST API accepts our sid+token
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
  ['env_vars',             checkEnvVars],
  ['supabase_admin_auth',  checkSupabaseAdminAuth],
  ['supabase_heartbeat',   checkSupabaseHeartbeat],
  ['supabase_dashboard',   checkSupabaseDashboard],
  ['twilio_credentials',   checkTwilioCredentials],
  ['cron_secret_shape',    checkCronSecretShape],
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

/**
 * Serialize an unknown thrown value into a useful human string.
 *
 * `String(err)` on a plain object returns the string "[object Object]" —
 * which is exactly what started surfacing in the doctor output once we
 * moved off Firebase (whose SDK throws Error subclasses) onto Supabase
 * (whose `PostgrestError` is a plain object { message, details, hint, code,
 * status }). The old `err instanceof Error ? err.message : String(err)`
 * pattern silently dropped every real error message.
 *
 * This helper:
 *   - unwraps Error instances via .message
 *   - extracts .message from plain object-shaped errors (Supabase, Twilio,
 *     fetch responses that get rethrown as objects)
 *   - appends .code / .hint / .status when present so we can diagnose
 *     without a second round-trip
 *   - falls back to JSON.stringify before String() as a last resort so we
 *     never leak literal "[object Object]" into a dashboard again
 */
function errToString(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err !== null && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    const message = typeof e.message === 'string' ? e.message : null;
    const code    = typeof e.code    === 'string' ? e.code    : null;
    const hint    = typeof e.hint    === 'string' ? e.hint    : null;
    const status  = typeof e.status  === 'number' ? e.status  : null;
    if (message) {
      const extra: string[] = [];
      if (code)   extra.push(`code=${code}`);
      if (hint)   extra.push(`hint=${hint}`);
      if (status) extra.push(`status=${status}`);
      return extra.length ? `${message} (${extra.join(', ')})` : message;
    }
    // No .message — try to serialize the whole object. Guard against
    // circular refs, and trim to keep the response sane.
    try {
      const s = JSON.stringify(err);
      if (s && s !== '{}') return s.length > 300 ? `${s.slice(0, 300)}...` : s;
    } catch { /* fall through */ }
  }
  return String(err);
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
          detail: `check threw: ${err instanceof Error ? err.message : String(err)}`,
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
        detail: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
