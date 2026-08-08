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
import { logSecurityEvent } from '@/lib/audit';

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

  // Read the state we are leaving so the record says what changed, not just
  // what it became.
  const previous = await readTwoFactorEnabledFresh();

  const result = await setTwoFactorEnabled(body.twoFactorEnabled, ctx.userId);
  if (!result.ok) {
    // A failed attempt to take the wall down is itself worth seeing.
    await logSecurityEvent({
      action: 'auth.two_factor_switch_failed',
      userId: ctx.userId,
      requestId: ctx.requestId,
      metadata: { requested: body.twoFactorEnabled, previous, error: result.error },
    });
    return ctx.err(`could not save setting: ${result.error}`, {
      status: 500, code: ApiErrorCode.UpstreamFailure,
    });
  }

  // Turning this off disables every human second factor across the whole
  // fleet. The only prior trace was app_settings.updated_by / updated_at — one
  // mutable row that the next flip overwrites, so the history of when the wall
  // was down did not exist anywhere. app_events is append-only.
  await logSecurityEvent({
    action: body.twoFactorEnabled
      ? 'auth.two_factor_switch_enabled'
      : 'auth.two_factor_switch_disabled',
    userId: ctx.userId,
    requestId: ctx.requestId,
    metadata: { previous, next: body.twoFactorEnabled, accountId: ctx.accountId },
  });

  return ctx.ok({ twoFactorEnabled: body.twoFactorEnabled });
  },
});
