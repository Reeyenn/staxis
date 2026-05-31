/**
 * Stripe-style request-idempotency helper.
 *
 * Routes that send SMS, write to billing, or do other expensive non-
 * idempotent work look up the caller-supplied `Idempotency-Key` header
 * here before doing anything.
 *
 * Convention (matching Stripe / Twilio):
 *   - Header name: `Idempotency-Key`. Case-insensitive (HTTP headers).
 *   - Value: caller-chosen UUID/ULID/short-hash. Treated as opaque text.
 *   - Optional. Routes accept requests without the header — those bypass
 *     the cache entirely (legacy callers, internal cron).
 *
 * The claim is ATOMIC (migration 0243's claim_idempotency_key RPC), which
 * closes the old check-then-act double-send race: two concurrent retries of
 * the same key no longer both read "no row" and both do the work. Exactly one
 * caller wins ('first'); concurrent callers get the cached response ('cached')
 * if the work already finished, or a 409 ('in-progress') if it's mid-flight.
 *
 * Storage: `idempotency_log` table (migration 0019). The winning caller writes
 * a 5-minute "pending" marker; recordIdempotency replaces it with the real
 * response + the full 24h TTL. A crashed first attempt frees the key in 5 min.
 *
 * Usage pattern in a route handler:
 *
 *   const idem = await checkIdempotency(req, 'send-shift-confirmations');
 *   if (idem.kind === 'cached' || idem.kind === 'in-progress') return idem.response;
 *
 *   // ... do the work ...
 *   const result = { ok: true, sent: 12 };
 *
 *   if (idem.kind === 'first') {
 *     await recordIdempotency(idem.key, 'send-shift-confirmations', result, 200, pid);
 *   }
 *   return NextResponse.json(result);
 *
 * Key length is bounded to prevent abuse (256 chars max). Anything longer or
 * malformed is treated as no-key.
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
  | { kind: 'in-progress'; response: NextResponse }
  | { kind: 'first'; key: string }
  | { kind: 'no-key' };

/** Single row shape returned by the claim_idempotency_key RPC. */
interface ClaimRow {
  claimed: boolean;
  existing_response: unknown;
  existing_status: number | null;
  existing_route: string | null;
}

/**
 * Atomically claim the caller's Idempotency-Key. Four outcomes:
 *
 *   - 'first'       — we won the claim. Run the work, then call
 *                     recordIdempotency() to cache the result.
 *   - 'cached'      — the work already completed under this key; return the
 *                     stored response immediately.
 *   - 'in-progress' — a concurrent request holds the key and hasn't finished;
 *                     return its 409 so the caller backs off (no double-work).
 *   - 'no-key'      — caller didn't send a (valid) header; proceed without dedup.
 */
export async function checkIdempotency(
  req: NextRequest,
  route: string,
): Promise<IdempotencyState> {
  const raw = req.headers.get(KEY_HEADER);
  if (!raw) return { kind: 'no-key' };
  const key = raw.trim();
  if (key.length === 0 || key.length > MAX_KEY_LENGTH || !KEY_FORMAT.test(key)) {
    // Treat malformed keys as no-key — conservative; skip the cache rather
    // than 400 the request. Routes validate their own body shape.
    return { kind: 'no-key' };
  }

  try {
    const { data, error } = await supabaseAdmin.rpc('claim_idempotency_key', {
      p_key: key,
      p_route: route,
    });

    if (error) {
      // Don't fail the route if the claim blows up — better to possibly
      // double-send than to refuse all sends. Surfaced in logs.
      console.warn('[idempotency] claim rpc failed:', error.message);
      return { kind: 'first', key };
    }

    const row = (Array.isArray(data) ? data[0] : data) as ClaimRow | undefined;
    // We won the claim (fresh insert or expired-row takeover), or there's
    // somehow no row to report — either way, proceed and do the work.
    if (!row || row.claimed) return { kind: 'first', key };

    // Held by a fresh row. If it belongs to a DIFFERENT route, the key was
    // reused across operations — not a hit; proceed.
    if (row.existing_route !== route) return { kind: 'first', key };

    const resp = row.existing_response;
    const isPending =
      !!resp && typeof resp === 'object' &&
      (resp as Record<string, unknown>).__pending__ === true;

    if (isPending) {
      return {
        kind: 'in-progress',
        response: NextResponse.json(
          {
            ok: false,
            error: 'A request with this Idempotency-Key is already being processed.',
            code: 'IdempotencyInProgress',
          },
          { status: 409 },
        ),
      };
    }

    return {
      kind: 'cached',
      response: NextResponse.json(resp ?? {}, { status: row.existing_status ?? 200 }),
    };
  } catch (err) {
    console.warn('[idempotency] claim raised:', err);
    return { kind: 'first', key };
  }
}

/**
 * Replace the pending claim with the real response and extend the TTL to 24h
 * so retries within the next day hit the cache.
 *
 * Best-effort: caching must never make a successful request fail. The row was
 * created by checkIdempotency's claim (kind === 'first'); this UPDATE fills it
 * in. If the claim already expired/was pruned, the update no-ops and a later
 * retry simply re-does the work.
 */
export async function recordIdempotency(
  key: string,
  route: string,
  responseBody: unknown,
  statusCode: number,
  pid?: string | null,
): Promise<void> {
  try {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await supabaseAdmin
      .from('idempotency_log')
      .update({
        response: responseBody,
        status_code: statusCode,
        property_id: pid ?? null,
        expires_at: expiresAt,
      })
      .eq('key', key)
      .eq('route', route);
  } catch (err) {
    console.warn('[idempotency] cache write failed (non-fatal):', err);
  }
}
