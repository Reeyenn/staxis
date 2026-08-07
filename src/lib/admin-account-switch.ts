/**
 * Admin account switcher — become a demo person, and get back.
 *
 * WHAT IT IS
 * A platform admin (Reeyen) picks one of the demo people out of the avatar
 * menu and BECOMES them: a real Supabase session for that auth user, the whole
 * app exactly as they see it, every action attributed to them. One tap in the
 * same menu puts the admin session back.
 *
 * WHY THE MACHINERY LOOKS LIKE THIS
 *
 * 1. HOW A SESSION IS MINTED. @supabase/auth-js 2.104 (the installed version)
 *    exposes no `auth.admin.createSession`. The sanctioned server-side way to
 *    hand a browser a session for an arbitrary auth user is
 *    `auth.admin.generateLink({ type: 'magiclink' })` and then having the
 *    browser redeem `properties.hashed_token` through
 *    `supabase.auth.verifyOtp({ token_hash, type: 'magiclink' })`. That is
 *    already the proven path in this codebase — the phone-handoff QR flow
 *    (src/lib/phone-pairing-server.ts) mints exactly this way. We never touch
 *    `action_link` (it would put a credential in a URL) and we never email
 *    anything: the hashed token goes straight back over the authenticated
 *    response body.
 *
 *    generateLink with type 'magiclink' CREATES the user when the email is
 *    unknown. Every email this module passes it is read back from
 *    `auth.admin.getUserById(...)`, so the user provably already exists. Never
 *    pass a caller-supplied email here.
 *
 * 2. WHO IS SWITCHABLE IS DECIDED HERE, ON THE SERVER, EVERY TIME. The client
 *    never supplies the set, and a forged account id in the request body is run
 *    through the identical predicate the list is built from. The rule:
 *
 *      switchable  =  the account is active
 *                  ∧  its role is not 'admin'          (never become another admin)
 *                  ∧  it is not the robot walker account
 *                  ∧  the canonical authority resolver returns a snapshot
 *                  ∧  that snapshot is not the platform-admin wildcard
 *                  ∧  it reaches at least one hotel
 *                  ∧  EVERY hotel it reaches has properties.is_test = true
 *
 *    The last clause is the one that keeps a real customer (anyone at Comfort
 *    Suites) unswitchable. It is computed from
 *    `listAuthoritativePropertyAccess`, the same resolver RLS mirrors — not
 *    from `accounts.property_access` (legacy) and not from a name pattern.
 *    Every failure path fails CLOSED (unswitchable), including an unreadable
 *    authority snapshot.
 *
 * 3. THE WAY BACK. Becoming the demo person REPLACES the browser session, so
 *    "back to admin" cannot be a client-side memory of who you were. At switch
 *    time the server sets an httpOnly, HMAC-signed return cookie carrying:
 *      • the admin's auth user id + account id (the binding),
 *      • the admin's OWN single-use magic-link hashed token,
 *      • a jti, an iat and a 2-hour exp.
 *    The redeem endpoint refuses unless ALL of these hold:
 *      • the HMAC verifies under a key derived from SUPABASE_SERVICE_ROLE_KEY
 *        (server-only, domain-separated — see deriveReturnTokenKey),
 *      • the payload version matches and the clock is inside [iat, exp],
 *      • the jti has never been claimed before (single-use, atomic — see
 *        below),
 *      • the bound admin account STILL exists, is STILL role 'admin' and is
 *        STILL active (a demoted admin cannot be restored),
 *      • GoTrue still accepts the hashed token (it is consumed on first use,
 *        so a replay dies here too even if everything above were bypassed).
 *
 *    Why this is not a privilege-escalation door: a demo user cannot READ the
 *    cookie (httpOnly), cannot FORGE one (the HMAC key never leaves the
 *    server), and cannot MINT one (minting lives behind requireAdmin AND
 *    behind performAccountSwitch's own second admin verification). The only
 *    thing the cookie does is put back the exact admin identity that was
 *    displaced, in the one browser where the displacement happened, for a few
 *    hours, once.
 *
 *    Known, deliberate failure mode: GoTrue stores one outstanding magic-link
 *    token per user, so an admin who signs in fresh somewhere else while
 *    switched invalidates their own way back. The refusal is clean (the return
 *    endpoint 401s, the cookies clear, the page asks them to sign in) and the
 *    alternative — a second, longer-lived credential — is strictly worse.
 *
 * 4. SINGLE USE WITHOUT A NEW TABLE. The jti is claimed through
 *    `claim_idempotency_key` (migration 0243) against `idempotency_log`
 *    (migration 0019) — an existing, deny-all-to-browser, atomic
 *    claim-once store with a 24h TTL that already outlives the 2h token.
 *    Unlike src/lib/idempotency.ts's checkIdempotency, which fails OPEN on an
 *    RPC error because a double-send beats a refused send, this call fails
 *    CLOSED: for an auth token, a refused redeem beats a replayed one.
 *
 * 5. 2FA IS NOT WEAKENED. Nothing here changes any policy for a real account.
 *    The one 2FA-adjacent action is: when the global 2FA switch is on AND the
 *    target would not already pass through its own skip_2fa allowlist, the
 *    switch registers THIS browser as a trusted device for the DEMO account —
 *    the same artifact /api/auth/trust-device writes, scoped to an account
 *    that has just been proven to reach demo hotels only, authorized by a
 *    verified platform admin. Without it the switched session would 401 on
 *    every API call and the feature would be broken on arrival. The admin's
 *    own trust row is left untouched (and re-issued alongside if this browser
 *    had no device token at all), so the way back still works.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  listAuthoritativePropertyAccess,
  type AuthoritativePropertyAccess,
} from '@/lib/authorization/server';
import {
  generateDeviceToken,
  hashDeviceToken,
  TRUST_DURATION_DB_MS,
} from '@/lib/trusted-device';
import { isTwoFactorEnabled } from '@/lib/two-factor';
import { env } from '@/lib/env';
import { log } from '@/lib/log';

// ─── Constants ──────────────────────────────────────────────────────────────

/** httpOnly, signed. The only thing that authorizes a return to admin. */
export const RETURN_COOKIE_NAME = 'staxis_admin_return';

