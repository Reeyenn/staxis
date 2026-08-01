// ═══════════════════════════════════════════════════════════════════════════
// Complaints — count-only Dashboard read layer.
//
// Raw complaint rows carry guest PII and are server-only. This browser module
// polls the authoritative /api/complaints/summary projection; it never opens a
// PostgREST SELECT or realtime channel on the complaints table.
// ═══════════════════════════════════════════════════════════════════════════

import { fetchWithAuth } from '@/lib/api-fetch';
import { readEnvelope } from '@/lib/api-envelope';
import {
  isComplaintDashboardSummary,
  type ComplaintDashboardSummary,
} from '@/lib/complaints-summary';

const POLL_INTERVAL_MS = 30_000;
const TERMINAL_STATUSES = new Set([403, 404]);

class ComplaintSummaryFetchError extends Error {
  constructor(readonly status: number | undefined, message: string) {
    super(message);
    this.name = 'ComplaintSummaryFetchError';
  }
}

async function fetchComplaintSummary(pid: string): Promise<ComplaintDashboardSummary> {
  const response = await fetchWithAuth(
    `/api/complaints/summary?pid=${encodeURIComponent(pid)}`,
    { method: 'GET', headers: { 'Content-Type': 'application/json' } },
  );
  const result = await readEnvelope<unknown>(response, 'Could not load complaint summary');
  if (result.error) throw new ComplaintSummaryFetchError(result.status, result.error);
  if (!isComplaintDashboardSummary(result.data)) {
    throw new Error('/api/complaints/summary returned an invalid projection');
  }
  return result.data;
}

export function subscribeToComplaintSummary(
  _uid: string, pid: string,
  callback: (summaries: ComplaintDashboardSummary[]) => void,
  onError?: (error: unknown) => void,
): () => void {
  let cancelled = false;
  let terminal = false;
  let requestSequence = 0;

  const load = () => {
    if (cancelled || terminal) return;
    const request = ++requestSequence;
    fetchComplaintSummary(pid)
      .then((summary) => {
        if (cancelled || terminal || request !== requestSequence) return;
        callback([summary]);
      })
      .catch((error: unknown) => {
        if (cancelled || request !== requestSequence) return;
        if (error instanceof ComplaintSummaryFetchError
          && error.status !== undefined
          && TERMINAL_STATUSES.has(error.status)) {
          terminal = true;
        }
        onError?.(error);
      });
  };

  load();
  const interval = setInterval(() => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    load();
  }, POLL_INTERVAL_MS);
  const onVisibility = () => {
    if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;
    load();
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
  }

  return () => {
    cancelled = true;
    requestSequence += 1;
    clearInterval(interval);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility);
    }
  };
}
