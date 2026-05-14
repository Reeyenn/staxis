'use client';

// ─── useTtsPlayer — sentence-by-sentence streaming TTS playback ──────────
//
// Called from inside ChatPanel. As the agent's reply text streams in, the
// hook splits on sentence boundaries and fires one `/api/agent/speak`
// request per sentence. The MP3 blobs queue in order and play through a
// single hidden <audio> element so playback is gapless.
//
// Why sentence-level: TTS is character-priced (~$0.015/1k chars) so per-
// sentence chunks add a few cents but pay for themselves in perceived
// latency — the user hears Staxis start talking ~1s after the first
// sentence finishes streaming, instead of waiting for the entire reply.
//
// Cancellation rules:
//   - `stop()` (called from the speaker-off toggle, Stop button, mic tap,
//     wake-word "stop") aborts every in-flight fetch, pauses + clears the
//     <audio> element, and empties the queue. Fires immediately.
//   - Component unmount calls stop() automatically.

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';

// ─── Module-scoped TTS singleton — only one playback in the tab at a time ─
// Without this mediator, the voice-mode overlay and the per-message Play
// button can each instantiate a separate <audio> element. If both play at
// once they collide audibly. Every useTtsPlayer instance registers its
// `stop` here when it enters the speaking state; the next instance to
// speak calls the previous owner's `stop` first.
let activeTtsStop: (() => void) | null = null;
function takeTtsOwnership(stop: () => void): () => void {
  if (activeTtsStop && activeTtsStop !== stop) {
    try { activeTtsStop(); } catch { /* ignore */ }
  }
  activeTtsStop = stop;
  return () => {
    if (activeTtsStop === stop) activeTtsStop = null;
  };
}

interface UseTtsPlayerOpts {
  /** Active property — sent with every /speak request for cost attribution. */
  propertyId: string | null;
  /** Active conversation, if any. Lets the cost row link back. */
  conversationId: string | null;
  /** Whether the user has opted in to voice replies. When false, every
   *  speak() call is a no-op (the hook still tracks pending text in case
   *  the user toggles speaker on mid-stream, but nothing plays). */
  enabled: boolean;
  /** Called when the queue drains to empty (last sentence finished
   *  playing). Used by ChatPanel to auto-arm the mic. */
  onDone?: () => void;
}

export interface UseTtsPlayerReturn {
  isSpeaking: boolean;
  /** Feed a chunk of streamed assistant text into the player. The hook
   *  buffers and splits on sentence boundaries internally. Safe to call
   *  with the same delta repeatedly; the hook tracks how much of the
   *  buffer has been spoken so far via offset. */
  feedStreamingText(fullText: string): void;
  /** Tell the player that the assistant is done streaming. Flushes the
   *  current buffer as a final "sentence" even if it doesn't end with
   *  punctuation. */
  finalizeStreamingText(): void;
  /** Stop playback immediately and abort all pending requests. */
  stop(): void;
  /** Reset the hook's "current message" state. Call when starting a new
   *  conversation or before a new assistant turn so old buffer doesn't
   *  bleed into the next reply. */
  reset(): void;
}

/** Split a buffer at sentence boundaries, return { sentences, rest }.
 *  Exported for unit tests. */
export function splitSentences(buf: string): { sentences: string[]; rest: string } {
  // Boundary = run of .!? followed by whitespace OR end-of-string.
  // Keep punctuation with the sentence. The look-behind is supported in
  // every browser we target (Chromium + Safari 16+).
  const matches = [...buf.matchAll(/[^.!?\n]*[.!?]+(?=\s|$)/g)];
  if (matches.length === 0) return { sentences: [], rest: buf };
  const sentences: string[] = [];
  let consumed = 0;
  for (const m of matches) {
    const end = (m.index ?? 0) + m[0].length;
    sentences.push(buf.slice(consumed, end).trim());
    consumed = end;
  }
  return { sentences: sentences.filter(Boolean), rest: buf.slice(consumed) };
}

