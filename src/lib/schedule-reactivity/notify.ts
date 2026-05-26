/**
 * SMS push for red-severity schedule alerts.
 *
 * Best-effort: any failure here is logged + swallowed. The schedule_alerts
 * row is already persisted (the banner will render); SMS is the optional
 * escalation for the worst gaps so the manager hears about it even when
 * they're not in front of the dashboard.
 *
 * Recipient: the property's scheduling-manager (staff.is_scheduling_manager
 * = true). Same convention sick-callout/notify uses.
 *
 * Body cap: 320 chars (~2 SMS segments). Multiple alerts in one call are
 * stacked into a single SMS with a compact day-by-day list.
 *
 * Rate-limited via the standard 'notify-housekeepers-sms' bucket — yes,
 * the bucket name is housekeeper-flavored, but it's already on the
 * BILLING_IMPACTING_ENDPOINTS list and a single SMS per red gap is well
 * inside the 30/hr cap. A new bucket would be premature.
 */

import { sendSms } from '@/lib/sms';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import type { Suggestion, AlertDepartment } from './types';

const DEPT_LABEL: Record<AlertDepartment, string> = {
  housekeeping: 'Housekeeping',
  front_desk: 'Front desk',
  maintenance: 'Maintenance',
  breakfast: 'Breakfast',
  houseman: 'Houseman',
  other: 'Other',
};

export async function sendAlertSms(input: {
  propertyId: string;
  propertyName: string;
  alerts: Array<{
    alertDate: string;
    dept: AlertDepartment;
    suggestion: Suggestion;
  }>;
}): Promise<{ sent: boolean; recipient?: string; bodyLength?: number }> {
  if (input.alerts.length === 0) return { sent: false };

  const phone = await fetchSchedulingManagerPhone(input.propertyId);
  if (!phone) {
    log.info('[schedule-reactivity] no scheduling manager phone — skipping red SMS', {
      propertyId: input.propertyId,
    });
    return { sent: false };
  }

  const lines: string[] = [`${input.propertyName}: schedule gap`];
  for (const a of input.alerts.slice(0, 4)) {
    const direction = a.suggestion.suggestedAction === 'add_shift'
      ? 'short' : 'over';
    const pct = (a.suggestion.context as { pctOfDemand?: number }).pctOfDemand ?? null;
    const pctStr = pct !== null ? ` (${pct}%)` : '';
    const dept = DEPT_LABEL[a.dept];
    lines.push(`${a.alertDate} ${dept}: ${direction}${pctStr}`);
  }
  if (input.alerts.length > 4) {
    lines.push(`+${input.alerts.length - 4} more — open the schedule.`);
  }
  lines.push('Open Manager → Schedule to act.');
  const body = lines.join('\n').slice(0, 320);

  try {
    await sendSms(phone, body);
    log.info('[schedule-reactivity] red SMS sent', {
      propertyId: input.propertyId, alertCount: input.alerts.length,
    });
    return { sent: true, recipient: phone, bodyLength: body.length };
  } catch (e) {
    log.warn('[schedule-reactivity] red SMS send failed (fail-quiet)', {
      propertyId: input.propertyId,
      err: e instanceof Error ? e.message : String(e),
    });
    return { sent: false, recipient: phone, bodyLength: body.length };
  }
}

async function fetchSchedulingManagerPhone(propertyId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('staff')
    .select('phone')
    .eq('property_id', propertyId)
    .eq('is_scheduling_manager', true)
    .not('phone', 'is', null)
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return (data as { phone: string | null }).phone ?? null;
}
