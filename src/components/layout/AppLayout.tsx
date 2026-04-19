'use client';

import React, { useEffect } from 'react';
import { Header } from './Header';
import { useLang } from '@/contexts/LanguageContext';
import { useSyncContext } from '@/contexts/SyncContext';
import { t } from '@/lib/translations';
import { WifiOff, RefreshCw } from 'lucide-react';

export function AppLayout({ children }: { children: React.ReactNode }) {
  const { lang } = useLang();
  const { isOnline, pendingCount, isSyncing } = useSyncContext();

  /* ── Determine which banner (if any) to show ── */
  const showOffline  = !isOnline;
  const showSyncing  = isOnline && isSyncing;
  const showBanner   = showOffline || showSyncing;

  /* ── Build the offline label with optional pending count ── */
  const offlineLabel = pendingCount > 0
    ? `Offline - ${pendingCount} ${t('changesQueued', lang)}`
    : t('offline', lang);

  // Register FCM service worker for push notifications
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker
        .register('/firebase-messaging-sw.js', { scope: '/' })
        .catch((err) => console.warn('SW registration failed:', err));
    }
  }, []);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <Header />

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

      <main style={{
        flex: 1,
        width: '100%',
        maxWidth: '1920px',
        margin: '0 auto',
      }}>
        {children}
      </main>
    </div>
  );
}
