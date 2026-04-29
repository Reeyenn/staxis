/**
 * Stripe-style request-idempotency helper.
 *
 * Routes that send SMS, write to billing, or do other expensive non-
 * idempotent work look up the caller-supplied `Idempotency-Key` header
 * here before doing anything. If we've seen the key in the last 24h,
 * return the cached response and skip the work — that's the whole point.
 *
 * Convention (matching Stripe / Twilio):
 *   - Header name: `Idempotency-Key`. Case-insensitive (HTTP headers).
 *   - Value: caller-chosen UUID/ULID/short-hash. Treated as opaque text.
 *   - Optional. Routes accept requests without the header — those
 *     bypass the cache entirely (legacy callers, internal cron).
 *
 * Storage: `idempotency_log` table (migration 0019). 24h TTL, RLS
 * deny-all to anon/authenticated, service-role bypasses for these
 * helpers (which run server-side only).
 *
 * Usage pattern in a route handler:
 *
 *   const idem = await checkIdempotency(req, 'send-shift-confirmations');
 *   if (idem.kind === 'cached') return idem.response;
 *
 *   // ... do the work ...
 *   const result = { ok: true, sent: 12 };
 *
 *   if (idem.kind === 'first') {
 *     await recordIdempotency(idem.key, 'send-shift-confirmations', result, 200, pid);
 *   }
 *   return NextResponse.json(result);
 *
 * Key length is bounded to prevent abuse (256 chars max). Anything
 * longer is treated as no-key.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';

const KEY_HEADER = 'idempotency-key';
const MAX_KEY_LENGTH = 256;
// Allow alphanumerics, dashes, underscores. Rejects anything weird that
// could be path-traversal-like or break the storage layer.
const KEY_FORMAT = /^[A-Za-z0-9_-]{1,256}$/;

export type IdempotencyState =
  | { kind: 'cached'; response: NextResponse }
  | { kind: 'first'; key: string }
  | { kind: 'no-key' };

/**
 * Look up the caller's Idempotency-Key. Three outcomes:
 *
 *   - 'cached'  — we've seen this key for this route. Return the cached
 *                 response immediately; do not redo the work.
 *   - 'first'   — first time we've seen this key. Caller should run the
 *                 work and call `recordIdempotency()` after.
 *   - 'no-key'  — caller didn't send the header. Caller is free to
 *                 proceed without dedup; legacy or cron path.
 */
export async function checkIdempotency(
  req: NextRequest,
  route: string,
): Promise<IdempotencyState> {
  const raw = req.headers.get(KEY_HEADER);
  if (!raw) return { kind: 'no-key' };
  const key = raw.trim();
  if (key.length === 0 || key.length > MAX_KEY_LENGTH || !KEY_FORMAT.test(key)) {
    // Treat malformed keys as no-key. Conservative — don't 400 the
    // request, just skip the cache. Routes that care can validate
    // their own request shape.
    return { kind: 'no-key' };
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('idempotency_log')
      .select('response, status_code, expires_at, route')
      .eq('key', key)
      .maybeSingle();

    if (error) {
      // Don't fail the route if the cache lookup blows up — better to
      // possibly double-send than to refuse all sends. Log the issue
      // upstream.
      // eslint-disable-next-line no-console
      console.warn('[idempotency] cache lookup failed:', error.message);
      return { kind: 'first', key };
    }
    if (!data) return { kind: 'first', key };

    // Cache hit. Verify route matches — same key on a different route
    // means the caller is reusing a UUID across endpoints (unlikely but
    // possible). Treat as no-key to avoid returning the wrong shape.
    if ((data as { route?: string }).route !== route) {
      return { kind: 'first', key };
    }
    // Verify still fresh (we have an index on expires_at; cleanup runs
    // nightly, but it's possible an entry survives past expiry between
    // cleanups).
    const expiresAt = new Date((data as { expires_at: string }).expires_at).getTime();
    if (expiresAt < Date.now()) {
      return { kind: 'first', key };
    }

    const response = NextResponse.json(
      (data as { response: unknown }).response,
      { status: (data as { status_code?: number }).status_code ?? 200 },
    );
    return { kind: 'cached', response };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[idempotency] cache check raised:', err);
    return { kind: 'first', key };
  }
}

/**
 * Persist a route's response under the idempotency key so a retry
 * within the next 24 hours hits the cache.
 *
 * Best-effort: writing to the cache should never make a successful
 * request fail. If the insert errors (DB hiccup, conflict on a parallel
 * retry that beat us to it), we just don't cache and the caller still
 * sends the success response to the client.
 */
export async function recordIdempotency(
  key: string,
  route: string,
  responseBody: unknown,
  statusCode: number,
  pid?: string | null,
): Promise<void> {
  try {
    await supabaseAdmin.from('idempotency_log').insert({
      key,
      route,
      response: responseBody,
      status_code: statusCode,
      property_id: pid ?? null,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[idempotency] cache write failed (non-fatal):', err);
  }
}
