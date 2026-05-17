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

/**
 * Per-route trace sampler for the server + edge runtimes.
 *
 * Logging-PII audit S2: a global tracesSampleRate of 0.1 lets one noisy
 * endpoint (/api/events fires per agent action, /api/sms-reply on every
 * inbound Twilio webhook) crowd out signal from rare-but-interesting
 * routes (admin doctor, agent commands). When the Sentry quota is hit
 * mid-month the routes we actually need to debug are the ones that
 * disappear first.
 *
 * Picks one of:
 *   - 0.0   "drop" — known-no-signal transactions (healthchecks)
 *   - 0.01  "noisy" — high-QPS event hooks
 *   - 0.05  "medium" — cron + voice-brain (volume scales with hotels)
 *   - 0.1   "default" — every other route, matches the prior global rate
 *
 * The sampler is duck-typed against the Sentry samplingContext to avoid
 * pulling the typings into a shared module (server and edge SDKs have
 * slightly different shapes). The runtime contract: return a number
 * 0..1, return undefined to inherit the global rate.
 */
type SamplingContext = {
  transactionContext?: { name?: string };
  request?: { url?: string };
};

export function shouldSampleTransaction(ctx: SamplingContext): number | undefined {
  const name = ctx.transactionContext?.name ?? '';
  const url = ctx.request?.url ?? '';
  const path = name || url;

  // Strip method prefix ("GET /api/...") if present.
  const route = path.replace(/^[A-Z]+\s+/, '');

  // 0.0: zero-signal hot paths the SDK may still pick up.
  if (route === 'GET' || route.startsWith('OPTIONS')) return 0;

  // 0.01: the two highest-QPS routes called out by the audit.
  if (route.includes('/api/events')) return 0.01;
  if (route.includes('/api/sms-reply')) return 0.01;

  // 0.05: cron fans-out + voice agent.
  if (route.includes('/api/cron/')) return 0.05;
  if (route.includes('/api/agent/voice-brain')) return 0.05;
  if (route.includes('/api/agent/nudges/check')) return 0.05;

  // Default — inherit the global rate (0.1 server, 0.1 edge, 0.05 client).
  return undefined;
}
