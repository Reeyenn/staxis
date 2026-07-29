'use client';

import React from 'react';

import { fetchWithAuth } from '@/lib/api-fetch';
import { AssistantMarkdown } from '@/components/agent/AssistantMarkdown';
import styles from './PortfolioAsk.module.css';

interface PortfolioAskProps {
  organizationId: string;
  organizationName: string;
  available: boolean;
  unavailableReason?: string | null;
}

interface StreamFrame {
  type?: string;
  delta?: string;
  finalText?: string;
  message?: string;
  code?: string;
  id?: string;
  conversationId?: string;
}

/**
 * The server has its own bounded execution budget, but a response body can
 * still become disconnected after the headers arrive. Keep this below that
 * outer budget so the client always reaches an honest, retryable terminal
 * state instead of leaving assistive technology on an endless `aria-busy`.
 */
export const PORTFOLIO_ASK_STREAM_INACTIVITY_MS = 30_000;
/** Hard stop even when a broken intermediary keeps sending meaningless bytes. */
export const PORTFOLIO_ASK_ABSOLUTE_MS = 60_000;
/** A portfolio answer is prose, not an unbounded transport or data-export surface. */
export const PORTFOLIO_ASK_MAX_FRAME_CHARS = 128 * 1024;
export const PORTFOLIO_ASK_MAX_ANSWER_CHARS = 64 * 1024;

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ActiveRequest {
  sequence: number;
  controller: AbortController;
  cancel(): void;
}

function streamPayload(frame: string): string | null {
  const trimmed = frame.trim();
  if (!trimmed) return null;

  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart());

  // The production route emits SSE. Accepting a bare JSON frame as well makes
  // the EOF path tolerant of standards-compliant stream adapters that remove
  // the SSE field prefix while preserving the same closed JSON contract.
  return dataLines.length > 0 ? dataLines.join('\n') : trimmed;
}

function unavailableCopy(reason: string | null | undefined, organizationName: string): string {
  if (reason === 'company_setting_off') {
    return `Ask Staxis is turned off for ${organizationName}. A company owner can enable it in My Portfolio.`;
  }
  if (reason === 'no_hotels') {
    return `Ask Staxis will be available after ${organizationName} has an authorized hotel.`;
  }
  if (reason === 'settings_unavailable' || reason === 'invalid_company_setting') {
    return 'Ask Staxis could not verify the company setting just now. No hotel information was sent.';
  }
  return `Ask Staxis is not available for ${organizationName}.`;
}

