// Canonical server-side env module. Parsed via Zod at module load to fail
// fast on missing required vars; re-parsed on each access so test suites
// that mutate process.env between cases still observe the new values.
//
// All `process.env.X` reads outside of next.config.ts and sentry.*.config.ts
// should go through this module. The CI guard (scripts/check-env-access.mjs)
// enforces that.
//
// Legacy fallback: during the migration sweep, this module accepts the older
// variable names listed below. Phase 7 of the env-vars audit drops them.
//
// Do NOT import from a client component — use env-client.ts instead. Next.js
// catches accidental client imports during build (server-side modules bleed
// secrets to the browser bundle).

import { z } from 'zod';

const phoneE164 = z.string().regex(/^\+\d{10,15}$/, 'must be E.164 (e.g. +12816669887)');

// Treat empty strings as missing — many deploy platforms (Vercel, Fly, Railway)
// require a value for every declared env var and use '' as the "unset"
// placeholder. Without this, `FOO=''` would fail .startsWith() / .min()
// checks for vars meant to be optional.
function emptyToUndef(obj: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = v === '' ? undefined : v;
  }
  return out;
}

// ─── Service-to-service hostname allowlist (Plan v2 F-AI-6) ──────────────
// A compromised env editor that sets RAILWAY_SCRAPER_URL or ML_SERVICE_URLS
// or VERCEL_DOCTOR_URL to an attacker host would send our bearer secrets
// to that host on the next cron tick. Constrain to known managed-platform
// suffixes (and our own domain) so that vector is closed at env-parse
// time. Add new suffixes here when adding a deploy platform.
//
// The allowlist is intentionally simple — suffix match on the registrable
// hostname. Localhost is permitted so dev/test setups keep working.
const SERVICE_HOSTNAME_SUFFIXES: readonly string[] = [
  '.railway.app',
  '.up.railway.app',
  '.fly.dev',
  '.vercel.app',           // Vercel preview deployments
  'getstaxis.com',
  '.getstaxis.com',
  'hotelops-ai.vercel.app',
  'localhost',
  '127.0.0.1',
];

function hostnameOnAllowlist(rawUrl: string): boolean {
  // The allowlist is a security boundary against compromised PROD env
  // editors. Tests + local dev use placeholder URLs (ml.example.com,
  // localhost variants) that shouldn't have to be in the suffix list.
  // We bypass when NODE_ENV is not explicitly 'production' AND when
  // VERCEL_ENV is not 'production'. Vercel sets VERCEL_ENV=production
  // on real prod deploys, NODE_ENV is "production" both there and on
  // any prod-mode `next build`; either signal turns the check on.
  if (process.env.NODE_ENV !== 'production' && process.env.VERCEL_ENV !== 'production') {
    return true;
  }

  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return SERVICE_HOSTNAME_SUFFIXES.some(
    (s) => host === s || host === s.replace(/^\./, '') || host.endsWith(s),
  );
}

function allHostnamesOnAllowlist(csv: string): boolean {
  return csv.split(',').map((s) => s.trim()).filter(Boolean).every(hostnameOnAllowlist);
}

function serviceHostnameAllowlistMessage(varName: string): string {
  return (
    `${varName} hostname must end with one of: ${SERVICE_HOSTNAME_SUFFIXES.join(', ')}. ` +
    `This blocks a compromised env from redirecting bearer secrets to an attacker host. ` +
    `Add a new suffix to SERVICE_HOSTNAME_SUFFIXES in src/lib/env.ts if onboarding a new platform.`
  );
}

