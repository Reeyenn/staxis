'use client';

// ─── WalkthroughOverlay — the Clicky-style cursor demo ───────────────────
// Mounted once globally inside AppLayout. Sits idle until the agent
// chatbot fires the `walk_user_through` tool, then takes over the page:
// snapshots the live DOM → asks /api/walkthrough/step what to do next →
// animates a cursor to the target element → narrates via Web Speech →
// waits for the user to actually click → loops.
//
// Teach-only: the cursor NEVER auto-clicks. The user does the click
// themselves. The overlay listens for any click event to detect
// progress; if they click somewhere unexpected, the next step is sent
// with `deviated: true` and Claude adapts from the new page state.
//
// Triggers come in via the `agent:tool-call-started` window event that
// `useAgentChat` mirrors from the SSE stream (see useAgentChat.ts side
// channel). When the walkthrough starts, we dispatch `walkthrough:start`
// so the chat panel can close itself.
//
// Mobile (touch): a flying cursor doesn't fit a phone metaphor. We swap
// to a pulsing outline on the target element + a "Tap here" pill.

import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import { Cursor, TargetHighlight } from './Cursor';
import { snapshotInteractiveElements, serializeSnapshot, type SnapshotElement } from './snapshotDom';

// ─── Constants ───────────────────────────────────────────────────────────

const MAX_STEPS = 12;
const DOM_SETTLE_MS = 500;
const CURSOR_FLIGHT_MS = 700;

// ─── Types matching /api/walkthrough/step ────────────────────────────────

interface HistoryEntry {
  narration: string;
  targetName?: string;
  /** elementId from the snapshot Claude picked for this step. Sent back to
   * the server so Claude can avoid repeating itself. */
  targetElementId?: string;
  deviated?: boolean;
  deviatedTo?: string;
}

type StepAction =
  | { type: 'click'; elementId: string; narration: string; done?: false }
  | { type: 'done'; narration: string }
  | { type: 'cannot_help'; narration: string };

interface StepResponseOk {
  ok: true;
  action: StepAction;
}
interface StepResponseErr {
  ok: false;
  error: string;
  code?: string;
}
type StepResponse = StepResponseOk | StepResponseErr;

// ─── Component ───────────────────────────────────────────────────────────

