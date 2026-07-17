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
import { sanitizeForSms } from '@/lib/api-validate';
import { APP_TIMEZONE } from '@/lib/utils';
import { log } from '@/lib/log';
import { getOverview } from './store';
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

  // (Reminder + escalation SMS removed 2026-07 — all Twilio texting retired.
  // Due/overdue state stays visible on the compliance overview + dashboard.)

  return result;
}
