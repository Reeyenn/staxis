/**
 * Map a `property_sessions.status` to the legacy job-shaped fields in the
 * active property list response. The property list still exposes
 * `{status, step, progressPct}` for existing hotel-directory consumers.
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
      return { status: 'complete', step: 'Connected. Polling every ~30s.', progressPct: 100 };
    case 'paused_mfa':
      return { status: 'mapping', step: 'Waiting for MFA. Click to resolve.', progressPct: 70 };
    case 'paused_no_knowledge_file':
      return { status: 'mapping', step: 'Awaiting mapper. PMS not learned yet.', progressPct: 50 };
    case 'paused_cost_cap':
      return { status: 'running', step: 'Cost cap tripped. Auto-resumes at midnight.', progressPct: 90 };
    case 'paused_circuit_breaker':
      return { status: 'failed', step: 'Repeated read failures. Paused for triage.', progressPct: null };
    case 'failed_restart':
      return { status: 'failed', step: 'Login failing. Verify credentials.', progressPct: null };
    case 'stopped':
      return { status: 'cancelled', step: 'Stopped by admin.', progressPct: null };
    default:
      return { status: 'running', step: `Status: ${sessionStatus}`, progressPct: null };
  }
}
