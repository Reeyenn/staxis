/**
 * External Service Policy — single source of truth for timeouts, retry counts,
 * and the `externalFetch` wrapper for every call that leaves a Vercel function.
 *
 * ─── Why this file exists ────────────────────────────────────────────────────
 *
 * Vercel functions have a `maxDuration` ceiling (default 10s, set to 30–60s
 * on most of our routes). Every external service call must complete inside
 * that budget. Worst-case wall-clock for an SDK call is:
 *
 *     timeout × (1 + maxRetries) + retry-backoff
 *
 * For Anthropic at `timeout: 50_000, maxRetries: 1`, worst case is ~100s.
 * That's over the 60s ceiling, but the function dies cleanly when Vercel
 * kills it — the cost-reservation finally blocks recover state. For
 * `maxRetries: 2` we'd burn ~150s — long enough that we leak two reservations
 * before Vercel intervenes. So `maxRetries: 1` is the deliberate ceiling.
 *
 * Pre-2026-05-17 the budget math lived in a comment inside `llm.ts` that the
 * walkthrough route author never read, so the walkthrough route shipped with
 * `new Anthropic({ apiKey })` — no timeout, SDK-default 2 retries. The audit
 * at `.claude/reports/external-api-audit.md` flagged it as the highest-blast-
 * radius finding. Centralizing the policy here is how we stop reinventing
 * the mistake.
 *
 * ─── The rules ───────────────────────────────────────────────────────────────
 *
 * 1. Every SDK client (`new Anthropic(...)`, `new Stripe(...)`, etc.) on a
 *    Vercel function MUST pass `timeout` and `maxRetries` (or the SDK's
 *    equivalent option) using one of the constants below. Raw numbers are a
 *    code-review red flag.
 *
 * 2. Every outbound `fetch(url, ...)` to an external host MUST go through
 *    `externalFetch` from this module. Raw `fetch(externalUrl)` without a
 *    signal is a code-review red flag.
 *
 * 3. Background workers (CUA on Fly, ML service on Fly) have different
 *    ceilings and may use their own values — but they must still be
 *    explicit. See `cua-service/src/anthropic-client.ts` for an example
 *    (120s timeout, 1 retry, fits the 15-min job deadline).
 *
 * See also: CLAUDE.md → "External Services Policy" for the policy doc.
 */

// ─── Anthropic ───────────────────────────────────────────────────────────────

/**
 * Per-request timeout for the main agent chat (streaming + sync).
 * Route maxDuration is 60s; with `maxRetries: 1` worst case is ~100s.
 * Vercel kills the function cleanly past 60s and `runWithCostReservation`'s
 * finally block recovers the reservation.
 */
export const ANTHROPIC_REQUEST_TIMEOUT_MS = 50_000;

/**
 * Per-request timeout for vision (invoice OCR, photo count). Shorter than
 * main agent because OCR is fast and the user is staring at a spinner —
 * a long retry chain is worse UX than a clean failure.
 */
export const ANTHROPIC_VISION_TIMEOUT_MS = 30_000;

/**
 * Per-request timeout for the walkthrough step route. Capped below the
 * route's `maxDuration = 30s` so we can fail cleanly and return an error
 * rather than be killed mid-response.
 */
export const ANTHROPIC_WALKTHROUGH_TIMEOUT_MS = 20_000;

/**
 * SDK-level retry count for every Anthropic call site on Vercel. One retry
 * is enough to absorb a single transient 5xx / 429 / connection blip; two
 * retries (the SDK default) blows past the Vercel function ceiling.
 */
export const ANTHROPIC_MAX_RETRIES = 1;

// ─── Stripe ──────────────────────────────────────────────────────────────────

/**
 * Per-request timeout for Stripe SDK calls. The SDK default is 80_000ms
 * (80s) — way too long for the checkout button. 30s is more than enough
 * for any Stripe API call we make (typical p99 is sub-second).
 */
export const STRIPE_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Stripe SDK retry count. Stripe handles idempotency via idempotency keys
 * (we pass them on customers.create and checkout.sessions.create), so
 * retries are safe.
 */
export const STRIPE_MAX_NETWORK_RETRIES = 2;

// ─── Outbound HTTP fetch ─────────────────────────────────────────────────────

/**
 * Default timeout for outbound `fetch` to an external service (Twilio,
 * ElevenLabs, GitHub, Resend, etc.). 15s comfortably covers any normal
 * response while still failing fast when the upstream hangs.
 */
export const EXTERNAL_FETCH_TIMEOUT_MS = 15_000;

/**
 * Shorter timeout for diagnostic checks (doctor route, diagnose route).
 * If a diagnostic call hangs, we want the doctor page to render with a
 * "warn" rather than blocking the whole admin dashboard.
 */
export const EXTERNAL_FETCH_SHORT_TIMEOUT_MS = 10_000;

/**
 * Longer timeout for ML service inference + training calls. The service
 * runs XGBoost-quantile / Monte Carlo simulations that can take 30–45s
 * on the larger properties; 45s covers most calls with headroom.
 */
export const EXTERNAL_FETCH_LONG_TIMEOUT_MS = 45_000;

// ─── externalFetch ───────────────────────────────────────────────────────────

export interface ExternalFetchOptions extends RequestInit {
  /**
   * Per-request timeout in milliseconds. Defaults to
   * `EXTERNAL_FETCH_TIMEOUT_MS` (15s) if omitted. Pass one of the
   * `EXTERNAL_FETCH_*_TIMEOUT_MS` constants — raw numbers are a
   * code-review red flag.
   */
  timeoutMs?: number;

  /**
   * Optional additional AbortSignal to compose with the timeout. Useful
   * when the route forwards `req.signal` so a client disconnect also
   * cancels the upstream call.
   *
   * IMPORTANT: pass via this field, not via `init.signal` — `init.signal`
   * would override the timeout entirely.
   */
  abortSignal?: AbortSignal;
}

/**
 * `fetch` wrapper that guarantees an upper bound on wall-clock time.
 *
 * - Always attaches `AbortSignal.timeout(timeoutMs)` so a hung upstream
 *   can't block the Vercel function past its `maxDuration`.
 * - If `abortSignal` is provided, composes both signals via
 *   `AbortSignal.any` so EITHER fires aborts the request. Used by routes
 *   that want to forward `req.signal` for client-disconnect cancellation.
 *
 * The function deliberately does NOT do retries — the caller knows its
 * failure semantics best (some routes 502 immediately, some return a
 * graceful fallback). If you need retries, wrap this call yourself.
 */
export function externalFetch(
  url: string,
  options: ExternalFetchOptions = {},
): Promise<Response> {
  const { timeoutMs, abortSignal, signal, ...init } = options;
  // `signal` from RequestInit is silently dropped — the explicit
  // `abortSignal` field is the only way to compose, by design. Catch
  // accidental use loudly so it doesn't override the timeout.
  if (signal !== undefined) {
    throw new Error(
      "externalFetch: don't pass `signal` via init — use `abortSignal` so it composes with the timeout.",
    );
  }
  const timeout = timeoutMs ?? EXTERNAL_FETCH_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeout);
  const composed = abortSignal
    ? AbortSignal.any([timeoutSignal, abortSignal])
    : timeoutSignal;
  return fetch(url, { ...init, signal: composed });
}
