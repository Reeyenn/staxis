'use client';

import React, { useEffect } from 'react';
import { Header } from './Header';
import { ActivityTracker } from './ActivityTracker';
import { FeedbackButton } from './FeedbackButton';
import { FloatingChatButton } from '@/components/agent/FloatingChatButton';
import { WakeWord } from '@/components/agent/WakeWord';
import { VoicePanelProvider } from '@/components/agent/VoicePanelContext';
import { VoiceModeOverlay } from '@/components/agent/VoiceModeOverlay';
import { useVoiceModeKeyboard } from '@/components/agent/useVoiceModeKeyboard';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { useSyncContext } from '@/contexts/SyncContext';
import { t } from '@/lib/translations';
import { WifiOff, RefreshCw } from 'lucide-react';

export function AppLayout({ children }: { children: React.ReactNode }) {
  const { lang } = useLang();
  const { isOnline, pendingCount, isSyncing } = useSyncContext();
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const voiceSurfaceAvailable = Boolean(user && activePropertyId);

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
    <VoicePanelProvider>
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <Header />
      <ActivityTracker />

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
      <FeedbackButton />
      <FloatingChatButton />
      {voiceSurfaceAvailable && <WakeWord />}
      {voiceSurfaceAvailable && <VoiceModeMount />}
    </div>
    </VoicePanelProvider>
  );
}

// ─── Inner mount — has access to VoicePanelContext ───────────────────────
//
// Owns the global voice-mode keyboard shortcut (Cmd+/) and the overlay.
// Lives inside the provider so the keyboard hook can read voice-mode
// state. There is no "talk back to me?" onboarding modal — ElevenLabs
// always speaks; opting out lives in Settings → Voice.
function VoiceModeMount() {
  useVoiceModeKeyboard({ suppressed: false });
  return <VoiceModeOverlay />;
}
