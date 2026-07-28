/**
 * The morning brief — one pinned card at the top of the Staxis tab.
 * MANAGER ONLY, service-role.
 *
 * GET ?propertyId=<uuid>
 *   → { ok, data: { brief, cached } }
 *
 * `brief` is null in exactly one situation that matters: this hotel has never
 * been checked. Then there is no card at all — not "quiet night", not "all
 * normal", not an empty box. Every sentence a brief can print is a claim about
 * having looked, and on a hotel nobody has looked at, silence is the only true
 * thing to say.
 *
 * NO CRON AND NO PAID MODEL ON GET. The brief is assembled from deterministic
 * templates on the first load of the hotel's own calendar day and cached
 * against that day (src/lib/findings/brief-server.ts). Opening or navigating to
 * Feed must never wait on, retry, or spend money with an AI provider.
 *
 * WHY THE property_id FILTER IS THE TENANT WALL HERE
 * Identical to /api/findings: `findings` and `finding_runs` are deny-all to
 * anon AND authenticated (migration 0360), so there is no RLS policy behind
 * this route. Every read goes through src/lib/findings/store.ts, which applies
 * the hotel filter inside scopedDb before handing the query builder back. The
 * gate deciding WHICH propertyId is legitimate is loadManagerCaller +
 * managerManagesHotel, right here. The day's cache row is keyed on a
 * server-derived string containing that same property id and is re-checked
 * against it on read.
 *
 * loadManagerCaller is the shared, schema-pinned account lookup. Do not
 * hand-roll another one: the last three times a route did, it selected a column
 * that does not exist (`accounts.name` most recently), PostgREST errored, the
 * route read the error as "no such account", and the feature was silently dead
 * for every user with a green build and a green suite.
 */

import { NextRequest } from 'next/server';
import { requireSession } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';
import { checkAndIncrementRateLimit } from '@/lib/api-ratelimit';
import { loadManagerCaller, managerManagesHotel } from '@/lib/team-auth';
import { loadFeedMorningBrief } from '@/lib/findings/feed-brief';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  const pidV = validateUuid(new URL(req.url).searchParams.get('propertyId'), 'propertyId');
  if (pidV.error) {
    return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const propertyId = pidV.value!;

  const caller = await loadManagerCaller(session.userId);
  if (!caller || !managerManagesHotel(caller, propertyId)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  // Keyed on the RAW property id — api_limits.property_id FKs properties(id),
  // so a hashed composite would FK-violate and this would fail for the wrong
  // reason. The read is deterministic now, but the limiter still bounds cache
  // and ledger work from rapid reloads. The cards below remain unaffected.
  const limit = await checkAndIncrementRateLimit('findings-brief', propertyId);
  if (!limit.allowed) {
    return err('Too many requests, try again shortly', {
      requestId,
      status: 429,
      code: ApiErrorCode.RateLimited,
      headers: { 'Retry-After': String(limit.retryAfterSec) },
    });
  }

  try {
    const result = await loadFeedMorningBrief(propertyId);
    // `stopped` distinguishes the two reasons there is no brief. A null brief
    // has always meant "nobody has checked this hotel"; a switched-off Morning
    // Briefer (admin AI Staff page) means "nobody is writing one". The screen
    // renders nothing either way — it is the API that must not conflate them.
    return ok(
      { brief: result.brief, cached: result.cached, stopped: result.stopped === true },
      { requestId },
    );
  } catch (e) {
    // Deliberately NOT a null brief. "No brief" is a statement ("we have never
    // checked this hotel") and we have no right to make it when the read
    // failed; the screen renders nothing at all on an error instead.
    log.error('[findings:brief] failed', {
      requestId,
      err: e instanceof Error ? e.message : String(e),
    });
    return err('Could not build the morning brief', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  }
}
