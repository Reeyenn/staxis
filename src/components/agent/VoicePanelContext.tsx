'use client';

// ─── VoicePanelContext — coordination state for the voice surface ────────
//
// Coordinates two mutually-exclusive surfaces:
//
//   - The floating ChatPanel (text chat with optional per-message playback)
//   - The VoiceModeOverlay (dedicated voice experience, Clicky-style bar)
//
// Mutual exclusion is enforced by the context itself: opening one closes
// the other. This eliminates the "two overlays stacked" bug class.
//
// `openVoiceMode` is idempotent — calling it while voice mode is already
// open is a no-op (prevents the wake word from re-arming mid-utterance).

import { createContext, useCallback, useContext, useMemo, useState } from 'react';

export interface VoicePanelContextValue {
  /** Whether the floating text ChatPanel is currently open. */
  panelOpen: boolean;
  /** Open the text chat panel. Closes voice mode if it was open. */
  openPanel(): void;
  /** Close the text chat panel. */
  closePanel(): void;

  /** Whether the dedicated VoiceModeOverlay is currently open. */
  voiceModeOpen: boolean;
  /** Enter voice mode. Closes the chat panel. No-op if already open. */
  openVoiceMode(): void;
  /** Exit voice mode. */
  closeVoiceMode(): void;
}

const VoicePanelContext = createContext<VoicePanelContextValue | null>(null);

export function VoicePanelProvider({ children }: { children: React.ReactNode }) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [voiceModeOpen, setVoiceModeOpen] = useState(false);

  const openPanel = useCallback(() => {
    setVoiceModeOpen(false);  // mutual exclusion
    setPanelOpen(true);
  }, []);

  const closePanel = useCallback(() => {
    setPanelOpen(false);
  }, []);

  const openVoiceMode = useCallback(() => {
    // Idempotent — bail if already open so the wake word doesn't re-arm
    // the mic mid-utterance.
    setVoiceModeOpen((prev) => {
      if (prev) return prev;
      // Closing the chat panel needs to happen even when we transition
      // false→true. Doing it inside the updater keeps the two state
      // changes batched.
      setPanelOpen(false);
      return true;
    });
  }, []);

  const closeVoiceMode = useCallback(() => {
    setVoiceModeOpen(false);
  }, []);

  const value = useMemo<VoicePanelContextValue>(() => ({
    panelOpen,
    openPanel,
    closePanel,
    voiceModeOpen,
    openVoiceMode,
    closeVoiceMode,
  }), [
    panelOpen,
    openPanel,
    closePanel,
    voiceModeOpen,
    openVoiceMode,
    closeVoiceMode,
  ]);

  return (
    <VoicePanelContext.Provider value={value}>
      {children}
    </VoicePanelContext.Provider>
  );
}

/** Hook — returns the panel context, or `null` if used outside the provider.
 *  Components like FloatingChatButton can render no-ops in that case. */
export function useVoicePanel(): VoicePanelContextValue | null {
  return useContext(VoicePanelContext);
}
