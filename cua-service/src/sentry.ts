/**
 * Sentry integration for the CUA worker.
 *
 * Why this exists:
 *   The Next.js app already has @sentry/nextjs wired up — every
 *   log.error() in src/lib/log.ts calls captureException, errors flow
 *   to staxis.sentry.io automatically. The CUA worker on Fly is a
 *   separate process, separate codebase, separate node_modules. Errors
 *   that happen there (a Playwright crash, a Claude API timeout, a bad
 *   recipe) used to surface only in `flyctl logs` — easy to miss until
 *   a customer complains. This module sends them to the same Sentry
 *   project so all errors land in one inbox.
 *
 * Init: called once at startup from src/index.ts. After that, log.error
 * automatically captures the exception (see ./log.ts).
 *
 * If SENTRY_DSN is missing, init silently no-ops — local dev doesn't
 * need Sentry, and we don't want missing config to crash the worker.
 */

import * as Sentry from '@sentry/node';

let initialized = false;

export function initSentry(): boolean {
  if (initialized) return true;

  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    // Local dev or misconfigured deploy — fail open. The log.ts integration
    // checks `initialized` before calling Sentry methods, so this is safe.
    return false;
  }

  Sentry.init({
    dsn,
    // tracesSampleRate=0 — we don't need tracing on a worker, just errors.
    // Keeping the dependency lightweight.
    tracesSampleRate: 0,
    // environment lets us filter prod/dev errors in the Sentry UI.
    environment: process.env.NODE_ENV ?? 'development',
    // Tag every event with the worker_id so we can pivot on which Fly
    // machine produced the error (handy for "is one machine bad, or
    // is it a global bug?").
    initialScope: {
      tags: {
        service: 'cua-worker',
        fly_app: process.env.FLY_APP_NAME ?? 'staxis-cua',
        fly_region: process.env.FLY_REGION ?? 'unk',
        fly_machine: process.env.FLY_MACHINE_ID ?? 'unk',
      },
    },
    // Defense-in-depth: redact credential-shaped strings before sending.
    // The mapper already substitutes creds with $username/$password
    // placeholders in recipes, so this filter is a backstop for cases
    // where a credential leaks into a stack trace or log message.
    //
    // We REDACT (replace with `<redacted>`) rather than DROP the event,
    // because the previous "drop on match" version was too aggressive —
    // any error involving a JWT-shaped string (every Supabase access
    // token starts with "eyJ") would silently disappear, hiding real
    // bugs.
    beforeSend(event) {
      const redactInPlace = (obj: unknown): void => {
        if (!obj || typeof obj !== 'object') return;
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v === 'string') {
            // Anthropic API key shape: sk-ant-api03-… (95+ chars).
            // We only redact the long-form key; shorter sk-ant- mentions
            // (e.g., the prefix in a doc) are fine.
            if (/sk-ant-api\d{2}-[a-zA-Z0-9_-]{80,}/.test(v)) {
              (obj as Record<string, unknown>)[k] = '<redacted:anthropic_key>';
            }
            // Supabase service-role key: JWT with role:'service_role' —
            // we can't easily check the payload, so use length as a
            // proxy. Service role keys are 200+ chars; access tokens are
            // ~150-200; we redact only the longest ones to err on the
            // side of preserving real errors.
            else if (/eyJ[a-zA-Z0-9_-]{30,}\.[a-zA-Z0-9_-]{30,}\.[a-zA-Z0-9_-]{200,}/.test(v)) {
              (obj as Record<string, unknown>)[k] = '<redacted:long_jwt>';
            }
          } else if (typeof v === 'object') {
            redactInPlace(v);
          }
        }
      };
      redactInPlace(event);
      return event;
    },
  });

  initialized = true;
  return true;
}

export function captureException(err: unknown, context?: Record<string, unknown>): void {
  if (!initialized) return;
  Sentry.captureException(err, context ? { extra: context } : undefined);
}

export function captureMessage(msg: string, level: 'info' | 'warning' | 'error' = 'error', context?: Record<string, unknown>): void {
  if (!initialized) return;
  Sentry.captureMessage(msg, {
    level,
    extra: context,
  });
}

/**
 * Flush pending events before process exit. Sentry's transport is async
 * so unsent events can vanish on crash. Call this from the SIGTERM
 * handler with a short timeout so deploys don't hang on a bad network.
 *
 * Hard timeout via Promise.race — Sentry.flush's own timeout argument
 * isn't always honoured (network stalls can pin the event loop), so we
 * wrap it in our own setTimeout escape hatch. Returns either way.
 */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!initialized) return;
  await Promise.race([
    Sentry.flush(timeoutMs).catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs + 100)),
  ]);
}
