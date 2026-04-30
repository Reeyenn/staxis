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

import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';

const SYNTHETIC_EMAIL_DOMAIN = 'staxis.invalid';

/** Build the synthetic email used to identify this staff member's auth user. */
function syntheticEmailFor(staffId: string): string {
  return `staff-${staffId}@${SYNTHETIC_EMAIL_DOMAIN}`;
}

/**
 * Ensure a Supabase auth user exists for `staffId` and that the staff row's
 * `auth_user_id` column points at it. Idempotent — safe to call on every
 * link generation. Returns the auth user's id.
 *
 * Failure modes are surfaced as thrown errors with a clear `[staff-auth]`
 * prefix so callers (the SMS fan-out + the Link API) can include them in
 * their failure logs. We never silently produce a "staff is auth-linked"
 * result that isn't backed by a real row, because the magic-link
 * generation step downstream depends on the email existing.
 */
export async function ensureStaffAuthUser(
  staffId: string,
): Promise<{ authUserId: string; email: string }> {
  // Look up the existing staff row first — we need to know whether
  // auth_user_id is already populated.
  const { data: staffRow, error: lookupErr } = await supabaseAdmin
    .from('staff')
    .select('id, auth_user_id, name')
    .eq('id', staffId)
    .maybeSingle();
  if (lookupErr) {
    throw new Error(`[staff-auth] staff lookup failed: ${errToString(lookupErr)}`);
  }
  if (!staffRow) {
    throw new Error(`[staff-auth] no staff row with id ${staffId}`);
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
    // List + filter by email. The admin listUsers paginates by default;
    // we only need the first match.
    const { data: list, error: listErr } = await supabaseAdmin.auth.admin.listUsers({
      page: 1,
      perPage: 200,
    });
    if (listErr) {
      throw new Error(`[staff-auth] listUsers fallback failed: ${errToString(listErr)}`);
    }
    const match = (list?.users ?? []).find(u => u.email === email);
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
 * Mint a one-time magic-link token for the given staff member and return
 * the full URL to embed in the SMS body or copy to clipboard.
 *
 * Always calls `ensureStaffAuthUser` first so this works on a freshly-added
 * staff member who's never had a link generated. The returned URL has the
 * shape:
 *
 *   https://hotelops-ai.vercel.app/housekeeper/{staffId}?pid={pid}&token={hashed_token}
 *
 * Same path + query the page already supports for unauthenticated callers
 * (the `token` param is the only addition). When the page sees `token`,
 * it consumes it via supabase.auth.verifyOtp and establishes a session.
 * When the page does NOT see `token`, it falls back to the polling
 * service-role API path. Either way the page works.
 *
 * Tokens default to a 1-hour Supabase TTL. Once consumed, the resulting
 * Supabase session is good for ~1 week, so a HK who clicks the link in
 * the morning has access for the full shift even if the token would have
 * otherwise expired.
 *
 * @param staffId  UUID of the staff member
 * @param pid      UUID of the property the URL is scoped to
 * @param baseUrl  Optional override for the deployment origin. Defaults
 *                 to https://hotelops-ai.vercel.app — the production
 *                 deploy. Pass `req.nextUrl.origin` from inside an API
 *                 route if you want preview deploys to mint preview-
 *                 scoped links.
 */
export async function buildHousekeeperLink(
  staffId: string,
  pid: string,
  baseUrl: string = 'https://hotelops-ai.vercel.app',
): Promise<string> {
  const { email } = await ensureStaffAuthUser(staffId);

  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type: 'magiclink',
    email,
  });
  if (error) {
    throw new Error(`[staff-auth] generateLink failed: ${errToString(error)}`);
  }
  const tokenHash = data?.properties?.hashed_token;
  if (!tokenHash) {
    // Generated link API surface returns either action_link OR hashed_token
    // depending on Supabase client version. Fall back to action_link if
    // hashed_token is unset — the page knows how to handle both.
    const actionLink = data?.properties?.action_link;
    if (!actionLink) {
      throw new Error('[staff-auth] generateLink: no token returned');
    }
    return actionLink;
  }

  // Trim trailing slash from baseUrl just in case.
  const cleanBase = baseUrl.replace(/\/$/, '');
  return (
    `${cleanBase}/housekeeper/${encodeURIComponent(staffId)}` +
    `?pid=${encodeURIComponent(pid)}` +
    `&token=${encodeURIComponent(tokenHash)}`
  );
}
