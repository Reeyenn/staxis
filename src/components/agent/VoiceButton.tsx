'use client';

// ─── VoiceButton — tap-to-talk mic ───────────────────────────────────────
//
// Single component that handles:
//   - Mic permission (with a friendly "enable mic in browser settings"
//     fallback on denial)
//   - Recording via MediaRecorder; falls back to recordrtc on iOS Safari
//     (which lacks MediaRecorder under iOS < 14.5 and has flaky behavior
//     even on newer versions)
//   - Silence detection (5s) + 60s hard cap → auto-stop
//   - Upload to /api/agent/transcribe + retry-once
//   - Imperative `start()` via forwardRef so parent components
//     (FloatingMicButton, WakeWord) can trigger recording externally.
//
// Props:
//   - propertyId, conversationId   — passed to /transcribe
//   - size                          — 'small' (inline in composer) or 'large' (FAB)
//   - disabled                      — eg streaming or panel closed
//   - onTranscript(text)            — called after successful transcribe
//   - onStartRecording?()           — called when recording begins (e.g.
//                                     to stop TTS playback)
//   - onCapHit?()                   — called when /transcribe returns 429
//                                     (caller may want to show a toast)
//
// The button has 5 visual states: idle, recording, uploading, denied,
// errored, capped. They're all styled with the Snow tokens.

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { Mic, MicOff, Loader2 } from 'lucide-react';
import { fetchWithAuth } from '@/lib/api-fetch';

export type VoiceButtonHandle = {
  /** Start recording. No-op if already recording. */
  start: () => Promise<void>;
  /** Stop recording. Forces the silence-detector to fire. */
  stop: () => void;
};

export interface VoiceButtonProps {
  propertyId: string | null;
  conversationId: string | null;
  size?: 'small' | 'large';
  disabled?: boolean;
  onTranscript: (text: string) => void;
  onStartRecording?: () => void;
  onCapHit?: () => void;
}

type State =
  | { kind: 'idle' }
  | { kind: 'recording'; startedAt: number; durationSec: number }
  | { kind: 'uploading' }
  | { kind: 'denied' }
  | { kind: 'error'; message: string }
  | { kind: 'capped' };

const MAX_RECORDING_MS = 60_000;
const SILENCE_TIMEOUT_MS = 5_000;
const SILENCE_THRESHOLD = 0.012;   // RMS amplitude on the 0..1 range

// Detect iOS Safari for the recordrtc fallback. `MediaRecorder` exists
// on iOS 14.5+ but its webm/opus support is missing — only mp4/aac. We
// route iOS through recordrtc which produces 16kHz mono WAV that Whisper
// handles reliably regardless of file size.
function shouldUseRecordrtcFallback(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) && !('MSStream' in window);
  // The webm+opus codec is what we'd otherwise prefer. If MediaRecorder
  // doesn't expose it, we're on Safari and need recordrtc.
  const hasWebmOpus =
    typeof MediaRecorder !== 'undefined' &&
    MediaRecorder.isTypeSupported('audio/webm;codecs=opus');
  return isIOS || !hasWebmOpus;
}

