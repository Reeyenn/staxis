/**
 * Map a `property_sessions.status` to the legacy "onboarding job" shape
 * the admin Onboarding tab + owner wizard UIs already consume.
 *
 * Plan v4 collapsed onboarding into a one-row-per-hotel `property_sessions`
 * table, but three independent UI surfaces (admin Onboarding tab funnel,
 * owner wizard /onboard, /settings/pms) still poll legacy
 * `/api/admin/onboarding-jobs`, `/api/pms/job-status`, and
 * `/api/admin/list-properties` for a job-shaped response with
 * `{status, step, progressPct}` fields. Before this helper existed, each
 * of those routes hand-rolled the same status→shape projection and they
 * drifted.
 *
 * One source of truth. If you tweak a label here it shows up everywhere.
 */

export type LegacyJobStatus =
  | 'queued'
  | 'running'
  | 'mapping'
  | 'extracting'
  | 'complete'
  | 'failed'
  | 'cancelled';

export interface MappedSessionJobShape {
  /** Legacy job status (drives stage in the funnel + UI styling). */
  status: LegacyJobStatus;
  /** Human-readable line shown in the UI. */
  step: string;
  /** 0-100 (null = indeterminate). */
  progressPct: number | null;
}

/** Statuses that count as "in flight" — non-terminal, surface in the
 *  Onboarding tab's live-status column + funnel "Needs help" stage. */
export const IN_FLIGHT_LEGACY_STATUSES = new Set<LegacyJobStatus>([
  'queued',
  'running',
  'mapping',
  'extracting',
]);

/**
 * Project a property_sessions.status to the legacy job shape.
 * Unknown / future statuses fall through to `running` with the raw
 * status as the step text so an admin can see something's off.
 */
export function mapPropertySessionStatusToJobShape(
  sessionStatus: string,
): MappedSessionJobShape {
  switch (sessionStatus) {
    case 'starting':
      return { status: 'running', step: 'Logging into PMS…', progressPct: 30 };
    case 'alive':
      return { status: 'complete', step: 'Connected — polling every ~30s.', progressPct: 100 };
    case 'paused_mfa':
      return { status: 'mapping', step: 'Waiting for MFA — click to resolve.', progressPct: 70 };
    case 'paused_no_knowledge_file':
      return { status: 'mapping', step: 'Awaiting mapper — PMS not learned yet.', progressPct: 50 };
    case 'paused_cost_cap':
      return { status: 'running', step: 'Cost cap tripped — auto-resumes at midnight.', progressPct: 90 };
    case 'paused_circuit_breaker':
      return { status: 'failed', step: 'Repeated read failures — paused for triage.', progressPct: null };
    case 'failed_restart':
      return { status: 'failed', step: 'Login failing — verify credentials.', progressPct: null };
    case 'stopped':
      return { status: 'cancelled', step: 'Stopped by admin.', progressPct: null };
    default:
      return { status: 'running', step: `Status: ${sessionStatus}`, progressPct: null };
  }
}
