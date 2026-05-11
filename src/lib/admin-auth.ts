/**
 * Admin auth gate — used by every /api/admin/* route.
 *
 * Pattern mirrors requireSession from api-auth.ts but adds a check
 * that the caller's accounts row has role='admin'. Keeping this
 * separate (vs a parameter on requireSession) means admin routes are
 * grep-able and security audits can verify the gate is applied.
 */

import { timingSafeEqual } from 'node:crypto';
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

/**
 * Admin role OR CRON_SECRET — for fleet-ops endpoints that need to be
 * callable from BOTH the admin UI (signed-in admin) AND ops scripts
 * (curl with CRON_SECRET), without granting access to non-admin
 * signed-in users.
 *
 * Why this isn't `requireSessionOrCron` from api-auth.ts: that helper
 * accepts ANY session token, no role check. For fleet ops (reassigning
 * scrapers, viewing instance topology) that's too loose — only admins
 * should drive the fleet. Cron-secret callers are trusted by virtue of
 * holding the shared secret (same trust level as the GitHub Actions
 * workflows themselves).
 *
 * Order matters: cron-secret check first because it's a constant-time
 * memcmp (no DB round-trip). Only fall through to session+role check on
 * miss. Keeps script-driven calls fast and avoids hammering Supabase
 * Auth on every reassignment.
 */
export async function requireAdminOrCron(req: NextRequest): Promise<
  | { ok: true; kind: 'cron' }
  | { ok: true; kind: 'session'; userId: string; email: string | null; accountId: string }
  | { ok: false; response: NextResponse }
> {
  const auth = req.headers.get('authorization') ?? '';
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const expected = `Bearer ${cronSecret}`;
    const authBuf = Buffer.from(auth);
    const expectedBuf = Buffer.from(expected);
    if (authBuf.length === expectedBuf.length) {
      try {
        if (timingSafeEqual(authBuf, expectedBuf)) {
          return { ok: true, kind: 'cron' };
        }
      } catch {
        // length-mismatch already guarded by the if-check; this is the
        // defense-in-depth catch.
      }
    }
  }

  // Fall through to standard admin gate (session + admin role).
  const admin = await requireAdmin(req);
  if (!admin.ok) return { ok: false, response: admin.response };
  return {
    ok: true,
    kind: 'session',
    userId: admin.userId,
    email: admin.email,
    accountId: admin.accountId,
  };
}
