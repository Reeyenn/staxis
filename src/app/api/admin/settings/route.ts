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

import { defineRoute, adminGate } from '@/lib/api-route';
import { ApiErrorCode } from '@/lib/api-response';
import { readTwoFactorEnabledFresh, setTwoFactorEnabled } from '@/lib/two-factor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body { twoFactorEnabled?: unknown }

export const GET = defineRoute({
  resolve: (req) => adminGate(req),
  handler: async (ctx) => {

  const twoFactorEnabled = await readTwoFactorEnabledFresh();
  return ctx.ok({ twoFactorEnabled });
  },
});

export const POST = defineRoute({
  resolve: (req) => adminGate(req),
  handler: async (ctx) => {

  let body: Body;
  try { body = (await ctx.req.json()) as Body; } catch { body = {}; }

  if (typeof body.twoFactorEnabled !== 'boolean') {
    return ctx.err('twoFactorEnabled must be a boolean', {
      status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  const result = await setTwoFactorEnabled(body.twoFactorEnabled, ctx.userId);
  if (!result.ok) {
    return ctx.err(`could not save setting: ${result.error}`, {
      status: 500, code: ApiErrorCode.UpstreamFailure,
    });
  }

  return ctx.ok({ twoFactorEnabled: body.twoFactorEnabled });
  },
});
