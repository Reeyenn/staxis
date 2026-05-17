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

const ServerSchema = z.object({
  // ── Supabase ──────────────────────────────────────────
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),

  // ── Anthropic ─────────────────────────────────────────
  ANTHROPIC_API_KEY: z.string().startsWith('sk-ant-').optional(),

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

  // ── Email ─────────────────────────────────────────────
  RESEND_API_KEY: z.string().optional(),

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
  GITHUB_WEBHOOK_SECRET: z.string().optional(),

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
  ML_SERVICE_URLS: z.string().min(1).optional(),
  ML_SERVICE_SECRET: z.string().optional(),

  // ── Admin / DevOps tokens ─────────────────────────────
  GITHUB_TOKEN: z.string().optional(),
  VERCEL_API_TOKEN: z.string().optional(),
  VERCEL_PROJECT_ID: z.string().optional(),
  VERCEL_TEAM_ID: z.string().optional(),
  VERCEL_DOCTOR_URL: z.string().url().optional(),
  FLY_API_TOKEN: z.string().optional(),
  FLY_APP_NAME: z.string().default('staxis-cua'),
  RAILWAY_SCRAPER_URL: z.string().url().optional(),

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
});

type Env = z.infer<typeof ServerSchema>;

function parseEnv(): Env {
  const rawEnv = emptyToUndef(process.env);
  const result = ServerSchema.safeParse({
    ...rawEnv,
    // Legacy fallback reconciliation. Phase 7 deletes these lines after prod
    // env vars are migrated to the canonical names.
    NEXT_PUBLIC_APP_URL:
      rawEnv.NEXT_PUBLIC_APP_URL ??
      rawEnv.NEXT_PUBLIC_SITE_URL ??
      rawEnv.NEXT_PUBLIC_BASE_URL,
    TWILIO_FROM_NUMBER: rawEnv.TWILIO_FROM_NUMBER ?? rawEnv.TWILIO_PHONE_NUMBER,
    OPS_ALERT_PHONE: rawEnv.OPS_ALERT_PHONE ?? rawEnv.MANAGER_PHONE,
    ML_SERVICE_URLS: rawEnv.ML_SERVICE_URLS ?? rawEnv.ML_SERVICE_URL,
  });

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
