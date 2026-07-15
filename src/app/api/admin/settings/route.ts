/**
 * /api/admin/settings
 *
 * Read/write the GLOBAL app settings — currently just the master 2FA switch.
 * Modeled on /api/admin/sections (requireAdmin + supabaseAdmin + ok/err
 * envelope).
 *
 *   GET  → { twoFactorEnabled }               — current switch state
 *   POST { twoFactorEnabled: boolean }        → { twoFactorEnabled }
 *
 * Flipping twoFactorEnabled=false disables ALL human Staxis 2FA fleet-wide
 * (password-login-on-new-device OTP, admin device trust, signup email confirm,
 * phone-handoff code). It does NOT affect the PMS/CUA robot's own MFA.
 *
 * Auth: requireAdmin (admin-only) + supabaseAdmin (service-role) via
 * setTwoFactorEnabled. Default/fail-safe is ON everywhere it's read.
 */

import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { readTwoFactorEnabledFresh, setTwoFactorEnabled } from '@/lib/two-factor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body { twoFactorEnabled?: unknown }

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const twoFactorEnabled = await readTwoFactorEnabledFresh();
  return ok({ twoFactorEnabled }, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  let body: Body;
  try { body = (await req.json()) as Body; } catch { body = {}; }

  if (typeof body.twoFactorEnabled !== 'boolean') {
    return err('twoFactorEnabled must be a boolean', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  const result = await setTwoFactorEnabled(body.twoFactorEnabled, auth.userId);
  if (!result.ok) {
    return err(`could not save setting: ${result.error}`, {
      requestId, status: 500, code: ApiErrorCode.UpstreamFailure,
    });
  }

  return ok({ twoFactorEnabled: body.twoFactorEnabled }, { requestId });
}
