'use client';

// ─── VoicePanelContext — coordination state for the voice surface ────────
//
// The voice surface has four components that need to talk to each other:
//
//   - `<FloatingChatButton />`     opens the panel
//   - `<FloatingMicButton />`      opens the panel AND requests an immediate
//                                  recording on the embedded <VoiceButton />
//   - `<WakeWord />`               does the same (open + record) on a
//                                  detected wake phrase
//   - `<ChatPanel />` / `<VoiceButton />`  consumes the "auto-record"
//                                  request and starts the mic
//
// Rather than threading refs and prop callbacks across the tree, this
// context exposes a small set of operations. Provider is mounted once in
// AppLayout so every consumer can grab it.
//
// We intentionally do NOT put the TTS player here — TTS is owned by
// ChatPanel because that's the only place it's heard, and putting it in a
// global context complicates SSR + hot-reload.

import { createContext, useCallback, useContext, useMemo, useState } from 'react';

export interface VoicePanelContextValue {
  /** Whether the floating ChatPanel is currently open. */
  panelOpen: boolean;
  /** Open the panel without queueing a recording (text mode). */
  openPanel(): void;
  /** Close the panel. Cancels any pending voice request. */
  closePanel(): void;
  /** Open the panel AND ask the embedded VoiceButton to start recording
   *  on its next render. Used by FloatingMicButton + WakeWord. */
  openPanelAndRecord(): void;
  /** Has someone (FloatingMic/WakeWord) requested an auto-record that the
   *  VoiceButton hasn't consumed yet? */
  voiceRecordingRequested: boolean;
  /** VoiceButton calls this after it acts on the request, so subsequent
   *  renders don't re-trigger recording. */
  consumeVoiceRecordingRequest(): void;
}

const VoicePanelContext = createContext<VoicePanelContextValue | null>(null);

export function VoicePanelProvider({ children }: { children: React.ReactNode }) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [voiceRecordingRequested, setVoiceRecordingRequested] = useState(false);

  const openPanel = useCallback(() => {
    setPanelOpen(true);
  }, []);

  const closePanel = useCallback(() => {
    setPanelOpen(false);
    setVoiceRecordingRequested(false);
  }, []);

  const openPanelAndRecord = useCallback(() => {
    setPanelOpen(true);
    setVoiceRecordingRequested(true);
  }, []);

  const consumeVoiceRecordingRequest = useCallback(() => {
    setVoiceRecordingRequested(false);
  }, []);

  const value = useMemo<VoicePanelContextValue>(() => ({
    panelOpen,
    openPanel,
    closePanel,
    openPanelAndRecord,
    voiceRecordingRequested,
    consumeVoiceRecordingRequest,
  }), [
    panelOpen,
    openPanel,
    closePanel,
    openPanelAndRecord,
    voiceRecordingRequested,
    consumeVoiceRecordingRequest,
  ]);

  return (
    <VoicePanelContext.Provider value={value}>
      {children}
    </VoicePanelContext.Provider>
  );
}

/** Hook — returns the panel context, or `null` if used outside the provider.
 *  Components like FloatingMicButton can render no-ops in that case. */
export function useVoicePanel(): VoicePanelContextValue | null {
  return useContext(VoicePanelContext);
}

/** Hook — like useVoicePanel but throws if the provider is missing. Use in
 *  components that MUST coordinate (ChatPanel itself). */
export function useRequiredVoicePanel(): VoicePanelContextValue {
  const v = useContext(VoicePanelContext);
  if (!v) {
    throw new Error('useRequiredVoicePanel must be used inside <VoicePanelProvider>');
  }
  return v;
}
