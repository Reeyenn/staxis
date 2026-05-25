/**
 * Barrel re-exports for the housekeeping report engine.
 *
 *   buildDailyReport      — pull data + compute the daily payload
 *   buildWeeklyReport     — same, weekly window
 *   resolveRecipients     — figure out who gets the email for a property
 *   sendDailyReportEmail  — render + send a single recipient's daily report
 *   sendWeeklyReportEmail — same, weekly
 *
 * Aggregator + anomaly + insight helpers stay un-exported here so the
 * cron route only sees the high-level surface.
 */

export { buildDailyReport } from './daily-report';
export { buildWeeklyReport, mondayBeforeSunday } from './weekly-report';
export { resolveRecipients } from './recipients';
export {
  renderDailyReport,
  renderWeeklyReport,
  sendDailyReportEmail,
  sendWeeklyReportEmail,
} from './email-template';
export type {
  DailyReportPayload,
  WeeklyReportPayload,
  Anomaly,
  RecipientOutcome,
} from './types';
