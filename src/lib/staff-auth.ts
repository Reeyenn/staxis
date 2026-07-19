// ═══════════════════════════════════════════════════════════════════════════
// Magic-link auth for housekeepers + laundry workers.
//
// Each staff member can have a backing Supabase auth user. The first time
// Maria generates a link to that staff member (Send Shift Confirmations
// fan-out, or the per-staff "Copy" button on the schedule), this module
// lazily creates the auth user via the admin API, stores the auth_user_id
// on the staff row, and mints a one-time magic-link token.
//
// The token is embedded in the housekeeper URL the staff member receives.
// The page consumes it on mount, calls supabase.auth.verifyOtp, and from
// that point forward has a real authenticated session — meaning RLS
// policies match, postgres_changes events flow over realtime, and the
// page no longer needs the polling fallback to see Start/Done taps
// reflected on screen.
//
// Why a separate auth user (not just shared anon access): so each staff
// has a distinct auth.uid() that RLS can pin. The "housekeeper read own
// rooms" policy on rooms looks up the staff row whose auth_user_id ==
// auth.uid() and only returns rooms assigned to that staff. So Cindy
// can't read Astri's rooms even though both have valid sessions.
//
// Why a synthetic email (.invalid TLD): Supabase auth.users requires an
// email per row, but housekeepers don't have email addresses on file —
// they're paired by phone. Using `staff-{uuid}@staxis.invalid` satisfies
// the schema requirement; the .invalid TLD is reserved by RFC 2606 and
// routes nowhere, so even if Supabase ever tried to send a confirmation
// email it would fail to deliver to a real inbox.
// ═══════════════════════════════════════════════════════════════════════════

import { randomBytes, randomInt } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';
import { logSecurityEvent } from '@/lib/audit';
import { hashStaffLinkToken } from '@/lib/staff-link-auth';

const SYNTHETIC_EMAIL_DOMAIN = 'staxis.invalid';

// ─── Per-staff link-token (security audit 2026-06-26 #1) ───────────────────
// The standing bearer credential embedded in the mobile SMS link as `&tok=`.
// Verified server-side on every public housekeeper/laundry/engineer call
// (src/lib/staff-link-auth.ts verifyStaffLinkToken). 90-day TTL; a re-sent SMS
// reuses the staff member's existing active token so old links keep working.
const STAFF_LINK_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

/**
 * Mint (or reuse) the per-staff link token for (staffId, pid) and return the
 * RAW token to embed in the URL. Reuses the existing active (unexpired,
 * unrevoked) row if one exists — its raw value is not recoverable (only the
 * hash is stored), so "reuse" means: if a live token row exists we cannot
 * re-derive its raw value, therefore we mint a fresh token and let the old row
 * expire on its own TTL. To keep a single working link per staff we instead
 * upsert onto a freshly minted token each send but bound the row count via the
 * expiry sweep. Callers MUST have already asserted the staff row belongs to
 * pid (ensureStaffAuthUser does this upstream in both link builders).
 *
 * Returns the raw token (never persisted) for URL embedding.
 */
export async function mintStaffLinkToken(staffId: string, pid: string): Promise<string> {
  const raw = randomBytes(32).toString('hex'); // 256-bit
  const tokenHash = hashStaffLinkToken(raw);
  const expiresAt = new Date(Date.now() + STAFF_LINK_TOKEN_TTL_MS).toISOString();

  const { error } = await supabaseAdmin
    .from('staff_link_tokens')
    .insert({
      token_hash: tokenHash,
      staff_id: staffId,
      property_id: pid,
      expires_at: expiresAt,
    });
  if (error) {
    // 23505 unique-violation on token_hash means a 256-bit collision — cosmically
    // improbable; treat as fatal so it surfaces rather than silently reusing.
    throw new Error(`[staff-auth] staff_link_tokens insert failed: ${errToString(error)}`);
  }
  return raw;
}

