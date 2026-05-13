/**
 * Structured logger for API routes and shared lib code.
 *
 * Why this exists:
 *   Vercel ingests stdout/stderr line-by-line. Plain `console.error("foo
 *   failed: " + err)` works for one bug, but for incident response across
 *   3+ services (Vercel + Railway + Supabase) you want to filter, group,
 *   and correlate events. JSON logs let you do `cat logs | jq 'select(.requestId == "abc")'`
 *   and see every line of a single user request across the whole stack.
 *
 *   Pairs with the requestId helper below so each Vercel→Railway→Supabase
 *   round trip carries the same id end to end. When Mario reports a bug
 *   ("the button hung for 30 seconds at 3:14 PM") you can pluck that
 *   request out of the firehose by id rather than time-correlating three
 *   separate log streams.
 *
 * Design rules (deliberately small surface area):
 *   - One file, no deps. We're not adopting pino / winston / bunyan
 *     here; if we need their features later (sampling, transports) we'll
 *     swap this out, but for now JSON-on-stdout is enough.
 *   - Always JSON. Never colored / pretty / multiline. Vercel's log
 *     parser handles single-line JSON cleanly.
 *   - Always include `level`, `at` (ISO timestamp), `msg`. Everything
 *     else is fields the caller chooses.
 *   - Never log secrets. The caller has to do that part right; we don't
 *     try to scrub here because false confidence is worse than no
 *     confidence.
 */

import { captureException } from '@/lib/sentry';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  requestId?: string;
  route?: string;
  pid?: string;          // property_id when relevant
  userId?: string;
  staffId?: string;
  durationMs?: number;
  errorCode?: string;
  status?: number;
  // Caller can attach anything; we serialize the whole object.
  [k: string]: unknown;
}

function emit(level: LogLevel, msg: string, fields?: LogFields): void {
  const line: Record<string, unknown> = {
    level,
    at: new Date().toISOString(),
    msg,
    ...(fields ?? {}),
  };
  // Errors / Error subclasses don't serialize cleanly through JSON.stringify
  // by default — they come out as `{}`. Pull stack/message off explicitly.
  //
  // For plain objects shaped like errors (notably Supabase's PostgrestError,
  // which is `{ message, details, hint, code }` — NOT an Error subclass),
  // synthesize a real Error from the .message so Sentry has both a sensible
  // group key AND the underlying message in the event title. Without this
  // the Sentry fallback at the end of this function would bucket every
  // Supabase failure under the same static log line.
  let firstError: unknown;
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      if (v instanceof Error) {
        line[k] = { name: v.name, message: v.message, stack: v.stack };
        if (!firstError) firstError = v;
      } else if (
        !firstError &&
        typeof v === 'object' && v !== null &&
        'message' in v && typeof (v as { message: unknown }).message === 'string'
      ) {
        const obj = v as { message: string; [k: string]: unknown };
        const synthetic = new Error(obj.message);
        // Copy code/details/hint/etc. onto the synthetic Error so Sentry's
        // event "extras" carry them through. Object.assign won't overwrite
        // the synthetic's `.stack` because plain objects don't have one.
        Object.assign(synthetic, obj);
        firstError = synthetic;
      }
    }
  }
  // Stringify safely — circular refs become "[circular]" instead of
  // crashing the request.
  let text: string;
  try {
    text = JSON.stringify(line);
  } catch {
    text = JSON.stringify({ level, at: line.at, msg, _serializeError: true });
  }
  // eslint-disable-next-line no-console
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(text);

  // Ship error-level events with an attached Error to Sentry. No-op until
  // SENTRY_DSN is set in env (see src/lib/sentry.ts + src/instrumentation.ts).
  // We only ship 'error' level because warn/info would flood the dashboard.
  if (level === 'error' && firstError) {
    captureException(firstError, { msg, ...(fields ?? {}) });
  } else if (level === 'error' && !firstError) {
    // No Error attached — ship a synthetic one so Sentry has a stack.
    captureException(new Error(msg), fields ?? {});
  }
}

export const log = {
  debug: (msg: string, f?: LogFields) => emit('debug', msg, f),
  info:  (msg: string, f?: LogFields) => emit('info',  msg, f),
  warn:  (msg: string, f?: LogFields) => emit('warn',  msg, f),
  error: (msg: string, f?: LogFields) => emit('error', msg, f),
};

/**
 * Pull a request id off the incoming headers, or generate one if absent.
 * The id rides through downstream fetches via the `x-request-id` header
 * (see `withRequestId` below). Format is short + url-safe so it shows up
 * legibly in URLs and toast messages without being noise.
 *
 * Header name follows the de-facto convention used by AWS / GCP / Datadog
 * / Sentry; if a caller already set it (e.g. a load balancer in front),
 * we honor that rather than minting a new id and breaking the chain.
 */
export function getOrMintRequestId(req: { headers: { get(name: string): string | null } }): string {
  const incoming = req.headers.get('x-request-id');
  if (incoming && /^[a-z0-9-]{6,64}$/i.test(incoming)) return incoming;
  // 8 chars from a 36-char alphabet — ~41 bits of entropy. Plenty for
  // request-correlation purposes; we're not using this as a security
  // token. Avoids hauling in a uuid lib.
  return Math.random().toString(36).slice(2, 10);
}
