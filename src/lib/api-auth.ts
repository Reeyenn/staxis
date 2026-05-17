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
import { log } from '@/lib/log';
import { env } from '@/lib/env';

/**
 * Classification of session-validation failure modes. The client (fetchWithAuth)
 * reads this `code` from the JSON body to decide between auto-refresh vs. forced
 * sign-out. Keep these stable — they're a client/server contract.
 *
 *   token_expired     — JWT's `exp` claim is in the past, OR Supabase says
 *                       "JWT expired". Client should refresh and retry once.
 *   token_malformed   — Token isn't a parseable JWT (3 parts, valid base64).
 *                       Client should sign out and re-login.
 *   user_not_found    — JWT is valid but `auth.users` has no matching row.
 *                       Either the user was deleted or the session was revoked.
 *                       Client should sign out.
 *   project_mismatch  — JWT's `iss` claim doesn't match this deploy's
 *                       NEXT_PUBLIC_SUPABASE_URL. Almost always a Vercel
 *                       env-var drift. Client must sign out; ops must fix.
 *   auth_unavailable  — Supabase Auth service returned a 5xx or the call
 *                       threw. Transient — caller should not sign out, just
 *                       surface a retry prompt.
 *   missing_token     — No Authorization header at all (different from
 *                       "invalid token"; client treats this as expired).
 *   unknown           — Catch-all for failures we haven't classified yet.
 */
export type SessionFailureCode =
  | 'token_expired'
  | 'token_malformed'
  | 'user_not_found'
  | 'project_mismatch'
  | 'auth_unavailable'
  | 'missing_token'
  | 'unknown';

interface DecodedClaims {
  iss?: string;
  aud?: string;
  exp?: number;
  sub?: string;
}

/**
 * Decode a Supabase JWT's payload WITHOUT verifying the signature. We use
 * this to log diagnostic claims when validation has already failed — there's
 * no security boundary here, the token is being rejected.
 *
 * Returns null on any parse failure (not a 3-part token, bad base64, bad
 * JSON). Never throws.
 */
function decodeJwtClaimsUnverified(token: string): DecodedClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(b64, 'base64').toString('utf8');
    const obj = JSON.parse(json) as Record<string, unknown>;
    return {
      iss: typeof obj.iss === 'string' ? obj.iss : undefined,
      aud: typeof obj.aud === 'string' ? obj.aud : undefined,
      exp: typeof obj.exp === 'number' ? obj.exp : undefined,
      sub: typeof obj.sub === 'string' ? obj.sub : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Classify a session-validation failure into one of the codes above so the
 * client can decide between refresh-and-retry vs. hard sign-out, and so
 * server logs/Sentry have an actionable tag.
 *
 * Inputs:
 *   token        — the raw bearer token the client sent (used to read claims)
 *   supabaseErr  — error returned by supabaseAdmin.auth.getUser, or null if
 *                  the call succeeded but data.user was falsy
 *   userMissing  — true if data.user was falsy (distinct from supabaseErr)
 */
function classifySessionFailure(
  token: string,
  supabaseErr: { message?: string; status?: number; name?: string } | null,
  userMissing: boolean,
): { code: SessionFailureCode; claims: DecodedClaims | null } {
  const claims = decodeJwtClaimsUnverified(token);

  // Token doesn't even parse as a JWT — malformed.
  if (!claims) return { code: 'token_malformed', claims: null };

  // Hard server unavailability (5xx from Supabase Auth) — transient. Don't
  // sign the user out for this.
  if (supabaseErr?.status && supabaseErr.status >= 500) {
    return { code: 'auth_unavailable', claims };
  }

  // Expiry: prefer the claim, fall back to the error message.
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp === 'number' && claims.exp < now) {
    return { code: 'token_expired', claims };
  }
  const msg = (supabaseErr?.message ?? '').toLowerCase();
  if (msg.includes('expired') || msg.includes('jwt expired')) {
    return { code: 'token_expired', claims };
  }

  // Project mismatch: JWT was signed by a different Supabase project than
  // this deploy's URL points to. Issuer is `<NEXT_PUBLIC_SUPABASE_URL>/auth/v1`.
  const expectedUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  if (expectedUrl && claims.iss && !claims.iss.startsWith(expectedUrl)) {
    return { code: 'project_mismatch', claims };
  }

  // Supabase explicitly told us the user is gone (or no user came back even
  // though we had no error to inspect).
  if (msg.includes('user not found') || msg.includes('user_not_found') || userMissing) {
    return { code: 'user_not_found', claims };
  }

  return { code: 'unknown', claims };
}

