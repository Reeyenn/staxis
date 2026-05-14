'use client';

// ─── useVoiceRecording — extracted recording lifecycle hook ──────────────
//
// Same logic the v1 VoiceButton component had inline, lifted out so both
// the old VoiceButton (until Step 7 deletes it) and the new
// VoiceModeOverlay can call it. No UI; pure state machine + browser
// audio plumbing.
//
// Behavior matches v1 exactly:
//   - getUserMedia({ audio: true }) with denial / unsupported fallbacks
//   - MediaRecorder on desktop / Chrome / Firefox / desktop Safari 17+
//   - recordrtc StereoAudioRecorder fallback on iOS Safari (no webm/opus)
//   - AudioContext + AnalyserNode RMS for silence detection (5s threshold)
//   - 60s hard cap via setTimeout
//   - Upload to /api/agent/transcribe with one silent retry on 5xx / network
//   - 429 → 'capped' state + onCapHit callback
//   - Empty transcript → 'error' state with friendly message

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';

export type RecordingState =
  | { kind: 'idle' }
  | { kind: 'recording'; startedAt: number; durationSec: number }
  | { kind: 'uploading' }
  | { kind: 'denied' }
  | { kind: 'error'; message: string }
  | { kind: 'capped' };

export interface UseVoiceRecordingOpts {
  propertyId: string | null;
  conversationId: string | null;
  onTranscript(text: string): void;
  /** Called when recording begins. Used eg to stop TTS playback. */
  onStartRecording?(): void;
  /** Called when /transcribe returns 429. */
  onCapHit?(): void;
}

export interface UseVoiceRecordingReturn {
  state: RecordingState;
  start(): Promise<void>;
  stop(): void;
}

const MAX_RECORDING_MS = 60_000;
// Time of continuous silence before we treat the user as "done speaking" and
// fire /transcribe. Was 5s in the first cut — felt agonizing in real use,
// added 5s on top of every turn. 800ms is the ChatGPT/Claude-voice norm.
// If users complain about mid-sentence cutoffs (pause-for-breath), raise to
// 1200ms before touching SILENCE_THRESHOLD.
const SILENCE_TIMEOUT_MS = 800;
// Anything below this RMS counts as silence. Kept conservative (0.012) so a
// quiet-room speaker doesn't get clipped mid-sentence. In a noisy hotel
// lobby this could under-detect silence (vacuum / PA / ice machine clear
// 0.012 routinely) — Phase 2 work is adaptive thresholding (rolling p95
// floor). For Phase 1 a fixed conservative threshold is the safer trade.
const SILENCE_THRESHOLD = 0.012;

function shouldUseRecordrtcFallback(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) && !('MSStream' in window);
  const hasWebmOpus =
    typeof MediaRecorder !== 'undefined' &&
    MediaRecorder.isTypeSupported('audio/webm;codecs=opus');
  return isIOS || !hasWebmOpus;
}

export function useVoiceRecording(opts: UseVoiceRecordingOpts): UseVoiceRecordingReturn {
  const { propertyId, conversationId, onTranscript, onStartRecording, onCapHit } = opts;

  const [state, setState] = useState<RecordingState>({ kind: 'idle' });

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<{
    stop: () => Promise<Blob | null>;
    mimeType: string;
  } | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const maxDurationTimerRef = useRef<number | null>(null);
  const durationTickRef = useRef<number | null>(null);
  const isStoppingRef = useRef(false);

  // Latest callbacks via ref so the imperative API doesn't restart on prop change.
  const onTranscriptRef = useRef(onTranscript);
  const onStartRecordingRef = useRef(onStartRecording);
  const onCapHitRef = useRef(onCapHit);
  useEffect(() => { onTranscriptRef.current = onTranscript; }, [onTranscript]);
  useEffect(() => { onStartRecordingRef.current = onStartRecording; }, [onStartRecording]);
  useEffect(() => { onCapHitRef.current = onCapHit; }, [onCapHit]);

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

  useEffect(() => () => cleanup(), [cleanup]);

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
        res = await doFetch();  // one silent retry on 5xx
      }
    } catch {
      try {
        res = await doFetch();  // one silent retry on network error
      } catch (e) {
        setState({ kind: 'error', message: "Couldn't hear you, tap to retry." });
        console.error('[useVoiceRecording] transcribe network error', e);
        return;
      }
    }

    if (res.status === 429) {
      setState({ kind: 'capped' });
      onCapHitRef.current?.();
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
    onTranscriptRef.current(transcript.trim());
  }, [propertyId, conversationId]);

  const buildRecorder = useCallback(async (stream: MediaStream): Promise<{
    stop: () => Promise<Blob | null>;
    mimeType: string;
  }> => {
    if (shouldUseRecordrtcFallback()) {
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
            try { resolve(rec.getBlob()); } catch { resolve(null); }
          });
        }),
      };
    }

    const mr = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
    const chunks: BlobPart[] = [];
    mr.ondataavailable = (ev) => { if (ev.data.size > 0) chunks.push(ev.data); };
    mr.start(250);
    return {
      mimeType: 'audio/webm',
      stop: () => new Promise<Blob | null>((resolve) => {
        mr.onstop = () => resolve(new Blob(chunks, { type: 'audio/webm' }));
        try { mr.stop(); } catch { resolve(null); }
      }),
    };
  }, []);

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

  const start = useCallback(async () => {
    setState(prev => {
      if (prev.kind === 'recording' || prev.kind === 'uploading') return prev;
      return prev;
    });
    // Re-read state to avoid double-start.
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setState({ kind: 'error', message: 'This browser does not support recording.' });
      return;
    }

    onStartRecordingRef.current?.();

    let stream: MediaStream;
    try {
      // Explicit AEC / NS / AGC. Browser defaults usually enable these but
      // the spec leaves it to the implementation, and without echoCancellation
      // on a laptop the mic picks up Nova's TTS audio from the speakers and
      // re-transcribes it — Nova ends up talking to herself. Forcing the
      // constraints here closes that feedback path even on browsers that
      // default them off (some Android Chromium builds).
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (e) {
      const errName = (e as { name?: string })?.name;
      if (errName === 'NotAllowedError' || errName === 'PermissionDeniedError') {
        setState({ kind: 'denied' });
      } else {
        setState({ kind: 'error', message: "Couldn't access your microphone." });
        console.error('[useVoiceRecording] getUserMedia failed', e);
      }
      return;
    }

    streamRef.current = stream;

    try {
      recorderRef.current = await buildRecorder(stream);
    } catch (e) {
      console.error('[useVoiceRecording] recorder init failed', e);
      cleanup();
      setState({ kind: 'error', message: 'Recording failed to start.' });
      return;
    }

    // Silence detection.
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
          finishRecording().catch((e) => console.error('[useVoiceRecording] silence-stop failed', e));
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
  }, [buildRecorder, cleanup, finishRecording]);

  const stop = useCallback(() => {
    setState(prev => {
      if (prev.kind === 'recording') void finishRecording();
      return prev;
    });
  }, [finishRecording]);

  return { state, start, stop };
}
