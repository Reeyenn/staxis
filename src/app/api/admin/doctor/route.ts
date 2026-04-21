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
 *   3. Read-only. Never writes to Firestore, never sends SMS, never
 *      mutates state. Safe to hammer in a loop.
 *   4. Fast. Every check runs in parallel, aggressive timeouts, cached
 *      where reasonable.
 *
 * ─── What's checked ──────────────────────────────────────────────────────
 *
 *   env_vars            — every required env var is present and non-empty
 *   firebase_admin_auth — preflight Firestore read using the service
 *                         account key (catches stale/revoked keys)
 *   firestore_heartbeat — scraperStatus/heartbeat doc exists and is fresh
 *   firestore_dashboard — scraperStatus/dashboard doc exists
 *   twilio_credentials  — Twilio REST API accepts our sid+token
 *   cron_secret_shape   — CRON_SECRET is set and looks like a secret
 *                         (not accidentally left as "changeme")
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
import admin from '@/lib/firebase-admin';

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
  ['env_vars',            checkEnvVars],
  ['firebase_admin_auth', checkFirebaseAdminAuth],
  ['firestore_heartbeat', checkFirestoreHeartbeat],
  ['firestore_dashboard', checkFirestoreDashboard],
  ['twilio_credentials',  checkTwilioCredentials],
  ['cron_secret_shape',   checkCronSecretShape],
];

// ─── Individual checks ───────────────────────────────────────────────────

/**
 * All env vars the app needs at runtime. Grouped by owner so error messages
 * point to the right platform (Vercel UI vs Railway UI).
 *
 * If you add a new required env var anywhere in the Vercel code, ADD IT
 * HERE TOO — otherwise a missing var silently becomes undefined at runtime.
 */
const REQUIRED_ENV_VARS: Array<{ name: string; group: string }> = [
  // Firebase Admin (server-side)
  { name: 'FIREBASE_ADMIN_CLIENT_EMAIL',        group: 'firebase-admin' },
  { name: 'FIREBASE_ADMIN_PRIVATE_KEY',         group: 'firebase-admin' },
  { name: 'NEXT_PUBLIC_FIREBASE_PROJECT_ID',    group: 'firebase-admin' },
  // Firebase client (exposed to browser, prefixed NEXT_PUBLIC_)
  { name: 'NEXT_PUBLIC_FIREBASE_API_KEY',       group: 'firebase-client' },
  { name: 'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',   group: 'firebase-client' },
  { name: 'NEXT_PUBLIC_FIREBASE_APP_ID',        group: 'firebase-client' },
  // Twilio
  { name: 'TWILIO_ACCOUNT_SID',                 group: 'twilio' },
  { name: 'TWILIO_AUTH_TOKEN',                  group: 'twilio' },
  { name: 'TWILIO_PHONE_NUMBER',                group: 'twilio' },
  // Ops alert phone (without this, alerts silently no-op — the exact failure mode we're trying to prevent)
  { name: 'OPS_ALERT_PHONE',                    group: 'alerts' },
  // Shared secret for cron auth
  { name: 'CRON_SECRET',                        group: 'cron' },
];

async function checkEnvVars(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  const missing: string[] = [];
  const empty: string[] = [];

  for (const v of REQUIRED_ENV_VARS) {
    const val = process.env[v.name];
    if (val === undefined) {
      missing.push(v.name);
    } else if (val.trim() === '') {
      empty.push(v.name);
    }
  }

  if (missing.length === 0 && empty.length === 0) {
    return {
      status: 'ok',
      detail: `all ${REQUIRED_ENV_VARS.length} required env vars present`,
    };
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

async function checkFirebaseAdminAuth(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  // We don't import verifyFirebaseAuth here because it's memoized — and we
  // want this check to actually test auth on every call, not cache. So we
  // replicate the preflight: a cheap authenticated Firestore read.
  try {
    await admin.firestore().collection('scraperStatus').doc('heartbeat').get();
    return {
      status: 'ok',
      detail: 'service account key accepted by Firestore',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: 'fail',
      detail: `Firebase Admin auth failed: ${msg}`,
      fix: 'Service account key is likely stale/revoked. Firebase Console → Project Settings → Service Accounts → Generate new private key. Update BOTH Vercel (FIREBASE_ADMIN_PRIVATE_KEY) AND Railway (FIREBASE_PRIVATE_KEY). See RUNBOOKS.md → Firebase Key Rotation.',
    };
  }
}

async function checkFirestoreHeartbeat(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  try {
    const snap = await admin.firestore().collection('scraperStatus').doc('heartbeat').get();
    if (!snap.exists) {
      return {
        status: 'warn',
        detail: 'scraperStatus/heartbeat doc does not exist yet (scraper may not have run)',
        fix: 'Check Railway: is the hotelops-scraper service running? Look for "Firebase auth verified ✓" in Railway logs.',
      };
    }
    const data = snap.data() ?? {};
    const at = (data.at as { toDate?: () => Date } | undefined)?.toDate?.();
    if (!at) {
      return { status: 'warn', detail: 'heartbeat doc exists but has no "at" timestamp field' };
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
      detail: `Firestore read failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function checkFirestoreDashboard(): Promise<Omit<Check, 'name' | 'durationMs'>> {
  try {
    const snap = await admin.firestore().collection('scraperStatus').doc('dashboard').get();
    if (!snap.exists) {
      return {
        status: 'warn',
        detail: 'scraperStatus/dashboard doc does not exist yet (scraper may not have completed a pull)',
      };
    }
    const data = snap.data() ?? {};
    const pulledAt = (data.pulledAt as { toDate?: () => Date } | undefined)?.toDate?.();
    const errorCode = typeof data.errorCode === 'string' ? data.errorCode : null;

    // We don't alert here — that's scraper-health's job. Just surface state.
    if (errorCode) {
      return {
        status: 'warn',
        detail: `dashboard errorCode=${errorCode} (scraper-health handles alerting — this is just FYI)`,
      };
    }
    if (pulledAt) {
      const minAgo = Math.floor((Date.now() - pulledAt.getTime()) / 60_000);
      return { status: 'ok', detail: `last successful pull ${minAgo} min ago` };
    }
    return { status: 'warn', detail: 'dashboard doc exists but has no pulledAt' };
  } catch (err) {
    return {
      status: 'fail',
      detail: `Firestore read failed: ${err instanceof Error ? err.message : String(err)}`,
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
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'fail', detail: `Twilio API call failed: ${msg}` };
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
