/**
 * ElevenLabs REST wrapper. Phase E2E (2026-05-22).
 *
 * Two call sites today both inline the same `xi-api-key` header + timeout
 * + Sentry-on-5xx boilerplate:
 *
 *   - src/app/api/agent/voice-session/route.ts — mints signed WebSocket URL
 *   - src/app/api/agent/speak/route.ts         — text-to-speech (binary)
 *
 * The WebSocket conversation surface (src/components/agent/useConversationalSession.ts)
 * uses @elevenlabs/client SDK directly — that's a different paradigm and
 * NOT what this wrapper covers. REST only.
 *
 * Design: thin wrapper on top of externalFetch so the realtime/voice-chat
 * SDK can stay untouched while REST calls get consistent headers, timeouts,
 * and 5xx Sentry capture with a deduping fingerprint.
 */

import * as Sentry from '@sentry/nextjs';
import { env } from '@/lib/env';
import {
  externalFetch,
  EXTERNAL_FETCH_TIMEOUT_MS,
  EXTERNAL_FETCH_SHORT_TIMEOUT_MS,
} from '@/lib/external-service-config';

const ELEVENLABS_BASE = 'https://api.elevenlabs.io';

export interface ElevenLabsFetchOptions extends Omit<RequestInit, 'signal'> {
  /** Defaults to EXTERNAL_FETCH_TIMEOUT_MS (15s). Use SHORT for control-plane calls (signed URL mint). */
  timeoutMs?: number;
  /** Composed with the route's request signal for client-disconnect cancellation. */
  abortSignal?: AbortSignal;
  /** Diagnostic label included in Sentry events if the call 5xxs. */
  diagnosticLabel?: string;
}

export const ELEVENLABS_SHORT_TIMEOUT_MS = EXTERNAL_FETCH_SHORT_TIMEOUT_MS;
export const ELEVENLABS_DEFAULT_TIMEOUT_MS = EXTERNAL_FETCH_TIMEOUT_MS;

/**
 * Authenticated ElevenLabs REST call. Centralizes `xi-api-key`, timeout
 * defaults, and Sentry on 5xx.
 *
 * Throws if ELEVENLABS_API_KEY is unset — caller routes already check for
 * config before hitting this path, but this throw is a defense-in-depth
 * guarantee that we never accidentally send a request with an empty
 * header value (which ElevenLabs would 401 with an unhelpful error).
 */
export async function elevenLabsFetch(
  pathOrUrl: string,
  options: ElevenLabsFetchOptions = {},
): Promise<Response> {
  const apiKey = env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error('ELEVENLABS_API_KEY not configured');
  }

  const url = pathOrUrl.startsWith('http')
    ? pathOrUrl
    : `${ELEVENLABS_BASE}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;

  const {
    timeoutMs = ELEVENLABS_DEFAULT_TIMEOUT_MS,
    abortSignal,
    diagnosticLabel,
    headers,
    ...rest
  } = options;

  const mergedHeaders: Record<string, string> = {
    'xi-api-key': apiKey,
    ...(headers as Record<string, string> | undefined),
  };

  const res = await externalFetch(url, {
    ...rest,
    headers: mergedHeaders,
    timeoutMs,
    abortSignal,
  });

  // Sentry on 5xx — uses a deduping fingerprint so a repeated outage
  // collapses into one issue per endpoint instead of spamming. Reports
  // 4xx via the same path but at 'warning' level so they don't drown
  // out the actually-broken-service signal. The wrapper does NOT throw
  // on non-2xx — callers branch on `res.ok` like before.
  if (res.status >= 500) {
    reportElevenLabsFailure({
      pathOrUrl,
      status: res.status,
      label: diagnosticLabel,
      level: 'error',
    });
  } else if (!res.ok) {
    reportElevenLabsFailure({
      pathOrUrl,
      status: res.status,
      label: diagnosticLabel,
      level: 'warning',
    });
  }

  return res;
}

function reportElevenLabsFailure(args: {
  pathOrUrl: string;
  status: number;
  label?: string;
  level: 'warning' | 'error';
}): void {
  try {
    Sentry.withScope((scope) => {
      // Fingerprint on the path (drop the query string + base) so retries
      // against the same endpoint dedup into one Sentry issue.
      const cleanPath = (() => {
        try {
          const u = new URL(args.pathOrUrl, ELEVENLABS_BASE);
          return u.pathname;
        } catch {
          return args.pathOrUrl;
        }
      })();
      scope.setFingerprint(['elevenlabs_rest_failure', cleanPath]);
      scope.setLevel(args.level);
      scope.setTag('elevenlabs.path', cleanPath);
      scope.setTag('elevenlabs.status', String(args.status));
      if (args.label) scope.setTag('elevenlabs.label', args.label);
      Sentry.captureMessage(`elevenlabs_rest_failure: ${cleanPath} status=${args.status}`);
    });
  } catch {
    // Telemetry must never break the caller.
  }
}
