'use client';

import React, { useEffect, useState, useRef } from 'react';
import { Header } from './Header';
import { BottomNav } from './BottomNav';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import { WifiOff, Wifi } from 'lucide-react';

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [isOnline, setIsOnline]       = useState(true);
  const [showSyncing, setShowSyncing] = useState(false);
  const syncTimerRef                  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { lang }                      = useLang();

  useEffect(() => {
    setIsOnline(navigator.onLine);

    const handleOnline = () => {
      setIsOnline(true);
      // Show a brief "syncing" banner whenever connectivity is restored
      setShowSyncing(true);
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
      syncTimerRef.current = setTimeout(() => setShowSyncing(false), 3000);
    };

    const handleOffline = () => {
      setIsOnline(false);
      setShowSyncing(false);
    };

    window.addEventListener('online',  handleOnline);
    window.addEventListener('offline', handleOffline);

    // Register the FCM / offline service worker so it is always active
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker
        .register('/firebase-messaging-sw.js', { scope: '/' })
        .catch((err) => console.warn('SW registration failed:', err));
    }

    return () => {
      window.removeEventListener('online',  handleOnline);
      window.removeEventListener('offline', handleOffline);
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    };
  }, []);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <Header />

      {/* ── Offline banner ── */}
      {!isOnline && (
        <div style={{
          background: 'rgba(239,68,68,0.12)', borderBottom: '1px solid rgba(239,68,68,0.3)',
          padding: '8px 16px',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
        }}>
          <WifiOff size={14} color="#EF4444" />
          <span style={{ fontSize: '12px', fontWeight: 600, color: '#EF4444' }}>
            {t('offline', lang)}
          </span>
        </div>
      )}

      {/* ── Syncing banner (shown briefly after reconnecting) ── */}
      {isOnline && showSyncing && (
        <div style={{
          background: 'rgba(34,197,94,0.10)', borderBottom: '1px solid rgba(34,197,94,0.25)',
          padding: '8px 16px',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
        }}>
          <Wifi size={14} color="#22c55e" />
          <span style={{ fontSize: '12px', fontWeight: 600, color: '#22c55e' }}>
            {t('syncing', lang)}
          </span>
        </div>
      )}

      <main style={{
        flex: 1,
        width: '100%',
        maxWidth: '800px',
        margin: '0 auto',
        /* bottom padding = nav 64px + safe area + 8px breathing room */
        paddingBottom: 'calc(72px + env(safe-area-inset-bottom, 0px))',
      }}>
        {children}
      </main>
      <BottomNav />
    </div>
  );
}
