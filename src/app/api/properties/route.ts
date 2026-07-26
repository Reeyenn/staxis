/**
 * GET /api/properties            → { ok, data: { properties: PropertyRow[] } }
 * GET /api/properties?propertyId → the same shape, one row (or none).
 *
 * THE HOTELS THIS PERSON MAY OPEN, with every column the app shell needs, read
 * with service-role and scoped in the app. It is what `PropertyContext` runs on,
 * which makes it the door into the entire signed-in product.
 *
 * ─── THE BUG THIS ROUTE EXISTS TO FIX ─────────────────────────────────────
 * `getProperties()` used to read `properties` through the ANON browser client.
 * The RLS policies on that table (0002/0003) answer from `accounts.property_access`
 * — the flat legacy array — and know nothing about company hats (0364). A
 * company person's legacy array is EMPTY by construction: every hotel they
 * reach comes from a hat. So Postgres returned zero rows, with a 200 and no
 * error; `PropertyContext` set an empty property list; `activeProperty` stayed
 * null; `/home` bounced to `/company`; and `/company` said "No active access
 * grant". A dual-hat GM+VP could not enter her own hotel.
 *
 * That is the CLAUDE.md RLS bug class one level up — browser client + an RLS
 * blind spot = a silent empty state that reads as "you have nothing" — and it
 * gets the house fix: read past RLS on the server, and let the app decide who
 * may see what.
 *
 * There was a SECOND wall behind the first, and it is why widening RLS alone
 * would not have been enough: `PropertyContext` then filtered whatever came
 * back through `user.propertyAccess` — the same legacy array — so a hat-only
 * account would still have landed on zero hotels. Coverage is resolved once,
 * here, through the spine.
 *
 * ─── THE WALL ─────────────────────────────────────────────────────────────
 * `accessibleProperties` — the legacy array UNION every live hat's coverage.
 * Never a subtraction: an account that could open a hotel yesterday still can.
 * Nothing the caller sends names a hotel it does not already reach; the
 * `propertyId` parameter can only ever NARROW the answer, never widen it.
 *
 * ─── WHY NOT /api/property-selector/bootstrap ─────────────────────────────
 * That route answers the picker's question — six columns, a health chip per
 * hotel, the company header and the chat door — and pays for company scope,
 * portfolio access and a findings read to do it. This one answers the app
 * shell's question: every column of every hotel you may open, and nothing
 * else. Folding them together would put a chip computation on every mount of
 * the shell, or a fifty-column select on the sign-in critical path.
 *
 * ─── AUTH ─────────────────────────────────────────────────────────────────
 * requireSession, then `loadSessionAccount` — NOT `loadManagerCaller`. This is
 * the app shell: a housekeeper, a front-desk lead and a company's finance lead
 * all have to be able to open their hotel, and the manager gate refuses all
 * three. The tenant wall is not the role, it is the coverage.
 *
 * @tenant-scope authenticated account -> accessibleProperties(accountId); the
 * optional propertyId query parameter is intersected with that set and can only
 * narrow it.
 */

import { NextRequest } from 'next/server';

import { requireSession } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';
import { loadSessionAccount } from '@/lib/team-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { accessibleProperties } from '@/lib/company/access';
import { PROPERTY_COLS } from '@/lib/db-mappers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  const account = await loadSessionAccount(session.userId);
  if (!account) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  const rawPropertyId = req.nextUrl.searchParams.get('propertyId');
  let onlyPropertyId: string | null = null;
  if (rawPropertyId !== null) {
    const v = validateUuid(rawPropertyId, 'propertyId');
    if (v.error) {
      return err(v.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    onlyPropertyId = v.value!;
  }

  try {
    const access = await accessibleProperties(account.accountId);

    // Admins and legacy `'*'` holders reach the whole fleet — the one case
    // that is not an id list, and exactly what the anon read returned for them
    // before. `null` here means "no `.in()` filter".
    let scopeIds: string[] | null = access.all ? null : access.propertyIds;

    if (onlyPropertyId) {
      // Intersection, not substitution. Asking for a hotel you do not reach
      // returns an empty list — the same answer as asking for one that does
      // not exist, so the response cannot be used to probe the fleet.
      if (scopeIds !== null && !scopeIds.includes(onlyPropertyId)) {
        return ok({ properties: [] }, { requestId });
      }
      scopeIds = [onlyPropertyId];
    }

    if (scopeIds !== null && scopeIds.length === 0) {
      // Zero hotels is a real answer for a brand-new staff signup awaiting
      // approval. The client's own gates explain it; this route does not
      // pretend it is an error.
      return ok({ properties: [] }, { requestId });
    }

    const base = supabaseAdmin.from('properties').select(PROPERTY_COLS);
    const scoped = scopeIds === null ? base : base.in('id', scopeIds);
    const { data, error } = await scoped;
    if (error) throw new Error(`property read failed: ${error.message}`);

    return ok({ properties: data ?? [] }, { requestId });
  } catch (e) {
    // Deliberately an error, not an empty list. An empty list is a CLAIM —
    // "you have no hotels" — and that claim is precisely what locked company
    // people out of the product. A failed read has not earned it.
    log.error('[properties] read failed', {
      requestId,
      err: e instanceof Error ? e.message : String(e),
    });
    return err('Could not load your hotels', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  }
}
