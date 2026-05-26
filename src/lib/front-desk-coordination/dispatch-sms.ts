/**
 * SMS dispatch with mandatory audit + dry-run-by-default safety.
 *
 *   Mode read from `properties.sms_notifications_mode` per call.
 *     'dry_run' (default) — write notification_events row, DO NOT call Twilio.
 *     'live'              — write notification_events row AND call Twilio.
 *
 * Why the audit always happens (in both modes):
 *   - In dry_run the audit row IS the side-effect. The /front-desk
 *     "Notification log" panel renders these rows so the operator can
 *     see what would have gone out.
 *   - In live mode the audit row is the receipt — provider_id +
 *     provider_status + error_text for forensics, fully decoupled from
 *     the Twilio API's own logging.
 *
 * Threat model:
 *   - A malicious code path can't bypass the audit and silently fire
 *     Twilio: the audit happens BEFORE the Twilio call, and the Twilio
 *     call only fires inside the `mode === 'live'` branch which is
 *     gated by the per-property column.
 *   - If `properties.sms_notifications_mode` is missing/invalid (which
 *     the migration's CHECK constraint would already reject at write
 *     time), the helper defaults to 'dry_run' — fail-safe. Never assume
 *     'live' just because the column is unreadable.
 *   - "No recipients" is still audited as a single bookkeeping row
 *     (recipient_staff_id=null, mode reflected) so the panel can
 *     surface "we wanted to ping but no one was on shift". This is the
 *     pattern from prior incidents where a silent no-op masked a real
 *     scheduling gap.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import { sendSms } from '@/lib/sms';
import { isSmsConfigured } from '@/lib/env';
import type {
  DispatchEventType,
  DispatchMode,
  DispatchOutcome,
  DispatchRecipient,
} from './types';

export interface DispatchSMSInput {
  propertyId: string;
  eventType: DispatchEventType;
  body: string;
  payload: Record<string, unknown>;
  recipients: DispatchRecipient[];
}

export interface DispatchSMSResult {
  mode: DispatchMode;
  outcomes: DispatchOutcome[];
}

/**
 * Look up the property's notification mode. Always returns a concrete
 * value — defaults to 'dry_run' on any read failure (column missing,
 * row gone, RLS denial, etc.) so a misconfigured deployment cannot
 * accidentally send real texts.
 *
 * Exported for unit tests; do NOT import from API routes — go through
 * dispatchSMS().
 */
export async function resolveSmsNotificationMode(
  propertyId: string,
): Promise<DispatchMode> {
  try {
    const { data, error } = await supabaseAdmin
      .from('properties')
      .select('sms_notifications_mode')
      .eq('id', propertyId)
      .maybeSingle();

    if (error) {
      log.warn('[dispatch-sms] properties.sms_notifications_mode read failed — defaulting to dry_run', {
        propertyId, err: error.message,
      });
      return 'dry_run';
    }
    if (!data) {
      log.warn('[dispatch-sms] property not found — defaulting to dry_run', { propertyId });
      return 'dry_run';
    }
    const raw = (data as { sms_notifications_mode?: string }).sms_notifications_mode;
    if (raw === 'live') return 'live';
    return 'dry_run';
  } catch (err) {
    log.error('[dispatch-sms] mode resolution threw — defaulting to dry_run', {
      propertyId, err: err instanceof Error ? err.message : String(err),
    });
    return 'dry_run';
  }
}

interface InsertAuditArgs {
  propertyId: string;
  eventType: DispatchEventType;
  recipient: DispatchRecipient | null;
  body: string;
  payload: Record<string, unknown>;
  mode: DispatchMode;
}

/**
 * Write a single notification_events row. Returns the row id, or null
 * if the write failed (in which case we still proceed — the audit is
 * best-effort; never let logging break dispatch). Callers should
 * surface the null to the outcome.
 */