/**
 * Cosmetic twin of the cookie above, readable by JS so the menu can say "you
 * are switched" and draw the ring without a network round trip on every page
 * load for every user in the product. It carries a display name and nothing
 * else. Forging it produces a button that fails at redemption — it has no
 * authority and must never be treated as any.
 */
export const RETURN_HINT_COOKIE_NAME = 'staxis_switch_hint';

/** Short by design. Long enough for a building session, short enough to matter. */
export const RETURN_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

/** Bumping this invalidates every outstanding return token. */
export const RETURN_TOKEN_VERSION = 1;

/** Namespace for the single-use claim rows in idempotency_log. */
export const RETURN_CLAIM_ROUTE = 'admin-account-switch-return';

/**
 * The robot walker's account. It lives on a test hotel (so it would otherwise
 * qualify) but it belongs to the nightly walk, not to Reeyen — becoming it
 * would collide with a running automation.
 */
export const ROBOT_ACCOUNT_USERNAME = 'robot.manager';

/** Small clock tolerance so a token minted a moment ago is never "from the future". */
const CLOCK_SKEW_MS = 30_000;

// ─── Return token codec ─────────────────────────────────────────────────────

export interface ReturnTokenPayload {
  /** RETURN_TOKEN_VERSION at mint time. */
  v: number;
  /** auth.users.id of the admin who switched. The binding. */
  adminAuthUserId: string;
  /** accounts.id of the same admin, re-verified at redeem time. */
  adminAccountId: string;
  /** accounts.id the admin switched INTO. Diagnostic + audit. */
  targetAccountId: string;
  /** The admin's own single-use GoTrue magic-link token hash. */
  adminTokenHash: string;
  /** Single-use id, claimed atomically at redeem time. */
  jti: string;
  /** Minted at (ms). */
  iat: number;
  /** Expires at (ms). */
  exp: number;
}

export type ReturnTokenFailure =
  | 'malformed'
  | 'bad_signature'
  | 'bad_payload'
  | 'version_mismatch'
  | 'expired'
  | 'not_yet_valid';

/**
 * Derive the token-signing key from the service-role key.
 *
 * Domain-separated so the signing key is NOT the service-role key itself: a
 * token, or a signature, leaking tells an attacker nothing about the key that
 * opens the database. Same shape as derivePhonePairingBypassCode's use of the
 * service-role key as a server-only root secret, and it avoids introducing a
 * new required env var (which would also have to land in REQUIRED_ENV_VARS and
 * the doctor before this could ship).
 */
export function deriveReturnTokenKey(serviceRoleKey: string): Buffer {
  return createHmac('sha256', serviceRoleKey)
    .update('staxis:admin-account-switch:return-token:v1')
    .digest();
}

function b64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(input: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(input)) return null;
  try {
    return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  } catch {
    return null;
  }
}

function sign(body: string, key: Buffer): string {
  return b64url(createHmac('sha256', key).update(body).digest());
}

