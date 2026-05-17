// Canonical server-side env module. Parsed once at module-load via Zod;
// failure aggregates every missing/invalid var into a single error so a
// boot failure tells you everything that's wrong, not just the first miss.
//
// All `process.env.X` reads outside of next.config.ts and sentry.*.config.ts
// should go through this module. A CI guard enforces that.
//
// Legacy fallback: during the migration sweep, this module accepts the older
// variable names listed below. Phase 7 of the env-vars audit drops them.
//
// Do NOT import from a client component. The `server-only` import below
// throws at build time if you do; use `env-client.ts` instead.

import 'server-only';
import { z } from 'zod';

const phoneE164 = z.string().regex(/^\+\d{10,15}$/, 'must be E.164 (e.g. +12816669887)');

const ServerSchema = z.object({
  // ── Supabase ──────────────────────────────────────────
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),

  // ── Anthropic ─────────────────────────────────────────
  ANTHROPIC_API_KEY: z.string().startsWith('sk-ant-').optional(),

  // ── Twilio ────────────────────────────────────────────
  TWILIO_ACCOUNT_SID: z.string().startsWith('AC').optional(),
  TWILIO_AUTH_TOKEN: z.string().min(20).optional(),
  TWILIO_FROM_NUMBER: phoneE164.optional(),
  TWILIO_BALANCE_WARN_USD: z.coerce.number().default(10),
  TWILIO_BALANCE_FAIL_USD: z.coerce.number().default(5),

  // ── Stripe (graceful disable when unset) ──────────────
  STRIPE_SECRET_KEY: z.string().startsWith('sk_').optional(),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith('whsec_').optional(),
  STRIPE_PRICE_ID: z.string().startsWith('price_').optional(),

  // ── ElevenLabs ────────────────────────────────────────
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_AGENT_ID: z.string().optional(),
  ELEVENLABS_VOICE_ID: z.string().optional(),
  ELEVENLABS_WEBHOOK_SECRET: z.string().min(16).optional(),

  // ── Email ─────────────────────────────────────────────
  RESEND_API_KEY: z.string().startsWith('re_').optional(),

  // ── Sentry ────────────────────────────────────────────
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_AUTH_TOKEN: z.string().optional(),
  SENTRY_WEBHOOK_SECRET: z.string().min(16).optional(),

  // ── App origin (canonical = NEXT_PUBLIC_APP_URL only) ─
  // Legacy NEXT_PUBLIC_SITE_URL and NEXT_PUBLIC_BASE_URL are accepted as
  // fallbacks by the parse layer below; the schema only knows the canonical.
  NEXT_PUBLIC_APP_URL: z.string().url().default('https://getstaxis.com'),

  // ── Cron / internal secrets ───────────────────────────
  CRON_SECRET: z.string().min(16),
  LOCAL_SYNC_SECRET: z.string().min(16).optional(),
  GITHUB_WEBHOOK_SECRET: z.string().min(16).optional(),

  // ── Voice / wake word ─────────────────────────────────
  PICOVOICE_ACCESS_KEY: z.string().optional(),

  // ── reCAPTCHA ─────────────────────────────────────────
  NEXT_PUBLIC_RECAPTCHA_SITE_KEY: z.string().optional(),

  // ── Ops alert phone (canonical = OPS_ALERT_PHONE) ─────
  // Legacy MANAGER_PHONE accepted by parse layer.
  OPS_ALERT_PHONE: phoneE164.optional(),

  // ── ML routing (canonical = ML_SERVICE_URLS only) ─────
  // CSV — single-shard is just one entry. Legacy singular ML_SERVICE_URL
  // accepted by parse layer.
  ML_SERVICE_URLS: z.string().min(1),
  ML_SERVICE_SECRET: z.string().min(8),

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

const parsed = ServerSchema.safeParse({
  ...process.env,
  // Legacy fallback reconciliation. Phase 7 deletes these lines after prod
  // env vars are migrated to the canonical names.
  NEXT_PUBLIC_APP_URL:
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.NEXT_PUBLIC_SITE_URL ??
    process.env.NEXT_PUBLIC_BASE_URL,
  TWILIO_FROM_NUMBER: process.env.TWILIO_FROM_NUMBER ?? process.env.TWILIO_PHONE_NUMBER,
  OPS_ALERT_PHONE: process.env.OPS_ALERT_PHONE ?? process.env.MANAGER_PHONE,
  ML_SERVICE_URLS: process.env.ML_SERVICE_URLS ?? process.env.ML_SERVICE_URL,
});

if (!parsed.success) {
  const flat = parsed.error.flatten().fieldErrors;
  const lines = Object.entries(flat).map(([k, msgs]) => `  ${k}: ${(msgs ?? []).join(', ')}`);
  // eslint-disable-next-line no-console
  console.error('❌ Server env vars failed validation:\n' + lines.join('\n'));
  throw new Error(
    'Invalid server environment. Missing/invalid: ' + Object.keys(flat).join(', ')
  );
}

export const env = parsed.data;

// Configured-flag helpers — the few callers that gracefully disable
// (Stripe, Twilio, Resend) read these instead of hand-rolling the checks.
export const isStripeConfigured = !!(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);
export const isSmsConfigured = !!(
  env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER
);
export const isEmailConfigured = !!env.RESEND_API_KEY;
