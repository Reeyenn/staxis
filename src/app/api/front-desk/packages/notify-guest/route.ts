/**
 * POST /api/front-desk/packages/notify-guest
 *
 * Text the guest that a package is waiting at the desk. Resolves the guest phone
 * stored on the package, enqueues a Twilio SMS via the sms_jobs queue, and
 * stamps guest_notified_at. Fail-closed rate limit + per-day idempotency so a
 * double-click doesn't double-text the guest. If no phone is on file the UI
 * hides the button; this route 400s defensively.
 */

import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { validateUuid, validateString, validatePhone, sanitizeForSms } from '@/lib/api-validate';
import { enqueueSms } from '@/lib/sms-jobs';
import { gatePackagesWrite } from '@/lib/packages/api-gate';
import { getPackage, getPropertyName, markGuestNotified } from '@/lib/packages/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

interface Body {
  pid?: string;
  id?: string;
  /** Optional custom note. Appended to the server template, never replaces it. */
  message?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  const gate = await gatePackagesWrite<Body>(req, 'packages-notify-guest');
  if (!gate.ok) return gate.response;
  const { body, pid, requestId } = gate;

  const idV = validateUuid(body.id, 'id');
  if (idV.error) {
    return err(idV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  try {
    const pkg = await getPackage(pid, idV.value!);
    if (!pkg) {
      return err('Package not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
    }

    // Only a held package is "waiting" — don't text a guest about a parcel
    // they've already collected (the UI hides the button, but guard the API).
    if (pkg.status !== 'held') {
      return err('Package already picked up', {
        requestId,
        status: 409,
        code: ApiErrorCode.ValidationFailed,
      });
    }

    if (!pkg.guestPhone) {
      return err('No guest phone on file for this package', {
        requestId,
        status: 400,
        code: ApiErrorCode.ValidationFailed,
      });
    }
    // SMS needs a real phone — an email-shaped contact can't be texted.
    const ph = validatePhone(pkg.guestPhone, 'guestPhone');
    if (ph.error || !ph.value || pkg.guestPhone.includes('@')) {
      return err('Guest contact is not a textable phone number', {
        requestId,
        status: 400,
        code: ApiErrorCode.ValidationFailed,
      });
    }
    const toPhone = ph.value;

    const propertyName = await getPropertyName(pid);

    // ALWAYS frame the SMS as a hotel package notice (server template). An
    // optional custom note is APPENDED (sanitized + capped at 200), never
    // replaces the body — so this can't be turned into an arbitrary-content
    // texter. Guest name is the hotel's own data, sanitized below.
    const hi = pkg.guestName ? `Hi ${pkg.guestName},` : 'Hello,';
    const carrierPart = pkg.carrier ? ` (${pkg.carrier})` : '';
    let smsBody =
      `${hi} this is ${propertyName}. A package${carrierPart} arrived for you and is being held ` +
      `at the front desk. Stop by anytime to pick it up.`;
    if (body.message) {
      const m = validateString(body.message, { max: 200, label: 'message' });
      if (m.error) {
        return err(m.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      }
      const note = sanitizeForSms(m.value!);
      if (note) smsBody += ` Note: ${note}`;
    }
    smsBody = sanitizeForSms(smsBody).slice(0, 480);

    // Per-day idempotency: a double-click within the same UTC day dedupes; a
    // genuine follow-up the next day sends again.
    const dayBucket = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
    const idempotencyKey = `package-notify:${pkg.id}:${dayBucket}`;

    const job = await enqueueSms({
      propertyId: pid,
      toPhone,
      body: smsBody,
      idempotencyKey,
      metadata: { kind: 'package_notify', packageId: pkg.id },
    });

    await markGuestNotified(pid, pkg.id);

    return ok({ queued: true, jobId: job.id }, { requestId });
  } catch (e) {
    log.error('packages notify-guest failed', { requestId, pid, err: errToString(e) });
    return err('Internal server error', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  }
}
