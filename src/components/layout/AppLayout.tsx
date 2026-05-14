'use client';

import React, { useEffect, useState } from 'react';
import { Header } from './Header';
import { ActivityTracker } from './ActivityTracker';
import { FeedbackButton } from './FeedbackButton';
import { FloatingChatButton } from '@/components/agent/FloatingChatButton';
import { WakeWord } from '@/components/agent/WakeWord';
import { VoicePanelProvider, useVoicePanel } from '@/components/agent/VoicePanelContext';
import { VoiceModeOverlay } from '@/components/agent/VoiceModeOverlay';
import { VoiceReplyOnboardingModal } from '@/components/agent/VoiceReplyOnboardingModal';
import { useVoiceModeKeyboard } from '@/components/agent/useVoiceModeKeyboard';
import { fetchWithAuth } from '@/lib/api-fetch';
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
// Owns: the global voice-mode keyboard shortcut, the onboarding modal
// trigger, and the VoiceModeOverlay itself. Lives here (not at the
// outer AppLayout level) so all three can read `useVoicePanel()`.
function VoiceModeMount() {
  const voicePanel = useVoicePanel();
  const voiceModeOpen = voicePanel?.voiceModeOpen ?? false;

  // Onboarding modal — fires the first time the user enters voice mode
  // when accounts.voice_onboarded_at is still NULL. Session flag protects
  // against re-fire within the same tab even before the DB write commits.
  const [onboardedAt, setOnboardedAt] = useState<string | null | undefined>(undefined);
  const [shownThisSession, setShownThisSession] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  // Hydrate onboardedAt once on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithAuth('/api/agent/voice-preference');
        if (!res.ok || cancelled) return;
        const body = await res.json();
        setOnboardedAt(body.data?.voiceOnboardedAt ?? null);
      } catch {
        if (!cancelled) setOnboardedAt(null);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Fire the modal when voice mode opens for the first time without onboarding.
  useEffect(() => {
    if (!voiceModeOpen) return;
    if (shownThisSession) return;
    if (onboardedAt === undefined) return;  // still loading
    if (onboardedAt !== null) return;        // already onboarded
    setModalOpen(true);
  }, [voiceModeOpen, shownThisSession, onboardedAt]);

  // Keyboard shortcut — Cmd+/ on macOS, Ctrl+/ on Windows. Suppressed
  // while the onboarding modal owns focus.
  useVoiceModeKeyboard({ suppressed: modalOpen });

  return (
    <>
      <VoiceModeOverlay />
      <VoiceReplyOnboardingModal
        open={modalOpen}
        onDone={() => {
          setShownThisSession(true);  // only flip AFTER successful POST
          setOnboardedAt(new Date().toISOString());
          setModalOpen(false);
        }}
        onDismiss={() => {
          // User dismissed without choosing — don't set session flag so
          // they get re-prompted next time they enter voice mode.
          setModalOpen(false);
        }}
      />
    </>
  );
}
