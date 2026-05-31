/**
 * POST /api/front-desk/lost-and-found/notify-guest
 *
 * Text the guest that we found their item ("…want it shipped?"). Resolves the
 * guest phone from the item (or, if the item is a found item matched to a lost
 * report, from that report), enqueues a Twilio SMS via the sms_jobs queue, and
 * records the outcome in shipping_info. Fail-closed rate limit + per-day
 * idempotency so a double-click doesn't double-text the guest.
 */

import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { validateUuid, validateString, validatePhone, sanitizeForSms } from '@/lib/api-validate';
import { enqueueSms } from '@/lib/sms-jobs';
import { gateFrontDeskWrite } from '@/lib/lost-and-found/api-gate';
import { getAppItem, updateAppItem } from '@/lib/lost-and-found/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

interface Body {
  pid?: string;
  id?: string;
  /** Optional custom SMS body. Falls back to a default template. */
  message?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  const gate = await gateFrontDeskWrite<Body>(req, 'lost-found-notify-guest');
  if (!gate.ok) return gate.response;
  const { body, pid, requestId } = gate;

  const idV = validateUuid(body.id, 'id');
  if (idV.error) {
    return err(idV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  try {
    const item = await getAppItem(pid, idV.value!);
    if (!item) {
      return err('Item not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
    }

    // Resolve the guest contact: prefer the item's own contact, else the
    // matched counterpart's (a found item matched to a guest's lost report).
    let contact = item.guestContact;
    let guestName = item.guestName;
    if (!contact && item.matchedItemId) {
      const counterpart = await getAppItem(pid, item.matchedItemId);
      if (counterpart) {
        contact = counterpart.guestContact;
        guestName = guestName ?? counterpart.guestName;
      }
    }
    if (!contact) {
      return err('No guest contact on file for this item', {
        requestId,
        status: 400,
        code: ApiErrorCode.ValidationFailed,
      });
    }
    // SMS needs a phone. An email contact can't be texted.
    const ph = validatePhone(contact, 'guestContact');
    if (ph.error || !ph.value || contact.includes('@')) {
      return err('Guest contact is not a textable phone number', {
        requestId,
        status: 400,
        code: ApiErrorCode.ValidationFailed,
      });
    }
    const toPhone = ph.value;

    // Property name for the message.
    const { data: prop } = await supabaseAdmin
      .from('properties')
      .select('name')
      .eq('id', pid)
      .maybeSingle();
    const propertyName = typeof prop?.name === 'string' && prop.name ? prop.name : 'the hotel';

    // Build the body. A custom message (sanitized) overrides the default.
    let smsBody: string;
    if (body.message) {
      const m = validateString(body.message, { max: 480, label: 'message' });
      if (m.error) {
        return err(m.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      }
      smsBody = sanitizeForSms(m.value!);
    } else {
      const hi = guestName ? `Hi ${guestName},` : 'Hello,';
      const desc = item.itemDescription ? ` (${item.itemDescription})` : '';
      smsBody = sanitizeForSms(
        `${hi} this is ${propertyName}. We believe we found an item that may be yours${desc}. ` +
          `Reply to this message to arrange pickup or shipping. Thank you!`,
      );
    }
    smsBody = smsBody.slice(0, 480);

    // Per-day idempotency: a double-click within the same UTC day dedupes; a
    // genuine follow-up next day sends again.
    const dayBucket = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
    const idempotencyKey = `lost-found-notify:${item.id}:${dayBucket}`;

    const job = await enqueueSms({
      propertyId: pid,
      toPhone,
      body: smsBody,
      idempotencyKey,
      metadata: { kind: 'lost_found_notify', itemId: item.id },
    });

    // Record the outcome on the item (merge into shipping_info).
    const shippingInfo = {
      ...(item.shippingInfo ?? {}),
      sms_job_id: job.id,
      sms_enqueued_at: new Date().toISOString(),
      sms_status: job.status,
    };
    await updateAppItem(pid, item.id, { shippingInfo });

    return ok({ queued: true, jobId: job.id }, { requestId });
  } catch (e) {
    log.error('lost-found notify-guest failed', { requestId, pid, err: errToString(e) });
    return err('Internal server error', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  }
}