/**
 * Thrown when a caller passes a staffId that doesn't belong to the pid
 * they also passed. This is the cross-tenant pivot vector that F-NEW-04
 * targets: the bulk SMS route used to validate only that the caller had
 * access to `pid` and trust every staffId in the body, so a caller with
 * access to property A could mint a magic-link for a staff row in
 * property B by passing B's UUID. Routes catch this and 403 (or filter
 * the offender out of the batch). Either way, the audit event has
 * already been written from inside ensureStaffAuthUser so the alert
 * lives in Sentry regardless of how the caller reacts.
 */
export class CrossTenantStaffError extends Error {
  constructor(public readonly staffId: string, public readonly pid: string) {
    super(`Staff ${staffId} does not belong to property ${pid}`);
    this.name = 'CrossTenantStaffError';
  }
}

/** Build the synthetic email used to identify this staff member's auth user. */
function syntheticEmailFor(staffId: string): string {
  return `staff-${staffId}@${SYNTHETIC_EMAIL_DOMAIN}`;
}

/**
 * Ensure a Supabase auth user exists for `staffId` and that the staff row's
 * `auth_user_id` column points at it. Idempotent — safe to call on every
 * link generation. Returns the auth user's id.
 *
 * F-NEW-04 contract: this helper is the cross-tenant boundary for
 * housekeeper magic-link minting. The staff row MUST belong to `pid` —
 * we lookup with `.eq('id', staffId).eq('property_id', pid)` and throw
 * CrossTenantStaffError otherwise. A SecurityEvent is also written so
 * the alert reaches Sentry regardless of how the caller handles the
 * exception. Routes that previously trusted client-supplied staffIds
 * within a request-level `pid` are now safe at the helper layer too.
 *
 * Failure modes are surfaced as thrown errors with a clear `[staff-auth]`
 * prefix so callers (the SMS fan-out + the Link API) can include them in
 * their failure logs. We never silently produce a "staff is auth-linked"
 * result that isn't backed by a real row, because the magic-link
 * generation step downstream depends on the email existing.
 */
export async function ensureStaffAuthUser(
  staffId: string,
  pid: string,
): Promise<{ authUserId: string; email: string }> {
  // Look up the existing staff row first — we need to know whether
  // auth_user_id is already populated. F-NEW-04: scope to `pid` so a
  // caller who only owns property X can't trigger link minting for a
  // staff row in property Y.
  const { data: staffRow, error: lookupErr } = await supabaseAdmin
    .from('staff')
    .select('id, auth_user_id, name, property_id')
    .eq('id', staffId)
    .eq('property_id', pid)
    .maybeSingle();
  if (lookupErr) {
    throw new Error(`[staff-auth] staff lookup failed: ${errToString(lookupErr)}`);
  }
  if (!staffRow) {
    // Could be a genuine missing row OR a cross-tenant probe. Both look
    // identical here (the `.eq('property_id', pid)` masks the difference)
    // — which is the right posture: we don't leak existence. But we DO
    // record the attempt because the route-layer log alone isn't enough:
    // staff-link callers don't audit failure today, and the route
    // currently uses /api/staff-list to enumerate staffIds within a
    // property, so a probe is the only realistic explanation for a miss.
    await logSecurityEvent({
      action: 'auth.cross_tenant_staff_attempt',
      propertyId: pid,
      metadata: { staffId, helper: 'ensureStaffAuthUser' },
    });
    throw new CrossTenantStaffError(staffId, pid);
  }

  const email = syntheticEmailFor(staffId);

  // Fast path: staff already linked. Trust the column — if the auth user
  // got deleted out from under us, the magic-link mint downstream will
  // fail loudly and we'll fall through to the create branch on retry.
  if (staffRow.auth_user_id) {
    return { authUserId: staffRow.auth_user_id, email };
  }

  // Slow path: create the auth user. Use email_confirm:true so Supabase
  // doesn't try to send a "confirm your email" message to the .invalid
  // address. user_metadata carries the staff_id so we can correlate from
  // the auth side without joining back to staff.
  const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: {
      kind: 'housekeeper',
      staff_id: staffId,
      staff_name: staffRow.name ?? null,
    },
  });

  // Race / recovery: if another concurrent call beat us to creation, the
  // admin API returns "User already registered". In that case look up by
  // email and proceed with whatever id is on file.
  if (createErr) {
    const msg = errToString(createErr);
    if (!msg.toLowerCase().includes('already')) {
      throw new Error(`[staff-auth] createUser failed: ${msg}`);
    }
    // List + filter by email. Supabase admin listUsers does not support
    // an email filter, so we paginate. Loop with a hard cap of 50 pages
    // (10k users at perPage=200) so a malformed response can't infinite-
    // loop. For Staxis-scale tenants the match is virtually always on
    // page 1; the loop exists for the rare large-tenant case where a
    // synthetic .invalid email lands deep in the list.
    const PER_PAGE = 200;
    const PAGE_CAP = 50;
    let match: { id: string; email?: string } | undefined;
    for (let page = 1; page <= PAGE_CAP; page++) {
      const { data: list, error: listErr } = await supabaseAdmin.auth.admin.listUsers({
        page,
        perPage: PER_PAGE,
      });
      if (listErr) {
        throw new Error(`[staff-auth] listUsers fallback failed: ${errToString(listErr)}`);
      }
      const users = list?.users ?? [];
      match = users.find(u => u.email === email);
      if (match) break;
      if (users.length < PER_PAGE) break; // last page
    }
    if (!match) {
      throw new Error(`[staff-auth] race recovery: no user with email ${email}`);
    }
    // Persist the linkage we just discovered.
    await supabaseAdmin.from('staff').update({ auth_user_id: match.id }).eq('id', staffId);
    return { authUserId: match.id, email };
  }

  if (!created?.user) {
    throw new Error('[staff-auth] createUser returned no user');
  }

  // Persist the new linkage so future calls hit the fast path.
  const { error: updateErr } = await supabaseAdmin
    .from('staff')
    .update({ auth_user_id: created.user.id })
    .eq('id', staffId);
  if (updateErr) {
    // Non-fatal: the auth user exists; the link table just isn't updated.
    // The next call to ensureStaffAuthUser will see auth_user_id null and
    // try to recreate, hit "already registered", and successfully patch.
    console.error('[staff-auth] failed to persist auth_user_id:', errToString(updateErr));
  }

  return { authUserId: created.user.id, email };
}

