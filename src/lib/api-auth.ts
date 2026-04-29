/**
 * Shared API-route auth helpers.
 *
 * We have two distinct auth contexts and they were each previously
 * inlined or skipped across many routes — this file centralizes both
 * so adding a new route is one import + one call instead of a
 * copy-pasted blob that drifts out of sync with the others.
 *
 *   1. CRON_SECRET   — admin/maintenance routes hit by GitHub Actions
 *                       cron, our local curl, or the Railway watchdog.
 *                       Bearer token in `Authorization` header. If the
 *                       env var isn't set (dev), pass-through so local
 *                       devs can still hit the route without ceremony.
 *
 *   2. requireSession — user-facing routes triggered from the
 *                       authenticated UI. Verify a Supabase access
 *                       token in `Authorization: Bearer …` against
 *                       the admin client, optionally check that the
 *                       caller has access to the property in the body.
 */

import { timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';

/**
 * Returns null on success, or a NextResponse the caller should return
 * to short-circuit with 401. If CRON_SECRET is unset (dev), allows
 * everything through.
 *
 * Constant-time string compare via crypto.timingSafeEqual on equal-length
 * buffers — `===` short-circuits on the first differing byte and leaks the
 * secret over many requests through response timing. The Railway scraper
 * uses the same pattern (scraper/scraper.js post-Apr-28); keeping this
 * symmetric so neither side is the weakest link.
 */
export function requireCronSecret(req: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return null;  // dev mode — no secret configured
  const auth = req.headers.get('authorization') ?? '';
  const expected = `Bearer ${secret}`;
  const authBuf = Buffer.from(auth);
  const expectedBuf = Buffer.from(expected);
  let ok = false;
  if (authBuf.length === expectedBuf.length) {
    try { ok = timingSafeEqual(authBuf, expectedBuf); } catch { ok = false; }
  }
  if (ok) return null;
  return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
}

/**
 * Verify a Supabase user session from the Authorization header.
 * Returns the user info on success, or a NextResponse the caller
 * should return to short-circuit with 401.
 *
 * The UI must send the access token like:
 *   const { data: { session } } = await supabase.auth.getSession();
 *   fetch('/api/...', {
 *     headers: { Authorization: `Bearer ${session.access_token}` },
 *     ...
 *   });
 */
export async function requireSession(req: NextRequest): Promise<
  | { ok: true; userId: string; email: string | null }
  | { ok: false; response: NextResponse }
> {
  const auth = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (!m) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'missing bearer token' }, { status: 401 }),
    };
  }
  const token = m[1];
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data.user) {
      return {
        ok: false,
        response: NextResponse.json({ error: 'invalid session token' }, { status: 401 }),
      };
    }
    return { ok: true, userId: data.user.id, email: data.user.email ?? null };
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: 'auth verification failed' }, { status: 500 }),
    };
  }
}

/**
 * Dual-auth: accept EITHER a valid Supabase session token OR the
 * CRON_SECRET. Used by routes that are user-facing (Mario clicks a
 * button) but also need to be reachable from cron or smoke tests
 * (post-deploy verification, the watchdog's periodic ping).
 *
 * Order matters: try CRON_SECRET first because it's a constant-time
 * memcmp (O(1), no network), and only fall through to a Supabase Auth
 * round-trip if the secret didn't match. That keeps cron requests fast
 * and avoids hammering Supabase Auth on every health check.
 *
 * Returns:
 *   { ok: true, kind: 'cron' }                  — CRON_SECRET matched
 *   { ok: true, kind: 'session', userId, email } — session token validated
 *   { ok: false, response }                       — neither, 401
 *
 * If CRON_SECRET is unset (dev), the helper still requires a valid
 * session token. Pre-launch dev mode: just set a CRON_SECRET locally.
 */
export async function requireSessionOrCron(req: NextRequest): Promise<
  | { ok: true; kind: 'cron' }
  | { ok: true; kind: 'session'; userId: string; email: string | null }
  | { ok: false; response: NextResponse }
> {
  const auth = req.headers.get('authorization') ?? '';

  // Try cron-secret first (fast path, constant time).
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const expected = `Bearer ${cronSecret}`;
    const authBuf = Buffer.from(auth);
    const expectedBuf = Buffer.from(expected);
    if (authBuf.length === expectedBuf.length) {
      try {
        if (timingSafeEqual(authBuf, expectedBuf)) {
          return { ok: true, kind: 'cron' };
        }
      } catch {
        // length mismatch already handled by the if-guard; this is the
        // belt-and-suspenders catch.
      }
    }
  }

  // Fall through to session validation.
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (!m) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'missing bearer token' }, { status: 401 }),
    };
  }
  const token = m[1];
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data.user) {
      return {
        ok: false,
        response: NextResponse.json({ error: 'invalid session token' }, { status: 401 }),
      };
    }
    return { ok: true, kind: 'session', userId: data.user.id, email: data.user.email ?? null };
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: 'auth verification failed' }, { status: 500 }),
    };
  }
}

/**
 * Verify the caller has access to a specific property. Used after
 * requireSession() succeeds — confirms the userId is associated with
 * the pid via the `accounts` table.
 *
 * Returns true if the caller has access, false otherwise. The caller
 * decides whether to 403 or silently no-op.
 */
export async function userHasPropertyAccess(userId: string, pid: string): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin
      .from('accounts')
      .select('role, property_access')
      .eq('data_user_id', userId)
      .maybeSingle();
    if (error || !data) return false;
    if (data.role === 'admin') return true;  // admins access every property
    const access = (data.property_access ?? []) as string[];
    return access.includes(pid) || access.includes('*');
  } catch {
    return false;
  }
}
