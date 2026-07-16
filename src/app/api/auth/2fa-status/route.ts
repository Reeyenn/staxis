/**
 * GET /api/auth/2fa-status  (public, read-only)
 *
 * Returns { enabled } — whether human Staxis 2FA is globally on. Pre-session
 * flows that need to know before any login exists (signup, the phone-handoff
 * page, the /signin/verify guard) read this to decide whether to present a
 * code step at all.
 *
 * No auth on purpose: these flows run before a session exists, and the on/off
 * state of the 2FA wall is not sensitive (a disabled wall is self-evident to
 * anyone who simply signs in). Only the single boolean is exposed.
 *
 * NOTE: this reports the HUMAN Staxis 2FA switch only. It has nothing to do
 * with the PMS/CUA robot's own MFA.
 */

import type { NextRequest } from 'next/server';
import { ok } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { readTwoFactorEnabledFresh } from '@/lib/two-factor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const enabled = await readTwoFactorEnabledFresh();
  return ok({ enabled }, { requestId });
}
