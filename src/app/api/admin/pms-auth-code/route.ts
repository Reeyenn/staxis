/**
 * POST /api/admin/pms-auth-code
 *
 * Manual 2FA code entry from the Launch Bay panel. When a learning run
 * (or, later, a polling login) parks on a PMS 2FA screen and the code
 * went to Reeyen's PHONE instead of the hotel's @getstaxis.com inbox,
 * he types it into the hotel's onboarding panel and this route drops it
 * into `pms_auth_codes` — the same table the emailed-code pipeline
 * writes — where the robot's `fetchLatestAuthCode()` poller claims it
 * atomically (single-use, 15-min freshness window on the robot side).
 *
 * Body: { propertyId, code }
 *
 * Mirrors the emailed-code row shape (source='sms' — the code WAS an
 * SMS, just relayed by a human). No migration needed: the
 * pms_auth_codes source CHECK already allows 'email' | 'sms'.
 *
 * Security: requireAdmin + per-property rate limit (30/hr) + 4-8 digit
 * validation. The code itself is never logged or echoed back — audit
 * metadata records only its length.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';
import { checkAndIncrementRateLimit } from '@/lib/api-ratelimit';
import { writeAudit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

interface Body {
  propertyId?: unknown;
  code?: unknown;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body) {
    return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const pidV = validateUuid(body.propertyId, 'propertyId');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  // Accept "123 456" / "123-456" the way a human reads a code off a
  // phone, but store bare digits — the robot types exactly what's here.
  const rawCode = typeof body.code === 'string' ? body.code : '';
  const code = rawCode.replace(/[\s-]/g, '');
  if (!/^\d{4,8}$/.test(code)) {
    return err('Code must be 4-8 digits', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const rl = await checkAndIncrementRateLimit('admin-pms-auth-code', pidV.value!);
  if (!rl.allowed) {
    return err(
      `Rate limited. Try again in ${rl.retryAfterSec}s.`,
      { requestId, status: 429, code: ApiErrorCode.RateLimited,
        headers: { 'Retry-After': String(rl.retryAfterSec) } },
    );
  }

  // Only accept codes for properties that actually have a PMS login the
  // robot could be stuck on — blocks blind inserts against random UUIDs.
  const { data: creds } = await supabaseAdmin
    .from('scraper_credentials')
    .select('property_id, is_active')
    .eq('property_id', pidV.value!)
    .maybeSingle();
  if (!creds || !creds.is_active) {
    return err(
      'This hotel has no active PMS connection to hand a code to.',
      { requestId, status: 400, code: ApiErrorCode.ValidationFailed },
    );
  }

  const { error: insErr } = await supabaseAdmin
    .from('pms_auth_codes')
    .insert({
      property_id: pidV.value!,
      email_to: 'manual:launch-bay',
      source: 'sms',
      code,
      sender: auth.email ?? 'admin',
      subject: 'Manual code entry (Launch Bay)',
      raw_ref: null,
    });
  if (insErr) {
    return err(
      `Could not hand the code to the robot: ${insErr.message}`,
      { requestId, status: 500, code: ApiErrorCode.InternalError },
    );
  }

  await writeAudit({
    action: 'cua.mfa.code_entered',
    actorUserId: auth.userId,
    actorEmail: auth.email ?? undefined,
    targetType: 'property',
    targetId: pidV.value!,
    hotelId: pidV.value!,
    metadata: { code_len: code.length, request_id: requestId },
  });

  return ok({ delivered: true }, { requestId });
}
