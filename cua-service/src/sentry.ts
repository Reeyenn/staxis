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
    // Don't capture player-private things by accident. The CUA worker
    // handles credentials in mapper.ts — make sure they never get
    // serialized into a Sentry event.
    beforeSend(event) {
      // Strip any field that looks like a credential before sending.
      // Defensive — we already substitute creds with $username/$password
      // in recipes, but a stack trace could surface them.
      const stringified = JSON.stringify(event);
      if (/sk-ant-[a-zA-Z0-9_-]{20,}/.test(stringified) ||
          /eyJ[a-zA-Z0-9_-]{20,}/.test(stringified)) {
        // Service-role key or Anthropic key found in payload — drop it.
        return null;
      }
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
 */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!initialized) return;
  try {
    await Sentry.flush(timeoutMs);
  } catch {
    // Best-effort — never block shutdown on Sentry.
  }
}
