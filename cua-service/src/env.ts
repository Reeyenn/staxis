// Canonical env module for the cua-service worker. Mirrors the main app's
// src/lib/env.ts: Zod schema parsed at module load with aggregated errors.
//
// Legacy fallback: NEXT_PUBLIC_SUPABASE_URL accepts SUPABASE_URL as fallback
// during the migration sweep. Phase 7 drops that after Fly secrets are
// rotated to the canonical name.

import { z } from 'zod';

const Schema = z.object({
  // ── Supabase (required) ───────────────────────────────
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),

  // ── Anthropic (required) ──────────────────────────────
  ANTHROPIC_API_KEY: z.string().startsWith('sk-ant-'),

  // ── Sentry (optional — SDK no-ops if missing) ─────────
  SENTRY_DSN: z.string().url().optional(),

  // ── Worker tuning (optional with defaults) ────────────
  JOB_TIMEOUT_MS: z.coerce.number().int().positive().default(900_000),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  PULL_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
  WORKER_ID_PREFIX: z.string().default('cua'),
  CUA_JOB_COST_CAP_MICROS: z.coerce.number().int().positive().default(5_000_000),

  // ── Platform auto-injected (read-only metadata) ───────
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  FLY_APP_NAME: z.string().default('staxis-cua'),
  FLY_MACHINE_ID: z.string().optional(),
  FLY_REGION: z.string().optional(),
  HOSTNAME: z.string().default('local'),
});

const parsed = Schema.safeParse(process.env);

if (!parsed.success) {
  const flat = parsed.error.flatten().fieldErrors;
  const lines = Object.entries(flat).map(([k, msgs]) => `  ${k}: ${(msgs ?? []).join(', ')}`);
  // eslint-disable-next-line no-console
  console.error('❌ cua-service env vars failed validation:\n' + lines.join('\n'));
  console.error(
    '\nFix: fly secrets set KEY=value -a staxis-cua, then `fly deploy`.\n' +
    'For local dev: copy parent .env.local into cua-service/.env or symlink it.'
  );
  throw new Error(
    'Invalid environment. Missing/invalid: ' + Object.keys(flat).join(', ')
  );
}

export const env = parsed.data;
