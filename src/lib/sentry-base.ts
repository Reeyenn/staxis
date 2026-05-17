/**
 * Shared Sentry.init options used by client, server, and edge runtimes.
 *
 * Why this exists: each runtime has its own config file at the repo root
 * (sentry.client.config.ts, sentry.server.config.ts, sentry.edge.config.ts).
 * They diverge legitimately on DSN env var, environment env var, trace
 * sample rate, and client-only replay/breadcrumb hooks — but the safety
 * defaults (PII scrubbing, default-PII off, ignored noise) must stay
 * identical across all three or we get drift like the May 2026 audit
 * finding H3 (edge runtime was missing `beforeSend: scrubSentryEvent`
 * for months because three independent files copied the wrong subset
 * of options).
 *
 * Anything that should be uniform across runtimes goes here. Anything
 * runtime-specific (DSN env, sample rate, replays, breadcrumb hook)
 * stays in the runtime-specific config file and is merged in via spread.
 */

import { scrubSentryEvent } from '@/lib/sentry-scrub';

export function getBaseSentryOptions() {
  return {
    sendDefaultPii: false,
    debug: false,
    beforeSend: scrubSentryEvent,
    ignoreErrors: ['failed to pipe response', /other side closed/] as (string | RegExp)[],
  };
}