export function mintReturnToken(payload: ReturnTokenPayload, key: Buffer): string {
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${body}.${sign(body, key)}`;
}

/**
 * Verify a raw return token. Never throws. Signature is checked with a
 * constant-time compare BEFORE the payload is trusted for anything.
 */
export function verifyReturnToken(
  raw: string,
  key: Buffer,
  nowMs: number,
): { ok: true; payload: ReturnTokenPayload } | { ok: false; reason: ReturnTokenFailure } {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096) {
    return { ok: false, reason: 'malformed' };
  }
  const parts = raw.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [body, signature] = parts;

  const expected = Buffer.from(sign(body, key), 'utf8');
  const provided = Buffer.from(signature, 'utf8');
  if (expected.length !== provided.length) return { ok: false, reason: 'bad_signature' };
  if (!timingSafeEqual(expected, provided)) return { ok: false, reason: 'bad_signature' };

  const decoded = fromB64url(body);
  if (!decoded) return { ok: false, reason: 'malformed' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded.toString('utf8'));
  } catch {
    return { ok: false, reason: 'bad_payload' };
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'bad_payload' };
  const p = parsed as Record<string, unknown>;

  const stringFields = ['adminAuthUserId', 'adminAccountId', 'targetAccountId', 'adminTokenHash', 'jti'] as const;
  for (const field of stringFields) {
    if (typeof p[field] !== 'string' || (p[field] as string).length === 0) {
      return { ok: false, reason: 'bad_payload' };
    }
  }
  if (typeof p.v !== 'number' || typeof p.iat !== 'number' || typeof p.exp !== 'number') {
    return { ok: false, reason: 'bad_payload' };
  }
  if (!Number.isFinite(p.iat) || !Number.isFinite(p.exp)) return { ok: false, reason: 'bad_payload' };
  if (p.v !== RETURN_TOKEN_VERSION) return { ok: false, reason: 'version_mismatch' };
  if (nowMs >= p.exp) return { ok: false, reason: 'expired' };
  if (nowMs + CLOCK_SKEW_MS < p.iat) return { ok: false, reason: 'not_yet_valid' };

  return { ok: true, payload: parsed as ReturnTokenPayload };
}

/** Fresh single-use id for a return token. */
export function newReturnJti(): string {
  return randomBytes(24).toString('hex');
}

/** idempotency_log key for a jti. Alphanumeric + dash only, by that table's convention. */
export function returnClaimKey(jti: string): string {
  return `adminswitchreturn-${jti}`;
}

// ─── Cookie shapes ──────────────────────────────────────────────────────────

function cookieDomain(requestHost: string | null | undefined): string | undefined {
  // Same rule as trustCookieOptions: on the production domain, share one
  // cookie across getstaxis.com and www.getstaxis.com. Previews and localhost
  // stay host-only.
  const host = (requestHost ?? '').toLowerCase().split(':')[0];
  return host === 'getstaxis.com' || host.endsWith('.getstaxis.com') ? '.getstaxis.com' : undefined;
}

export function returnCookieOptions(requestHost?: string | null) {
  return {
    name: RETURN_COOKIE_NAME,
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    // 'strict' rather than the trust cookie's 'lax': this cookie is only ever
    // read by a same-origin POST from our own page, so strict costs nothing
    // and removes cross-site submission as a shape entirely.
    sameSite: 'strict' as const,
    path: '/',
    maxAge: Math.floor(RETURN_TOKEN_TTL_MS / 1000),
    domain: cookieDomain(requestHost),
  };
}

export function hintCookieOptions(requestHost?: string | null) {
  return {
    name: RETURN_HINT_COOKIE_NAME,
    // Deliberately readable by JS — it is the menu's only cheap way to know it
    // is in a switched session. Carries a display name, no authority.
    httpOnly: false,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    path: '/',
    maxAge: Math.floor(RETURN_TOKEN_TTL_MS / 1000),
    domain: cookieDomain(requestHost),
  };
}

// ─── Who is switchable ──────────────────────────────────────────────────────

export interface SwitchCandidateAccount {
  id: string;
  username: string;
  displayName: string;
  role: string;
  active: boolean;
  authUserId: string;
  skip2fa: boolean;
}

export interface SwitchableDemoAccount {
  accountId: string;
  displayName: string;
  /** One line, e.g. "General manager, Testing Hotel". */
  roleLine: string;
}

export type SwitchRefusal =
  | 'not_found'
  | 'inactive'
  | 'is_admin'
  | 'is_robot'
  | 'authority_unavailable'
  | 'wildcard_access'
  | 'no_hotels'
  | 'reaches_real_hotel';

export interface SwitchablePolicyDeps {
  /** ids of every properties row with is_test = true, or null when unreadable. */
  listTestPropertyIds(): Promise<string[] | null>;
  /** One accounts row, or null. */
  loadAccount(accountId: string): Promise<SwitchCandidateAccount | null>;
  /** The canonical authority snapshot. Null means "cannot prove" → refuse. */
  authoritativeAccess(accountId: string): Promise<AuthoritativePropertyAccess | null>;
}

export interface SwitchableListDeps extends SwitchablePolicyDeps {
  /** Accounts that touch any of these hotels, by any authority mechanism. */
  listCandidateAccountIds(testPropertyIds: readonly string[]): Promise<string[] | null>;
  /** propertyId → hotel name, for the one-line role label. */
  loadPropertyNames(propertyIds: readonly string[]): Promise<Map<string, string>>;
  /** Active company/hotel job title for this account, if any. */
  loadJobTitle(accountId: string): Promise<string | null>;
}

/**
 * THE predicate. Both the list and the switch go through this, so a forged
 * account id in a request body is evaluated by exactly the rule that built the
 * menu. Every refusal path is closed, including "we could not read".
 */
export async function resolveSwitchableDemoAccount(
  accountId: string,
  deps: SwitchablePolicyDeps,
): Promise<
  | { ok: true; account: SwitchCandidateAccount; access: AuthoritativePropertyAccess; testPropertyIds: Set<string> }
  | { ok: false; reason: SwitchRefusal }
> {
  const testIds = await deps.listTestPropertyIds();
  if (!testIds) return { ok: false, reason: 'authority_unavailable' };
  const testSet = new Set(testIds);

  const account = await deps.loadAccount(accountId);
  if (!account) return { ok: false, reason: 'not_found' };
  if (!account.active) return { ok: false, reason: 'inactive' };
  if (account.role === 'admin') return { ok: false, reason: 'is_admin' };
  if (account.username === ROBOT_ACCOUNT_USERNAME) return { ok: false, reason: 'is_robot' };

  const access = await deps.authoritativeAccess(accountId);
  if (!access) return { ok: false, reason: 'authority_unavailable' };
  // all=true is the platform-admin wildcard. It arrives with empty arrays, so
  // the "every hotel is a test hotel" check below would vacuously pass it.
  if (access.all) return { ok: false, reason: 'wildcard_access' };
  if (access.propertyIds.length === 0) return { ok: false, reason: 'no_hotels' };
  if (!access.propertyIds.every((id) => testSet.has(id))) {
    return { ok: false, reason: 'reaches_real_hotel' };
  }

  return { ok: true, account, access, testPropertyIds: testSet };
}

/** Human role label without leaking role slugs into the menu. */
function roleWord(role: string): string {
  switch (role) {
    case 'owner': return 'Owner';
    case 'general_manager': return 'General manager';
    case 'front_desk': return 'Front desk';
    case 'housekeeping': return 'Housekeeping';
    case 'maintenance': return 'Maintenance';
    case 'staff': return 'Staff';
    default: return 'Team member';
  }
}

export function buildRoleLine(
  role: string,
  jobTitle: string | null,
  hotelNames: readonly string[],
): string {
  const who = jobTitle && jobTitle.trim().length > 0 ? jobTitle.trim() : roleWord(role);
  if (hotelNames.length === 0) return who;
  if (hotelNames.length === 1) return `${who}, ${hotelNames[0]}`;
  return `${who}, ${hotelNames.length} demo hotels`;
}

/**
 * Build the menu's roster. Two stages on purpose: narrow to the handful of
 * accounts that touch a demo hotel by ANY mechanism, then put each one through
 * the authoritative predicate above. Stage one can only ever under-list (which
 * is cosmetic); stage two is what decides.
 */
export async function listSwitchableDemoAccounts(
  deps: SwitchableListDeps,
): Promise<SwitchableDemoAccount[] | null> {
  const testIds = await deps.listTestPropertyIds();
  if (!testIds) return null;
  if (testIds.length === 0) return [];

  const candidates = await deps.listCandidateAccountIds(testIds);
  if (!candidates) return null;

  const names = await deps.loadPropertyNames(testIds);
  const out: SwitchableDemoAccount[] = [];

  for (const candidateId of candidates) {
    const resolved = await resolveSwitchableDemoAccount(candidateId, deps);
    if (!resolved.ok) continue;
    const jobTitle = await deps.loadJobTitle(candidateId);
    const hotelNames = resolved.access.propertyIds
      .map((id) => names.get(id))
      .filter((n): n is string => typeof n === 'string');
    out.push({
      accountId: resolved.account.id,
      displayName: resolved.account.displayName,
      roleLine: buildRoleLine(resolved.account.role, jobTitle, hotelNames),
    });
  }

  out.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return out;
}

// ─── Switch ─────────────────────────────────────────────────────────────────

export interface DeviceTrustGrant {
  /** The device token the browser should now hold, when a new one was minted. */
  newDeviceToken: string | null;
}

export interface PerformSwitchInput {
  /** accounts.id of the caller, already gated by requireAdmin. Re-verified here. */
  callerAccountId: string;
  /** auth.users.id of the caller. */
  callerAuthUserId: string;
  /** accounts.id the caller wants to become. Untrusted. */
  targetAccountId: string;
  /** The staxis_device cookie already on this browser, if any. */
  deviceCookieValue: string | null;
  nowMs: number;
}

export interface PerformSwitchDeps extends SwitchablePolicyDeps {
  /** Verifies the CALLER is still an active platform admin. */
  loadAccount(accountId: string): Promise<SwitchCandidateAccount | null>;
  /** auth.users email for an auth user id, or null. */
  authEmail(authUserId: string): Promise<string | null>;
  /** generateLink({ type: 'magiclink' }) → properties.hashed_token. */
  mintMagicLinkTokenHash(email: string): Promise<string | null>;
  /** Global human-2FA switch. */
  twoFactorEnabled(): Promise<boolean>;
  /** Would this auth user already pass the skip_2fa env allowlist? */
  skip2faAllowlisted(authUserId: string): boolean;
  /** Registers this device as trusted for an account. Idempotent-ish; best effort. */
  grantDeviceTrust(accountId: string, deviceTokenHash: string): Promise<boolean>;
  signingKey: Buffer;
  newJti(): string;
  newDeviceToken(): string;
  hashDeviceToken(token: string): string;
}

export type PerformSwitchResult =
  | {
      ok: true;
      targetTokenHash: string;
      targetDisplayName: string;
      adminDisplayName: string;
      returnToken: string;
      deviceTrust: DeviceTrustGrant;
    }
  | { ok: false; status: number; reason: string };

/**
 * Do the switch.
 *
 * Note the SECOND admin verification at the top. The route is already behind
 * requireAdmin; this repeats the check against the database so the dangerous
 * capability does not live in one gate. A caller who is no longer an admin
 * cannot switch even if a route gate were removed or reordered tomorrow.
 */
export async function performAccountSwitch(
  input: PerformSwitchInput,
  deps: PerformSwitchDeps,
): Promise<PerformSwitchResult> {
  const caller = await deps.loadAccount(input.callerAccountId);
  if (!caller || caller.role !== 'admin' || !caller.active) {
    return { ok: false, status: 403, reason: 'not_platform_admin' };
  }
  if (caller.authUserId !== input.callerAuthUserId) {
    return { ok: false, status: 403, reason: 'identity_mismatch' };
  }
  if (input.targetAccountId === input.callerAccountId) {
    return { ok: false, status: 400, reason: 'already_this_account' };
  }

  const target = await resolveSwitchableDemoAccount(input.targetAccountId, deps);
  if (!target.ok) {
    return { ok: false, status: 403, reason: `not_switchable:${target.reason}` };
  }

  // Both magic links are minted from emails read back out of auth.users, never
  // from anything the caller sent — generateLink would otherwise create a user.
  const targetEmail = await deps.authEmail(target.account.authUserId);
  if (!targetEmail) return { ok: false, status: 409, reason: 'target_has_no_auth_email' };
  const adminEmail = await deps.authEmail(caller.authUserId);
  if (!adminEmail) return { ok: false, status: 409, reason: 'admin_has_no_auth_email' };

  // The admin's token is minted FIRST. If the return path cannot be built, we
  // must not displace the admin session at all.
  const adminTokenHash = await deps.mintMagicLinkTokenHash(adminEmail);
  if (!adminTokenHash) return { ok: false, status: 502, reason: 'return_mint_failed' };

  const targetTokenHash = await deps.mintMagicLinkTokenHash(targetEmail);
  if (!targetTokenHash) return { ok: false, status: 502, reason: 'target_mint_failed' };

  // ── 2FA: make the switched session usable without touching any policy ──
  // Only when the gate would actually bite. If the global switch is off, or
  // the demo account is already on the skip_2fa allowlist, we grant nothing.
  const deviceTrust: DeviceTrustGrant = { newDeviceToken: null };
  const twoFactorOn = await deps.twoFactorEnabled();
  const alreadyExempt =
    target.account.skip2fa && deps.skip2faAllowlisted(target.account.authUserId);
  if (twoFactorOn && !alreadyExempt) {
    const token = input.deviceCookieValue ?? deps.newDeviceToken();
    const tokenHash = deps.hashDeviceToken(token);
    const granted = await deps.grantDeviceTrust(target.account.id, tokenHash);
    if (!granted) return { ok: false, status: 502, reason: 'device_trust_failed' };
    if (!input.deviceCookieValue) {
      // This browser had no device token, so the one we just minted becomes
      // the cookie. The admin needs a row against the SAME hash or the way
      // back lands in a 2FA-required session.
      const adminGranted = await deps.grantDeviceTrust(caller.id, tokenHash);
      if (!adminGranted) return { ok: false, status: 502, reason: 'device_trust_failed' };
      deviceTrust.newDeviceToken = token;
    }
  }

  const returnToken = mintReturnToken(
    {
      v: RETURN_TOKEN_VERSION,
      adminAuthUserId: caller.authUserId,
      adminAccountId: caller.id,
      targetAccountId: target.account.id,
      adminTokenHash,
      jti: deps.newJti(),
      iat: input.nowMs,
      exp: input.nowMs + RETURN_TOKEN_TTL_MS,
    },
    deps.signingKey,
  );

  return {
    ok: true,
    targetTokenHash,
    targetDisplayName: target.account.displayName,
    adminDisplayName: caller.displayName,
    returnToken,
    deviceTrust,
  };
}

// ─── Return ─────────────────────────────────────────────────────────────────

export interface PerformReturnInput {
  /** Raw cookie value. Untrusted. */
  rawToken: string | null;
  nowMs: number;
}

export interface PerformReturnDeps {
  signingKey: Buffer;
  loadAccount(accountId: string): Promise<SwitchCandidateAccount | null>;
  /**
   * Atomically claim this jti. TRUE means "you are the first and only".
   * MUST fail closed (return false) when it cannot prove that.
   */
  claimSingleUse(jti: string): Promise<boolean>;
}

export type PerformReturnResult =
  | {
      ok: true;
      adminTokenHash: string;
      adminDisplayName: string;
      adminAccountId: string;
      adminAuthUserId: string;
    }
  | { ok: false; status: number; reason: string };

export async function performAdminReturn(
  input: PerformReturnInput,
  deps: PerformReturnDeps,
): Promise<PerformReturnResult> {
  if (!input.rawToken) return { ok: false, status: 401, reason: 'no_return_token' };

  const verified = verifyReturnToken(input.rawToken, deps.signingKey, input.nowMs);
  if (!verified.ok) return { ok: false, status: 401, reason: `token_${verified.reason}` };

  // Claim BEFORE handing anything back, so a replay racing the first redeem
  // loses rather than both winning.
  const claimed = await deps.claimSingleUse(verified.payload.jti);
  if (!claimed) return { ok: false, status: 401, reason: 'token_already_used' };

  // The binding is re-checked against the live database, not just the
  // signature. An admin who was demoted or deactivated while switched cannot
  // be restored by a token minted before the demotion.
  const admin = await deps.loadAccount(verified.payload.adminAccountId);
  if (!admin || admin.role !== 'admin' || !admin.active) {
    return { ok: false, status: 403, reason: 'admin_no_longer_authorized' };
  }
  if (admin.authUserId !== verified.payload.adminAuthUserId) {
    return { ok: false, status: 403, reason: 'admin_identity_changed' };
  }

  return {
    ok: true,
    adminTokenHash: verified.payload.adminTokenHash,
    adminDisplayName: admin.displayName,
    adminAccountId: admin.id,
    adminAuthUserId: admin.authUserId,
  };
}

// ─── Live dependency wiring ─────────────────────────────────────────────────

function toCandidate(row: Record<string, unknown> | null): SwitchCandidateAccount | null {
  if (!row) return null;
  const id = row.id;
  const username = row.username;
  const displayName = row.display_name;
  const role = row.role;
  const authUserId = row.data_user_id;
  if (
    typeof id !== 'string' ||
    typeof username !== 'string' ||
    typeof displayName !== 'string' ||
    typeof role !== 'string' ||
    typeof authUserId !== 'string'
  ) {
    return null;
  }
  return {
    id,
    username,
    displayName,
    role,
    active: row.active === true,
    authUserId,
    skip2fa: row.skip_2fa === true,
  };
}

async function liveListTestPropertyIds(): Promise<string[] | null> {
  const { data, error } = await supabaseAdmin
    .from('properties')
    .select('id')
    .eq('is_test', true);
  if (error) {
    log.error('[account-switch] could not read demo hotels — refusing', { err: error.message });
    return null;
  }
  return (data ?? []).map((row) => row.id as string);
}

async function liveLoadAccount(accountId: string): Promise<SwitchCandidateAccount | null> {
  const { data, error } = await supabaseAdmin
    .from('accounts')
    .select('id, username, display_name, role, active, data_user_id, skip_2fa')
    .eq('id', accountId)
    .maybeSingle();
  if (error) return null;
  return toCandidate(data as Record<string, unknown> | null);
}

/**
 * Cheap first pass: everyone who might touch a demo hotel, by any of the four
 * mechanisms that exist. It deliberately OVER-includes (every member of a
 * company that operates a demo hotel, whether or not that member reaches the
 * demo hotel specifically) because the authoritative predicate re-decides each
 * one afterwards. Over-including costs one RPC per extra candidate;
 * under-including would silently drop someone from the menu.
 */
async function liveListCandidateAccountIds(
  testPropertyIds: readonly string[],
): Promise<string[] | null> {
  const ids = new Set<string>();
  const propertyIds = [...testPropertyIds];

  // 1. Companies that operate a demo hotel → their active members.
  const relationships = await supabaseAdmin
    .from('organization_property_relationships')
    .select('organization_id')
    .is('ends_at', null)
    .in('property_id', propertyIds);
  if (relationships.error) return null;
  const organizationIds = [
    ...new Set(
      (relationships.data ?? [])
        .map((row) => row.organization_id)
        .filter((id): id is string => typeof id === 'string'),
    ),
  ];
  if (organizationIds.length > 0) {
    const members = await supabaseAdmin
      .from('organization_memberships')
      .select('account_id')
      .eq('status', 'active')
      .is('ended_at', null)
      .in('organization_id', organizationIds);
    if (members.error) return null;
    for (const row of members.data ?? []) {
      if (typeof row.account_id === 'string') ids.add(row.account_id);
    }
  }

  // Note: the effective-access VIEW is deliberately not queried here. Every
  // access grant hangs off a membership, and every membership belongs to an
  // organization, so step 1 is already a superset of anything the view could
  // add — and reading it would trip the Stage-C guard that forbids app source
  // from naming the raw legacy access column.

  const staffLinks = await supabaseAdmin
    .from('account_property_staff_links')
    .select('account_id')
    .eq('is_active', true)
    .in('property_id', propertyIds);
  if (staffLinks.error) return null;
  for (const row of staffLinks.data ?? []) {
    if (typeof row.account_id === 'string') ids.add(row.account_id);
  }

  const bridges = await supabaseAdmin
    .from('account_property_authorization_bridges')
    .select('account_id')
    .is('retired_at', null)
    .in('property_id', propertyIds);
  if (bridges.error) return null;
  for (const row of bridges.data ?? []) {
    if (typeof row.account_id === 'string') ids.add(row.account_id);
  }

  return [...ids];
}

async function liveLoadPropertyNames(
  propertyIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (propertyIds.length === 0) return out;
  const { data, error } = await supabaseAdmin
    .from('properties')
    .select('id, name')
    .in('id', [...propertyIds]);
  if (error) return out;
  for (const row of data ?? []) {
    if (typeof row.id === 'string' && typeof row.name === 'string') out.set(row.id, row.name);
  }
  return out;
}

async function liveLoadJobTitle(accountId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('organization_memberships')
    .select('job_title')
    .eq('account_id', accountId)
    .eq('status', 'active')
    .is('ended_at', null)
    .limit(1);
  if (error) return null;
  const title = data?.[0]?.job_title;
  return typeof title === 'string' && title.trim().length > 0 ? title : null;
}

async function liveAuthEmail(authUserId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(authUserId);
  if (error || !data.user?.email) return null;
  return data.user.email.trim().toLowerCase();
}

/**
 * Mint a one-time login token for an EXISTING auth user.
 *
 * `email` must always come from auth.users (liveAuthEmail). generateLink with
 * type 'magiclink' creates the user when the address is unknown, so a
 * caller-supplied address here would be an account-creation primitive.
 * We read only `properties.hashed_token` — never `action_link`, which would
 * carry the credential inside a URL.
 */
async function liveMintMagicLinkTokenHash(email: string): Promise<string | null> {
  try {
    const { data, error } = await supabaseAdmin.auth.admin.generateLink({
      type: 'magiclink',
      email,
    });
    const hashed = data?.properties?.hashed_token;
    if (error || typeof hashed !== 'string' || hashed.length === 0) return null;
    return hashed;
  } catch {
    return null;
  }
}

async function liveGrantDeviceTrust(accountId: string, tokenHash: string): Promise<boolean> {
  const existing = await supabaseAdmin
    .from('trusted_devices')
    .select('id')
    .eq('account_id', accountId)
    .eq('token_hash', tokenHash)
    .maybeSingle();
  if (existing.error) return false;
  if (existing.data) return true;

  const { error } = await supabaseAdmin.from('trusted_devices').insert({
    account_id: accountId,
    token_hash: tokenHash,
    user_agent: 'staxis-admin-account-switch',
    ip: null,
    expires_at: new Date(Date.now() + TRUST_DURATION_DB_MS).toISOString(),
  });
  return !error;
}

function liveSkip2faAllowlisted(authUserId: string): boolean {
  if (env.SKIP_2FA_ENABLED !== 'true') return false;
  return (env.SKIP_2FA_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(authUserId);
}

/**
 * Atomic claim-once on the existing idempotency_log store.
 *
 * FAILS CLOSED, unlike src/lib/idempotency.ts's checkIdempotency: for a
 * request-dedup cache, a possible double-send beats a refused send; for an
 * auth token, a refused redeem beats a replayed one.
 *
 * After winning the claim we immediately finalize the row. claim_idempotency_key
 * writes a 5-minute "pending" marker, and an unfinalized key frees itself after
 * that window — which would make a redeemed token replayable. Finalizing pins it
 * for the table's full 24h TTL, comfortably past the token's 2h life.
 */
async function liveClaimSingleUse(jti: string): Promise<boolean> {
  const key = returnClaimKey(jti);
  try {
    const { data, error } = await supabaseAdmin.rpc('claim_idempotency_key', {
      p_key: key,
      p_route: RETURN_CLAIM_ROUTE,
    });
    if (error) {
      log.error('[account-switch] single-use claim failed — refusing return', {
        err: error.message,
      });
      return false;
    }
    const row = (Array.isArray(data) ? data[0] : data) as { claimed?: unknown } | null;
    if (!row || row.claimed !== true) return false;
  } catch (error) {
    log.error('[account-switch] single-use claim threw — refusing return', {
      err: error instanceof Error ? error.message : 'unknown',
    });
    return false;
  }

  const { error: finalizeError } = await supabaseAdmin
    .from('idempotency_log')
    .update({
      response: { redeemed: true },
      status_code: 200,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    })
    .eq('key', key);
  if (finalizeError) {
    // The claim itself already happened, so this redeem is still the only one
    // in flight. The risk is a replay AFTER the 5-minute pending window, so we
    // refuse rather than hand back an admin credential we cannot burn.
    log.error('[account-switch] could not finalize single-use claim — refusing return', {
      err: finalizeError.message,
    });
    return false;
  }
  return true;
}

export function liveSigningKey(): Buffer {
  return deriveReturnTokenKey(env.SUPABASE_SERVICE_ROLE_KEY);
}

export function liveSwitchableListDeps(): SwitchableListDeps {
  return {
    listTestPropertyIds: liveListTestPropertyIds,
    loadAccount: liveLoadAccount,
    authoritativeAccess: listAuthoritativePropertyAccess,
    listCandidateAccountIds: liveListCandidateAccountIds,
    loadPropertyNames: liveLoadPropertyNames,
    loadJobTitle: liveLoadJobTitle,
  };
}

export function livePerformSwitchDeps(): PerformSwitchDeps {
  return {
    listTestPropertyIds: liveListTestPropertyIds,
    loadAccount: liveLoadAccount,
    authoritativeAccess: listAuthoritativePropertyAccess,
    authEmail: liveAuthEmail,
    mintMagicLinkTokenHash: liveMintMagicLinkTokenHash,
    twoFactorEnabled: isTwoFactorEnabled,
    skip2faAllowlisted: liveSkip2faAllowlisted,
    grantDeviceTrust: liveGrantDeviceTrust,
    signingKey: liveSigningKey(),
    newJti: newReturnJti,
    newDeviceToken: generateDeviceToken,
    hashDeviceToken,
  };
}

export function livePerformReturnDeps(): PerformReturnDeps {
  return {
    signingKey: liveSigningKey(),
    loadAccount: liveLoadAccount,
    claimSingleUse: liveClaimSingleUse,
  };
}
