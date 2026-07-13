/**
 * Client half of the API envelope.
 *
 * The server half lives in src/lib/api-response.ts: every /api/* route
 * returns { ok, requestId, data?, error?, code?, details? }. This module
 * is the ONE place the client unwraps that shape, so pages stop hand-rolling
 * `res.json().then(j => j?.ok ? j.data : ...)` with subtly different error
 * handling each time.
 *
 * Deliberately a separate file from api-response.ts (which re-exports it):
 * api-response.ts imports `next/server`, and this helper is consumed from
 * 'use client' hooks/components — keeping it here keeps next/server out of
 * the client bundle. No React, no Next imports; safe everywhere.
 */

import type { ApiResponse } from './api-response';

/**
 * What the client gets back after unwrapping a Response.
 *
 * Exactly one of `data` / `error` is present — check `result.error` first:
 *
 *   const result = await readEnvelope<Room[]>(res);
 *   if (result.error) { setError(result.error); return; }
 *   setRooms(result.data);
 */
export type EnvelopeResult<T> =
  | { data: T; error?: undefined; code?: undefined; status?: undefined; requestId?: string }
  | { data?: undefined; error: string; code?: string; status?: number; requestId?: string };

/**
 * Unwrap a fetch Response carrying the standard envelope.
 *
 * Success requires BOTH transport success (`res.ok`) and envelope success
 * (`body.ok === true`) — a 200 with `{ ok: false }` is still an error.
 * A non-JSON body (HTML error page, empty 502 from the proxy, aborted
 * stream) never throws; it becomes `Failed (<status>)`.
 *
 * On error, `code` (machine-stable, see ApiErrorCode) and `status` ride
 * along so callers can special-case e.g. rate limiting; `requestId` rides
 * along on both paths for support/Sentry triage.
 *
 * `fallbackError` (optional) replaces the generic `Failed (<status>)` text
 * when the body carries no usable error string — pages with bespoke
 * bilingual copy pass their own message. A server-provided error string
 * still wins over the fallback.
 */
export async function readEnvelope<T>(
  res: Response,
  fallbackError?: string,
): Promise<EnvelopeResult<T>> {
  const body = (await res.json().catch(() => null)) as Partial<ApiResponse<T>> | null;
  const requestId =
    body && typeof body.requestId === 'string' ? body.requestId : undefined;

  if (!res.ok || !body || body.ok !== true) {
    const message =
      body && typeof body.error === 'string' && body.error.length > 0
        ? body.error
        : fallbackError !== undefined && fallbackError.length > 0
          ? fallbackError
          : `Failed (${res.status})`;
    return {
      error: message,
      status: res.status,
      ...(body && typeof body.code === 'string' ? { code: body.code } : {}),
      ...(requestId !== undefined ? { requestId } : {}),
    };
  }

  return {
    data: body.data as T,
    ...(requestId !== undefined ? { requestId } : {}),
  };
}
