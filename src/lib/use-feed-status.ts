'use client';

/**
 * useFeedStatus — per-property PMS feed trust for SESSION surfaces
 * (feat/cua-partial-promotion).
 *
 * Fetches /api/pms/feed-status once per property and refreshes every 60s
 * (matches the CUA's knowledge hot-reload cadence — a recovered feed clears
 * its "still learning" state within ~2 minutes end-to-end).
 *
 * Containment rules:
 *  - Until the first response arrives → null. Consumers MUST treat null as
 *    "render as today" (no banners, no neutralization) — this layer only
 *    ever ADDS honesty, never blocks data.
 *  - On a transient refresh failure → HOLD the last-known-good value. A
 *    flapping network must not toggle surfaces between honest-partial and
 *    fake-zero renderings at the refresh cadence.
 *
 * Rooms-driven surfaces (RoomsTab / front-desk / housekeeper mobile) do NOT
 * need this hook — their feed status rides the rooms responses themselves.
 * This is for surfaces on other data paths: dashboard tiles, ScheduleTab.
 */

import { useEffect, useRef, useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';
import type { PropertyFeedStatus } from '@/lib/pms/feed-status';

const REFRESH_MS = 60_000;

export function useFeedStatus(pid: string | null | undefined): PropertyFeedStatus | null {
  const [status, setStatus] = useState<PropertyFeedStatus | null>(null);
  // Last-known-good per property, survives re-renders; keyed so a property
  // switch never shows the previous hotel's status.
  const lastGood = useRef<{ pid: string; value: PropertyFeedStatus } | null>(null);

  useEffect(() => {
    if (!pid) {
      setStatus(null);
      return;
    }
    let cancelled = false;

    const load = async () => {
      try {
        const res = await fetchWithAuth(
          `/api/pms/feed-status?pid=${encodeURIComponent(pid)}`,
          { method: 'GET', headers: { 'Content-Type': 'application/json' } },
        );
        if (!res.ok) throw new Error(`feed-status ${res.status}`);
        const json = (await res.json().catch(() => null)) as
          | { ok?: boolean; data?: PropertyFeedStatus }
          | null;
        const value = json?.ok ? json.data : undefined;
        if (!value || (value.mode !== 'no_pms' && value.mode !== 'onboarding' && value.mode !== 'live')) {
          throw new Error('feed-status unexpected body');
        }
        if (cancelled) return;
        lastGood.current = { pid, value };
        setStatus(value);
      } catch {
        // Hold last-known-good for THIS property; otherwise stay null
        // (= render as today). Never flap to a fake-zero rendering.
        if (cancelled) return;
        if (lastGood.current?.pid === pid) setStatus(lastGood.current.value);
      }
    };

    setStatus(lastGood.current?.pid === pid ? lastGood.current.value : null);
    void load();
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void load();
    }, REFRESH_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pid]);

  return status;
}
