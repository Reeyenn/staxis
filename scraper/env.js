// Canonical env module for the scraper. Mirrors src/lib/env.ts (main app)
// and cua-service/src/env.ts. Zod schema, aggregated boot error, single
// source of truth.
//
// Required vars are kept optional in the schema so downstream code
// (createSupabase, scraper-health) can surface its own actionable error
// when missing — same pattern as the main app's env.ts. The boot-fail
// guarantee for prod is enforced via the scraper-health cron alert.
//
// Legacy fallback during migration sweep:
//   NEXT_PUBLIC_SUPABASE_URL ?? SUPABASE_URL   (bare form used to be canonical here)
//   TWILIO_FROM_NUMBER       ?? TWILIO_PHONE_NUMBER
//   OPS_ALERT_PHONE          ?? MANAGER_PHONE
// Phase 7 drops these after Railway env is rotated.

const { z } = require('zod');

function emptyToUndef(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = v === '' ? undefined : v;
  }
  return out;
}

const Schema = z.object({
  // ── Supabase ──────────────────────────────────────────
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

  // ── PMS credentials ───────────────────────────────────
  CA_USERNAME: z.string().optional(),
  CA_PASSWORD: z.string().optional(),
  HOTELOPS_PROPERTY_ID: z.string().optional(),

  // ── Operational tuning ────────────────────────────────
  TIMEZONE: z.string().default('America/Chicago'),
  TICK_MINUTES: z.coerce.number().int().positive().default(5),
  MIN_EXPECTED_ROOMS: z.coerce.number().int().positive().default(60),
  CSV_TEST_ON_STARTUP: z.coerce.boolean().default(false),
  HEADED: z.coerce.boolean().default(false),
  SCRAPER_INSTANCE_ID: z.string().default('default'),

  // ── Alerting (optional) ───────────────────────────────
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),
  OPS_ALERT_PHONE: z.string().optional(),

  // ── Cron auth ─────────────────────────────────────────
  CRON_SECRET: z.string().optional(),

  // ── Vercel watchdog ───────────────────────────────────
  VERCEL_DOCTOR_URL: z.string().url().optional(),

  // ── Platform auto-injected ────────────────────────────
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().optional(),
});

function parseEnv() {
  const raw = emptyToUndef(process.env);
  const result = Schema.safeParse(raw);

  if (!result.success) {
    const flat = result.error.flatten().fieldErrors;
    const lines = Object.entries(flat).map(([k, msgs]) => `  ${k}: ${(msgs ?? []).join(', ')}`);
    console.error('❌ scraper env vars failed validation:\n' + lines.join('\n'));
    console.error(
      '\nFix: set the var in Railway → service → Variables, then redeploy.\n' +
      'For local dev: copy scraper/.env.example to scraper/.env and fill in.'
    );
    throw new Error('Invalid environment. Missing/invalid: ' + Object.keys(flat).join(', '));
  }
  return result.data;
}

// Parse once at module load to surface schema errors early.
parseEnv();

// Re-parse on each property access so tests that mutate process.env between
// cases observe the new values (matches src/lib/env.ts).
const env = new Proxy({}, {
  get(_t, prop) {
    return parseEnv()[prop];
  },
  has(_t, prop) {
    return prop in parseEnv();
  },
  ownKeys() {
    return Object.keys(parseEnv());
  },
  getOwnPropertyDescriptor(_t, prop) {
    const fresh = parseEnv();
    if (!(prop in fresh)) return undefined;
    return { enumerable: true, configurable: true, value: fresh[prop] };
  },
});

module.exports = { env };