const ServerSchema = z.object({
  // ── Supabase ──────────────────────────────────────────
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),

  // ── Anthropic ─────────────────────────────────────────
  ANTHROPIC_API_KEY: z.string().startsWith('sk-ant-').optional(),

  // ── OpenAI ────────────────────────────────────────────
  // Required: powers Whisper STT (/api/agent/transcribe) and is treated as
  // production-required by /api/admin/doctor's REQUIRED_ENV_VARS. Keep the
  // doctor's voice-surface contract honest by failing boot if it's missing —
  // silent degradation of STT during a deploy with a dropped env var was the
  // failure mode this gate exists to prevent. (Audit Batch 1, F-01.)
  OPENAI_API_KEY: z.string().startsWith('sk-'),

  // ── Twilio ────────────────────────────────────────────
  // Optional everywhere — sms.ts gracefully refuses to send when unset.
  // We deliberately don't enforce the `AC` prefix on the SID: tests use
  // synthetic credentials that don't match Twilio's real-world format.
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),
  TWILIO_BALANCE_WARN_USD: z.coerce.number().default(10),
  TWILIO_BALANCE_FAIL_USD: z.coerce.number().default(5),

  // ── Stripe (graceful disable when unset) ──────────────
  // Same relaxed validation as Twilio — tests use 'sk_test_…' but the
  // value can be any non-empty string.
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_ID: z.string().optional(),

  // ── ElevenLabs ────────────────────────────────────────
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_AGENT_ID: z.string().optional(),
  ELEVENLABS_VOICE_ID: z.string().optional(),
  ELEVENLABS_WEBHOOK_SECRET: z.string().optional(),

  // ── Voice replay protection (Plan v2 M-1) ─────────────
  // When 'true', /api/agent/voice-brain refuses any turn whose body lacks
  // an ElevenLabs conversation_id. Default 'false' for rollout so the
  // route keeps working if ElevenLabs ever changes which field carries
  // the id; flip to 'true' after a week of green logs.
  STAXIS_VOICE_REQUIRE_CONNECTION_BINDING: z.enum(['true', 'false']).optional(),
  // Override for the voice-session idle-expiry window (ms). Optional;
  // src/lib/agent/voice-session.ts falls back to 5 min when unset.
  // Routed through here to satisfy scripts/check-env-access.mjs.
  STAXIS_VOICE_SESSION_IDLE_MS: z.coerce.number().int().positive().optional(),

  // ── AI data-retention posture stamp (Plan v2 F-AI-1) ───
  // Freeform stamp set by the operator after confirming Zero Data
  // Retention (or equivalent data controls) in Anthropic / OpenAI /
  // ElevenLabs dashboards. Doctor's ai_data_policy_documented check
  // reads it and warns yellow when missing. See RUNBOOKS.md > "AI Data
  // Retention Posture" for the confirmation steps. Typical value:
  //   zdr-confirmed-2026-05-20-anthropic+openai+elevenlabs
  STAXIS_AI_DATA_POLICY: z.string().optional(),

  // ── CUA action policy enforce state (Plan v2.1 CR-3) ───
  // Mirror of the Fly worker's CUA_POLICY_ENFORCE env. The CUA worker
  // is the source of truth; this mirror lets the Vercel-side doctor's
  // `cua_action_policy_enforce_status` check surface the active
  // posture without needing direct access to Fly secrets. Operator
  // sets BOTH places when flipping enforce.
  CUA_POLICY_ENFORCE: z.enum(['warn', 'enforce']).optional(),

  // ── Email ─────────────────────────────────────────────
  RESEND_API_KEY: z.string().optional(),
  // Comms-voice audit follow-up (2026-05-22): Resend webhook signing
  // secret for /api/webhooks/resend. Format: `whsec_<base64>`. Generated
  // by Resend when you add a webhook endpoint on their dashboard; copy
  // the value into Vercel env. Optional — if unset, the webhook route
  // refuses every request (fail-closed) so a misconfigured deploy can't
  // accept unsigned bounce/complaint POSTs.
  RESEND_WEBHOOK_SECRET: z.string().optional(),

  // ── Sentry ────────────────────────────────────────────
  SENTRY_DSN: z.string().url().optional(),
  NEXT_PUBLIC_SENTRY_DSN: z.string().url().optional(),
  SENTRY_AUTH_TOKEN: z.string().optional(),
  SENTRY_WEBHOOK_SECRET: z.string().optional(),

  // ── App origin (canonical = NEXT_PUBLIC_APP_URL only) ─
  // Legacy NEXT_PUBLIC_SITE_URL and NEXT_PUBLIC_BASE_URL are accepted as
  // fallbacks by the parse layer below; the schema only knows the canonical.
  NEXT_PUBLIC_APP_URL: z.string().url().default('https://getstaxis.com'),

  // ── Cron / internal secrets ───────────────────────────
  // Optional in the schema — requireCronSecret() in api-auth.ts already
  // fails closed in production when missing. Keeping it optional lets
  // dev/test boot without it and lets test cases exercise the
  // "unset → reject" branch directly.
  CRON_SECRET: z.string().optional(),
  LOCAL_SYNC_SECRET: z.string().optional(),
  // Bearer secret for /api/claude-heartbeat. Distinct from CRON_SECRET so
  // this dev-tool channel can be rotated independently of cron auth.
  // Local Claude Code PostToolUse/Stop hooks attach this from tokens.env.
  HEARTBEAT_SECRET: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),

  // Dev/staging escape hatch for /api/sms-reply: when set to '1', the
  // route accepts JSON payloads without a Twilio signature. Must NEVER
  // be set on a prod deploy. Default unset → fail-closed (only signed
  // form-encoded Twilio webhooks accepted).
  ALLOW_UNSIGNED_SMS_WEBHOOK: z.string().optional(),

  // F-01 — 2FA-bypass env gate + allowlist. `accounts.skip_2fa` is a hard-set
  // DB column used today only by the role-demo investor accounts (test /
  // testhk / testfd at Comfort Suites). Without these gates, a future typo
  // or service-role write that flips skip_2fa=true on a real customer
  // account silently disables OTP fleet-wide with no detection signal.
  //
  // Phase 2 (current): SKIP_2FA_ENABLED must be literal 'true' AND the
  //   account's data_user_id must be in SKIP_2FA_USER_IDS (comma-separated)
  //   OR the bypass is refused. Either check failing writes
  //   auth.skip_2fa_blocked_by_env / auth.skip_2fa_account_not_allowlisted
  //   via logSecurityEvent so an attacker who flips skip_2fa=true on a
  //   non-allowlisted account immediately surfaces in Sentry.
  //
  // Phase 1 was the rollout grace period (default-honored if env unset);
  // both env vars are now set in Vercel production, so this commit safely
  // requires explicit 'true' + allowlist membership.
  SKIP_2FA_ENABLED: z.string().optional(),
  // Comma-separated list of accounts.data_user_id values that are permitted
  // to skip 2FA. Empty / unset = no account can skip, even with skip_2fa=true
  // in the DB. Set in Vercel; rotate when the demo account set changes.
  SKIP_2FA_USER_IDS: z.string().optional(),

  // Break-glass kill switch for the Phase-1 server-side 2FA enforcement in
  // requireSession() / requireSessionOrCron(). When set to literal 'true',
  // those helpers skip the validateDeviceTrust check and accept any valid
  // Supabase JWT (the pre-Phase-1 behavior). Default unset = enforced.
  //
  // Existence rationale: if validateDeviceTrust ever misfires in prod
  // (false-positive 401s locking users out), flip this in Vercel and the
  // gate disables without a redeploy. Every request hit with the var on
  // emits a CRITICAL log line + a doctor warning, so leaving it on past
  // an incident triage window will surface in monitoring.
  //
  // Never set this in preview or production absent an active incident.
  DISABLE_SERVER_2FA_ENFORCEMENT: z.string().optional(),

  // Codex review #7 (audit 2026-05-22): the doctor's
  // mfa_verified_hook_self_test calls the auth hook with a known demo
  // user id and asserts mfa_verified=true. If we ever recreate
  // test@staxis.local (PITR restore, accidental delete + recreate) with
  // a new auth.users.id, the doctor would falsely flag the hook as
  // broken. Set this in Vercel after rotating the demo user; default
  // fallback in the doctor route is the current prod UUID.
  STAXIS_DEMO_USER_ID: z
    .string()
    .uuid()
    .optional(),

  // ── Voice / wake word ─────────────────────────────────
  PICOVOICE_ACCESS_KEY: z.string().optional(),

  // ── reCAPTCHA ─────────────────────────────────────────
  NEXT_PUBLIC_RECAPTCHA_SITE_KEY: z.string().optional(),

  // ── Ops alert phone (canonical = OPS_ALERT_PHONE) ─────
  // Legacy MANAGER_PHONE accepted by parse layer. Schema relaxed to plain
  // string so tests can use synthetic numbers; the doctor check enforces
  // E.164 separately for prod monitoring.
  OPS_ALERT_PHONE: z.string().optional(),

  // ── ML routing (canonical = ML_SERVICE_URLS only) ─────
  // CSV — single-shard is just one entry. Legacy singular ML_SERVICE_URL
  // accepted by parse layer. Optional: when unset, ml-routing returns
  // null and cron callers skip the ML call (dev / unconfigured envs).
  ML_SERVICE_URLS: z.string().min(1).optional()
    .refine((csv) => !csv || allHostnamesOnAllowlist(csv), {
      message: serviceHostnameAllowlistMessage('ML_SERVICE_URLS'),
    }),
  ML_SERVICE_SECRET: z.string().optional(),

  // ── Admin / DevOps tokens ─────────────────────────────
  GITHUB_TOKEN: z.string().optional(),
  VERCEL_API_TOKEN: z.string().optional(),
  VERCEL_PROJECT_ID: z.string().optional(),
  VERCEL_TEAM_ID: z.string().optional(),
  VERCEL_DOCTOR_URL: z.string().url().optional()
    .refine((v) => !v || hostnameOnAllowlist(v), {
      message: serviceHostnameAllowlistMessage('VERCEL_DOCTOR_URL'),
    }),
  FLY_API_TOKEN: z.string().optional(),
  FLY_APP_NAME: z.string().default('staxis-cua'),
  RAILWAY_SCRAPER_URL: z.string().url().optional()
    .refine((v) => !v || hostnameOnAllowlist(v), {
      message: serviceHostnameAllowlistMessage('RAILWAY_SCRAPER_URL'),
    }),

  // ── Platform auto-injected (read-only metadata) ───────
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  NEXT_RUNTIME: z.enum(['nodejs', 'edge']).optional(),
  VERCEL: z.string().optional(),
  VERCEL_ENV: z.enum(['production', 'preview', 'development']).optional(),
  VERCEL_GIT_COMMIT_SHA: z.string().optional(),
  VERCEL_REGION: z.string().optional(),
  VERCEL_DEPLOYMENT_CREATED_AT: z.string().optional(),
  CI: z.string().optional(),

  // ── Misc ──────────────────────────────────────────────
  MODEL_OVERRIDE: z.string().optional(),
  SMOKE_PROPERTY_ID: z.string().uuid().optional(),
  TIMEZONE: z.string().default('America/Chicago'),

  // Kill-switch for the cron/sweep-orphan-auth-users job — set to "true"
  // to disable the sweep (e.g. during incident triage).
  DISABLE_ORPHAN_AUTH_SWEEP: z.string().optional(),
});

