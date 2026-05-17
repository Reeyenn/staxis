// Canonical env module for the scraper. Mirrors src/lib/env.ts (main app)
// and cua-service/src/env.ts. Zod schema, aggregated boot error, single
// source of truth.
//
// Legacy fallback during migration sweep:
//   NEXT_PUBLIC_SUPABASE_URL ?? SUPABASE_URL   (bare form used to be canonical here)
//   TWILIO_FROM_NUMBER       ?? TWILIO_PHONE_NUMBER
//   OPS_ALERT_PHONE          ?? MANAGER_PHONE
// Phase 7 drops these after Railway env is rotated.

const { z } = require('zod');

const phoneE164 = z.string().regex(/^\+\d{10,15}$/, 'must be E.164 (e.g. +12816669887)');

const Schema = z.object({
  // ── Supabase (required) ───────────────────────────────
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),

  // ── PMS credentials (required) ────────────────────────
  CA_USERNAME: z.string().min(1),
  CA_PASSWORD: z.string().min(1),
  HOTELOPS_PROPERTY_ID: z.string().uuid().optional(), // can fall back to DB lookup

  // ── Operational tuning ────────────────────────────────
  TIMEZONE: z.string().default('America/Chicago'),
  TICK_MINUTES: z.coerce.number().int().positive().default(5),
  MIN_EXPECTED_ROOMS: z.coerce.number().int().positive().default(60),
  CSV_TEST_ON_STARTUP: z.coerce.boolean().default(false),
  HEADED: z.coerce.boolean().default(false),
  SCRAPER_INSTANCE_ID: z.string().default('default'),

  // ── Alerting (optional) ───────────────────────────────
  TWILIO_ACCOUNT_SID: z.string().startsWith('AC').optional(),
  TWILIO_AUTH_TOKEN: z.string().min(20).optional(),
  TWILIO_FROM_NUMBER: phoneE164.optional(),
  OPS_ALERT_PHONE: phoneE164.optional(),

  // ── Cron auth ─────────────────────────────────────────
  CRON_SECRET: z.string().min(16).optional(),

  // ── Vercel watchdog ───────────────────────────────────
  VERCEL_DOCTOR_URL: z.string().url().optional(),

  // ── Platform auto-injected ────────────────────────────
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().optional(),
});

const parsed = Schema.safeParse({
  ...process.env,
  // Legacy fallback reconciliation. Phase 7 drops these lines.
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL,
  TWILIO_FROM_NUMBER: process.env.TWILIO_FROM_NUMBER ?? process.env.TWILIO_PHONE_NUMBER,
  OPS_ALERT_PHONE: process.env.OPS_ALERT_PHONE ?? process.env.MANAGER_PHONE,
});

if (!parsed.success) {
  const flat = parsed.error.flatten().fieldErrors;
  const lines = Object.entries(flat).map(([k, msgs]) => `  ${k}: ${(msgs ?? []).join(', ')}`);
  console.error('❌ scraper env vars failed validation:\n' + lines.join('\n'));
  console.error(
    '\nFix: set the var in Railway → service → Variables, then redeploy.\n' +
    'For local dev: copy scraper/.env.example to scraper/.env and fill in.'
  );
  throw new Error('Invalid environment. Missing/invalid: ' + Object.keys(flat).join(', '));
}

module.exports = { env: parsed.data };
