/**
 * Structured logging for the CUA worker.
 *
 * Single-line JSON logs (one per event) so Fly.io's log aggregator can
 * parse them, plus a human-readable mode for local development. Never
 * log credentials or recipe contents — only metadata.
 *
 * log.error and log.warn additionally capture to Sentry (if SENTRY_DSN
 * is set). Mirrors the pattern in src/lib/log.ts in the Next.js app —
 * every error goes to one inbox regardless of which service produced it.
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
    emit('warn',  msg, ctx);
    // Warnings often signal real bugs we want to know about — capture as
    // 'warning' level so they show up in Sentry but don't trigger the
    // 'errors only' alert. (If a warning is too noisy, add a filter
    // here.)
    captureMessage(msg, 'warning', ctx);
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
