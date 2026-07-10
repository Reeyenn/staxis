'use client';

// ─── usePmsOnboardJob — the Save & Onboard polling state machine ────────────
//
// Faithful extraction of the jobId/jobStatus/pollState machine that lived
// inline in settings/pms/page.tsx. It polls /api/pms/job-status every 3s
// while an onboarding job is in flight and encodes real incident behavior —
// DO NOT "simplify" the states without reading the audit notes below:
//
//   - Stalled-state tracking (audit Flow 2 #4 + #11). The pre-fix polling
//     loop had no concept of "we've been at the same progress for ages" —
//     a dead Fly worker meant the user stared at the spinner indefinitely
//     with no signal. We track the last time progressPct changed; after
//     STALLED_WARN_MS render a banner ('stalled-warn'); after
//     STALLED_STOP_MS bail entirely ('stopped-stalled') and log to Sentry.
//   - Network failures during polling are tracked separately
//     (pollNetworkFailures) so the page can surface an offline banner
//     without conflating it with "worker is down".
//   - Runtime parser (audit Flow 2 #5): responses go through
//     parsePmsJobStatusResponse so a server-side field rename can't freeze
//     the progress bar at 0 permanently; on parse failure we keep polling
//     but log.

import { useEffect, useRef, useState } from 'react';
import * as Sentry from '@sentry/nextjs';
import { fetchWithAuth } from '@/lib/api-fetch';
import { parsePmsJobStatusResponse } from '@/lib/api-validate';

export interface PmsJobStatus {
  status: 'queued' | 'running' | 'mapping' | 'extracting' | 'complete' | 'failed';
  step: string | null;
  progressPct: number;
  error: string | null;
  result: Record<string, unknown> | null;
}

export type PmsPollState = 'polling' | 'stalled-warn' | 'stopped-stalled' | 'stopped-offline';

const STALLED_WARN_MS = 5 * 60 * 1000;   // 5 min — banner
const STALLED_STOP_MS = 15 * 60 * 1000;  // 15 min — stop + Sentry

export interface UsePmsOnboardJobResult {
  jobStatus: PmsJobStatus | null;
  pollState: PmsPollState;
  pollNetworkFailures: number;
  userStopped: boolean;
  /** Kick off polling for a freshly queued job (the page supplies the
   *  bilingual "Waiting for a worker…" initial status). */
  start: (jobId: string, initialStatus: PmsJobStatus) => void;
  /** The stalled-banner "Stop" button. */
  stop: () => void;
}

export function usePmsOnboardJob({
  propertyId,
  onFinished,
}: {
  /** For Sentry context on the stalled report only. */
  propertyId: string | null;
  /**
   * Runs when the job reaches 'complete' or 'failed' (page flips its Save
   * button out of "Onboarding…" and refreshes the property header). Lives in
   * the polling effect's dependency array — exactly where the original kept
   * refreshProperty — so pass a useCallback keyed on refreshProperty.
   */
  onFinished: () => void | Promise<void>;
}): UsePmsOnboardJobResult {
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<PmsJobStatus | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastProgressChangeRef = useRef<number>(0);
  const lastProgressPctRef = useRef<number>(-1);
  const [pollState, setPollState] = useState<PmsPollState>('polling');
  const [pollNetworkFailures, setPollNetworkFailures] = useState(0);
  const [userStopped, setUserStopped] = useState(false);

  // ─── Job polling ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    // Reset stalled-state tracking on a new job.
    lastProgressChangeRef.current = Date.now();
    lastProgressPctRef.current = -1;
    setPollState('polling');
    setPollNetworkFailures(0);
    setUserStopped(false);

    const poll = async () => {
      if (cancelled || userStopped) return;
      let madeNetworkProgress = false;
      try {
        const res = await fetchWithAuth(`/api/pms/job-status?id=${jobId}`);
        const raw = await res.json();
        madeNetworkProgress = true;
        if (cancelled) return;
        if (res.ok) {
          const parsed = parsePmsJobStatusResponse(raw);
          if (parsed.value) {
            // Stalled-state tracking — when progressPct advances, reset
            // the clock; otherwise let it tick toward the warn / stop
            // thresholds.
            if (parsed.value.progressPct !== lastProgressPctRef.current) {
              lastProgressPctRef.current = parsed.value.progressPct;
              lastProgressChangeRef.current = Date.now();
              setPollState('polling');
            }
            setJobStatus(parsed.value);
            if (parsed.value.status === 'complete' || parsed.value.status === 'failed') {
              await onFinished();
              return; // stop polling
            }
          } else {
            console.warn('pms job-status response shape unexpected:', parsed.error);
          }
        }
      } catch {
        // Transient error — keep polling, but track the failure count.
        if (!cancelled) {
          setPollNetworkFailures(n => n + 1);
        }
      }
      if (cancelled) return;

      // Reset failure counter on a successful network call.
      if (madeNetworkProgress) {
        setPollNetworkFailures(0);
      }

      // Stalled-state escalation. Only check while job is in flight (not
      // terminal). The thresholds are wall-clock since the last
      // progressPct change, not since the job started — a job that
      // legitimately progresses slowly (long extraction phase) won't
      // trip the warn as long as the percent ticks at least once every
      // 5 min.
      const stalledMs = Date.now() - lastProgressChangeRef.current;
      if (stalledMs > STALLED_STOP_MS) {
        // Stop polling and report. The job may still complete on the
        // server side — manual refresh recovers — but we won't keep
        // hammering the API forever.
        setPollState('stopped-stalled');
        Sentry.captureMessage('pms-onboard stalled — stopping client poll', {
          level: 'error',
          tags: { surface: 'settings/pms', reason: 'onboard-stalled' },
          extra: {
            jobId,
            propertyId,
            lastProgressPct: lastProgressPctRef.current,
            stalledSec: Math.round(stalledMs / 1000),
          },
        });
        return;
      }
      if (stalledMs > STALLED_WARN_MS) {
        setPollState('stalled-warn');
      }
      pollTimerRef.current = setTimeout(poll, 3000);
    };

    void poll();
    return () => {
      cancelled = true;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
    // STALLED_WARN_MS / STALLED_STOP_MS are module-level constants;
    // propertyId is Sentry context only (same exclusions as the original).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, onFinished, userStopped]);

  return {
    jobStatus,
    pollState,
    pollNetworkFailures,
    userStopped,
    start: (id, initialStatus) => {
      setJobId(id);
      setJobStatus(initialStatus);
      // Polling kicks in via the useEffect above.
    },
    stop: () => setUserStopped(true),
  };
}