async function insertAudit(args: InsertAuditArgs): Promise<string | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from('notification_events')
      .insert({
        property_id: args.propertyId,
        event_type: args.eventType,
        recipient_staff_id: args.recipient?.staffId ?? null,
        recipient_phone: args.recipient?.phone ?? null,
        recipient_name: args.recipient?.name ?? null,
        body: args.body,
        payload: args.payload,
        mode: args.mode,
      })
      .select('id')
      .single();
    if (error) {
      log.error('[dispatch-sms] audit insert failed', {
        propertyId: args.propertyId,
        eventType: args.eventType,
        err: error.message,
      });
      return null;
    }
    return (data as { id: string }).id;
  } catch (err) {
    log.error('[dispatch-sms] audit insert threw', {
      propertyId: args.propertyId,
      eventType: args.eventType,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Update a notification_events row with Twilio's outcome. Best-effort
 * — a failed update doesn't change what we tell the caller.
 */
async function patchAudit(
  auditId: string,
  fields: { provider_id?: string | null; provider_status?: string | null; error_text?: string | null },
): Promise<void> {
  try {
    const { error } = await supabaseAdmin
      .from('notification_events')
      .update(fields)
      .eq('id', auditId);
    if (error) {
      log.warn('[dispatch-sms] audit patch failed', { auditId, err: error.message });
    }
  } catch (err) {
    log.warn('[dispatch-sms] audit patch threw', {
      auditId, err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Fan out a coordination event to N recipients. ALWAYS audits each
 * recipient (or a single placeholder row if there are none); ONLY in
 * 'live' mode does it call Twilio.
 *
 * Returns one outcome per recipient. Callers that want a fire-and-forget
 * "did we at least audit it" answer can simply ignore the return value.
 */
export async function dispatchSMS(input: DispatchSMSInput): Promise<DispatchSMSResult> {
  const mode = await resolveSmsNotificationMode(input.propertyId);

  // No-recipients case: still write ONE placeholder row so the
  // notification log surfaces "we wanted to ping <event_type> but no
  // one was on shift". Helps spot scheduling gaps.
  if (input.recipients.length === 0) {
    const auditId = await insertAudit({
      propertyId: input.propertyId,
      eventType: input.eventType,
      recipient: null,
      body: input.body,
      payload: { ...input.payload, no_recipients: true },
      mode,
    });
    return {
      mode,
      outcomes: [
        {
          auditId: auditId ?? '',
          mode,
          sent: false,
          recipientStaffId: null,
          recipientPhone: null,
          recipientName: null,
          providerId: null,
          errorText: auditId == null ? 'audit_insert_failed' : null,
        },
      ],
    };
  }

  const outcomes: DispatchOutcome[] = [];
  for (const recipient of input.recipients) {
    const auditId = await insertAudit({
      propertyId: input.propertyId,
      eventType: input.eventType,
      recipient,
      body: input.body,
      payload: input.payload,
      mode,
    });

    // dry_run never calls Twilio — even if a recipient lacks a phone,
    // the row still got written for the panel.
    if (mode === 'dry_run') {
      outcomes.push({
        auditId: auditId ?? '',
        mode,
        sent: false,
        recipientStaffId: recipient.staffId,
        recipientPhone: recipient.phone,
        recipientName: recipient.name,
        providerId: null,
        errorText: auditId == null ? 'audit_insert_failed' : null,
      });
      continue;
    }

    // live mode below.
    if (!recipient.phone) {
      const err = 'recipient_missing_phone';
      if (auditId) await patchAudit(auditId, { error_text: err, provider_status: 'skipped' });
      outcomes.push({
        auditId: auditId ?? '',
        mode,
        sent: false,
        recipientStaffId: recipient.staffId,
        recipientPhone: null,
        recipientName: recipient.name,
        providerId: null,
        errorText: err,
      });
      continue;
    }

    if (!isSmsConfigured()) {
      const err = 'twilio_not_configured';
      if (auditId) await patchAudit(auditId, { error_text: err, provider_status: 'skipped' });
      log.warn('[dispatch-sms] live mode requested but Twilio env missing — audited as skipped', {
        propertyId: input.propertyId,
        eventType: input.eventType,
      });
      outcomes.push({
        auditId: auditId ?? '',
        mode,
        sent: false,
        recipientStaffId: recipient.staffId,
        recipientPhone: recipient.phone,
        recipientName: recipient.name,
        providerId: null,
        errorText: err,
      });
      continue;
    }

    try {
      await sendSms(recipient.phone, input.body);
      if (auditId) await patchAudit(auditId, { provider_status: 'sent' });
      outcomes.push({
        auditId: auditId ?? '',
        mode,
        sent: true,
        recipientStaffId: recipient.staffId,
        recipientPhone: recipient.phone,
        recipientName: recipient.name,
        providerId: null,
        errorText: null,
      });
    } catch (sendErr) {
      const errText = sendErr instanceof Error ? sendErr.message : String(sendErr);
      if (auditId) await patchAudit(auditId, { provider_status: 'failed', error_text: errText });
      outcomes.push({
        auditId: auditId ?? '',
        mode,
        sent: false,
        recipientStaffId: recipient.staffId,
        recipientPhone: recipient.phone,
        recipientName: recipient.name,
        providerId: null,
        errorText: errText,
      });
    }
  }

  return { mode, outcomes };
}
