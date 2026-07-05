import { NextRequest } from 'next/server';
import { validateUuid } from '@/lib/api-validate';
import { err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';

/**
 * RETIRED — security audit 2026-06-26 #1 (HIGH: public staffId enumeration).
 *
 * This endpoint used to return every scheduled staff member's UUID + name to
 * ANY unauthenticated caller who knew the property id. That was the enumeration
 * root cause: the whole public mobile surface trusted the (pid, staffId) tuple
 * as its only credential, `pid` leaks (SMS forwarding, browser history, Referer,
 * carrier logs), and this route handed out the matching staffIds — so anyone
 * with a pid could act as any scheduled staff member.
 *
 * THE FIX MADE THIS ENDPOINT UNNECESSARY. The "pick who you are" roster flow is
 * gone: each staff member now gets their OWN per-staff link (`&tok=`) straight
 * to /housekeeper/[id] (or /laundry/[id], /engineer/[id]). The link's token —
 * not a listed staffId — is the credential the public API routes verify
 * (src/lib/staff-link-auth.ts). There is nothing left for a roster endpoint to
 * do that wouldn't re-open the enumeration hole.
 *
 * So the route now returns 410 Gone. It still UUID-validates `pid` (400 on
 * garbage) purely so a malformed capability URL gets a clean signal, but it
 * never touches the `staff` table and never emits a staff id or name again.
 *
 * If a property-scoped roster is ever needed again, it MUST be gated behind a
 * valid property-scoped link token and return opaque, short-lived selection
 * handles — never raw staff.id. Do NOT restore the old behaviour.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const { searchParams } = new URL(req.url);

  // Keep the 400-on-garbage-pid signal so a mangled link is distinguishable
  // from the intentional retirement below.
  const pidV = validateUuid(searchParams.get('pid'), 'pid');
  if (pidV.error) {
    return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  return err(
    'The staff picker has been retired — open your personal shift link from your text message.',
    { requestId, status: 410, code: ApiErrorCode.IdempotencyConflict },
  );
}
