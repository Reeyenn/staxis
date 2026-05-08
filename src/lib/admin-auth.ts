/**
 * Admin auth gate — used by every /api/admin/* route.
 *
 * Pattern mirrors requireSession from api-auth.ts but adds a check
 * that the caller's accounts row has role='admin'. Keeping this
 * separate (vs a parameter on requireSession) means admin routes are
 * grep-able and security audits can verify the gate is applied.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/api-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';

export async function requireAdmin(req: NextRequest): Promise<
  | { ok: true; userId: string; email: string | null; accountId: string }
  | { ok: false; response: NextResponse }
> {
  const session = await requireSession(req);
  if (!session.ok) return { ok: false, response: session.response };

  const { data: account } = await supabaseAdmin
    .from('accounts')
    .select('id, role')
    .eq('data_user_id', session.userId)
    .maybeSingle();

  if (!account || (account.role as string) !== 'admin') {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'admin only' },
        { status: 403 },
      ),
    };
  }

  return {
    ok: true,
    userId: session.userId,
    email: session.email,
    accountId: account.id as string,
  };
}
