'use client';

/**
 * F8 — Stale-data banner.
 *
 * Mounted explicitly on /dashboard and /staff (NOT in AppLayout) so it
 * never bleeds onto /housekeeping, /maintenance, /inventory, or any other
 * authenticated page that doesn't depend on the Choice Advantage scraper.
 *
 * Thresholds match the v2 master plan:
 *   ≥ 90 min → yellow ("numbers may be old")
 *   ≥ 4 h   → red    ("don't act on these")
 *   watchdog degraded → small chip (operator visibility into SMS path)
 *
 * Polls /api/scraper-status every 60s while mounted. Cleans up on unmount.
 * If the API errors out the banner stays hidden — we'd rather under-alarm
 * than show a false "stale" warning that the customer can't act on.
 */

import { useEffect, useState } from 'react';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import { fetchWithAuth } from '@/lib/api-fetch';

const POLL_MS = 60_000;
const YELLOW_MIN = 90;
const RED_MIN = 240; // 4h

interface ScraperStatus {
  dashboard: { pulled_at: string | null; age_minutes: number | null; error_code: string | null };
  plan:      { pulled_at: string | null; age_minutes: number | null };
  watchdog:  { degraded: boolean; degraded_reason: string | null };
}

interface Envelope {
  ok: boolean;
  data?: ScraperStatus;
}

function formatAge(minutes: number, lang: 'en' | 'es'): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 60 * 24) {
    const h = Math.round(minutes / 60);
    return lang === 'es' ? `${h} h` : `${h}h`;
  }
  const d = Math.round(minutes / 60 / 24);
  return lang === 'es' ? `${d} d` : `${d}d`;
}

export default function StaleDataBanner() {
  const { activePropertyId } = useProperty();
  const { lang } = useLang();
  const [status, setStatus] = useState<ScraperStatus | null>(null);

  useEffect(() => {
    if (!activePropertyId) return;
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetchWithAuth(
          `/api/scraper-status?pid=${encodeURIComponent(activePropertyId!)}`,
          { cache: 'no-store' },
        );
        if (!res.ok) {
          // Auth failure, rate-limit, 5xx — keep last good (or null) state.
          // Under-alarm > over-alarm: a false stale banner is worse than
          // a silent banner during a transient blip.
          return;
        }
        const body = (await res.json()) as Envelope;
        if (cancelled) return;
        if (body.ok && body.data) setStatus(body.data);
      } catch {
        // Network blip — same logic, keep last good state.
      }
    }

    void poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [activePropertyId]);

  if (!status) return null;

  const dashAge = status.dashboard.age_minutes;
  const planAge = status.plan.age_minutes;
  const worstAge = Math.max(dashAge ?? -1, planAge ?? -1);
  const showStale = worstAge >= YELLOW_MIN;
  const isRed = worstAge >= RED_MIN;
  const showDegraded = status.watchdog.degraded;

  if (!showStale && !showDegraded) return null;

  const ageLabel = worstAge > 0 ? formatAge(worstAge, lang) : '';
  const staleMessage = (isRed ? t('staleDataRed', lang) : t('staleDataYellow', lang))
    .replace('{{age}}', ageLabel);
  const degradedMessage = t('staleAlertingDegraded', lang);

  return (
    <div
      data-testid="stale-data-banner"
      role="status"
      aria-live="polite"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '10px 14px',
        margin: '0 0 12px',
        borderRadius: 8,
        // Snow tokens — globals.css defines --red, --red-dim, --yellow, --yellow-dim.
        background: isRed ? 'var(--red-dim)' : 'var(--yellow-dim)',
        color: isRed ? 'var(--red)' : 'var(--yellow)',
        border: `1px solid ${isRed ? 'var(--red)' : 'var(--yellow)'}`,
        fontSize: 14,
        lineHeight: 1.4,
      }}
    >
      {showStale && <div>{staleMessage}</div>}
      {showDegraded && (
        <div style={{ fontSize: 12, opacity: 0.85 }}>{degradedMessage}</div>
      )}
    </div>
  );
}
