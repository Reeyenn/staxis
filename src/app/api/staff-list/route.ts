import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';
import { validateUuid } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log, getOrMintRequestId } from '@/lib/log';

/**
 * Public endpoint — returns the staff scheduled to work today for a given
 * property. Used by the housekeeper / laundry mobile pages to let someone
 * identify who they are (no login required — the URL encodes the property).
 *
 * THE RESPONSE IS DELIBERATELY MINIMAL.
 *
 * Previously this route returned `select *` mapped to camelCase, which
 * leaked every staff member's phone number, hourly wage, weekly hours, and
 * scheduling-manager flag to anyone who knew the property id. The pid
 * shows up in the SMS we send out and ends up in browser history,
 * referrer headers, and any spouse/coworker who borrows the phone for
 * 30 seconds. That was a real PII + payroll leak.
 *
 * Now we only return the fields the public landing pages actually need:
 *   { id, name, isSenior }
 *
 * Anything that needs phone / wage data must go through an authenticated
 * route.
 *
 * Legacy `uid` query param is accepted for URL back-compat but ignored.
 *
 * Response shape (uniform envelope from src/lib/api-response.ts):
 *   200: { ok: true, requestId, data: Array<{id,name,isSenior}> }
 *   4xx: { ok: false, requestId, error, code }
 *   5xx: { ok: false, requestId, error, code }
 */
export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const { searchParams } = new URL(req.url);
  const rawPid = searchParams.get('pid');

  // UUID-validate the pid before it touches the query — even though
  // supabase-js parameterises and the `pid` doesn't really tunnel into
  // SQL, returning a 400 for garbage is a useful early signal that the
  // capability URL is malformed.
  const pidV = validateUuid(rawPid, 'pid');
  if (pidV.error) {
    return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const pid = pidV.value!;

  // Pull only the columns we need to return. Belt-and-suspenders against
  // someone later widening the response mapper without thinking about the
  // PII implications.
  const { data, error: queryError } = await supabaseAdmin
    .from('staff')
    .select('id, name, is_senior')
    .eq('property_id', pid)
    .eq('scheduled_today', true)
    .eq('is_active', true);

  if (queryError) {
    // Don't echo PG error text — leaks schema/column names. Log the full
    // detail server-side and return generic 500 to caller.
    log.error('[staff-list] query failed', { err: queryError, requestId });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  // Minimal projection. NEVER add phone, hourly_wage, weekly_hours, or
  // is_scheduling_manager here — those are private. If a consumer needs
  // them, build a separate authenticated route.
  const mapped = (data ?? []).map(s => ({
    id: s.id,
    name: s.name,
    isSenior: s.is_senior,
  }));

  return ok(mapped, { requestId });
}
