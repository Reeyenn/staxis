'use client';

import React, { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import dynamic from 'next/dynamic';
import { ConcourseBar } from '@/components/concourse/ConcourseBar';
import { ActivityTracker } from './ActivityTracker';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { useSyncContext } from '@/contexts/SyncContext';
import { t } from '@/lib/translations';
import { WifiOff } from 'lucide-react';
import { sectionForPath, isSectionEnabled, SECTION_META } from '@/lib/sections/registry';
import { localAppHref } from '@/lib/portfolio-ui/acting-scope';
import { RouteErrorState } from './RouteResourceState';
import {
  clearStaleChunkRecoveryIncident,
  staleChunkFailureSeenThisBoot,
  STALE_CHUNK_STABLE_BOOT_MS,
} from '@/lib/stale-chunk-recovery';
import { useNavigationReady } from '@/lib/hooks/use-reliable-navigation';
import { useOptionalHotelActingContext } from '@/contexts/HotelActingContext';

// The one AI object in the corner: the Obsidian mark, its peek and its panel,
// plus the companion brain behind them and the overflow menu that now holds
// feedback and AI activity. Load it lazily so it stays out of each page's
// initial JS bundle; it pops in post-hydration with no layout shift because it
// is fixed-position. ssr:false — nothing to server-render at rest.
//
// MOUNTED HERE, which is why housekeeper and laundry screens never see it: they
// do not import AppLayout. That is a fact about today's file layout though, so
// the companion ALSO refuses on those paths itself (companionMounts in
// src/lib/companion/mount.ts) and the bar refuses a housekeeping hat through
// chatIsMountedForRole. Independent gates, on purpose.
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
    activeScope,
    capabilityOverridesStatus,
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
  const companyScopedPersonalMessages = activeScope.kind === 'company'
    && currentSection === 'communications';
  const sectionOff = Boolean(
    !companyScopedPersonalMessages && currentSection && (
      actingSectionEnabled === false
      || (actingSectionEnabled === null
        && activeProperty
        && !isSectionEnabled(activeProperty.enabledSections, currentSection))
    ),
  );

  /* ── Company scope has no section pages yet ──
     The section routes read ONE hotel. Rendering them under a company scope
     would put a single building's numbers on a page the person opened to see
     the whole company, which is the worst possible failure here: it is wrong
     and it looks right. Say so instead, and offer the hotel version. The
     company versions of these pages ship separately. */
  // Messages is a personal inbox, including when the caller keeps an exact
  // company scope in the URL so it can show independently-authorized hotel
  // conversations. It is not a company operations module, so let the personal
  // Communications route render instead of showing the company-section
  // placeholder used by the other department pages.
  const companySectionPending = activeScope.kind === 'company'
    && currentSection !== null
    && currentSection !== 'communications';
  const companySectionLabel = currentSection ? SECTION_META[currentSection].label_en : '';

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

      {activeProperty && capabilityOverridesStatus === 'error' && (
        <div
          role="alert"
          aria-live="assertive"
          style={{
            borderBottom: '1px solid var(--snow-warm, rgba(184,92,61,0.3))',
            background: 'var(--snow-warm-dim, rgba(184,92,61,0.1))',
            padding: '8px 16px',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px',
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--snow-ink, var(--fg))' }}>
            Some actions are unavailable while hotel access settings are refreshed.
          </span>
          <button
            type="button"
            onClick={() => void refreshCapabilities()}
            style={{
              border: '1px solid currentColor', borderRadius: '8px', background: 'transparent',
              minHeight: 44, padding: '4px 12px', font: 'inherit', fontSize: '12px', fontWeight: 650,
              color: 'var(--snow-ink, var(--fg))', cursor: 'pointer',
            }}
          >
            Try again
          </button>
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
            title={'We could not load your hotels'}
            message={'No data was changed. Check your connection and try again.'}
            retryLabel={'Try again'}
            onRetry={retryProperties}
          />
        ) : companySectionPending ? (
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
              {`${companySectionLabel} across your whole company is on its way`}
            </div>
            <div style={{ fontSize: '14px', color: 'var(--text-secondary)', maxWidth: 420 }}>
              {'This page still shows one hotel at a time, so it is not showing you anything yet.'}
            </div>
            <a
              href={localAppHref(pathname)}
              style={{
                marginTop: 6,
                border: '1px solid currentColor', borderRadius: 8,
                minHeight: 44, padding: '10px 16px',
                display: 'inline-flex', alignItems: 'center',
                font: 'inherit', fontSize: 14, fontWeight: 650,
                color: 'var(--snow-ink, var(--fg))', textDecoration: 'none',
              }}
            >
              {`Open ${companySectionLabel} at one hotel`}
            </a>
          </div>
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
              {'This section is turned off for your hotel'}
            </div>
            <div style={{
              fontFamily: 'var(--font-geist), -apple-system, BlinkMacSystemFont, sans-serif',
              fontSize: '14px', color: 'var(--snow-ink2, var(--muted))', maxWidth: '420px', lineHeight: 1.5,
            }}>
              {'Your Staxis admin can turn it back on.'}
            </div>
          </div>
        ) : (
          children
        )}
      </main>
      {/* ONE object in the bottom-right corner. Feedback and AI activity used
          to sit here as their own floating buttons; they are rows in the
          panel's overflow menu now. */}
      {!hideGlobalAsk ? <AskStaxisBar /> : null}
    </div>
  );
}
