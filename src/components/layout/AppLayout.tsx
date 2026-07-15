'use client';

import React, { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { ConcourseBar } from '@/components/concourse/ConcourseBar';
import { ActivityTracker } from './ActivityTracker';
import { FeedbackButton } from './FeedbackButton';
import { AskStaxisBar } from '@/components/agent/AskStaxisBar';
import { AiActivityButton } from '@/components/agent/AiActivityButton';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { useSyncContext } from '@/contexts/SyncContext';
import { t } from '@/lib/translations';
import { WifiOff, RefreshCw } from 'lucide-react';
import { GlobalAutoTranslate } from '@/components/i18n/GlobalAutoTranslate';
import { sectionForPath, isSectionEnabled } from '@/lib/sections/registry';

export function AppLayout({ children }: { children: React.ReactNode }) {
  const { lang } = useLang();
  const { isOnline, pendingCount, isSyncing } = useSyncContext();
  const { activeProperty } = useProperty();

  /* ── Per-hotel section gate ──
     Block a page whose section this hotel has turned off — even via a direct
     or bookmarked link. FAIL-OPEN while the property is still loading
     (activeProperty null) so we never blank a page during load. No redirect:
     the Header stays mounted so the user can navigate to an enabled section,
     and redirecting would loop if Staxis (or every section) were off. */
  const pathname = usePathname();
  const currentSection = sectionForPath(pathname);
  const sectionOff = Boolean(
    activeProperty &&
    currentSection &&
    !isSectionEnabled(activeProperty.enabledSections, currentSection),
  );

  /* ── Determine which banner (if any) to show ── */
  const showOffline  = !isOnline;
  const showSyncing  = isOnline && isSyncing;
  const showBanner   = showOffline || showSyncing;

  /* ── Build the offline label with optional pending count ── */
  const offlineLabel = pendingCount > 0
    ? `Offline - ${pendingCount} ${t('changesQueued', lang)}`
    : t('offline', lang);

  // Notifications migrated from FCM → Twilio SMS in 2026-04 Supabase migration.
  // Any previously-installed /firebase-messaging-sw.js is unregistered on mount
  // so stale browsers stop fetching a file that no longer ships with the app.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.getRegistrations()
      .then(regs => {
        regs.forEach(reg => {
          const url = reg.active?.scriptURL ?? reg.installing?.scriptURL ?? reg.waiting?.scriptURL ?? '';
          if (url.includes('firebase-messaging-sw')) reg.unregister().catch(() => { /* best effort */ });
        });
      })
      .catch(() => { /* best effort — old browsers */ });
  }, []);

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', flexDirection: 'column',
      // Concourse shell — the soft top-lit page wash every screen sits on.
      background: 'radial-gradient(ellipse 1000px 500px at 50% 0%, #FFFFFF 0%, #F5F7F4 100%)',
    }}>
      <ConcourseBar />
      <ActivityTracker />
      <GlobalAutoTranslate />

      {/* ── Status banner ── */}
      {showBanner && (
        <div style={{
          borderBottom: '1px solid ' + (showSyncing ? 'var(--amber-border, rgba(251,191,36,0.3))' : 'var(--red-border, rgba(239,68,68,0.3))'),
          background:   showSyncing ? 'var(--amber-dim)' : 'var(--red-dim)',
          padding: '8px 16px',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
        }}>
          {showSyncing ? (
            <>
              <RefreshCw size={14} color="var(--amber)" style={{ animation: 'spin 1s linear infinite' }} />
              <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--amber)' }}>
                {t('syncingChanges', lang)}
              </span>
            </>
          ) : (
            <>
              <WifiOff size={14} color="var(--red)" />
              <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--red)' }}>
                {offlineLabel}
              </span>
            </>
          )}
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
        {sectionOff ? (
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
      <FeedbackButton />
      <AiActivityButton />
      <AskStaxisBar />
    </div>
  );
}
