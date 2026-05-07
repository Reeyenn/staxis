/**
 * Structured logging for the CUA worker.
 *
 * Single-line JSON logs (one per event) so Fly.io's log aggregator can
 * parse them, plus a human-readable mode for local development. Never
 * log credentials or recipe contents — only metadata.
 */

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
  warn:  (msg: string, ctx?: LogContext) => emit('warn',  msg, ctx),
  error: (msg: string, ctx?: LogContext) => emit('error', msg, ctx),
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
