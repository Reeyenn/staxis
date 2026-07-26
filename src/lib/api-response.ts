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

// Client half of the envelope (unwrap a fetch Response into { data } |
// { error }). Implementation lives in ./api-envelope so 'use client' code
// can import it without dragging next/server into the browser bundle;
// re-exported here so server-side callers see one module for the whole
// envelope story.
export { readEnvelope } from './api-envelope';
export type { EnvelopeResult } from './api-envelope';

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
  /**
   * Extra TOP-LEVEL sibling keys merged next to { ok, requestId, data }.
   * Use when `data`'s shape is load-bearing for already-deployed clients
   * (the public housekeeper/laundry pages hard-require Array.isArray(data),
   * and stale mobile bundles keep polling old shapes after a deploy) but the
   * route needs to carry an additional payload — new clients read the
   * sibling key, old clients ignore it. Envelope keys always win on
   * collision (spread order below).
   */
  extra?: Record<string, unknown>;
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
  const body = opts.extra
    ? { ...opts.extra, ...buildOkBody(data, opts.requestId) }
    : buildOkBody(data, opts.requestId);
  return NextResponse.json(body, {
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
  // Partial failure — some sub-operations succeeded, some didn't.
  // Paired with HTTP 207; `details` carries per-item outcome.
  PartialFailure: 'partial_failure',

  // ── The knowledge surfaces: the Knows screen and the company rulebook ─────
  // These screens are bilingual and their banners are read by housekeepers'
  // and managers' own eyes. A route's `error` string is English and always
  // will be — it is the log/dev surface. So each refusal ALSO carries a code
  // narrow enough that the client can own the sentence in EN and ES. Anything
  // that would read differently to a person gets its own code; anything that
  // reads the same shares one (every "that row is gone" is `fact_gone`).
  AccountNotFound: 'account_not_found',
  InvalidBody: 'invalid_body',
  UnknownAction: 'unknown_action',
  UnknownCategory: 'unknown_category',
  ContentRequired: 'content_required',
  SettingsRequired: 'settings_required',
  ConfirmFailed: 'confirm_failed',
  /** The fact / rulebook line the button pointed at is no longer in the book. */
  FactGone: 'fact_gone',
  RemoveFailed: 'remove_failed',
  SaveFailed: 'save_failed',
  MergeFailed: 'merge_failed',
  SettingsSaveFailed: 'settings_save_failed',
  /** Submitted with an empty box and no file. */
  NothingToRead: 'nothing_to_read',
  /** A file we could open, with no text in it at all. */
  FileNoText: 'file_no_text',
  /**
   * We could not get text out of that file. Collapses every developer-facing
   * parse/vision diagnostic — a person needs one sentence, not the reason
   * the PDF library gave up.
   */
  FileUnreadable: 'file_unreadable',
  /** Text arrived, but every chunk of it was blank. */
  NothingReadable: 'nothing_readable',
  AiDisabled: 'ai_disabled',
  AiUnavailable: 'ai_unavailable',
  /** This hotel is independent — it has no management company above it. */
  NoCompany: 'no_company',
  CompanyLeadershipOnly: 'company_leadership_only',
  FileTypeUnsupported: 'file_type_unsupported',
  FileTooBig: 'file_too_big',
  FileMalformed: 'file_malformed',
  /** The hotel's daily AI spend cap. Distinct from `rate_limited` on purpose:
   *  "come back in a minute" and "come back tomorrow" are different answers. */
  AiBudgetExhausted: 'ai_budget_exhausted',
} as const;

export type ApiErrorCodeValue = typeof ApiErrorCode[keyof typeof ApiErrorCode];