export function PortfolioAsk({
  organizationId,
  organizationName,
  available,
  unavailableReason,
}: PortfolioAskProps) {
  const [question, setQuestion] = React.useState('');
  const [asked, setAsked] = React.useState<string | null>(null);
  const [answer, setAnswer] = React.useState('');
  const [conversationId, setConversationId] = React.useState<string | null>(null);
  const [state, setState] = React.useState<'idle' | 'streaming' | 'failed'>('idle');
  const requestRef = React.useRef<ActiveRequest | null>(null);
  const sequenceRef = React.useRef(0);

  React.useEffect(() => {
    sequenceRef.current += 1;
    requestRef.current?.controller.abort();
    requestRef.current?.cancel();
    requestRef.current = null;
    setQuestion('');
    setAsked(null);
    setAnswer('');
    setConversationId(null);
    setState('idle');
    return () => {
      sequenceRef.current += 1;
      requestRef.current?.controller.abort();
      requestRef.current?.cancel();
      requestRef.current = null;
    };
  }, [available, organizationId]);

  const send = React.useCallback(async (retryMessage?: string) => {
    const message = (retryMessage ?? question).trim();
    if (!available || !message || state === 'streaming') return;
    setAsked(message);
    setQuestion('');
    setAnswer('');
    setState('streaming');
    requestRef.current?.cancel();
    const controller = new AbortController();
    const sequence = ++sequenceRef.current;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
    let absoluteTimer: ReturnType<typeof setTimeout> | null = null;
    let deadlineExpired = false;
    let sawDone = false;
    let terminalFailure = false;

    const clearInactivityDeadline = () => {
      if (inactivityTimer !== null) {
        clearTimeout(inactivityTimer);
        inactivityTimer = null;
      }
    };
    const clearAbsoluteDeadline = () => {
      if (absoluteTimer !== null) {
        clearTimeout(absoluteTimer);
        absoluteTimer = null;
      }
    };
    const clearDeadlines = () => {
      clearInactivityDeadline();
      clearAbsoluteDeadline();
    };
    const ownsRequest = () => requestRef.current?.sequence === sequence;
    const cancel = () => {
      clearDeadlines();
      controller.abort();
      if (reader) void reader.cancel('portfolio ask stream cancelled').catch(() => undefined);
    };
    requestRef.current = { sequence, controller, cancel };
    const isCurrent = () => (
      ownsRequest()
      && !controller.signal.aborted
    );
    const failCurrentRequest = () => {
      if (!ownsRequest() || sawDone) return;
      terminalFailure = true;
      // The server persists the user turn before it emits its first byte. A
      // failed retry must therefore start a fresh conversation rather than
      // append the same user sentence to a possibly half-finished thread.
      setConversationId(null);
      setAnswer('');
      setState('failed');
    };
    const resetInactivityDeadline = () => {
      clearInactivityDeadline();
      inactivityTimer = setTimeout(() => {
        if (!ownsRequest()) return;
        deadlineExpired = true;
        failCurrentRequest();
        cancel();
      }, PORTFOLIO_ASK_STREAM_INACTIVITY_MS);
    };
    absoluteTimer = setTimeout(() => {
      if (!ownsRequest()) return;
      deadlineExpired = true;
      failCurrentRequest();
      cancel();
    }, PORTFOLIO_ASK_ABSOLUTE_MS);

    resetInactivityDeadline();
    try {
      const response = await fetchWithAuth('/api/agent/portfolio', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message,
          organizationId,
          ...(conversationId ? { conversationId } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error(`portfolio chat ${response.status}`);

      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let streamed = '';

      const processFrame = (frame: string): 'continue' | 'done' | 'failed' => {
        const encodedPayload = streamPayload(frame);
        if (!encodedPayload || encodedPayload === '[DONE]') return 'continue';
        if (encodedPayload.length > PORTFOLIO_ASK_MAX_FRAME_CHARS) {
          failCurrentRequest();
          return 'failed';
        }
        let payload: StreamFrame;
        try { payload = JSON.parse(encodedPayload) as StreamFrame; } catch { return 'continue'; }
        if (!isCurrent()) return 'continue';

        if (payload.type === 'conversation_id') {
          const nextConversationId = payload.id ?? payload.conversationId;
          if (!nextConversationId || !UUID_RX.test(nextConversationId)) {
            failCurrentRequest();
            return 'failed';
          }
          resetInactivityDeadline();
          setConversationId(nextConversationId);
          return 'continue';
        }

        if (payload.type === 'text_delta' && typeof payload.delta === 'string' && payload.delta) {
          if (streamed.length + payload.delta.length > PORTFOLIO_ASK_MAX_ANSWER_CHARS) {
            failCurrentRequest();
            return 'failed';
          }
          resetInactivityDeadline();
          streamed += payload.delta;
          setAnswer(streamed);
          return 'continue';
        }

        if (payload.type === 'done') {
          if (!streamed && typeof payload.finalText === 'string') {
            if (payload.finalText.length > PORTFOLIO_ASK_MAX_ANSWER_CHARS) {
              failCurrentRequest();
              return 'failed';
            }
            streamed = payload.finalText;
          }
          if (!streamed.trim()) {
            failCurrentRequest();
            return 'failed';
          }
          resetInactivityDeadline();
          sawDone = true;
          setAnswer(streamed);
          setState('idle');
          return 'done';
        }

        if (payload.type === 'error') {
          // Never render a provider, database, or stack-adjacent error string.
          // The portfolio route also sanitizes this frame, but the client is a
          // second boundary for older servers and intermediaries.
          failCurrentRequest();
          return 'failed';
        }

        // Unknown frames neither render nor extend the inactivity window.
        return 'continue';
      };

      const processCompleteFrames = (): 'continue' | 'done' | 'failed' => {
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const result = processFrame(frame);
          if (result !== 'continue') return result;
        }
        return 'continue';
      };

      let terminal: 'continue' | 'done' | 'failed' = 'continue';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const decoded = decoder.decode(value, { stream: true });
        if (buffer.length + decoded.length > PORTFOLIO_ASK_MAX_FRAME_CHARS) {
          failCurrentRequest();
          terminal = 'failed';
          break;
        }
        buffer += decoded;
        terminal = processCompleteFrames();
        if (terminal !== 'continue') break;
      }
      if (terminal === 'continue') {
        const flushed = decoder.decode();
        if (buffer.length + flushed.length > PORTFOLIO_ASK_MAX_FRAME_CHARS) {
          failCurrentRequest();
          terminal = 'failed';
        } else {
          buffer += flushed;
          terminal = processCompleteFrames();
          if (terminal === 'continue' && buffer.trim()) terminal = processFrame(buffer);
        }
      }

      // EOF, disconnect, or malformed traffic without the route's explicit
      // done frame is not a completed operational answer, even when deltas
      // happened to render first.
      if (terminal !== 'done' && !sawDone) failCurrentRequest();
      if (terminal !== 'continue') cancel();
    } catch (error) {
      const wasAborted = error instanceof Error && error.name === 'AbortError';
      if (ownsRequest() && !sawDone && !terminalFailure && (deadlineExpired || !wasAborted)) {
        failCurrentRequest();
      }
    } finally {
      clearDeadlines();
      try { reader?.releaseLock(); } catch { /* an aborted read may still own the lock */ }
      if (requestRef.current?.sequence === sequence) requestRef.current = null;
    }
  }, [available, conversationId, organizationId, question, state]);

  const retryMessage = state === 'failed' && question.trim().length === 0 ? asked : null;

  if (!available) {
    return (
      <div className={styles.root}>
        <div className={styles.unavailable} role="status">
          {unavailableCopy(unavailableReason, organizationName)}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.composer}>
        <span className={styles.spark} aria-hidden="true">✦</span>
        <input
          className={styles.input}
          value={question}
          maxLength={4000}
          aria-label={`Ask Staxis about ${organizationName}`}
          placeholder="Ask across your hotels…"
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send(undefined);
            }
          }}
        />
        <button
          type="button"
          className={styles.send}
          disabled={state === 'streaming' || (question.trim().length === 0 && !retryMessage)}
          onClick={() => void send(retryMessage ?? undefined)}
        >
          {state === 'streaming' ? 'Reading…' : retryMessage ? 'Try again' : 'Ask'}
        </button>
      </div>

      {asked ? (
        <div className={styles.answer} aria-live="polite" aria-busy={state === 'streaming'}>
          <span className={styles.question}>{asked}</span>
          {state === 'failed'
            ? 'Staxis could not answer just now. Nothing about your hotels changed.'
            : answer
              ? <AssistantMarkdown text={answer} />
              : 'Reading your hotels…'}
        </div>
      ) : null}
    </div>
  );
}