export function WalkthroughOverlay() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();

  const [mode, setMode] = useState<'idle' | 'running' | 'loading' | 'done' | 'error'>('idle');
  const [caption, setCaption] = useState<string>('');
  const [target, setTarget] = useState<{ rect: { x: number; y: number; width: number; height: number }; name: string } | null>(null);
  const [step, setStep] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isTouch, setIsTouch] = useState(false);

  // Refs — don't trigger re-render.
  const runIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const taskRef = useRef<string>('');
  const historyRef = useRef<HistoryEntry[]>([]);

  // ── Touch detection ──────────────────────────────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(hover: none)');
    setIsTouch(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsTouch(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // ── TTS helper — fire-and-forget. Safari and Chrome diverge slightly
  //    on cancel behavior; we just cancel-then-speak to keep it simple.
  const speak = useCallback((text: string) => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    if (!text?.trim()) return;
    try {
      window.speechSynthesis.cancel();
      const utt = new SpeechSynthesisUtterance(text);
      utt.rate = 1.0;
      utt.pitch = 1.0;
      utt.volume = 1.0;
      window.speechSynthesis.speak(utt);
    } catch {
      // Best effort — TTS isn't critical
    }
  }, []);

  const stopSpeech = useCallback(() => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
  }, []);

  // ── Stop / cleanup ──────────────────────────────────────────────────
  const stop = useCallback(() => {
    runIdRef.current += 1;          // invalidate any in-flight loop
    abortRef.current?.abort();
    abortRef.current = null;
    stopSpeech();
    setMode('idle');
    setTarget(null);
    setCaption('');
    setStep(0);
    setErrorMsg(null);
    historyRef.current = [];
  }, [stopSpeech]);

  const showError = useCallback((msg: string) => {
    setMode('error');
    setErrorMsg(msg);
    setCaption(msg);
    setTarget(null);
    speak(msg);
  }, [speak]);

  // ── The per-step loop ────────────────────────────────────────────────
  const runLoop = useCallback(async (task: string) => {
    if (!activePropertyId) return;
    const myRunId = ++runIdRef.current;
    const abort = new AbortController();
    abortRef.current = abort;

    taskRef.current = task;
    historyRef.current = [];
    setErrorMsg(null);
    setCaption(`Starting: ${task}`);
    setMode('loading');
    setStep(0);
    setTarget(null);

    // Tell the chat panel to minimize.
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('walkthrough:start', { detail: { task } }));
    }

    for (let i = 0; i < MAX_STEPS; i++) {
      if (myRunId !== runIdRef.current) return;
      setStep(i + 1);
      setMode('loading');

      // Let the page settle before snapshotting (esp. after a navigation).
      await sleep(DOM_SETTLE_MS, abort.signal);
      if (myRunId !== runIdRef.current) return;

      const snapshot = snapshotInteractiveElements();
      let body: StepResponse;
      try {
        const res = await fetchWithAuth('/api/walkthrough/step', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            task: taskRef.current,
            propertyId: activePropertyId,
            history: historyRef.current,
            snapshot: serializeSnapshot(snapshot),
          }),
          signal: abort.signal,
        });
        if (myRunId !== runIdRef.current) return;
        if (!res.ok) {
          const errBody = (await res.json().catch(() => null)) as StepResponseErr | null;
          const msg = errBody?.error ?? `Step request failed (${res.status})`;
          showError(msg);
          return;
        }
        body = (await res.json()) as StepResponse;
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return;
        showError(err instanceof Error ? err.message : 'Network error');
        return;
      }
      if (myRunId !== runIdRef.current) return;

      if (!body.ok) {
        showError(body.error);
        return;
      }

      const action = body.action;
      if (action.type === 'done') {
        setMode('done');
        setCaption(action.narration);
        speak(action.narration);
        setTarget(null);
        // Auto-clear after a brief moment so the cursor doesn't linger.
        setTimeout(() => {
          if (myRunId === runIdRef.current) stop();
        }, 3500);
        return;
      }
      if (action.type === 'cannot_help') {
        setMode('error');
        setErrorMsg(action.narration);
        setCaption(action.narration);
        speak(action.narration);
        setTarget(null);
        return;
      }
      // action.type === 'click'
      const node = snapshot.byId.get(action.elementId);
      const meta = snapshot.elements.find(e => e.id === action.elementId);
      if (!node || !meta) {
        showError("I couldn't find that button on the page anymore — try asking again.");
        return;
      }

      // Scroll the target into view if it's off-screen, then re-measure.
      if (!meta.inViewport) {
        node.scrollIntoView({ block: 'center', behavior: 'smooth' });
        await sleep(400, abort.signal);
        if (myRunId !== runIdRef.current) return;
      }
      const liveRect = node.getBoundingClientRect();
      setTarget({
        rect: {
          x: liveRect.x,
          y: liveRect.y,
          width: liveRect.width,
          height: liveRect.height,
        },
        name: meta.name,
      });
      setCaption(action.narration);
      speak(action.narration);
      setMode('running');

      // Wait for the cursor to arrive before recording history, then wait
      // for the user to actually click.
      await sleep(CURSOR_FLIGHT_MS, abort.signal);
      if (myRunId !== runIdRef.current) return;

      const click = await waitForClick(node, abort.signal);
      if (myRunId !== runIdRef.current) return;

      historyRef.current.push({
        narration: action.narration,
        targetName: meta.name,
        targetElementId: action.elementId,
        ...(click.onTarget
          ? {}
          : {
              deviated: true,
              deviatedTo: click.clickedName?.slice(0, 120) ?? '(unknown element)',
            }),
      });

      // If the user deviated, the next iteration will re-snapshot and let
      // Claude adapt. Either way we just continue the loop.
    }

    // Step cap hit.
    const msg = "I got a bit lost — try rephrasing your question and I'll start over.";
    setCaption(msg);
    setMode('error');
    setErrorMsg(msg);
    speak(msg);
    setTarget(null);
  }, [activePropertyId, speak, stop, showError]);

  // ── Listen for the agent firing walk_user_through ──────────────────
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!user || !activePropertyId) return;

    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as
        | { type?: string; call?: { name?: string; args?: { task?: string } } }
        | undefined;
      const call = detail?.call;
      if (!call || call.name !== 'walk_user_through') return;
      const task = (call.args?.task ?? '').trim();
      if (!task) return;
      void runLoop(task);
    };
    window.addEventListener('agent:tool-call-started', handler);
    return () => window.removeEventListener('agent:tool-call-started', handler);
  }, [user, activePropertyId, runLoop]);

  // ── Cleanup on unmount ───────────────────────────────────────────────
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      stopSpeech();
    };
  }, [stopSpeech]);

  // ── Render ──────────────────────────────────────────────────────────
  if (mode === 'idle') return null;
  if (!user || !activePropertyId) return null;

  // The cursor tip lives roughly 4px in from the top-left of the SVG; we
  // want it to land near the center of the target's left edge so the
  // arrow "points at" the button without obscuring its label.
  const cursorAnchor = target
    ? { x: target.rect.x + target.rect.width / 2, y: target.rect.y + target.rect.height / 2 }
    : { x: window.innerWidth / 2, y: window.innerHeight / 2 };

  const hintLabel = isTouch ? 'Tap here' : 'Click here';

  return (
    <>
      {/* Target outline — always rendered when we have a target. */}
      <TargetHighlight
        rect={target?.rect ?? null}
        visible={mode === 'running' && !!target}
      />

      {/* Desktop floating cursor. Hidden on touch (no mouse metaphor). */}
      {!isTouch && (
        <Cursor
          x={cursorAnchor.x}
          y={cursorAnchor.y}
          visible={mode === 'running' && !!target}
          pulsing={mode === 'running' && !!target}
        />
      )}

      {/* "Tap here" / "Click here" pill near the target. */}
      {mode === 'running' && target && (
        <HintPill
          rect={target.rect}
          label={hintLabel}
        />
      )}

      {/* Caption + Stop button — fixed bottom of the screen. */}
      <CaptionBar
        text={caption}
        step={step}
        mode={mode}
        errorMsg={errorMsg}
        onStop={stop}
      />
    </>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────

function HintPill({ rect, label }: { rect: { x: number; y: number; width: number; height: number }; label: string }) {
  // Anchor below the target if there's room; otherwise above.
  const viewportH = typeof window !== 'undefined' ? window.innerHeight : 800;
  const placeBelow = rect.y + rect.height + 40 < viewportH - 100;
  const top = placeBelow ? rect.y + rect.height + 10 : rect.y - 36;
  return (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        top: Math.round(top),
        left: Math.round(rect.x + rect.width / 2),
        transform: 'translateX(-50%)',
        background: 'var(--snow-ink, #1F231C)',
        color: 'white',
        padding: '6px 12px',
        borderRadius: 999,
        fontSize: 12,
        fontFamily: "var(--font-geist), -apple-system, sans-serif",
        fontWeight: 600,
        letterSpacing: '0.01em',
        boxShadow: '0 6px 16px rgba(31, 35, 28, 0.20)',
        pointerEvents: 'none',
        zIndex: 9998,
        whiteSpace: 'nowrap',
        transition: 'top 700ms cubic-bezier(0.4, 0, 0.2, 1), left 700ms cubic-bezier(0.4, 0, 0.2, 1)',
      }}
    >
      {label}
    </div>
  );
}