export const VoiceButton = forwardRef<VoiceButtonHandle, VoiceButtonProps>(function VoiceButton(
  { propertyId, conversationId, size = 'small', disabled, onTranscript, onStartRecording, onCapHit },
  ref,
) {
  const [state, setState] = useState<State>({ kind: 'idle' });

  // Recording machinery refs.
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<{
    stop: () => Promise<Blob | null>;
    mimeType: string;
  } | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const silenceTimerRef = useRef<number | null>(null);
  const maxDurationTimerRef = useRef<number | null>(null);
  const durationTickRef = useRef<number | null>(null);
  const isStoppingRef = useRef(false);

  // ── Cleanup any recording resources ────────────────────────────────────
  const cleanup = useCallback(() => {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        try { track.stop(); } catch { /* ignore */ }
      }
      streamRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    if (silenceTimerRef.current !== null) {
      window.clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (maxDurationTimerRef.current !== null) {
      window.clearTimeout(maxDurationTimerRef.current);
      maxDurationTimerRef.current = null;
    }
    if (durationTickRef.current !== null) {
      window.clearInterval(durationTickRef.current);
      durationTickRef.current = null;
    }
    recorderRef.current = null;
    isStoppingRef.current = false;
  }, []);

  useEffect(() => {
    return () => cleanup();
  }, [cleanup]);

  // ── Upload to /transcribe with one retry on network error ──────────────
  const uploadBlob = useCallback(async (blob: Blob, mime: string): Promise<void> => {
    if (!propertyId) {
      setState({ kind: 'error', message: 'No active property.' });
      return;
    }
    setState({ kind: 'uploading' });

    const form = new FormData();
    const ext = mime.includes('wav') ? 'wav' : mime.includes('ogg') ? 'ogg' : 'webm';
    form.append('audio', blob, `recording.${ext}`);
    form.append('propertyId', propertyId);
    if (conversationId) form.append('conversationId', conversationId);

    const doFetch = () => fetchWithAuth('/api/agent/transcribe', {
      method: 'POST',
      body: form,
    });

    let res: Response;
    try {
      res = await doFetch();
      if (res.status >= 500) {
        // Silent retry once on 5xx
        res = await doFetch();
      }
    } catch {
      // Network error: retry once
      try {
        res = await doFetch();
      } catch (e) {
        setState({ kind: 'error', message: "Couldn't hear you, tap to retry." });
        console.error('[VoiceButton] transcribe network error', e);
        return;
      }
    }

    if (res.status === 429) {
      setState({ kind: 'capped' });
      onCapHit?.();
      return;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setState({
        kind: 'error',
        message: body?.error ?? "Couldn't hear you, tap to retry.",
      });
      return;
    }

    const body = await res.json().catch(() => null);
    const transcript: string | undefined = body?.data?.transcript;
    if (!transcript || !transcript.trim()) {
      setState({ kind: 'error', message: "Didn't catch that — tap to try again." });
      return;
    }
    setState({ kind: 'idle' });
    onTranscript(transcript.trim());
  }, [propertyId, conversationId, onTranscript, onCapHit]);

  // ── Build the MediaRecorder OR recordrtc-based recorder ────────────────
  const buildRecorder = useCallback(async (stream: MediaStream): Promise<{
    stop: () => Promise<Blob | null>;
    mimeType: string;
  }> => {
    if (shouldUseRecordrtcFallback()) {
      // Lazy import to keep the main bundle slim — recordrtc is ~50kb gzipped.
      // Wider `unknown` is required because the package's types model RecordRTC
      // as a class with extensive static helpers, none of which we use here.
      // Picking just the runtime members we care about via narrowed cast.
      type RecordrtcCtor = new (stream: MediaStream, opts: Record<string, unknown>) => {
        startRecording(): void;
        stopRecording(cb: () => void): void;
        getBlob(): Blob;
      };
      type RecordrtcStatics = { StereoAudioRecorder: unknown };
      const recordrtcMod = await import('recordrtc') as unknown as { default?: unknown };
      const ctor = (recordrtcMod.default ?? recordrtcMod) as unknown as
        RecordrtcCtor & RecordrtcStatics;
      const rec = new ctor(stream, {
        type: 'audio',
        mimeType: 'audio/wav',
        recorderType: ctor.StereoAudioRecorder,
        numberOfAudioChannels: 1,
        desiredSampRate: 16000,
      });
      rec.startRecording();
      return {
        mimeType: 'audio/wav',
        stop: () => new Promise<Blob | null>((resolve) => {
          rec.stopRecording(() => {
            try {
              resolve(rec.getBlob());
            } catch {
              resolve(null);
            }
          });
        }),
      };
    }

    // MediaRecorder path — covers Chrome, Firefox, Edge, desktop Safari 17+.
    const mr = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
    const chunks: BlobPart[] = [];
    mr.ondataavailable = (ev) => { if (ev.data.size > 0) chunks.push(ev.data); };
    mr.start(250);  // 250ms timeslice
    return {
      mimeType: 'audio/webm',
      stop: () => new Promise<Blob | null>((resolve) => {
        mr.onstop = () => {
          resolve(new Blob(chunks, { type: 'audio/webm' }));
        };
        try {
          mr.stop();
        } catch {
          resolve(null);
        }
      }),
    };
  }, []);

  // ── Finish recording: stop tracks, get blob, upload ────────────────────
  const finishRecording = useCallback(async () => {
    if (isStoppingRef.current) return;
    isStoppingRef.current = true;
    const rec = recorderRef.current;
    cleanup();
    if (!rec) {
      setState({ kind: 'idle' });
      return;
    }
    const blob = await rec.stop();
    if (!blob || blob.size === 0) {
      setState({ kind: 'error', message: "Didn't catch that — tap to try again." });
      return;
    }
    await uploadBlob(blob, rec.mimeType);
  }, [cleanup, uploadBlob]);

  // ── Start recording ────────────────────────────────────────────────────
  const start = useCallback(async () => {
    if (state.kind === 'recording' || state.kind === 'uploading') return;
    if (disabled) return;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setState({ kind: 'error', message: 'This browser does not support recording.' });
      return;
    }

    onStartRecording?.();

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      const errName = (e as { name?: string })?.name;
      if (errName === 'NotAllowedError' || errName === 'PermissionDeniedError') {
        setState({ kind: 'denied' });
      } else {
        setState({ kind: 'error', message: "Couldn't access your microphone." });
        console.error('[VoiceButton] getUserMedia failed', e);
      }
      return;
    }

    streamRef.current = stream;

    try {
      recorderRef.current = await buildRecorder(stream);
    } catch (e) {
      console.error('[VoiceButton] recorder init failed', e);
      cleanup();
      setState({ kind: 'error', message: 'Recording failed to start.' });
      return;
    }

    // Silence detection — uses AudioContext + AnalyserNode RMS. Inlined
    // here because it needs to close over finishRecording, which can't be
    // a forward dependency of a separate useCallback.
    if (typeof window !== 'undefined' && typeof AudioContext !== 'undefined') {
      const ctx = new AudioContext();
      audioContextRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);

      const buf = new Uint8Array(analyser.fftSize);
      let lastVoiceTs = performance.now();

      const tick = () => {
        if (!audioContextRef.current || audioContextRef.current.state === 'closed') return;
        analyser.getByteTimeDomainData(buf);
        let sumSq = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sumSq += v * v;
        }
        const rms = Math.sqrt(sumSq / buf.length);
        if (rms > SILENCE_THRESHOLD) {
          lastVoiceTs = performance.now();
        } else if (performance.now() - lastVoiceTs > SILENCE_TIMEOUT_MS) {
          // 5s of continuous silence — stop the recording.
          finishRecording().catch((e) => console.error('[VoiceButton] silence-stop failed', e));
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }

    const startedAt = Date.now();
    setState({ kind: 'recording', startedAt, durationSec: 0 });

    durationTickRef.current = window.setInterval(() => {
      setState((s) => s.kind === 'recording'
        ? { ...s, durationSec: Math.floor((Date.now() - s.startedAt) / 1000) }
        : s);
    }, 500);

    maxDurationTimerRef.current = window.setTimeout(() => {
      void finishRecording();
    }, MAX_RECORDING_MS);
  }, [
    state,
    disabled,
    onStartRecording,
    buildRecorder,
    cleanup,
    finishRecording,
  ]);

  // ── Stop recording manually (tap mic again) ────────────────────────────
  const stop = useCallback(() => {
    if (state.kind === 'recording') {
      void finishRecording();
    }
  }, [state.kind, finishRecording]);

  // Expose imperative handle.
  useImperativeHandle(ref, () => ({
    start,
    stop,
  }), [start, stop]);

  // ── Click handler ──────────────────────────────────────────────────────
  const handleClick = () => {
    if (state.kind === 'recording') {
      stop();
    } else if (state.kind === 'idle' || state.kind === 'error') {
      void start();
    } else if (state.kind === 'denied') {
      // Re-prompt — user may have just enabled mic in their browser settings.
      void start();
    } else if (state.kind === 'capped') {
      // Cap is set per-day; nothing the user can do until tomorrow. No-op.
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────
  const dim = size === 'large' ? 60 : 28;
  const iconSize = size === 'large' ? 26 : 13;

  const isRecording = state.kind === 'recording';
  const isUploading = state.kind === 'uploading';
  const isDenied = state.kind === 'denied';
  const isError = state.kind === 'error';
  const isCapped = state.kind === 'capped';
  const isInactive = disabled || isCapped;

  const bg = isRecording
    ? '#D7563A'  // warm red for recording
    : isInactive
      ? 'var(--snow-rule, rgba(31, 35, 28, 0.08))'
      : 'var(--snow-ink, #1F231C)';
  const fg = isInactive ? 'var(--snow-ink3, #A6ABA6)' : 'white';

  const sizeStyle: React.CSSProperties = size === 'large'
    ? { width: 60, height: 60, borderRadius: 30 }
    : { width: 28, height: 28, borderRadius: 7 };

  const aria = isRecording
    ? 'Stop recording'
    : isUploading
      ? 'Transcribing'
      : isCapped
        ? 'Daily voice limit reached'
        : 'Start voice message';

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <button
        type="button"
        onClick={handleClick}
        disabled={isInactive || isUploading}
        aria-label={aria}
        title={aria}
        style={{
          ...sizeStyle,
          border: 'none',
          cursor: isInactive || isUploading ? 'default' : 'pointer',
          background: bg,
          color: fg,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'background 0.18s ease',
          // Pulse animation while recording.
          animation: isRecording ? 'staxis-mic-pulse 1.2s ease-in-out infinite' : undefined,
          boxShadow: size === 'large' ? '0 6px 18px rgba(31, 35, 28, 0.16)' : undefined,
        }}
      >
        {isUploading ? (
          <Loader2 size={iconSize} strokeWidth={2.4} className="staxis-spin" />
        ) : isDenied ? (
          <MicOff size={iconSize} strokeWidth={2.2} />
        ) : (
          <Mic size={iconSize} strokeWidth={2.2} />
        )}
      </button>
      {/* Recording status (small variant: hidden — counter shown on FAB only). */}
      {isRecording && size === 'large' && (
        <span style={{
          fontFamily: 'var(--font-geist-mono), monospace',
          fontSize: 13,
          letterSpacing: '0.04em',
          color: 'var(--snow-ink, #1F231C)',
        }}>
          Listening… 0:{String(state.durationSec).padStart(2, '0')}
        </span>
      )}
      {isDenied && (
        <span style={{
          fontFamily: 'var(--font-geist), sans-serif',
          fontSize: 12,
          color: 'var(--snow-ink2, #5C625C)',
          maxWidth: 200,
        }}>
          Enable microphone access in your browser settings.
        </span>
      )}
      {isError && (
        <span style={{
          fontFamily: 'var(--font-geist), sans-serif',
          fontSize: 12,
          color: 'var(--snow-warm, #B85C3D)',
          maxWidth: 200,
        }}>
          {state.message}
        </span>
      )}
      {isCapped && (
        <span style={{
          fontFamily: 'var(--font-geist), sans-serif',
          fontSize: 12,
          color: 'var(--snow-ink2, #5C625C)',
          maxWidth: 200,
        }}>
          You&rsquo;ve hit today&rsquo;s voice limit — typing still works.
        </span>
      )}
    </div>
  );
});
