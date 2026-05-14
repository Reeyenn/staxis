'use client';

// ─── WakeWord — "Hey Staxis" / "Oye Staxis" background listener ──────────
//
// Mounted in AppLayout when:
//   1. The user has wake_word_enabled=true (accounts column)
//   2. /api/agent/wake-word-available returns { available: true } — both
//      .ppn keyword files exist on disk AND PICOVOICE_ACCESS_KEY is set
//
// Otherwise the component renders nothing and never loads the Picovoice
// SDK — keeps the bundle slim and the mic permission untouched.
//
// Detection behavior (INV-21):
//   - Active only when document.visibilityState === 'visible'. Hidden
//     tabs stop the worker via release(); becoming visible again restarts.
//   - On wake fire (Hey/Oye Staxis): openPanelAndRecord() — the panel
//     slides in, VoiceButton.start() runs.
//   - "STOP" built-in keyword: if there's anything playing on the page's
//     audio, the wake worker can't reach it directly. We post a custom
//     CustomEvent('staxis:tts-stop') that the panel's TtsPlayer listens
//     for. (Implemented in TtsPlayer via a window-level handler — see
//     follow-up if/when wake stop is wired live.)

import { useEffect, useRef, useState } from 'react';
import { useVoicePanel } from './VoicePanelContext';
import { fetchWithAuth } from '@/lib/api-fetch';

interface PorcupineKeyword {
  publicPath?: string;
  builtin?: string;  // 'Stop' is a Porcupine built-in
  label: string;
}

interface PorcupineDetection {
  label: string;
}

// Loose typing to avoid taking on @picovoice types as a hard import at the
// top of the file. The runtime import is dynamic so the SDK isn't in the
// main bundle unless the wake-word feature is actually wired up.
interface PorcupineWorkerLike {
  start(): Promise<void>;
  release(): Promise<void>;
}

interface WebVoiceProcessorLike {
  subscribe(consumer: unknown): Promise<void>;
  unsubscribe(consumer: unknown): Promise<void>;
}

export function WakeWord() {
  const ctx = useVoicePanel();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [accessKey, setAccessKey] = useState<string | null>(null);
  const workerRef = useRef<PorcupineWorkerLike | null>(null);
  const wvpRef = useRef<WebVoiceProcessorLike | null>(null);

  // ── Probe availability + key on mount ──────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Check 1: feature-gated by file presence + env var.
        const a = await fetchWithAuth('/api/agent/wake-word-available');
        if (cancelled) return;
        if (!a.ok) { setAvailable(false); return; }
        const ab = await a.json();
        const isAvailable = ab.data?.available === true;
        setAvailable(isAvailable);
        if (!isAvailable) return;

        // Check 2: user has enabled it.
        const pref = await fetchWithAuth('/api/agent/voice-preference');
        if (cancelled) return;
        if (!pref.ok) return;
        const prefBody = await pref.json();
        if (prefBody.data?.wakeWordEnabled !== true) return;

        // Pull the access key.
        const keyRes = await fetchWithAuth('/api/agent/picovoice-key');
        if (cancelled) return;
        if (!keyRes.ok) return;
        const keyBody = await keyRes.json();
        setAccessKey(keyBody.data?.accessKey ?? null);
      } catch (e) {
        console.warn('[WakeWord] availability probe failed', e);
        setAvailable(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Initialize the Porcupine worker when we have key + visibility ─────
  useEffect(() => {
    if (!ctx || !available || !accessKey) return;
    if (typeof window === 'undefined') return;

    let releaseRequested = false;

    const onDetect = (detection: PorcupineDetection) => {
      const label = detection.label.toLowerCase();
      if (label === 'stop') {
        // Built-in stop wake — interrupt any TTS that's playing.
        try {
          window.dispatchEvent(new CustomEvent('staxis:tts-stop'));
        } catch { /* ignore */ }
        return;
      }
      // "Hey Staxis" / "Oye Staxis" — open panel + record.
      ctx.openPanelAndRecord();
    };

    const start = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        // Dynamic imports — keep these out of the main bundle.
        const porcupine = await import('@picovoice/porcupine-web');
        const wvpMod = await import('@picovoice/web-voice-processor');

        const keywords: PorcupineKeyword[] = [
          { publicPath: '/wake-words/hey-staxis.ppn', label: 'Hey Staxis' },
          { publicPath: '/wake-words/oye-staxis.ppn', label: 'Oye Staxis' },
          // Built-in "stop" keyword — bundled with the worker, no .ppn needed.
          // The library accepts the string name when registered as a built-in.
          { builtin: 'Stop', label: 'Stop' } as unknown as PorcupineKeyword,
        ];

        // Worker model file — bundled with the SDK; loaded over HTTP at runtime.
        // Picovoice's web worker expects `modelPath` pointing to .pv. We
        // upload the model under /wake-words/porcupine_params.pv (one-time
        // step in the wake-word setup doc).
        const PorcupineWorker = (porcupine as unknown as {
          PorcupineWorker: {
            create(
              accessKey: string,
              keywords: PorcupineKeyword[],
              onDetection: (d: PorcupineDetection) => void,
              model: { publicPath: string },
            ): Promise<PorcupineWorkerLike>;
          };
        }).PorcupineWorker;
        if (!PorcupineWorker?.create) {
          console.warn('[WakeWord] Porcupine SDK shape changed; aborting init');
          return;
        }

        const worker = await PorcupineWorker.create(
          accessKey,
          keywords,
          onDetect,
          { publicPath: '/wake-words/porcupine_params.pv' },
        );
        if (releaseRequested) {
          await worker.release().catch(() => {});
          return;
        }
        workerRef.current = worker;

        const WebVoiceProcessor = (wvpMod as unknown as {
          WebVoiceProcessor: WebVoiceProcessorLike;
        }).WebVoiceProcessor;
        wvpRef.current = WebVoiceProcessor;
        await WebVoiceProcessor.subscribe(worker);
      } catch (e) {
        console.warn('[WakeWord] init failed (asset missing or perms denied)', e);
      }
    };

    const teardown = async () => {
      if (wvpRef.current && workerRef.current) {
        try { await wvpRef.current.unsubscribe(workerRef.current); } catch { /* ignore */ }
      }
      if (workerRef.current) {
        try { await workerRef.current.release(); } catch { /* ignore */ }
        workerRef.current = null;
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        if (!workerRef.current) void start();
      } else {
        void teardown();
      }
    };

    void start();
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      releaseRequested = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      void teardown();
    };
  }, [ctx, available, accessKey]);

  return null;
}