/**
 * Mint a short opaque CODE that the housekeeper page can exchange for
 * a session via /api/housekeeper/exchange-code. 8 chars from a 32-char
 * alphabet ≈ 40 bits of entropy. Combined with the per-IP rate limit
 * on the exchange endpoint, brute-forcing the code space is infeasible.
 *
 * Alphabet excludes letters that look like digits (I, L, O) and digits
 * that look like letters (0, 1) so codes are unambiguous if anyone ever
 * has to read one aloud.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function generateMagicCode(): string {
  let s = '';
  for (let i = 0; i < 8; i++) {
    s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return s;
}

/**
 * Mint a one-time magic-link for the given staff member and return the full
 * URL to embed in the SMS body or copy to clipboard. Shared implementation
 * behind buildHousekeeperLink / buildEngineerLink — the ONLY thing that
 * differs between staff surfaces is the URL path segment (`pathPrefix`).
 *
 * F-NEW-02 (Batch D): the URL carries a short opaque CODE instead of the
 * Supabase hashed_token. The hashed_token is stored server-side in
 * staff_magic_codes (keyed by code), and the mobile page POSTs the code to
 * /api/housekeeper/exchange-code to retrieve the token (that route is
 * department-agnostic — it keys on staff_magic_codes by code+staff+property).
 * That keeps the actual credential out of: Vercel access logs, Sentry
 * breadcrumbs, browser history, and Referer headers.
 *
 * The OLD ?token={hashed_token} URL pattern keeps working for the transition
 * window (in-flight SMSes from before this deploy). See
 * src/app/housekeeper/[id]/page.tsx for the dual-format handler.
 *
 * Returned URL shape:
 *   https://getstaxis.com/{pathPrefix}/{staffId}?pid={pid}&code={short_code}&tok={link_token}
 *
 * @param staffId     UUID of the staff member
 * @param pid         UUID of the property the URL is scoped to
 * @param pathPrefix  URL path segment for the surface ('housekeeper' | 'engineer')
 * @param baseUrl     Optional override for the deployment origin. Defaults
 *                    to https://getstaxis.com.
 */
