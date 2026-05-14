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
    a.onended = () => {
      try { URL.revokeObjectURL(next.url); } catch { /* ignore */ }
      playNext();
    };
    a.onerror = () => {
      console.error('[tts] audio playback error');
      try { URL.revokeObjectURL(next.url); } catch { /* ignore */ }
      playNext();
    };
    a.play().catch(e => {
      // Autoplay-blocked: surface to console; the user can tap the
      // panel to unblock. We don't surface an error toast because this
      // is a recoverable state (user gesture re-enables audio).
      console.warn('[tts] audio.play() rejected', e);
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
