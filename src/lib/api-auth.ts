import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from './supabase-admin';

/**
 * Session auth for app-internal API routes.
 *
 * Verifies the Supabase bearer token from `Authorization: Bearer <jwt>`
 * resolves to an accounts row, and (when `pid` is provided) that the
 * account either has admin role or property_access includes `pid`.
 *
 * Returns either a NextResponse to short-circuit, or `{ accountId, role }`
 * for the caller to proceed.
 */
export async function requireSession(req: NextRequest, opts?: { pid?: string | null }):
  Promise<NextResponse | { accountId: string; role: string; userId: string }>
{
  const authHeader = req.headers.get('authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data: account, error: acctErr } = await supabaseAdmin
    .from('accounts')
    .select('id, role, property_access')
    .eq('data_user_id', userData.user.id)
    .maybeSingle();

  if (acctErr || !account) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (opts?.pid) {
    const role = account.role as string;
    const access = (account.property_access as string[]) ?? [];
    if (role !== 'admin' && !access.includes(opts.pid)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  return {
    accountId: account.id as string,
    role: account.role as string,
    userId: userData.user.id,
  };
}

/**
 * Light-weight verification for routes called from the public housekeeper
 * SMS link, where there is no logged-in user. Confirms that the supplied
 * `staffId` actually belongs to the supplied `pid` so a stranger can't
 * fire help-requests for staff they don't know.
 */
export async function verifyStaffBelongsToProperty(
  staffId: string,
  pid: string,
): Promise<boolean> {
  if (!staffId || !pid) return false;
  const { data } = await supabaseAdmin
    .from('staff')
    .select('id')
    .eq('id', staffId)
    .eq('property_id', pid)
    .maybeSingle();
  return !!data;
}