function CaptionBar({
  text, step, mode, errorMsg, onStop,
}: {
  text: string;
  step: number;
  mode: 'idle' | 'running' | 'loading' | 'done' | 'error';
  errorMsg: string | null;
  onStop: () => void;
}) {
  const isError = mode === 'error';
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        bottom: 'max(24px, env(safe-area-inset-bottom, 24px))',
        left: '50%',
        transform: 'translateX(-50%)',
        maxWidth: 'min(640px, 92vw)',
        background: isError ? 'var(--snow-warm, #B85C3D)' : 'var(--snow-ink, #1F231C)',
        color: 'white',
        padding: '14px 18px',
        borderRadius: 14,
        boxShadow: '0 12px 32px rgba(31, 35, 28, 0.22), 0 3px 8px rgba(31, 35, 28, 0.12)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        fontFamily: "var(--font-geist), -apple-system, sans-serif",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        {step > 0 && !isError && (
          <div
            style={{
              fontSize: 9,
              textTransform: 'uppercase',
              letterSpacing: '0.14em',
              opacity: 0.6,
              fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
              marginBottom: 4,
            }}
          >
            {mode === 'loading' ? 'Thinking…' : mode === 'done' ? 'Done' : `Step ${step}`}
          </div>
        )}
        <div style={{ fontSize: 14, lineHeight: 1.4, fontWeight: 500 }}>
          {errorMsg ?? text}
        </div>
      </div>
      <button
        onClick={onStop}
        aria-label="Stop walkthrough"
        title="Stop walkthrough"
        style={{
          flexShrink: 0,
          width: 32,
          height: 32,
          borderRadius: 8,
          border: 'none',
          background: 'rgba(255, 255, 255, 0.12)',
          color: 'white',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'background 0.15s ease',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.22)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.12)'; }}
      >
        <X size={16} strokeWidth={2.4} />
      </button>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const id = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(id);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort);
  });
}

interface ClickOutcome {
  onTarget: boolean;
  clickedName?: string;
}

function waitForClick(target: HTMLElement, signal: AbortSignal): Promise<ClickOutcome> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve({ onTarget: false });
      return;
    }
    const handler = (ev: MouseEvent) => {
      const clicked = ev.target as HTMLElement | null;
      if (!clicked) return;
      // Ignore clicks inside the overlay's own UI (caption bar, stop button).
      // Those have aria-live="polite" or role="status" on ancestors so we
      // can detect them by walking up; simpler is to check zIndex via
      // closest with a sentinel class. We use the X-icon button's aria-label.
      const inOverlay = clicked.closest('[aria-label="Stop walkthrough"]');
      if (inOverlay) return; // user is interacting with overlay, not the page

      const onTarget = target === clicked || target.contains(clicked);
      const name = onTarget
        ? undefined
        : (clicked.getAttribute('aria-label')
            ?? clicked.textContent?.replace(/\s+/g, ' ').trim().slice(0, 120)
            ?? '');
      cleanup();
      resolve({ onTarget, clickedName: name || undefined });
    };
    const onAbort = () => {
      cleanup();
      resolve({ onTarget: false });
    };
    const cleanup = () => {
      document.removeEventListener('click', handler, true);
      signal.removeEventListener('abort', onAbort);
    };
    document.addEventListener('click', handler, true);
    signal.addEventListener('abort', onAbort);
  });
}