/** Build the 401 response from a classified failure. */
function authFailureResponse(
  code: SessionFailureCode,
  hint?: string,
): NextResponse {
  return NextResponse.json(
    {
      error: 'invalid session token',
      code,
      ...(hint ? { hint } : {}),
    },
    { status: 401 },
  );
}

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
  const secret = env.CRON_SECRET;
  if (!secret) {
    // Fail-closed in TRUE production only. A missing CRON_SECRET on a
    // real prod deploy is config drift (env var dropped during a redeploy)
    // — historically this would silently open every admin/cron endpoint.
    //
    // Vercel preview deploys also have NODE_ENV='production' but are not
    // a security boundary; gating on VERCEL_ENV lets previews still pass
    // through unsigned for smoke tests. Railway/Fly prod (no VERCEL_ENV)
    // falls through to the NODE_ENV check.
    const isVercelProd = env.VERCEL_ENV === 'production';
    const isOtherProd = env.NODE_ENV === 'production' && !env.VERCEL_ENV;
    if (isVercelProd || isOtherProd) {
      console.error('[api-auth] CRON_SECRET unset in production — refusing request');
      return NextResponse.json({ error: 'server misconfigured' }, { status: 500 });
    }
    return null;  // dev / preview — no secret configured
  }
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
  const route = new URL(req.url).pathname;
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (!m) {
    // Treat as expired for client purposes — the natural recovery (refresh
    // session, attach header, retry) is the same.
    log.warn('requireSession: missing bearer header', { route, code: 'missing_token' });
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'missing bearer token', code: 'missing_token' satisfies SessionFailureCode },
        { status: 401 },
      ),
    };
  }
  const token = m[1];
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data.user) {
      const { code, claims } = classifySessionFailure(
        token,
        error
          ? { message: error.message, status: error.status, name: error.name }
          : null,
        !data.user,
      );
      // Log enough to act on: failure code, decoded claims (no signature, no
      // user PII beyond the auth uuid which we already log everywhere), and
      // the Supabase error message. Goes through log.warn (warn doesn't ship
      // to Sentry — see log.ts), so this doesn't flood the Sentry dashboard
      // every time a user's tab sits idle past their JWT expiry. Project
      // mismatch is the one case we DO want in Sentry because it's a config
      // bug, not a normal expiry.
      const fields = {
        route,
        code,
        supabaseErr: error?.message ?? null,
        supabaseStatus: error?.status ?? null,
        jwt_iss: claims?.iss ?? null,
        jwt_aud: claims?.aud ?? null,
        jwt_exp: claims?.exp ?? null,
        jwt_sub: claims?.sub ?? null,
        expected_iss_prefix: env.NEXT_PUBLIC_SUPABASE_URL ?? null,
      };
      if (code === 'project_mismatch') {
        log.error('requireSession: project mismatch — env-var drift', fields);
      } else {
        log.warn('requireSession: rejected', fields);
      }
      return { ok: false, response: authFailureResponse(code) };
    }
    return { ok: true, userId: data.user.id, email: data.user.email ?? null };
  } catch (err) {
    log.error('requireSession: auth verification threw', {
      route,
      err: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'auth verification failed', code: 'auth_unavailable' satisfies SessionFailureCode },
        { status: 500 },
      ),
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
  const cronSecret = env.CRON_SECRET;
  // In TRUE production a missing CRON_SECRET means the cron path is
  // disabled — session validation may still succeed below. Same
  // VERCEL_ENV gating as requireCronSecret so preview deploys don't
  // spam this log line.
  const isVercelProd = env.VERCEL_ENV === 'production';
  const isOtherProd = env.NODE_ENV === 'production' && !env.VERCEL_ENV;
  if (!cronSecret && (isVercelProd || isOtherProd)) {
    console.error('[api-auth] CRON_SECRET unset in production — cron path disabled');
  }
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
  const route = new URL(req.url).pathname;
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (!m) {
    log.warn('requireSessionOrCron: missing bearer header', { route, code: 'missing_token' });
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'missing bearer token', code: 'missing_token' satisfies SessionFailureCode },
        { status: 401 },
      ),
    };
  }
  const token = m[1];
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data.user) {
      const { code, claims } = classifySessionFailure(
        token,
        error
          ? { message: error.message, status: error.status, name: error.name }
          : null,
        !data.user,
      );
      const fields = {
        route,
        code,
        supabaseErr: error?.message ?? null,
        supabaseStatus: error?.status ?? null,
        jwt_iss: claims?.iss ?? null,
        jwt_aud: claims?.aud ?? null,
        jwt_exp: claims?.exp ?? null,
        jwt_sub: claims?.sub ?? null,
        expected_iss_prefix: env.NEXT_PUBLIC_SUPABASE_URL ?? null,
      };
      if (code === 'project_mismatch') {
        log.error('requireSessionOrCron: project mismatch — env-var drift', fields);
      } else {
        log.warn('requireSessionOrCron: rejected', fields);
      }
      return { ok: false, response: authFailureResponse(code) };
    }
    return { ok: true, kind: 'session', userId: data.user.id, email: data.user.email ?? null };
  } catch (err) {
    log.error('requireSessionOrCron: auth verification threw', {
      route,
      err: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'auth verification failed', code: 'auth_unavailable' satisfies SessionFailureCode },
        { status: 500 },
      ),
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
