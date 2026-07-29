'use client';

import React, { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import dynamic from 'next/dynamic';
import { ConcourseBar } from '@/components/concourse/ConcourseBar';
import { ActivityTracker } from './ActivityTracker';
import { FeedbackButton } from './FeedbackButton';
import { AiActivityButton } from '@/components/agent/AiActivityButton';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { useSyncContext } from '@/contexts/SyncContext';
import { t } from '@/lib/translations';
import { WifiOff } from 'lucide-react';
import { sectionForPath, isSectionEnabled } from '@/lib/sections/registry';
import { RouteErrorState, RouteLoadingState } from './RouteResourceState';
import {
  clearStaleChunkRecoveryIncident,
  staleChunkFailureSeenThisBoot,
  STALE_CHUNK_STABLE_BOOT_MS,
} from '@/lib/stale-chunk-recovery';
import { useNavigationReady } from '@/lib/hooks/use-reliable-navigation';
import { useOptionalHotelActingContext } from '@/contexts/HotelActingContext';

// The "Ask Staxis" command bar (~900 lines + react-markdown) sits on every
// authenticated page but starts collapsed and empty. Load it lazily so it stays
// out of each page's initial JS bundle; it pops in post-hydration with no layout
// shift (fixed-position pill). ssr:false — nothing to server-render at rest.
const AskStaxisBar = dynamic(
  () => import('@/components/agent/AskStaxisBar').then((m) => m.AskStaxisBar),
  { ssr: false, loading: () => null },
);

export function AppLayout({
  children,
  hideGlobalAsk = false,
}: {
  children: React.ReactNode;
  hideGlobalAsk?: boolean;
}) {
  useNavigationReady();
  const acting = useOptionalHotelActingContext();
  const { lang } = useLang();
  const { isOnline } = useSyncContext();
  const {
    activeProperty,
    capabilityOverridesStatus,
    capabilityOverridesError,
    propertiesError,
    refreshCapabilities,
    retryProperties,
  } = useProperty();

  /* ── Per-hotel section gate ──
     Block a page whose section this hotel has turned off — even via a direct
     or bookmarked link. FAIL-OPEN while the property is still loading
     (activeProperty null) so we never blank a page during load. No redirect:
     the Header stays mounted so the user can navigate to an enabled section,
     and redirecting would loop if Staxis (or every section) were off. */
  const pathname = usePathname();
  const currentSection = sectionForPath(pathname);
  const actingSectionEnabled = acting?.context?.source === 'portfolio' && currentSection
    ? acting.context.sectionAvailability[currentSection]
    : null;
  const sectionOff = Boolean(
    currentSection && (
      actingSectionEnabled === false
      || (actingSectionEnabled === null
        && activeProperty
        && !isSectionEnabled(activeProperty.enabledSections, currentSection))
    ),
  );

  /* ── Offline banner ──
     Just "you have no connection". There is no longer a queued-writes count
     or a post-reconnect "syncing" state: the manager Rooms board was the only
     surface that wrote while offline, and it was removed on 2026-07-24 when
     the PMS became the sole source of truth for room status. See SyncContext. */
  const showBanner = !isOnline;

  // AppLayout is imported by each authenticated page module, so reaching this
  // effect means the destination shell and its page chunk both rendered. Keep
  // the recovery guard through a short healthy dwell: a repeated stale-chunk
  // failure marks this boot and retains the guard, while a stable page clears
  // it so the same route can recover from a genuinely later deployment.
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      if (staleChunkFailureSeenThisBoot()) return;
      clearStaleChunkRecoveryIncident({
        getSessionStorage: () => window.sessionStorage,
        location: window.location,
        replaceHistoryUrl: (url) => window.history.replaceState(window.history.state, '', url),
      });
    }, STALE_CHUNK_STABLE_BOOT_MS);
    return () => window.clearTimeout(timeout);
  }, []);

  return (
    <div className="staxis-app-shell" style={{
      minHeight: '100vh', display: 'flex', flexDirection: 'column',
      // Concourse shell — the soft top-lit page wash every screen sits on.
      background: 'var(--staxis-app-background, radial-gradient(ellipse 1000px 500px at 50% 0%, #FFFFFF 0%, #F5F7F4 100%))',
    }}>
      <ConcourseBar />
      <ActivityTracker />

      {/* ── Status banner ── */}
      {showBanner && (
        <div style={{
          borderBottom: '1px solid var(--red-border, rgba(239,68,68,0.3))',
          background: 'var(--red-dim)',
          padding: '8px 16px',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
        }}>
          <WifiOff size={14} color="var(--red)" />
          <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--red)' }}>
            {t('offline', lang)}
          </span>
        </div>
      )}

      <main className="cx-swap" style={{
        flex: 1,
        width: '100%',
        maxWidth: '1920px',
        margin: '0 auto',
        // Flex column so full-bleed workspace pages (Communications) can
        // `flex: 1` to exactly fill the space under the floating bar instead
        // of hardcoding viewport math against the old 64px header.
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}>
        {/* Home navigation lives in the leftmost Concourse bar pill. */}
        {propertiesError ? (
          <RouteErrorState
            title={lang === 'es' ? 'No pudimos cargar tus hoteles' : 'We could not load your hotels'}
            message={lang === 'es'
              ? 'No se cambió ningún dato. Revisa tu conexión e inténtalo de nuevo.'
              : 'No data was changed. Check your connection and try again.'}
            retryLabel={lang === 'es' ? 'Reintentar' : 'Try again'}
            onRetry={retryProperties}
          />
        ) : activeProperty && capabilityOverridesStatus === 'error' ? (
          <RouteErrorState
            title={lang === 'es' ? 'No pudimos confirmar el acceso' : 'We could not confirm hotel access'}
            message={capabilityOverridesError ?? (lang === 'es'
              ? 'Revisa tu conexión e inténtalo de nuevo.'
              : 'Check your connection and try again.')}
            retryLabel={lang === 'es' ? 'Reintentar' : 'Try again'}
            onRetry={() => void refreshCapabilities()}
          />
        ) : activeProperty && capabilityOverridesStatus !== 'ready' ? (
          <RouteLoadingState
            title={lang === 'es' ? 'Comprobando el acceso al hotel…' : 'Checking hotel access…'}
            message={lang === 'es' ? 'Abriendo el espacio de trabajo actual.' : 'Opening the current hotel workspace.'}
          />
        ) : sectionOff ? (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            textAlign: 'center', gap: '10px',
            padding: 'clamp(48px, 12vh, 120px) 24px',
            minHeight: '50vh',
          }}>
            <div style={{
              fontFamily: 'var(--font-geist), -apple-system, BlinkMacSystemFont, sans-serif',
              fontSize: '18px', fontWeight: 600, color: 'var(--snow-ink, var(--fg))',
            }}>
              {lang === 'es'
                ? 'Esta sección está desactivada para tu hotel'
                : 'This section is turned off for your hotel'}
            </div>
            <div style={{
              fontFamily: 'var(--font-geist), -apple-system, BlinkMacSystemFont, sans-serif',
              fontSize: '14px', color: 'var(--snow-ink2, var(--muted))', maxWidth: '420px', lineHeight: 1.5,
            }}>
              {lang === 'es'
                ? 'Tu administrador de Staxis puede volver a activarla.'
                : 'Your Staxis admin can turn it back on.'}
            </div>
          </div>
        ) : (
          children
        )}
      </main>
      <div className="staxis-feedback-slot"><FeedbackButton /></div>
      <div className="staxis-ai-activity-slot"><AiActivityButton /></div>
      {!hideGlobalAsk ? <AskStaxisBar /> : null}
    </div>
  );
}
