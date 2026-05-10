// ═══════════════════════════════════════════════════════════════════════════
// ML Cron Schedule helpers — single source of truth for "when does the AI
// next do its automatic check?"
//
// Schedules mirror .github/workflows/ml-cron.yml. Times are UTC; we format
// for display in America/Chicago (Reeyen's timezone). When DST changes the
// CT offset shifts; Intl.DateTimeFormat handles that automatically.
//
// Why hardcode here instead of parsing the yml: the yml is a deploy-time
// config. The cockpit needs the schedule at render time. Keeping a small
// in-code copy avoids a runtime fetch + parse and is easy to update when
// the schedule changes (cross-reference the workflow file in the comments).
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Schedule definitions matching ml-cron.yml.
 * Times are UTC. dayOfWeekUtc 0=Sunday … 6=Saturday.
 */
export const ML_CRON_SCHEDULES = {
  // Weekly trainings (Sunday)
  hkTrainDemand:    { hourUtc: 8,  minuteUtc: 0,  dayOfWeekUtc: 0 },  // Sun 03:00 CDT
  hkTrainSupply:    { hourUtc: 8,  minuteUtc: 30, dayOfWeekUtc: 0 },  // Sun 03:30 CDT
  invTrainInventory:{ hourUtc: 9,  minuteUtc: 0,  dayOfWeekUtc: 0 },  // Sun 04:00 CDT

  // Daily inference + aggregation
  hkRunInference:   { hourUtc: 10, minuteUtc: 30 },                    // Daily 05:30 CDT
  invPredictInventory: { hourUtc: 11, minuteUtc: 0 },                  // Daily 06:00 CDT
  invAggregatePriors: { hourUtc: 12, minuteUtc: 0 },                   // Daily 07:00 CDT
} as const;

interface CronTime {
  hourUtc: number;
  minuteUtc: number;
  dayOfWeekUtc?: number;     // 0=Sun..6=Sat. Undefined = daily.
}

/**
 * Compute the next firing time of a cron expression. Returns a Date in UTC.
 * For weekly crons: finds the next instance of the given (day, hour, minute).
 * For daily crons: today at the time if still in the future, otherwise tomorrow.
 */
export function nextCronFiring(spec: CronTime, now: Date = new Date()): Date {
  const next = new Date(now);
  next.setUTCHours(spec.hourUtc, spec.minuteUtc, 0, 0);
  if (spec.dayOfWeekUtc !== undefined) {
    const todayDow = next.getUTCDay();
    let daysUntil = (spec.dayOfWeekUtc - todayDow + 7) % 7;
    if (daysUntil === 0 && next <= now) daysUntil = 7;
    next.setUTCDate(next.getUTCDate() + daysUntil);
  } else {
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  }
  return next;
}

/**
 * Format a future Date as a friendly "Next: Sun 4 AM CT (in 6d 14h)".
 * Use America/Chicago timezone so it displays in Reeyen's local time
 * regardless of where the server runs.
 */
export function formatNextCron(next: Date, now: Date = new Date()): string {
  const ms = next.getTime() - now.getTime();
  const hours = Math.floor(ms / 3600000);
  const days = Math.floor(hours / 24);
  const remHours = hours - days * 24;
  const inText =
    days > 0 && remHours > 0 ? `in ${days}d ${remHours}h`
    : days > 0 ? `in ${days}d`
    : hours > 0 ? `in ${hours}h`
    : `in <1h`;
  const timeText = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(next);
  return `Next: ${timeText} (${inText})`;
}

/**
 * For the Housekeeping system-health panel.
 * Returns ISO strings so the data shape stays JSON-friendly through the API.
 */
export function getHKNextScheduled(now: Date = new Date()): { nextTrainingAt: string; nextPredictionAt: string } {
  return {
    nextTrainingAt: nextCronFiring(ML_CRON_SCHEDULES.hkTrainDemand, now).toISOString(),
    nextPredictionAt: nextCronFiring(ML_CRON_SCHEDULES.hkRunInference, now).toISOString(),
  };
}

/** For the Inventory system-health panel. */
export function getInventoryNextScheduled(now: Date = new Date()): { nextTrainingAt: string; nextPredictionAt: string } {
  return {
    nextTrainingAt: nextCronFiring(ML_CRON_SCHEDULES.invTrainInventory, now).toISOString(),
    nextPredictionAt: nextCronFiring(ML_CRON_SCHEDULES.invPredictInventory, now).toISOString(),
  };
}
