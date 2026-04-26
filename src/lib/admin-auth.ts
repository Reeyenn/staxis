import { NextRequest, NextResponse } from 'next/server';

/**
 * Bearer-CRON_SECRET auth gate for admin/cron endpoints.
 *
 * Returns a NextResponse to short-circuit when auth fails, or null to let
 * the handler continue. Centralized so every admin route uses the same
 * check — previously each route reimplemented this and several forgot to
 * gate at all (#3, #4, #5, #9 in the bug audit).
 *
 * In production the secret is mandatory: a missing CRON_SECRET means the
 * endpoint refuses every request rather than going permissive (which is
 * what /admin/doctor used to do, leaking config diagnostics to the world).
 *
 * In non-production the helper stays permissive when the secret is unset,
 * so local `next dev` flows aren't broken before the env is set up.
 */
export function requireCronSecret(req: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      return NextResponse.json(
        { error: 'Server misconfigured: CRON_SECRET not set' },
        { status: 503 },
      );
    }
    return null; // dev mode bootstrap
  }
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}
