/**
 * GET /api/property-selector/bootstrap
 *   → { ok, data: { hotels, company, chat, signedInAs } }
 *
 * EVERYTHING the hotel picker draws, in ONE read. It serves two people from one
 * payload:
 *
 *   • a hotel person (a GM with one hotel, a housekeeper who covers two) gets
 *     their hotels, named, with room counts and nothing else. `company` is
 *     null and no chip is computed for them — a picker is a door, not a
 *     dashboard.
 *   • a company-scope person (owner / VP / finance, resolved from their hats)
 *     gets the same list PLUS a health chip per hotel, their company's name,
 *     and whether cross-hotel chat is open to them.
 *
 * ─── WHY THIS ROUTE EXISTS AT ALL: THE STALE-SNAPSHOT FIX ─────────────────
 * The picker used to render `accounts.property_access` — the array stamped onto
 * an account when its invitation was accepted. That array is a SNAPSHOT. A
 * hotel the company bought last week is covered by every company hat the moment
 * the relationship row exists, and it was still missing from the picker, so the
 * only way to see it was to re-invite the person. This route resolves coverage
 * through `accessibleProperties` — the legacy array UNION every hat's live
 * coverage — so the new hotel simply appears.
 *
 * ─── WHY NOT /api/company/queue ───────────────────────────────────────────
 * That route builds the whole portfolio: it runs the company's daily checks,
 * loads the approver directory, resolves sign-off per proposal, reads judged
 * phrasing and assembles the brief. It is the right cost for the screen a VP
 * opens to WORK. This one is on the critical path of every sign-in, and a chip
 * is three words — see `hotelHealthChips` for exactly which of the queue's
 * reads are shared (all the ones that decide what a finding means) and which
 * are skipped (all the ones that turn a finding into a sentence).
 *
 * ─── AUTH ─────────────────────────────────────────────────────────────────
 * requireSession, then `loadSessionAccount` — NOT `loadManagerCaller`. The
 * manager gate refuses front_desk, maintenance and housekeeping, and a
 * company's finance lead carries a legacy role of `front_desk`; gating here
 * would have shown a whole class of real users an empty picker. The tenant wall
 * is not the role anyway: it is `accessibleProperties`, which can only ever
 * return hotels this account's own legacy array or own hats name.
 *
 * loadSessionAccount is the shared, schema-pinned account lookup. Do not
 * hand-roll another one: the last three times a route did, it selected a column
 * that does not exist (`accounts.name` most recently), PostgREST errored, the
 * route read the error as "no such account", and the feature was silently dead
 * for every user with a green build and a green suite.
 */

import { NextRequest } from 'next/server';

import { requireSession } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { checkAndIncrementRateLimit } from '@/lib/api-ratelimit';
import { loadSessionAccount } from '@/lib/team-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { accessibleProperties } from '@/lib/company/access';
import { companyScopeFor, hotelHealthChips } from '@/lib/company/vp-queue-server';
import { resolvePortfolioAccessUncached } from '@/lib/company/portfolio';
import { rankHotels, type HotelChip } from '@/lib/company/vp-queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The most hotels one picker will draw. A Staxis administrator reaches every
 * property in the fleet, and rendering four hundred cards is not a picker —
 * they have /admin for that.
 */
const MAX_HOTELS = 60;

export interface PickerHotel {
  propertyId: string;
  name: string;
  totalRooms: number;
  /** Null for hotel people (never computed) and for hotels we cannot vouch for. */
  chip: HotelChip | null;
  /** Carried so the client can resume a half-finished setup without a second read. */
  onboardingCompletedAt: string | null;
  onboardingState: string | null;
  onboardingPromptShownAt: string | null;
}

interface PropertyRow {
  id: string;
  name: string | null;
  total_rooms: number | string | null;
  onboarding_completed_at: string | null;
  onboarding_state: string | null;
  onboarding_prompt_shown_at: string | null;
}

const PROPERTY_COLUMNS =
  'id, name, total_rooms, onboarding_completed_at, onboarding_state, onboarding_prompt_shown_at';

function roomCount(value: number | string | null): number {
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(n) && (n as number) > 0 ? Math.round(n as number) : 0;
}

/** The hotels this account may open, already bounded. Admins and `'*'` holders
 *  reach everything, which is the one case that is not an id list. */
