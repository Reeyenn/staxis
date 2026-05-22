/**
 * Structured logging for the CUA worker.
 *
 * Single-line JSON logs (one per event) so Fly.io's log aggregator can
 * parse them, plus a human-readable mode for local development. Never
 * log credentials or recipe contents — only metadata.
 *
 * Only log.error captures to Sentry. log.warn stays in Fly logs only —
 * mapper iteration generates a steady stream of "action X didn't map"
 * and "token budget exceeded" warnings that aren't bugs and would
 * otherwise spam the alert inbox. Matches the Next.js src/lib/log.ts
 * convention.
 *
 * Redaction safety net (added 2026-05-22, hardening pass):
 *   - Recursive scrub of `ctx` to depth 6 — top-level convention isn't
 *     enough once nested error/context objects show up.
 *   - Sensitive key names (password, token, authorization, etc.) →
 *     <redacted:key>.
 *   - Sensitive value patterns (sk-ant-…, long JWTs, Bearer tokens) →
 *     <redacted:pattern>.
 *   - Error instances → message/stack run through the value scrubber.
 *   - `msg` argument runs through the value scrubber too — catches the
 *     `log.info('typed ' + creds.password)` foot-gun.
 *   - Emitted line capped at 16 KiB so a runaway context can't blow
 *     past Fly's log line limit.
 *
 * Sentry's beforeSend (sentry.ts) is the second layer — this scrubber
 * is the first, and applies to every log line regardless of level.
 */

import { captureException, captureMessage } from './sentry.js';
import { env } from './env.js';

const isProd = env.NODE_ENV === 'production';

interface LogContext {
  jobId?: string;
  propertyId?: string;
  pmsType?: string;
  workerId?: string;
  recipeId?: string;
  step?: string;
  [k: string]: unknown;
}

// ─── Redaction ───────────────────────────────────────────────────────────

const REDACT_KEY_RE =
  /^(password|passwd|secret|token|api[_-]?key|authorization|cookie|set-cookie|ca_(?:username|password)(?:_encrypted)?)$/i;

// Note: `username` is intentionally NOT in the key deny-list. It often
// appears as a benign job context field (`username: 'staxis-admin'`) and
// blanket-redacting it would lose useful telemetry. PMS usernames never
// touch the log context by design — placeholders (`$username`) are used
// inside recipes, and browser-tool masks the actual value to
// `<username>` before any output is emitted. The value-pattern scrubber
// below catches stray credentials regardless of key name.

const REDACT_VALUE_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'anthropic_key', pattern: /sk-ant-api\d{2}-[A-Za-z0-9_-]{20,}/g },
  { name: 'bearer',        pattern: /Bearer\s+[A-Za-z0-9._-]{20,}/gi },
  // Long JWT (header.payload.signature, each ≥16 chars of base64url).
  { name: 'jwt',           pattern: /eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g },
];

const MAX_DEPTH = 6;
const MAX_EMITTED_BYTES = 16 * 1024; // 16 KiB per log line.

function scrubString(s: string): string {
  let out = s;
  for (const { name, pattern } of REDACT_VALUE_PATTERNS) {
    out = out.replace(pattern, `<redacted:${name}>`);
  }
  return out;
}

function scrubValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value;
  }
  if (depth >= MAX_DEPTH) return '<redacted:max_depth>';

  if (value instanceof Error) {
    // Error objects don't serialize their own fields via JSON.stringify
    // by default — pull message/stack/name out explicitly, scrub each.
    return {
      name: value.name,
      message: scrubString(value.message ?? ''),
      stack: value.stack ? scrubString(value.stack) : undefined,
    };
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return '<redacted:cycle>';
    seen.add(value);
    return value.map((v) => scrubValue(v, depth + 1, seen));
  }

  if (typeof value === 'object') {
    if (seen.has(value as object)) return '<redacted:cycle>';
    seen.add(value as object);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (REDACT_KEY_RE.test(k)) {
        out[k] = '<redacted:key>';
        continue;
      }
      out[k] = scrubValue(v, depth + 1, seen);
    }
    return out;
  }

  // Functions, symbols — never useful in logs, drop.
  return undefined;
}

function scrubContext(ctx: LogContext | undefined): LogContext | undefined {
  if (!ctx) return ctx;
  return scrubValue(ctx, 0, new WeakSet()) as LogContext;
}

function capLine(line: string): string {
  if (Buffer.byteLength(line, 'utf8') <= MAX_EMITTED_BYTES) return line;
  const marker = '…<redacted:line_truncated>';
  const buf = Buffer.from(line, 'utf8').subarray(0, MAX_EMITTED_BYTES - marker.length - 1);
  return buf.toString('utf8') + marker;
}

function emit(level: 'info' | 'warn' | 'error', msg: string, ctx?: LogContext) {
  const safeMsg = scrubString(msg);
  const safeCtx = scrubContext(ctx);
  if (isProd) {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg: safeMsg,
      ...(safeCtx ?? {}),
    });
    process.stdout.write(capLine(line) + '\n');
  } else {
    const ctxStr = safeCtx ? ' ' + JSON.stringify(safeCtx) : '';
    const stream = level === 'error' ? process.stderr : process.stdout;
    stream.write(capLine(`[${new Date().toISOString()}] ${level.toUpperCase()} ${safeMsg}${ctxStr}`) + '\n');
  }
}

// Exposed for unit tests only — the scrubber is the load-bearing piece
// and we want explicit coverage of nested objects, error instances, and
// the value-pattern matcher.
export const __test__ = { scrubString, scrubValue, scrubContext, capLine };

export const log = {
  info:  (msg: string, ctx?: LogContext) => emit('info',  msg, ctx),
  warn:  (msg: string, ctx?: LogContext) => {
    // Stays in Fly logs only — Sentry would spam the email alert inbox
    // during mapper iteration (per-action mapping failures, token-budget
    // bails, time-limit warnings are all expected operational events).
    // Real crashes still flow through log.error → Sentry.
    emit('warn',  msg, ctx);
  },
  error: (msg: string, ctx?: LogContext) => {
    emit('error', msg, ctx);
    // If the context has an `err` field (the conventional name in this
    // codebase), Sentry prefers seeing the Error object directly so it
    // can extract the stack trace. Otherwise capture as a message.
    const errField = ctx && 'err' in ctx ? ctx.err : undefined;
    if (errField instanceof Error) {
      captureException(errField, ctx);
    } else {
      captureMessage(msg, 'error', ctx);
    }
  },
};

/**
 * Generate a unique worker ID for this process. Format:
 *   <prefix>-<region>-<machine_id>  (Fly.io supplies FLY_MACHINE_ID)
 *   <prefix>-<hostname>             (local dev)
 *
 * Stored on every onboarding_jobs row that this process claims, so we
 * can attribute "which worker dropped this job" when debugging.
 */
export function makeWorkerId(): string {
  const prefix = env.WORKER_ID_PREFIX;
  const flyMachine = env.FLY_MACHINE_ID;
  const flyRegion = env.FLY_REGION;
  if (flyMachine) return `${prefix}-${flyRegion ?? 'unk'}-${flyMachine}`;
  return `${prefix}-${env.HOSTNAME}`;
}
