// AI feature #4 — NEVER-MISS NUDGES (SMS side).
//
// Run on a schedule (cron). For each property:
//   * remind on-shift maintenance staff by SMS what's still due today
//     (mid-morning + mid-afternoon, deduped per day-slot), and
//   * escalate to the GM/owner by SMS when a PM check is overdue (deduped
//     per day).
//
// The in-app GM nudges (agent_nudges) are generated separately by the existing
// 5-min nudge cron via checkComplianceAlerts() in src/lib/agent/nudges.ts.

import { supabaseAdmin } from '@/lib/supabase-admin';
import { enqueueSms } from '@/lib/sms-jobs';
import { sanitizeForSms } from '@/lib/api-validate';
import { APP_TIMEZONE } from '@/lib/utils';
import { log } from '@/lib/log';
import { getOverview } from './store';
import { smsMaintenance, toE164 } from './autoact';
import { getNudgeRecipients } from '@/lib/agent/nudges';

const REMIND_HOURS = [10, 14]; // local hours to nudge the engineer
const ESCALATE_HOURS = [16];   // local hour to escalate overdue to the GM

function localParts(now: Date, tz: string): { hour: number; date: string } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => fmt.find((p) => p.type === t)?.value ?? '';
  const h = Number(get('hour'));
  return { hour: h === 24 ? 0 : h, date: `${get('year')}-${get('month')}-${get('day')}` };
}

export interface ReminderResult {
  propertyId: string;
  remindersSent: number;
  escalationsSent: number;
}

export async function runComplianceRemindersForProperty(
  pid: string,
  now: Date = new Date(),
  tz: string = APP_TIMEZONE,
): Promise<ReminderResult> {
  const result: ReminderResult = { propertyId: pid, remindersSent: 0, escalationsSent: 0 };
  const { hour, date } = localParts(now, tz);

  const overview = await getOverview(pid, now);
  // Nothing configured → nothing to remind about.
  if (overview.readingsTotal === 0 && overview.pmTotal === 0) return result;

  const dueReadings = overview.readings.filter((r) => !r.doneThisPeriod);
  const duePm = overview.pmTasks.filter((p) => !p.doneThisPeriod);
  const overduePm = overview.pmTasks.filter((p) => p.overdue);

  // ── 1. Engineer reminder (mid-morning + mid-afternoon) ──────────────────
  if (REMIND_HOURS.includes(hour) && (dueReadings.length > 0 || duePm.length > 0)) {
    const slot = hour < 12 ? 'am' : 'pm';
    const parts: string[] = [];
    if (dueReadings.length) parts.push(`${dueReadings.length} reading${dueReadings.length === 1 ? '' : 's'}`);
    if (duePm.length) parts.push(`${duePm.length} equipment check${duePm.length === 1 ? '' : 's'}`);
    const body = `Reminder: ${parts.join(' and ')} still due today. Open your Staxis compliance list to log them.`;
    const sent = await smsMaintenance(pid, body, `remind:${date}:${slot}`);
    result.remindersSent += sent;
  }

  // ── 2. GM/owner escalation when something is OVERDUE ─────────────────────
  if (ESCALATE_HOURS.includes(hour) && overduePm.length > 0) {
    const recipients = await getNudgeRecipients(pid); // owner/GM account ids
    if (recipients.length > 0) {
      const { data: prop } = await supabaseAdmin.from('properties').select('name').eq('id', pid).maybeSingle();
      const hotelName = (prop?.name as string) || 'your hotel';
      const { data: accts } = await supabaseAdmin
        .from('accounts')
        .select('id, phone')
        .in('id', recipients);
      const names = overduePm.slice(0, 3).map((p) => p.task.name).join(', ');
      const body = sanitizeForSms(
        `⚠️ Compliance overdue at ${hotelName}: ${overduePm.length} life-safety check${overduePm.length === 1 ? '' : 's'} past due (${names}). Please follow up with maintenance.`,
      ).slice(0, 320);
      for (const a of accts ?? []) {
        const phone = typeof a.phone === 'string' ? toE164(a.phone) : null;
        if (!phone) continue;
        try {
          await enqueueSms({
            propertyId: pid,
            toPhone: phone,
            body,
            idempotencyKey: `compliance-escalate:${pid}:${date}:${a.id}`,
            metadata: { kind: 'compliance-escalation', accountId: a.id },
          });
          result.escalationsSent += 1;
        } catch (e) {
          log.error('[compliance/reminders] escalation enqueue failed', { pid, accountId: a.id, err: e instanceof Error ? e : new Error(String(e)) });
        }
      }
    }
  }

  return result;
}
