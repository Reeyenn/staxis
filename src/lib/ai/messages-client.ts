// ─── Per-provider model client factory ──────────────────────────────────────
//
// One place that turns "which provider serves this model" into a client the
// loops can call. Before this existed, eleven call sites each ran their own
// `new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, … })`, which meant eleven
// copies of the missing-key posture and no way to reach any other provider
// without touching all of them.
//
// Everything returned here satisfies `MessagesClient` (src/lib/agent/
// loop-core.ts), so the caller never branches on provider: it asks for the
// client belonging to the model the execution plan SELECTED and makes the same
// call it always made.

import 'server-only';

import Anthropic from '@anthropic-ai/sdk';
import { env } from '@/lib/env';
import { captureException } from '@/lib/sentry';
import {
  ANTHROPIC_MAX_RETRIES,
  ANTHROPIC_REQUEST_TIMEOUT_MS,
} from '@/lib/external-service-config';
import type { MessagesClient } from '@/lib/agent/loop-core';
import type { AiProvider } from '@/lib/ai/types';
import { createOpenAiMessagesClient } from '@/lib/ai/openai-messages';

export interface MessagesClientOptions {
  /** Per-attempt request timeout. Call sites keep passing the surface-specific
   * budget they already used (vision 50s, walkthrough 20s, chat 50s) so this
   * factory changes who serves a request, never how long it may take. */
  timeoutMs?: number;
  /** Transient-failure retries WITHIN one attempt, before the execution plan's
   * configured fallback is considered. */
  maxRetries?: number;
}

/**
 * Providers that can execute a Messages-shaped (text / tools / images) request.
 *
 * This is the honest answer to "may an admin put this feature on that model",
 * and it is derived from what code can actually do rather than from which
 * provider happened to supply the default model. `browser` and `in_house` are
 * absent because they are not model APIs at all — the browser speech provider
 * runs client-side and the in-house entries are our own forecasters.
 */
export const MESSAGES_RUNTIME_PROVIDERS = ['anthropic', 'openai'] as const;

export function isMessagesRuntimeProvider(provider: AiProvider): boolean {
  return (MESSAGES_RUNTIME_PROVIDERS as readonly AiProvider[]).includes(provider);
}

/**
 * Fail loudly, and make the failure countable, when a provider's key is absent.
 *
 * Same posture as the Anthropic path has had since the 2026-05-13 incident, in
 * which a missing key left the chat throwing a polite error for an unknown
 * length of time with ZERO operator notification — it was found only because
 * Reeyen typed "hi" into the chat himself. A Sentry event on the FIRST request
 * to hit it reaches the existing SMS pipeline within about a minute. See INV-22
 * in INVARIANTS.md.
 *
 * This matters more, not less, for OpenAI: a hotel whose Ask Staxis was moved
 * onto a GPT model in the Control Center has no other path to an answer, and a
 * silent empty reply is exactly the failure mode the guard exists to prevent.
 */
function requireProviderKey(provider: 'anthropic' | 'openai'): string {
  const key = provider === 'anthropic' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY;
  if (key) return key;
  const envVar = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
  const err = new Error(
    `${envVar} is not set, but a model from ${provider} is selected. ` +
    'Set it in Vercel → Project Settings → Environment Variables and redeploy, ' +
    'or point the affected features at another provider in the AI Control Center.',
  );
  captureException(err, {
    subsystem: 'ai-messages-client',
    failure_mode: 'missing_env_var',
    env_var: envVar,
  });
  throw err;
}

const clientCache = new Map<string, MessagesClient>();

/**
 * The client for `provider`, cached per (provider, timeout, retries).
 *
 * Caching is keyed on the options because the surfaces genuinely differ — the
 * walkthrough route must fail at 20s to stay inside its own route ceiling while
 * chat may run to 50s — and a single shared instance would silently hand one
 * surface the other's budget.
 */
export function getMessagesClient(
  provider: AiProvider,
  opts: MessagesClientOptions = {},
): MessagesClient {
  const timeoutMs = opts.timeoutMs ?? ANTHROPIC_REQUEST_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? ANTHROPIC_MAX_RETRIES;
  if (provider !== 'anthropic' && provider !== 'openai') {
    throw new Error(
      `Provider "${provider}" has no model API to call. ` +
      'Only anthropic and openai models can serve a text/tool request.',
    );
  }

  const cacheKey = `${provider}:${timeoutMs}:${maxRetries}`;
  const cached = clientCache.get(cacheKey);
  if (cached) return cached;

  const apiKey = requireProviderKey(provider);
  const client: MessagesClient = provider === 'anthropic'
    // maxRetries: SDK-level retry on transient 5xx / 408 / 429 / connection
    // errors. The Anthropic SDK applies `timeout` PER-ATTEMPT, so the total
    // budget is (maxRetries + 1) × timeout in the pathological case. With 50s
    // and one retry the worst case is ~100s — past Vercel's 60s ceiling, but
    // the function is killed cleanly and the sweeper cron recovers any stranded
    // reservation. Two retries would let us burn 150s, well over.
    ? new Anthropic({ apiKey, timeout: timeoutMs, maxRetries })
    : createOpenAiMessagesClient({ apiKey, timeoutMs, maxRetries });
  clientCache.set(cacheKey, client);
  return client;
}

/** Whether a provider's key is present. Does not throw and does not report. */
export function isMessagesProviderConfigured(provider: AiProvider): boolean {
  if (provider === 'anthropic') return Boolean(env.ANTHROPIC_API_KEY);
  if (provider === 'openai') return Boolean(env.OPENAI_API_KEY);
  return false;
}

/**
 * `getMessagesClient`, but null instead of an exception + Sentry event when the
 * provider is not configured.
 *
 * For the BEST-EFFORT call sites — complaint classification, message
 * translation, the report one-liner — whose contract is "never block the real
 * work". Those degrade to a plain-text fallback on any model failure, and a
 * developer running locally without a key is not an incident worth paging
 * anyone about. Ask Staxis is the opposite case and uses the throwing variant:
 * there, a missing key means the user gets nothing, so it must be loud.
 */
export function getMessagesClientIfConfigured(
  provider: AiProvider,
  opts: MessagesClientOptions = {},
): MessagesClient | null {
  if (!isMessagesProviderConfigured(provider)) return null;
  return getMessagesClient(provider, opts);
}

/** Drop cached clients. Exported for tests that swap env between cases; there
 * is no production caller, because a key change requires a redeploy anyway. */
export function resetMessagesClientCache(): void {
  clientCache.clear();
}
