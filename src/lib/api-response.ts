/**
 * Uniform API response shape + helpers.
 *
 * Goal: every /api/* route returns the same outer envelope so the client
 * can write ONE error handler that works for ANY route. As of 2026-04-29
 * the routes were each inventing their own shape (`{ok,error,code}`,
 * `{ok,action,context}`, `{message,updated,total}`, …) which made the
 * UI's error path fragile.
 *
 * The shape:
 *   {
 *     ok: boolean
 *     requestId: string         // always present, useful for support
 *     data?: T                  // present when ok=true (route-specific payload)
 *     error?: string            // present when ok=false (human-readable)
 *     code?: string             // present when ok=false (machine-stable; e.g. "rate_limited")
 *     details?: unknown         // optional structured detail (validation errors, etc.)
 *   }
 *
 * Migration pattern:
 *   - At the top of a route, mint a requestId via getOrMintRequestId(req)
 *   - Replace every `NextResponse.json(payload, { status })` with `ok(...)`
 *     or `err(...)` from this file
 *   - Pass `requestId` through to the helpers
 *
 * Migrating ALL routes is a mechanical refactor — see the audit notes in
 * the overnight handoff for the queue.
 */

import { NextResponse } from 'next/server';

/** The standard envelope. T is the route-specific payload type. */
export interface ApiResponse<T = unknown> {
  ok: boolean;
  requestId: string;
  data?: T;
  error?: string;
  code?: string;
  details?: unknown;
}

export interface OkOptions {
  requestId: string;
  /** HTTP status. Defaults to 200. Use 201 / 202 for create / accepted. */
  status?: number;
  /** Extra response headers (e.g. Idempotency-Key echo). */
  headers?: HeadersInit;
}

export interface ErrOptions {
  requestId: string;
  /** HTTP status. Defaults to 500. Use 400 for validation, 401 for auth, 429 for rate limits, etc. */
  status?: number;
  /** Stable machine-readable code (e.g. "rate_limited", "validation_failed", "not_found"). */
  code?: string;
  /** Optional structured error detail. */
  details?: unknown;
  /** Extra response headers (e.g. Retry-After). */
  headers?: HeadersInit;
}

/**
 * Build a success NextResponse with the standard envelope. Pass any
 * route-specific payload as `data`.
 *
 *   return ok({ rooms, total }, { requestId });
 */
export function ok<T>(data: T, opts: OkOptions): NextResponse {
  return NextResponse.json(buildOkBody(data, opts.requestId), {
    status: opts.status ?? 200,
    headers: opts.headers,
  });
}

/**
 * Build the success envelope as a plain object (without wrapping it in a
 * NextResponse). Used by routes that need to STORE the response body in
 * the idempotency cache and ALSO return it to the caller. Storing the
 * envelope (rather than just `data`) means a cache hit returns exactly
 * the same shape as a fresh response, so retries are indistinguishable
 * from first-time calls from the UI's perspective.
 *
 *   const body = buildOkBody({ sent, failed }, requestId);
 *   if (idem.kind === 'first') {
 *     await recordIdempotency(idem.key, 'route', body, 200, pid);
 *   }
 *   return NextResponse.json(body);
 */
export function buildOkBody<T>(data: T, requestId: string): ApiResponse<T> {
  return { ok: true, requestId, data };
}

/**
 * Build an error NextResponse with the standard envelope. `error` is the
 * human-readable message returned to the client; do NOT include secrets,
 * stack traces, or PII here. Use `code` for machine-stable identifiers.
 *
 *   return err('Rate limited', { requestId, status: 429, code: 'rate_limited' });
 */
export function err(error: string, opts: ErrOptions): NextResponse {
  const body: ApiResponse<never> = {
    ok: false,
    requestId: opts.requestId,
    error,
    ...(opts.code !== undefined ? { code: opts.code } : {}),
    ...(opts.details !== undefined ? { details: opts.details } : {}),
  };
  return NextResponse.json(body, {
    status: opts.status ?? 500,
    headers: opts.headers,
  });
}

/**
 * Common error codes. Add to this list rather than inventing strings at
 * call sites — keeping codes finite makes them grep-able and lets the
 * client write a switch statement.
 */
export const ApiErrorCode = {
  Unauthorized: 'unauthorized',
  Forbidden: 'forbidden',
  NotFound: 'not_found',
  ValidationFailed: 'validation_failed',
  RateLimited: 'rate_limited',
  IdempotencyConflict: 'idempotency_conflict',
  UpstreamFailure: 'upstream_failure',
  InternalError: 'internal_error',
} as const;

export type ApiErrorCodeValue = typeof ApiErrorCode[keyof typeof ApiErrorCode];