export async function buildStaffLink(
  staffId: string,
  pid: string,
  pathPrefix: string,
  baseUrl: string = 'https://getstaxis.com',
): Promise<string> {
  // F-NEW-04: pid is load-bearing — ensureStaffAuthUser asserts the
  // staff row belongs to pid before any auth-user creation or token mint.
  const { email } = await ensureStaffAuthUser(staffId, pid);

  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type: 'magiclink',
    email,
  });
  if (error) {
    throw new Error(`[staff-auth] generateLink failed: ${errToString(error)}`);
  }
  const tokenHash = data?.properties?.hashed_token;
  if (!tokenHash) {
    // FAIL CLOSED — Codex review of Batch D flagged that this path used to
    // fall back to `data.properties.action_link`, which is the Supabase
    // `auth/v1/verify?token=<hashed_token>&redirect_to=...` URL — the
    // credential IS in the URL. That silently re-opens exactly the
    // exposure F-NEW-02 closed (token in URL → Vercel logs / Sentry
    // breadcrumbs / browser history / Referer headers).
    //
    // Today's @supabase/supabase-js (^2.x) always returns hashed_token
    // for type: 'magiclink'. If a future Supabase version stops doing
    // that, we want the throw to surface in Sentry so we re-evaluate
    // the helper deliberately — not silently degrade security.
    throw new Error(
      '[staff-auth] generateLink: hashed_token absent — refusing to fall back to action_link (would leak credential in URL)',
    );
  }

  // Mint a fresh opaque code, store the {code → hashed_token} mapping
  // server-side, and embed the code in the URL. 15-minute TTL — Mario
  // typically Sends and the HK opens the SMS within seconds; 15 min is
  // a comfortable buffer for delayed carrier delivery. If a code does
  // expire, Mario can just Send again.
  //
  // Retry on the rare collision (40-bit code-space, vanishing chance
  // of a PRNG collision against existing rows, but we trust the unique
  // constraint to be cheap).
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  let code: string | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateMagicCode();
    const { error: insErr } = await supabaseAdmin
      .from('staff_magic_codes')
      .insert({
        code: candidate,
        staff_id: staffId,
        property_id: pid,
        hashed_token: tokenHash,
        expires_at: expiresAt,
      });
    if (!insErr) { code = candidate; break; }
    // 23505 = unique-violation; retry with a fresh code. Any other
    // error is fatal.
    if (insErr.code !== '23505') {
      throw new Error(`[staff-auth] staff_magic_codes insert failed: ${errToString(insErr)}`);
    }
  }
  if (!code) {
    throw new Error('[staff-auth] staff_magic_codes insert: 5 collisions in a row — PRNG broken?');
  }

  // Security audit 2026-06-26 #1: mint the per-staff link token and embed it as
  // &tok=. This — not the (pid, staffId) tuple — is the credential the public
  // API routes verify. (The `code` above is the orthogonal one-shot magic-code
  // that establishes the Supabase RLS session; kept unchanged.)
  const tok = await mintStaffLinkToken(staffId, pid);

  // Trim trailing slash from baseUrl just in case.
  const cleanBase = baseUrl.replace(/\/$/, '');
  return (
    `${cleanBase}/${pathPrefix}/${encodeURIComponent(staffId)}` +
    `?pid=${encodeURIComponent(pid)}` +
    `&code=${encodeURIComponent(code)}` +
    `&tok=${encodeURIComponent(tok)}`
  );
}

/**
 * Housekeeper magic-link (/housekeeper/[id]). Thin wrapper over buildStaffLink.
 */
export function buildHousekeeperLink(
  staffId: string,
  pid: string,
  baseUrl: string = 'https://getstaxis.com',
): Promise<string> {
  return buildStaffLink(staffId, pid, 'housekeeper', baseUrl);
}

// (buildEngineerLink removed 2026-07-19 — the engineering-compliance mobile
// surface was deleted with the compliance section.)