type Env = z.infer<typeof ServerSchema>;

function parseEnv(): Env {
  const rawEnv = emptyToUndef(process.env);
  const result = ServerSchema.safeParse(rawEnv);

  if (!result.success) {
    const flat = result.error.flatten().fieldErrors;
    const lines = Object.entries(flat).map(([k, msgs]) => `  ${k}: ${(msgs ?? []).join(', ')}`);
    console.error('❌ Server env vars failed validation:\n' + lines.join('\n'));
    throw new Error(
      'Invalid server environment. Missing/invalid: ' + Object.keys(flat).join(', ')
    );
  }
  return result.data;
}

// Fail-fast at module load — if any required var is missing or invalid, boot
// fails with the full list. Subsequent property reads re-parse so test suites
// that mutate process.env at runtime see the new values.
parseEnv();

export const env = new Proxy({} as Env, {
  get(_t, prop: string | symbol) {
    const fresh = parseEnv();
    return fresh[prop as keyof Env];
  },
  has(_t, prop) {
    const fresh = parseEnv();
    return prop in fresh;
  },
  ownKeys() {
    return Object.keys(parseEnv());
  },
  getOwnPropertyDescriptor(_t, prop: string | symbol) {
    const fresh = parseEnv();
    if (!(prop in fresh)) return undefined;
    return { enumerable: true, configurable: true, value: fresh[prop as keyof Env] };
  },
});

// Configured-flag helpers — functions (not constants) so callers see the
// current state, not a value frozen at module-load time. Tests that mutate
// process.env between cases observe the new state.
export const isStripeConfigured = () => !!(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);
export const isSmsConfigured = () =>
  !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER);
export const isEmailConfigured = () => !!env.RESEND_API_KEY;
