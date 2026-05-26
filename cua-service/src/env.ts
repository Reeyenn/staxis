// Canonical env module for the cua-service worker. Mirrors the main app's
// src/lib/env.ts: Zod schema parsed at module load with aggregated errors.
//
// The legacy SUPABASE_URL fallback was dropped by commit c0f5df2. Fly
// secrets must use NEXT_PUBLIC_SUPABASE_URL — `fly secrets set` it before
// deploying or boot will fail with a Zod aggregated error.

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

  // 2026-05-24: CUA_SHADOW_MODE removed. Legacy CA normalizers + the
  // 7-day parity gate were retired so the new generic-table-writer
  // (persistence/generic-table-writer.ts) is the only write path now.

  // ── Recipe signing (Plan v2 F-AI-2) ─────────────────────
  // Active HMAC key used to sign and verify pms_recipes.recipe rows.
  // Optional during the rollout: when missing, signRecipe throws and
  // verifyRecipe reports `no_key_configured`. recipe-runner's warn
  // mode logs and proceeds; enforce mode refuses. Set via `fly secrets
  // set RECIPE_SIGNING_KEY=<32+ bytes>`.
  RECIPE_SIGNING_KEY: z.string().min(32).optional(),
  // Previous-generation key, accepted by verifyRecipe during a key
  // rotation grace window. Unset it after the doctor's
  // `recipes_all_signed` check shows 100% of active rows resigned with
  // the new key.
  RECIPE_SIGNING_KEY_PREVIOUS: z.string().min(32).optional(),
  // 'warn' (default) — verifier logs mismatches but proceeds.
  // 'enforce' — verifier refuses on mismatch / missing signature.
  RECIPE_SIGNING_ENFORCE: z.enum(['warn', 'enforce']).default('warn'),

  // ── Critic (pre/post screenshot validator) ───────────────
  // Pre/post screenshot critic that grades each click in vision mode
  // and injects a "Critic note: …" if the click didn't appear to
  // achieve its intended outcome (arXiv 2410.00689 pattern, +5% on
  // WebVoyager). Defaults to 'true'; flip to 'false' via `fly secrets
  // set CUA_CRITIC_ENABLED=false -a staxis-cua` as a panic switch if
  // critic spend or false-failure injections cause problems in
  // production. Critic only fires on click verbs (left_click /
  // double_click) in vision mode — DOM mode skips it entirely
  // (read_page already provides grounding). Tested at runtime by
  // reading process.env directly, so test runs can flip between cases
  // without subprocess gymnastics.
  CUA_CRITIC_ENABLED: z.enum(['true', 'false']).default('true'),

  // ── DNS rebinding preflight (Plan v2 F-AI-5) ────────────
  // When 'true', safeGoto resolves the target hostname via dns.lookup
  // before navigating and refuses if the resolved IP is private. Closes
  // the trivial DNS-rebinding case (no rebinding mid-fetch) — does NOT
  // solve mid-resolution rebinding (Chromium does its own DNS); for
  // that we'd need --host-resolver-rules. Off by default during
  // rollout because dns.lookup adds latency + can flake on slow DNS;
  // flip to 'true' once we've measured the impact.
  CUA_DNS_PREFLIGHT: z.enum(['true', 'false']).default('false'),

  // ── Mapper job timeout (Plan v8 D.2 — vision is the only mode now) ──
  // Vision per-target wallclock is 3-5x slower than the deleted DOM tool;
  // 90min gives a real vision run + multiple help-request waits room
  // inside one job's lifetime. Per-job override via
  // workflow_jobs.payload.timeout_ms.
  MAPPER_JOB_TIMEOUT_MS: z.coerce.number().int().positive().default(90 * 60_000),

  // Help-request timeout — how long the mapper waits for admin to answer
  // a help-request before falling back to "mark target unavailable".
  // P1-2 (Codex hard pass): default 90s, not 5min, because Reeyen is one
  // admin and 5min × 13 targets = 65 minutes of pure idle waiting. With
  // 90s + admin-online check (skip help-request when no admin heartbeat
  // in last 5min), the cost stays bounded.
  HELP_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),

  // Plan v8 final review B1 + S1 — org-wide daily mapping spend cap.
  // Sum of cost_micros for source='mapping' rows over the last 24h.
  // When exceeded, mapping-driver refuses new jobs (existing ones run
  // to their per-job cap). Per-job cap is FIRST line; this is the
  // SAFETY NET against a 300-hotel wave where each hits per-job + the
  // aggregate still bombs. Default $100/day — raise via fly secrets
  // once vision proven across multiple PMSes.
  CUA_DAILY_MAPPING_SPEND_CAP_MICROS: z.coerce.number().int().positive().default(100_000_000),
  // Hard cap on the preflight lookup itself. Without this, a flaky
  // resolver can hang dns.lookup() indefinitely — Playwright's own
  // 30s navigation timeout only starts AFTER safeGoto's awaits return.
  // The lookup races against this timer; on timeout we log + proceed
  // (treat the preflight as best-effort, same as the existing ENOTFOUND
  // fallback). 2s is comfortably above normal DNS roundtrip; tune via
  // env if a region's resolver is consistently slower.
  CUA_DNS_PREFLIGHT_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000),

  // ── Rules-engine event ping (feature/cua-to-rules-engine-event-ping) ──
  //
  // When the CUA worker writes a high-priority PMS change (departure
  // checkout, new arrival, OOO flip, etc.), it POSTs to the staxis
  // /api/cron/run-rules-engine?propertyId=<uuid> so housekeeping gets
  // the resulting cleaning task within ~10s instead of waiting for the
  // 5-min cron. See cua-service/src/rules-engine-pinger.ts.
  //
  // RULES_ENGINE_BASE_URL — origin of the staxis web app (no trailing
  // slash, e.g. https://hotelops-ai.vercel.app). When unset, the pinger
  // returns immediately — the 5-min cron remains the only signal. That's
  // intentional for local dev: tests/dev workers don't fire cross-network.
  RULES_ENGINE_BASE_URL: z.string().url().optional(),
  // CRON_SECRET — bearer token matching the staxis web app's CRON_SECRET.
  // Already used elsewhere for cron auth; same value via `fly secrets set
  // CRON_SECRET=... -a staxis-cua`. Optional here so a worker can boot
  // without it (ping disables instead).
  CRON_SECRET: z.string().min(16).optional(),
  // Debounce window for the pinger. A burst of high-priority writes for
  // one property collapses to a single ping. 10s default — "sub-30s
  // response" target with comfortable margin.
  RULES_ENGINE_PING_DEBOUNCE_MS: z.coerce.number().int().positive().default(10_000),
  // Per-ping fetch timeout. The pinger fails quiet on timeout; the
  // 5-min cron is the safety net.
  RULES_ENGINE_PING_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

  // ── Platform auto-injected (read-only metadata) ───────
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  FLY_APP_NAME: z.string().default('staxis-cua'),
  FLY_MACHINE_ID: z.string().optional(),
  FLY_REGION: z.string().optional(),
  HOSTNAME: z.string().default('local'),
  // Fly machine memory limit (MB) — used by memory-monitor.ts to compute
  // pressure %. VM_MEMORY_MB is what Fly sets; FLY_MEMORY_MB is an older
  // alias still present in some configs.
  VM_MEMORY_MB: z.coerce.number().int().positive().optional(),
  FLY_MEMORY_MB: z.coerce.number().int().positive().optional(),
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
