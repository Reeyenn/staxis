/**
 * Backward-compatible view of active schedules shown by Mission Control.
 *
 * New operational metadata belongs in the observational job catalog. This
 * projection deliberately excludes staged, manual-only, retired, and
 * heartbeat-unmonitored jobs so existing Mission Control behavior
 * cannot change merely because an inactive job is documented.
 */

import { ACTIVE_MISSION_JOBS } from '@/lib/automation/job-catalog';

export type ScheduleSource =
  | { kind: 'github'; workflowFile: string }
  | { kind: 'vercel'; cronPath: string };

export interface ScheduleEntry {
  heartbeatName: string;
  source: ScheduleSource;
  cronExpr: string;
}

export const SCHEDULE_REGISTRY: ReadonlyArray<ScheduleEntry> = ACTIVE_MISSION_JOBS.map((job) => {
  if (job.source.kind === 'vercel') {
    if (job.target.kind !== 'route') {
      throw new Error(`Vercel job "${job.id}" must target a route`);
    }
    return {
      heartbeatName: job.heartbeat.name,
      source: { kind: 'vercel', cronPath: job.target.path },
      cronExpr: job.schedule,
    };
  }

  if (job.source.kind === 'github') {
    return {
      heartbeatName: job.heartbeat.name,
      source: { kind: 'github', workflowFile: job.source.workflowFile },
      cronExpr: job.schedule,
    };
  }

  throw new Error(`Active Mission Control job "${job.id}" has no scheduler source`);
});
