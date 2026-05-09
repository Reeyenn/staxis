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
 */

import { captureException, captureMessage } from './sentry.js';

const isProd = process.env.NODE_ENV === 'production';

interface LogContext {
  jobId?: string;
  propertyId?: string;
  pmsType?: string;
  workerId?: string;
  recipeId?: string;
  step?: string;
  [k: string]: unknown;
}

function emit(level: 'info' | 'warn' | 'error', msg: string, ctx?: LogContext) {
  if (isProd) {
    process.stdout.write(JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg,
      ...(ctx ?? {}),
    }) + '\n');
  } else {
    const ctxStr = ctx ? ' ' + JSON.stringify(ctx) : '';
    const stream = level === 'error' ? process.stderr : process.stdout;
    stream.write(`[${new Date().toISOString()}] ${level.toUpperCase()} ${msg}${ctxStr}\n`);
  }
}

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
  const prefix = process.env.WORKER_ID_PREFIX ?? 'cua';
  const flyMachine = process.env.FLY_MACHINE_ID;
  const flyRegion = process.env.FLY_REGION;
  if (flyMachine) return `${prefix}-${flyRegion ?? 'unk'}-${flyMachine}`;
  return `${prefix}-${process.env.HOSTNAME ?? 'local'}`;
}