async function readHotels(
  propertyIds: readonly string[] | null,
): Promise<PropertyRow[]> {
  const base = supabaseAdmin.from('properties').select(PROPERTY_COLUMNS);
  const scoped = propertyIds === null ? base : base.in('id', [...propertyIds]);
  const { data, error } = await scoped.order('name', { ascending: true }).limit(MAX_HOTELS);
  if (error) throw new Error(`property list failed: ${error.message}`);
  return (data ?? []) as unknown as PropertyRow[];
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  const account = await loadSessionAccount(session.userId);
  if (!account) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  try {
    // THE WALL, and the stale-snapshot fix in one call: the legacy array UNION
    // every live hat's coverage. Never a subtraction, so no account that could
    // reach a hotel yesterday loses it today.
    const access = await accessibleProperties(account.accountId);
    const reachesAll = access.all;
    const propertyIds = reachesAll ? null : access.propertyIds;

    // Keyed on a REAL property id the caller actually reaches (the api_limits
    // FK trap), with the account in the sub-key. A caller with no hotels at all
    // has nothing to read and nothing to cap.
    const anchor = reachesAll ? null : (propertyIds?.[0] ?? null);
    if (anchor) {
      const limit = await checkAndIncrementRateLimit('property-selector', anchor, {
        subKey: account.accountId,
      });
      if (!limit.allowed) {
        return err('Too many requests, try again shortly', {
          requestId,
          status: 429,
          code: ApiErrorCode.RateLimited,
          headers: { 'Retry-After': String(limit.retryAfterSec) },
        });
      }
    }

    if (!reachesAll && (propertyIds?.length ?? 0) === 0) {
      // No hotels is a real answer, not an error — the client's join-status
      // gate is what explains it to a pending staff signup.
      return ok(
        { hotels: [], company: null, chat: { available: false }, signedInAs: account.displayName },
        { requestId },
      );
    }

    const rows = await readHotels(propertyIds);

    // Wall A: null for a hotel GM, a front-desk lead, an administrator and
    // every single-hotel account in the product today. No scope, no chips, no
    // portfolio entry — the picker they have always had.
    const scope = await companyScopeFor(account);

    let chips = new Map<string, HotelChip | null>();
    if (scope) {
      // Chips ONLY for hotels this company operates. If a company person also
      // holds a legacy hotel somewhere else, that hotel is in their list and
      // gets no chip, because this company's watcher says nothing about it.
      //
      // The same is true past `companyScopeFor`'s own hotel cap, and it is safe
      // for the same reason: NO CHIP IS NOT A CLAIM. The only chip that asserts
      // anything about having looked is `quiet`, and `chipForHotel` cannot
      // produce it without a fresh run. Everything a capped-out hotel renders
      // is its name — silence, which is the honest thing to say about a
      // building this read did not reach.
      const covered = rows.map((r) => r.id).filter((id) => scope.propertyIds.includes(id));
      chips = await hotelHealthChips(covered);
    }

    const hotels: PickerHotel[] = rows.map((row) => ({
      propertyId: row.id,
      name: row.name ?? 'This hotel',
      totalRooms: roomCount(row.total_rooms),
      chip: chips.get(row.id) ?? null,
      onboardingCompletedAt: row.onboarding_completed_at,
      onboardingState: row.onboarding_state,
      onboardingPromptShownAt: row.onboarding_prompt_shown_at,
    }));

    // THE CHAT DOOR, asked of the one function that owns the question. Both
    // halves are required and neither is inferred here: a company-scope job AND
    // `cross_hotel_ai_chat` switched on. Uncached, so a company that turned it
    // off five seconds ago is not offered it on their next sign-in.
    let chatAvailable = false;
    if (scope) {
      const door = await resolvePortfolioAccessUncached(account.accountId, scope.organizationId);
      chatAvailable = door.ok;
    }

    return ok(
      {
        hotels: rankHotels(hotels),
        company: scope
          ? {
            organizationId: scope.organizationId,
            organizationName: scope.organizationName,
            companyRole: scope.companyRole,
            hotelCount: scope.propertyIds.length,
          }
          : null,
        chat: { available: chatAvailable },
        signedInAs: account.displayName,
      },
      { requestId },
    );
  } catch (e) {
    // Deliberately an error, not an empty list. An empty picker is a CLAIM —
    // "you have no hotels" — and a failed read has not earned the right to
    // make it. The screen says it could not load and offers a retry.
    log.error('[property-selector] bootstrap failed', {
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
