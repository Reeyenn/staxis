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
import { createSupabaseServerClient } from '@/lib/supabase-server';
import { log } from '@/lib/log';
import { env } from '@/lib/env';
import { hashDeviceToken, readDeviceCookie } from '@/lib/trusted-device';
import { logSecurityEvent } from '@/lib/audit';
import { isTwoFactorEnabled } from '@/lib/two-factor';

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
  | 'requires_2fa'
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
 * Decode the `mfa_verified` claim from a Supabase JWT WITHOUT verifying the
 * signature. Safe here because the caller has ALREADY validated the token via
 * `supabaseAdmin.auth.getUser` before passing it in — we're only reading what
 * the (now-trusted) JWT carries.
 *
 * The custom_access_token_hook (migration 0163) emits this claim ONLY when
 * true, as a JSON boolean. We therefore require a strict boolean `=== true`:
 * an absent claim, the string "true", or any other value all read as NOT
 * verified. This is the same claim every RLS policy gates on
 * (`mfa_verified_or_grace()`), so Door B agrees with Door A.
 *
 * Returns false on any parse failure. Never throws.
 */
function decodeJwtMfaVerified(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(b64, 'base64').toString('utf8');
    const obj = JSON.parse(json) as Record<string, unknown>;
    return obj.mfa_verified === true;
  } catch {
    return false;
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
 * Server-side 2FA enforcement (Phase 1, audit 2026-05-21).
 *
 * Without this, `requireSession()` validated only the Supabase JWT. An
 * attacker with a leaked staff password could call `signInWithPassword`
 * directly (curl / postman) and use the resulting JWT against any
 * /api/* route — the OTP step was pure UI choreography, never enforced
 * server-side. With this, every /api/* call that uses requireSession
 * must ALSO carry a valid `staxis_device` cookie matching a non-expired
 * row in `trusted_devices` (the cookie is issued only after OTP).
 *
 * Skip-2FA escape hatch: the same demo bypass that check-trust uses
 * (account.skip_2fa=true + SKIP_2FA_ENABLED=true env + user in
 * SKIP_2FA_USER_IDS allowlist + role!='admin' + no '*' in
 * property_access) is honored here too, so investor demo accounts
 * keep working exactly as before.
 *
 * Global switch: when the admin-toggleable human-2FA switch (migration
 * 0310, src/lib/two-factor.ts) is OFF, this returns ok immediately with
 * via='twofa_disabled' — the single server choke-point for the bypass.
 * isTwoFactorEnabled() fail-safes to TRUE on any error, so the bypass
 * only fires when the flag is provably off.
 *
 * Returns:
 *   { ok: true, via: 'device' | 'skip_2fa' | 'mfa_session' | 'twofa_disabled' }
 *                                             — caller proceeds
 *   { ok: false, reason }                     — caller returns 401 requires_2fa
 *
 * Fail-closed: any thrown error (DB outage, etc.) returns ok:false with
 * reason='db_error', mirroring the existing check-trust posture so a
 * Supabase hiccup doesn't silently open the gate.
 */
type DeviceTrustReason =
  | 'no_cookie'
  | 'cookie_invalid'
  | 'cookie_expired'
  | 'absolute_cap_reached'
  | 'no_account_row'
  | 'skip_2fa_blocked_by_env'
  | 'skip_2fa_not_allowlisted'
  | 'skip_2fa_refused_privileged'
  | 'db_error';

async function validateDeviceTrust(
  req: NextRequest,
  userId: string,
  route: string,
  requestId: string | null,
  // The already-validated bearer access token (when the caller authenticated
  // via the Authorization header). Used to read the `mfa_verified` claim for
  // the per-session-verification Door-B path below. Null on the cookie-session
  // path (intentional — that path degrades to the cookie/skip_2fa checks; all
  // 171 fetchWithAuth call sites send a bearer header, so the per-session
  // path is always available to real app traffic).
  accessToken: string | null = null,
): Promise<
  | { ok: true; via: 'device' | 'skip_2fa' | 'mfa_session' | 'twofa_disabled' }
  | { ok: false; reason: DeviceTrustReason }
> {
  // Break-glass kill switch — now FAILS SAFE. Setting this env var on any
  // publicly-reachable deploy (Vercel production, Vercel preview, or any other
  // NODE_ENV=production host) must NEVER silently disable the whole 2FA gate:
  // we IGNORE it there and keep enforcing (the secure default wins). It is
  // honored ONLY in local dev/test, where it's a convenience, not a security
  // boundary. The doctor hard-flags it (status:'fail') whenever set so its
  // presence can't hide. Mirrors requireHeartbeatSecret's prod+preview posture.
  //
  // Recovery note: because prod no longer honors this flag, recovery from a
  // validateDeviceTrust regression that 401s real users is now revert+redeploy
  // (~3 min on Vercel), NOT an env-flip. Accepted tradeoff for not leaving a
  // single env var able to turn off all server-side 2FA in production.
  if (env.DISABLE_SERVER_2FA_ENFORCEMENT === 'true') {
    const isVercelProd = env.VERCEL_ENV === 'production';
    const isVercelPreview = env.VERCEL_ENV === 'preview';
    const isOtherProd = env.NODE_ENV === 'production' && !env.VERCEL_ENV;
    if (isVercelProd || isVercelPreview || isOtherProd) {
      log.error('[validateDeviceTrust] DISABLE_SERVER_2FA_ENFORCEMENT set on a protected (prod/preview) deploy — IGNORING and enforcing 2FA (fail-safe). Unset this env var.', {
        route,
        userId,
        requestId: requestId ?? undefined,
        vercelEnv: env.VERCEL_ENV ?? null,
      });
      // Fall through to normal enforcement — do NOT bypass.
    } else {
      // Local dev / test only: honor the bypass for engineers iterating
      // without a trusted-device cookie.
      log.warn('[validateDeviceTrust] 2FA enforcement bypassed (local dev/test break-glass)', {
        route,
        userId,
        requestId: requestId ?? undefined,
      });
      return { ok: true, via: 'device' };
    }
  }

  if (!(await isTwoFactorEnabled())) {
    // Global human-2FA switch is OFF (migration 0310, admin-toggleable).
    // Bypass device-cookie + mfa claim + skip_2fa allowlist in one stroke
    // for all callers. Fail-safe: isTwoFactorEnabled() returns true on any
    // error, so this only fires when the flag is provably off.
    return { ok: true, via: 'twofa_disabled' };
  }

  try {
    // Look up the caller's accounts row. We need role + property_access
    // for the skip_2fa privileged-account refusal.
    const { data: account, error: acctErr } = await supabaseAdmin
      .from('accounts')
      .select('id, skip_2fa, role, property_access')
      .eq('data_user_id', userId)
      .maybeSingle();

    if (acctErr) {
      log.error('[validateDeviceTrust] accounts lookup failed — failing closed', {
        route, userId, requestId: requestId ?? undefined, err: acctErr.message,
      });
      return { ok: false, reason: 'db_error' };
    }
    if (!account) {
      // Orphan auth user — auth.users row exists but no accounts row. Fail
      // closed; the orphan sweeper or admin will clean up.
      return { ok: false, reason: 'no_account_row' };
    }

    // Try the device-cookie path first. If valid, we're done.
    const cookieValue = readDeviceCookie(req);
    if (cookieValue) {
      const tokenHash = hashDeviceToken(cookieValue);
      const { data: row, error: rowErr } = await supabaseAdmin
        .from('trusted_devices')
        .select('id, expires_at, absolute_expires_at')
        .eq('account_id', account.id)
        .eq('token_hash', tokenHash)
        .maybeSingle();

      if (rowErr) {
        log.error('[validateDeviceTrust] trusted_devices lookup failed — failing closed', {
          route, userId, requestId: requestId ?? undefined, err: rowErr.message,
        });
        return { ok: false, reason: 'db_error' };
      }

      if (row) {
        const now = Date.now();
        if (new Date(row.expires_at).getTime() <= now) {
          return { ok: false, reason: 'cookie_expired' };
        }
        const absExpRaw = (row as { absolute_expires_at?: string | null }).absolute_expires_at;
        if (!absExpRaw) {
          // Migration 0153 should have made this NOT NULL — if it's null,
          // we're on a DB missing the migration. Fail closed.
          log.error('[validateDeviceTrust] absolute_expires_at missing — migration 0153 not applied?', {
            route, userId, requestId: requestId ?? undefined, deviceId: row.id,
          });
          return { ok: false, reason: 'absolute_cap_reached' };
        }
        if (new Date(absExpRaw).getTime() <= now) {
          return { ok: false, reason: 'absolute_cap_reached' };
        }
        // Valid device trust. Don't bump last_seen_at here (that's
        // check-trust's job, runs once per sign-in). Doing it on every API
        // call would be a write per request.
        return { ok: true, via: 'device' };
      }
      // Cookie present but no matching row — treat as cookie_invalid
      // (likely revoked, expired-and-deleted, or forged). Fall through
      // to the per-session-verification / skip_2fa checks.
    }

    // Per-session-verification (Door B) fallback. This is what lets a user who
    // completed OTP but UNCHECKED "Trust this device" use /api/* this session
    // without a durable trusted_devices cookie (audit 2026-06-26 empty-app P1).
    //
    // The `mfa_verified=true` claim is minted by the auth hook ONLY when a
    // mfa_verified_sessions row exists for this session (or for the skip_2fa
    // demo branch). For a NON-skip_2fa account the row is the only source, and
    // that row is written only by the password-proof-gated trust-device path —
    // so accepting the claim here is exactly as strong as the trusted_devices
    // cookie, and it makes Door B agree with Door A (RLS gates on the same
    // claim). A stolen-password signInWithPassword session has a fresh
    // session_id with no row → no claim → this is inert → still blocked.
    //
    // GATED on !account.skip_2fa on purpose: for skip_2fa accounts the hook
    // sets the claim from the DB flag WITHOUT checking the env allowlist, so
    // accepting the claim here would bypass the allowlist/privileged-refusal
    // defense-in-depth below. skip_2fa accounts must go through that block.
    if (accessToken && !account.skip_2fa && decodeJwtMfaVerified(accessToken)) {
      return { ok: true, via: 'mfa_session' };
    }

    // Skip-2FA fallback. Mirrors check-trust's gate (env var + allowlist)
    // PLUS the privileged-account refusal that check-trust also applies
    // in Phase 1 — defense in depth for the case where check-trust was
    // somehow bypassed (e.g., a future code path that doesn't call it).
    if (account.skip_2fa) {
      const envOn = env.SKIP_2FA_ENABLED === 'true';
      const allowlist = (env.SKIP_2FA_USER_IDS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const onAllowlist = allowlist.includes(userId);
      const role = (account.role as string) ?? '';
      const access = (account.property_access ?? []) as string[];
      const isPrivileged = role === 'admin' || access.includes('*');

      // Privileged refusal takes precedence: an admin row with skip_2fa
      // should NEVER bypass, even if the env gate + allowlist are
      // (mis)configured to permit it. Log critical so the misconfiguration
      // surfaces in Sentry the moment it happens.
      if (isPrivileged) {
        await logSecurityEvent({
          action: 'auth.skip_2fa_refused_privileged',
          userId,
          requestId: requestId ?? undefined,
          metadata: {
            accountId: account.id,
            role,
            hadWildcardAccess: access.includes('*'),
            enforcement_point: 'requireSession',
          },
        });
        return { ok: false, reason: 'skip_2fa_refused_privileged' };
      }

      if (!envOn) {
        await logSecurityEvent({
          action: 'auth.skip_2fa_blocked_by_env',
          userId,
          requestId: requestId ?? undefined,
          metadata: {
            accountId: account.id,
            envGate: env.SKIP_2FA_ENABLED ?? null,
            enforcement_point: 'requireSession',
          },
        });
        return { ok: false, reason: 'skip_2fa_blocked_by_env' };
      }
      if (!onAllowlist) {
        await logSecurityEvent({
          action: 'auth.skip_2fa_account_not_allowlisted',
          userId,
          requestId: requestId ?? undefined,
          metadata: {
            accountId: account.id,
            allowlistSize: allowlist.length,
            enforcement_point: 'requireSession',
          },
        });
        return { ok: false, reason: 'skip_2fa_not_allowlisted' };
      }

      // All gates passed. Log the bypass usage so we can correlate
      // unexpected demo-account activity in Sentry.
      await logSecurityEvent({
        action: 'auth.skip_2fa_used',
        userId,
        requestId: requestId ?? undefined,
        metadata: {
          accountId: account.id,
          enforcement_point: 'requireSession',
        },
      });
      return { ok: true, via: 'skip_2fa' };
    }

    // No cookie, no skip_2fa — caller needs to OTP.
    return { ok: false, reason: cookieValue ? 'cookie_invalid' : 'no_cookie' };
  } catch (err) {
    log.error('[validateDeviceTrust] unexpected error — failing closed', {
      route, userId, requestId: requestId ?? undefined,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: 'db_error' };
  }
}

function requires2faResponse(reason: DeviceTrustReason): NextResponse {
  return NextResponse.json(
    {
      error: 'two-factor authentication required',
      code: 'requires_2fa' satisfies SessionFailureCode,
      reason,
    },
    { status: 401 },
  );
}

/**
 * Cookie-session fallback. Reads the `sb-*-auth-token` cookies set by
 * `@supabase/ssr`'s `createBrowserClient` (and refreshed by the
 * middleware), validates against Supabase Auth, and returns the user.
 *
 * Returns `{ ok: false }` when no cookie session is present, or when the
 * cookie session is invalid, or when called outside a Next.js request
 * context (e.g. unit tests pass a bare `Request` mock — `cookies()` then
 * throws and we treat it as "no session"). The bearer-header path is
 * preserved for the 171 fetchWithAuth call sites that always send it;
 * this fallback only fires when the header is absent.
 */
async function tryCookieSession(route: string): Promise<
  | { ok: true; userId: string; email: string | null }
  | { ok: false }
> {
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user) return { ok: false };
    return { ok: true, userId: data.user.id, email: data.user.email ?? null };
  } catch (err) {
    log.warn('api-auth: cookie fallback errored', {
      route,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false };
  }
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
    // Fail-closed in production AND on Vercel preview.
    //
    // Security audit 2026-06-26: the previous version passed through on
    // Vercel *preview* deploys ("for smoke tests"). But preview deploys
    // inherit the production env — including SUPABASE_SERVICE_ROLE_KEY —
    // and are publicly reachable at a guessable <project>-<hash>.vercel.app
    // URL. An unsigned pass-through there let anyone on the internet call
    // destructive cron/admin endpoints (delete auth.users, purge rows,
    // drain the SMS queue, email a hotel's report) against LIVE customer
    // data. Now mirrors requireHeartbeatSecret exactly: preview is treated
    // as a production-grade security boundary, not as dev.
    const isVercelProd = env.VERCEL_ENV === 'production';
    const isVercelPreview = env.VERCEL_ENV === 'preview';
    const isOtherProd = env.NODE_ENV === 'production' && !env.VERCEL_ENV;
    if (isVercelProd || isVercelPreview || isOtherProd) {
      console.error('[api-auth] CRON_SECRET unset in prod/preview — refusing request');
      return NextResponse.json({ error: 'server misconfigured' }, { status: 500 });
    }
    return null;  // dev / test — no secret configured
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
 * Returns null on success, or a NextResponse the caller should return to
 * short-circuit with 401. If HEARTBEAT_SECRET is unset, fails closed in
 * production and passes through in dev. Same shape as requireCronSecret
 * but reads its own env var so the Claude Code heartbeat channel can be
 * rotated independently of cron secrets.
 *
 * Added 2026-05-20 (security audit M2): the heartbeat endpoint
 * previously had no auth and wrote to claude_sessions via the
 * service-role client, so a random internet caller could pollute the
 * table. This gate closes that surface without forcing the local hook
 * scripts to take on full CRON_SECRET handling.
 */
export function requireHeartbeatSecret(req: NextRequest): NextResponse | null {
  const secret = env.HEARTBEAT_SECRET;
  if (!secret) {
    // Fail-closed in BOTH production and Vercel preview. Previews are
    // publicly reachable URLs — a preview deploy without the secret
    // would expose a service-role write surface. Codex post-shipment
    // review 2026-05-21 (finding A5) tightened this from the original
    // requireCronSecret-style pass-through-in-preview pattern. Cron
    // infra runs in scheduled jobs (not user-callable) while heartbeat
    // is a public POST endpoint — different threat surface.
    const isVercelProd = env.VERCEL_ENV === 'production';
    const isVercelPreview = env.VERCEL_ENV === 'preview';
    const isOtherProd = env.NODE_ENV === 'production' && !env.VERCEL_ENV;
    if (isVercelProd || isVercelPreview || isOtherProd) {
      console.error('[api-auth] HEARTBEAT_SECRET unset in prod/preview — refusing request');
      return NextResponse.json({ error: 'server misconfigured' }, { status: 500 });
    }
    return null;  // dev / test only — no secret configured
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
 * Verify a Supabase user session. Accepts EITHER an Authorization bearer
 * header (the path used by the 171 fetchWithAuth call sites) OR the
 * `sb-*-auth-token` cookies set by `@supabase/ssr` (the new cookie-storage
 * path; used by future server-component → API calls and as a safety net
 * if the bearer header is missing for any reason).
 *
 * Returns the user info on success, or a NextResponse the caller should
 * return to short-circuit with 401.
 *
 * The UI sends the access token like:
 *   const { data: { session } } = await supabase.auth.getSession();
 *   fetch('/api/...', {
 *     headers: { Authorization: `Bearer ${session.access_token}` },
 *     ...
 *   });
 */
/**
 * Options for requireSession / requireSessionOrCron.
 *
 * `enforce2FA` (default true) — when true, validates the staxis_device
 * cookie against trusted_devices in addition to the JWT. Required for any
 * user-facing route. Set to false ONLY for routes that participate in the
 * 2FA flow itself (e.g. an endpoint that needs to identify the caller
 * BEFORE they've completed OTP). None of the current callers need this;
 * the option exists so future auth-flow routes can opt out explicitly
 * instead of silently weakening the gate.
 */
export interface RequireSessionOptions {
  enforce2FA?: boolean;
  requestId?: string | null;
}

export async function requireSession(
  req: NextRequest,
  opts: RequireSessionOptions = {},
): Promise<
  | { ok: true; userId: string; email: string | null }
  | { ok: false; response: NextResponse }
> {
  const enforce2FA = opts.enforce2FA ?? true;
  const requestId = opts.requestId ?? null;
  const auth = req.headers.get('authorization') ?? '';
  const route = new URL(req.url).pathname;
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (!m) {
    // No bearer header — try the cookie session. If it succeeds, the caller
    // is signed in via the @supabase/ssr cookies and we treat that as a
    // successful auth. If it fails (no cookies, invalid, or cookie API
    // unavailable in this context), 401 missing_token — same code the
    // bearer-only callers got before, so fetchWithAuth's refresh/retry path
    // is unaffected.
    const cookieResult = await tryCookieSession(route);
    if (cookieResult.ok) {
      if (enforce2FA) {
        const trust = await validateDeviceTrust(req, cookieResult.userId, route, requestId);
        if (!trust.ok) {
          log.warn('requireSession: 2FA enforcement rejected cookie session', {
            route, userId: cookieResult.userId, reason: trust.reason,
          });
          return { ok: false, response: requires2faResponse(trust.reason) };
        }
      }
      return cookieResult;
    }

    log.warn('requireSession: missing bearer header and no cookie session', {
      route,
      code: 'missing_token',
    });
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
    // JWT is valid. Run server-side 2FA enforcement unless explicitly
    // opted out (e.g. auth-flow routes that must work before OTP).
    if (enforce2FA) {
      const trust = await validateDeviceTrust(req, data.user.id, route, requestId, token);
      if (!trust.ok) {
        log.warn('requireSession: 2FA enforcement rejected bearer session', {
          route, userId: data.user.id, reason: trust.reason,
        });
        return { ok: false, response: requires2faResponse(trust.reason) };
      }
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
export async function requireSessionOrCron(
  req: NextRequest,
  opts: RequireSessionOptions = {},
): Promise<
  | { ok: true; kind: 'cron' }
  | { ok: true; kind: 'session'; userId: string; email: string | null }
  | { ok: false; response: NextResponse }
> {
  const enforce2FA = opts.enforce2FA ?? true;
  const requestId = opts.requestId ?? null;
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
    // No bearer header — try the cookie session before 401-ing. Same
    // cookie-or-bearer fallback shape as requireSession; lifted to keep
    // user-facing cron-or-session routes (button clicks from the UI) working
    // even when fetchWithAuth's bearer attach fails for some reason.
    const cookieResult = await tryCookieSession(route);
    if (cookieResult.ok) {
      if (enforce2FA) {
        const trust = await validateDeviceTrust(req, cookieResult.userId, route, requestId);
        if (!trust.ok) {
          log.warn('requireSessionOrCron: 2FA enforcement rejected cookie session', {
            route, userId: cookieResult.userId, reason: trust.reason,
          });
          return { ok: false, response: requires2faResponse(trust.reason) };
        }
      }
      return { ok: true, kind: 'session', userId: cookieResult.userId, email: cookieResult.email };
    }

    log.warn('requireSessionOrCron: missing bearer header and no cookie session', {
      route,
      code: 'missing_token',
    });
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
    // JWT is valid. Apply server-side 2FA enforcement on the session path
    // (cron path returned earlier — secret-bearer callers are trusted).
    if (enforce2FA) {
      const trust = await validateDeviceTrust(req, data.user.id, route, requestId, token);
      if (!trust.ok) {
        log.warn('requireSessionOrCron: 2FA enforcement rejected bearer session', {
          route, userId: data.user.id, reason: trust.reason,
        });
        return { ok: false, response: requires2faResponse(trust.reason) };
      }
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
