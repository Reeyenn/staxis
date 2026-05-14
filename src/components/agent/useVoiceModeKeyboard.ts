'use client';

// ─── useVoiceModeKeyboard — Cmd+/ (Ctrl+/ on Windows) toggles voice mode ─
//
// Mounted once at the AppLayout level. Reads `voiceModeOpen` inside the
// keydown handler (via ref, never via captured closure) so toggling
// never gets stuck mid-render.
//
// No-op when:
//   - An <input>, <textarea>, or contentEditable element has focus.
//     (We don't want to swallow the user's '/' inside text fields.)
//   - The onboarding modal is open (passed in by AppLayout).

import { useEffect, useRef } from 'react';
import { useVoicePanel } from './VoicePanelContext';

export interface UseVoiceModeKeyboardOpts {
  /** When true, the shortcut is suppressed (e.g. while the onboarding
   *  modal is open and owning focus). */
  suppressed?: boolean;
}

export function useVoiceModeKeyboard(opts: UseVoiceModeKeyboardOpts = {}) {
  const voicePanel = useVoicePanel();

  // Ref-based reads so the keydown closure is stable but never sees stale state.
  const voicePanelRef = useRef(voicePanel);
  useEffect(() => { voicePanelRef.current = voicePanel; }, [voicePanel]);

  const suppressedRef = useRef(opts.suppressed);
  useEffect(() => { suppressedRef.current = opts.suppressed; }, [opts.suppressed]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const onKeyDown = (e: KeyboardEvent) => {
      // Modifier check: Cmd on macOS, Ctrl elsewhere. Allow Shift to be
      // either way — some keyboard layouts emit '?' (which is Shift+/).
      const isMod = e.metaKey || e.ctrlKey;
      if (!isMod) return;
      if (e.key !== '/' && e.key !== '?') return;

      const target = e.target as HTMLElement | null;
      // Don't hijack '/' inside text fields — the user is typing.
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
      }

      if (suppressedRef.current) return;
      const vp = voicePanelRef.current;
      if (!vp) return;

      e.preventDefault();
      if (vp.voiceModeOpen) vp.closeVoiceMode();
      else vp.openVoiceMode();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
