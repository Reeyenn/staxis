'use client';

// ─── useMessagePlayback — one-shot TTS for the per-message Play button ──
//
// Instantiated ONCE at the MessageList level (not per row). Each row
// gets `currentlyPlayingId` + `play(text, id)` + `stop()` via props.
// This keeps the single <audio> element + AbortController + module-level
// activeTtsStop singleton coordinated.

import { useCallback, useRef, useState } from 'react';
import { useTtsPlayer } from './useTtsPlayer';

export interface UseMessagePlaybackOpts {
  propertyId: string | null;
  /** Optional — gets attached to the cost-ledger row for attribution. */
  conversationId: string | null;
}

export interface UseMessagePlaybackReturn {
  currentlyPlayingId: string | null;
  play(text: string, id: string): Promise<void>;
  stop(): void;
}

export function useMessagePlayback(opts: UseMessagePlaybackOpts): UseMessagePlaybackReturn {
  const [currentlyPlayingId, setCurrentlyPlayingId] = useState<string | null>(null);

  // Hold the id we expect to be playing in a ref so the onDone callback
  // closure doesn't read stale state.
  const playingIdRef = useRef<string | null>(null);

  const tts = useTtsPlayer({
    propertyId: opts.propertyId,
    conversationId: opts.conversationId,
    enabled: true,  // playback is always enabled when the hook is mounted
    onDone: () => {
      playingIdRef.current = null;
      setCurrentlyPlayingId(null);
    },
  });

  const play = useCallback(async (text: string, id: string): Promise<void> => {
    // Toggle behaviour: tapping the play icon of the currently-playing
    // message stops playback.
    if (playingIdRef.current === id) {
      tts.stop();
      playingIdRef.current = null;
      setCurrentlyPlayingId(null);
      return;
    }
    // Reset clears any leftover blob URLs from a previous play before we
    // queue new ones — without this, URLs accumulate per consecutive press.
    tts.reset();
    playingIdRef.current = id;
    setCurrentlyPlayingId(id);
    tts.feedStreamingText(text);
    tts.finalizeStreamingText();
  }, [tts]);

  const stop = useCallback(() => {
    tts.stop();
    playingIdRef.current = null;
    setCurrentlyPlayingId(null);
  }, [tts]);

  return { currentlyPlayingId, play, stop };
}
