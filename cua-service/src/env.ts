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

  // Budget for one FULL learning run (login + all 12 targets) when the
  // trigger didn't set payload.cost_cap_micros. Sized 2026-06-09 for
  // Opus 4.8 at ~2x the expected $20-40 spend of a clean full learn —
  // the generic $5 CUA_JOB_COST_CAP_MICROS is per-phase/repair-scale
  // and would kill a full learn half-way. Org-wide daily wall below
  // (CUA_DAILY_MAPPING_SPEND_CAP_MICROS) still bounds the aggregate.
  CUA_FULL_LEARN_COST_CAP_MICROS: z.coerce.number().int().positive().default(40_000_000),

  // How long a learning run waits at a 2FA screen for a one-time code
  // to show up in pms_auth_codes (emailed codes land in seconds; codes
  // texted to Reeyen's phone need him to open Launch Bay and type them
  // in). 10 min default — generous for a human round-trip but bounded
  // so an abandoned run doesn't camp on the login page forever.
  CUA_MFA_CODE_WAIT_MS: z.coerce.number().int().positive().default(600_000),

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

  // ── PMS write-back panic switch (Phase 3) ──────────────
  // `fly secrets set CUA_WRITES_KILL_SWITCH=true -a staxis-cua` halts ALL
  // PMS write-back instantly, regardless of per-property pms_writeback_enabled
  // flags. Default 'false'.
  CUA_WRITES_KILL_SWITCH: z.enum(['true', 'false']).default('false'),

  // ── Mapper job timeout (Plan v8 D.2 — vision is the only mode now) ──
  // Vision per-target wallclock is 3-5x slower than the deleted DOM tool;
  // 90min gives a real vision run + multiple help-request waits room
  // inside one job's lifetime. Per-job override via
  // workflow_jobs.payload.timeout_ms.
  MAPPER_JOB_TIMEOUT_MS: z.coerce.number().int().positive().default(90 * 60_000),

  // Help-request timeout — how long the mapper waits for admin to answer
  // a help-request before falling back to "mark target unavailable".
  //
  // feature/cua-assist-board: raised 90s → 5min. This wait only ever runs
  // when an admin heartbeated in the last 5 minutes (requestHelp early-
  // exits otherwise), so it IS the human's point-and-click window on the
  // Learning Board — 90s was too short to notice the red flag, look at the
  // screenshot, and click. Idle stays bounded: the wait is admin-online-
  // gated, the help-flood breaker caps it at 3 stuck targets per job, and
  // the wait is credited back to the per-target wallclock budget (it never
  // eats per-target exploration time; the 90-min whole-job timeout is NOT
  // credited — 3 maxed waits ≈ 15 min of it, ample slack). Capped at 10min:
  // the help-request row's DB TTL is 15min with a 5-min sweep cron — the
  // wait must stay under TTL−sweep or the row can be swept mid-wait. Tune
  // via Fly secrets.
  HELP_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().max(600_000).default(300_000),

  // feature/cua-live-assist — idle timeout for a FOUNDER-driven takeover
  // session: how long the robot waits between the founder's clicks before it
  // gives up the takeover and hands control back to its own AI loop (the
  // founder walked away). This is a dedicated control table (no DB TTL/sweep),
  // so it isn't bound by the help-request TTL — but kept ≤10min so a forgotten
  // takeover can't freeze a mapping job indefinitely. Tune via Fly secrets.
  TAKEOVER_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().max(600_000).default(300_000),

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

  // ── Admin SMS nudge (optional — all four required to send) ──────────
  // When a learning run hits a 2FA screen, text the admin so he opens
  // Launch Bay and types the code in. No-ops unless ALL FOUR are set
  // (admin-sms.ts checks). Same Twilio account as the web app; set via
  // `fly secrets set TWILIO_ACCOUNT_SID=... -a staxis-cua` etc.
  TWILIO_ACCOUNT_SID: z.string().min(10).optional(),
  TWILIO_AUTH_TOKEN: z.string().min(10).optional(),
  TWILIO_FROM_NUMBER: z.string().min(8).optional(),
  ADMIN_ALERT_PHONE: z.string().min(8).optional(),

  // ── Platform auto-injected (read-only metadata) ───────
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  FLY_APP_NAME: z.string().default('staxis-cua'),
  FLY_MACHINE_ID: z.string().optional(),
  FLY_REGION: z.string().optional(),
  HOSTNAME: z.string().default('local'),
  // Fly machine memory limit (MB) — used by memory-monitor.ts to compute
  // pressure %. FLY_VM_MEMORY_MB is what Fly actually injects on every
  // machine; VM_MEMORY_MB / FLY_MEMORY_MB are older aliases still present
  // in some configs. memory-monitor prefers FLY_VM_MEMORY_MB.
  FLY_VM_MEMORY_MB: z.coerce.number().int().positive().optional(),
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
