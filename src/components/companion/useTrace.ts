'use client';

// ═══════════════════════════════════════════════════════════════════════════
// Asking the server what it can see on this screen.
//
// One read per screen. Not a poll: a trace is about a pattern in months of a
// hotel's own records, and that does not change while somebody reads a card.
// It re-asks when the person walks to another screen, which is the only event
// that can change the answer.
//
// It fails silent, always. A companion with nothing to show is the correct
// degraded state; a page that breaks because the greeter could not think of
// anything is not.
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect, useRef, useState } from 'react';
import { fetchWithAuth, SessionEndedError } from '@/lib/api-fetch';
import { readEnvelope } from '@/lib/api-envelope';
import { TRACE_MIN_VIEWPORT_WIDTH } from '@/lib/companion/trace';
import type { TracePage, TracePattern } from '@/lib/companion/trace/types';

export interface TraceLoad {
  patterns: readonly TracePattern[];
  /** True once a request for the CURRENT screen has come back, either way. */
  settled: boolean;
}

const EMPTY: TraceLoad = { patterns: [], settled: false };

/**
 * Is this window wide enough for a trace to mean anything?
 *
 * The overlay is a geometric argument about a page's own empty space, and a
 * phone has none. The companion itself is already hidden below 760px, so a
 * trace there would be an overlay with no companion attached to it. Checked
 * before the fetch rather than after, so a phone never pays for detection.
 */
function wideEnough(): boolean {
  if (typeof window === 'undefined') return false;
  return window.innerWidth >= TRACE_MIN_VIEWPORT_WIDTH;
}

export function useTrace(
  propertyId: string | null | undefined,
  page: TracePage | null,
  enabled: boolean,
): TraceLoad {
  const [load, setLoad] = useState<TraceLoad>(EMPTY);
  // Keyed on hotel AND screen, the same way every other panel in this app is
  // keyed, so walking back to a screen re-reads it and a hotel switch can never
  // leave one hotel's patterns drawn over another's board.
  const scope = `${propertyId ?? 'none'}:${page ?? 'none'}`;
  const loadedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !propertyId || !page || !wideEnough()) {
      loadedRef.current = null;
      setLoad(EMPTY);
      return;
    }
    if (loadedRef.current === scope) return;
    loadedRef.current = scope;
    setLoad(EMPTY);

    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithAuth(
          `/api/companion/trace?pid=${encodeURIComponent(propertyId)}&page=${encodeURIComponent(page)}`,
        );
        const envelope = await readEnvelope<{ patterns: TracePattern[] }>(res);
        if (cancelled) return;
        const patterns = envelope.error === undefined && envelope.data ? envelope.data.patterns : [];
        setLoad({ patterns: Array.isArray(patterns) ? patterns : [], settled: true });
      } catch (e) {
        if (cancelled) return;
        // A signed-out mid-request is already redirecting. Anything else means
        // there is nothing to show on this screen, which is a real answer.
        if (!(e instanceof SessionEndedError)) setLoad({ patterns: [], settled: true });
      }
    })();
    return () => { cancelled = true; };
  }, [enabled, propertyId, page, scope]);

  return load;
}