export function useTtsPlayer(opts: UseTtsPlayerOpts): UseTtsPlayerReturn {
  const { propertyId, conversationId, enabled, onDone } = opts;

  const [isSpeaking, setIsSpeaking] = useState(false);

  // Audio element ref — single instance reused for every sentence.
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Sentences awaiting playback. Each holds the MP3 blob URL once the
  // fetch completes. Played in FIFO order.
  const queueRef = useRef<Array<{ url: string }>>([]);

  // In-flight fetches we may need to abort.
  const inflightRef = useRef<Set<AbortController>>(new Set());

  // Buffer of unfetched assistant text waiting to be split + fetched.
  const bufferRef = useRef<string>('');
  // Offset within the assistant's full reply that we've already consumed.
  // Lets feedStreamingText be called with cumulative text.
  const consumedOffsetRef = useRef<number>(0);

  // Whether the hook is currently mid-utterance — covers both "waiting
  // for a fetch" and "playing a blob". Avoids racing onDone for an old
  // queue when a new sentence arrives during stop().
  const activeRef = useRef(false);
  // Module-singleton ownership release function — populated when this
  // instance takes ownership of the global "active TTS playback" slot.
  const ownershipReleaseRef = useRef<(() => void) | null>(null);

  // ── Lifecycle: create the <audio> element on mount ──────────────────────
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const a = new Audio();
    a.autoplay = false;
    a.preload = 'auto';
    audioRef.current = a;
    return () => {
      try {
        a.pause();
        a.src = '';
      } catch { /* ignore */ }
      audioRef.current = null;
    };
  }, []);

  // ── Stop everything, NOW ────────────────────────────────────────────────
  const stop = useCallback(() => {
    activeRef.current = false;

    // Release the module-singleton ownership slot if we held it.
    if (ownershipReleaseRef.current) {
      try { ownershipReleaseRef.current(); } catch { /* ignore */ }
      ownershipReleaseRef.current = null;
    }

    // Abort in-flight fetches.
    for (const c of inflightRef.current) {
      try { c.abort(); } catch { /* ignore */ }
    }
    inflightRef.current.clear();

    // Pause + clear the audio element.
    const a = audioRef.current;
    if (a) {
      try {
        a.pause();
        a.removeAttribute('src');
        a.load();  // releases the MediaSource handle
      } catch { /* ignore */ }
    }

    // Revoke any queued blob URLs and clear the queue.
    for (const item of queueRef.current) {
      try { URL.revokeObjectURL(item.url); } catch { /* ignore */ }
    }
    queueRef.current = [];

    setIsSpeaking(false);
  }, []);

  // Keep a ref to the latest `stop` so the singleton ownership slot can
  // call it without depending on a captured-at-mount closure.
  const stopRef = useRef(stop);
  useEffect(() => { stopRef.current = stop; }, [stop]);

  // ── Reset for a new utterance ──────────────────────────────────────────
  const reset = useCallback(() => {
    stop();
    bufferRef.current = '';
    consumedOffsetRef.current = 0;
  }, [stop]);

  // ── Play the next queued blob ──────────────────────────────────────────
  const playNext = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;

    const next = queueRef.current.shift();
    if (!next) {
      // Queue empty AND no in-flight fetches AND we're not buffering
      // anything → utterance is fully spoken. Fire onDone exactly once.
      if (inflightRef.current.size === 0 && bufferRef.current.length === 0 && activeRef.current) {
        activeRef.current = false;
        setIsSpeaking(false);
        try { onDone?.(); } catch (e) { console.error('[tts] onDone callback threw', e); }
      }
      return;
    }

    a.src = next.url;
    a.onplay = () => {
      // Logged once per sentence so a silent-TTS regression can be
      // diagnosed from the browser console without server logs. The
      // "Speaking…" status in the overlay reflects fetch+play, not
      // strictly onplay — see comment on setIsSpeaking call below.
      console.log('[tts] audio playback started', next.url);
    };
    a.onended = () => {
      try { URL.revokeObjectURL(next.url); } catch { /* ignore */ }
      playNext();
    };
    a.onerror = (e) => {
      // MediaError can be CSP blocking blob:, codec-not-supported, or
      // a 4xx on the blob URL itself. Include the MediaError code so
      // future regressions are diagnosable from the console.
      const code = (a.error as MediaError | null)?.code;
      console.error('[tts] audio playback error', { code, event: e, url: next.url });
      try { URL.revokeObjectURL(next.url); } catch { /* ignore */ }
      playNext();
    };
    a.play().catch(e => {
      // Most common causes (in order): (1) CSP missing media-src 'self'
      // blob: — the browser refuses to load the blob URL silently with
      // a NotSupportedError. (2) Autoplay policy when the audio element
      // was created outside a user gesture — NotAllowedError. (3) The
      // active document is hidden. We surface as error (not warn) since
      // the user gets the silent-TTS experience otherwise. Recovery:
      // re-tap the phone icon to re-enter voice mode under a fresh
      // gesture frame.
      console.error('[tts] audio.play() rejected', {
        name: (e as { name?: string })?.name,
        message: (e as { message?: string })?.message,
        url: next.url,
      });
      try { URL.revokeObjectURL(next.url); } catch { /* ignore */ }
      playNext();
    });
  }, [onDone]);

  // ── Fetch + enqueue one sentence ───────────────────────────────────────
  const speakSentence = useCallback(async (text: string) => {
    if (!enabled || !propertyId) return;
    const trimmed = text.trim();
    if (!trimmed) return;

    activeRef.current = true;
    setIsSpeaking(true);
    // Take the singleton ownership slot — preempts any other instance
    // mid-utterance (eg per-message Play button while voice mode is speaking).
    if (!ownershipReleaseRef.current) {
      ownershipReleaseRef.current = takeTtsOwnership(stopRef.current);
    }

    const controller = new AbortController();
    inflightRef.current.add(controller);

    try {
      const res = await fetchWithAuth('/api/agent/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: trimmed,
          voice: 'nova',
          propertyId,
          conversationId,
        }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const errBody = await res.json().catch(() => null);
        console.warn('[tts] /speak returned', res.status, errBody?.error);
        return;
      }
      const blob = await res.blob();
      // After the fetch resolved, stop() may have been called — check.
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      queueRef.current.push({ url });

      // If the audio element is idle, kick off playback.
      const a = audioRef.current;
      if (a && (a.paused || a.ended || !a.src)) {
        playNext();
      }
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') return;
      console.error('[tts] /speak failed', e);
    } finally {
      inflightRef.current.delete(controller);
      // If everything's drained and onDone hasn't fired (eg playback was
      // never started because we never got a blob), fire it.
      if (
        inflightRef.current.size === 0 &&
        queueRef.current.length === 0 &&
        bufferRef.current.length === 0 &&
        activeRef.current &&
        audioRef.current &&
        (audioRef.current.paused || audioRef.current.ended || !audioRef.current.src)
      ) {
        activeRef.current = false;
        setIsSpeaking(false);
        try { onDone?.(); } catch (e) { console.error('[tts] onDone threw', e); }
      }
    }
  }, [enabled, propertyId, conversationId, playNext, onDone]);

  // ── Feed text → split → fetch ──────────────────────────────────────────
  const feedStreamingText = useCallback((fullText: string) => {
    if (!enabled) return;
    if (fullText.length <= consumedOffsetRef.current) return;
    const delta = fullText.slice(consumedOffsetRef.current);
    consumedOffsetRef.current = fullText.length;
    bufferRef.current += delta;

    const { sentences, rest } = splitSentences(bufferRef.current);
    bufferRef.current = rest;
    for (const s of sentences) {
      void speakSentence(s);
    }
  }, [enabled, speakSentence]);

  const finalizeStreamingText = useCallback(() => {
    if (!enabled) return;
    const remaining = bufferRef.current.trim();
    bufferRef.current = '';
    if (remaining.length > 0) {
      void speakSentence(remaining);
    } else if (
      // Nothing to flush and the queue is already drained: emit done now.
      inflightRef.current.size === 0 &&
      queueRef.current.length === 0 &&
      activeRef.current
    ) {
      activeRef.current = false;
      setIsSpeaking(false);
      try { onDone?.(); } catch (e) { console.error('[tts] onDone threw', e); }
    }
  }, [enabled, speakSentence, onDone]);

  // ── If user toggles `enabled` off mid-utterance, stop immediately ──────
  useEffect(() => {
    if (!enabled) stop();
  }, [enabled, stop]);

  // ── Window-level stop event (wake word "stop", etc.) ───────────────────
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = () => stop();
    window.addEventListener('staxis:tts-stop', handler);
    return () => window.removeEventListener('staxis:tts-stop', handler);
  }, [stop]);

  return {
    isSpeaking,
    feedStreamingText,
    finalizeStreamingText,
    stop,
    reset,
  };
}
