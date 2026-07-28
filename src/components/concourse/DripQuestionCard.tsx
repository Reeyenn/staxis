'use client';

// ═══════════════════════════════════════════════════════════════════════════
// DripQuestionCard — the ONE thing Staxis asks the manager.
//
// Staxis already notices patterns in the hotel's own records ("4 hvac work
// orders on room 214 in 30 days"). This card turns one of them, occasionally,
// into a single question the manager can answer with one tap:
//
//     "4 hvac work orders on room 214 in the last 30 days — known problem room?"
//                              [ Yes ]  [ No ]
//
// A "yes" becomes a confirmed fact the copilot keeps forever. A "no" is
// recorded and the question is never asked again.
//
// THE TWO RULES THIS COMPONENT IS BUILT AROUND
//   1. At most ONE per session. The first fetch spends the session's question
//      (whether or not one came back), so answering never reveals a second card
//      and neither does navigating away and back.
//   2. It never adds a step to anyone's job. It renders nothing at all when
//      there is nothing to ask, it is dismissible, it never blocks anything,
//      and every failure path — offline, 500, no permission, missing table —
//      renders NOTHING rather than an error. A question is a nicety; it must
//      never be the reason a manager's screen looks broken.
//
// Reads/writes go through /api/memory/question (service-role behind
// requireSession) — never the browser Supabase client.
// ═══════════════════════════════════════════════════════════════════════════

import React from 'react';
import { CxIcon } from './icons';
import { useProperty } from '@/contexts/PropertyContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import { readEnvelope } from '@/lib/api-envelope';
import {
  alreadyAskedThisSession,
  markAskedThisSession,
  browserSessionStore,
} from '@/lib/drip-question-session';

interface Question {
  topic: string;
  category: string;
  en: string;
  es: string;
}

type Phase = 'idle' | 'showing' | 'saving' | 'thanks' | 'gone';

/** How long the "saved" confirmation lingers before the card removes itself. */
const THANKS_MS = 2200;

export function DripQuestionCard({ lang }: { lang: 'en' | 'es' }) {
  const es = lang === 'es';
  const { activePropertyId } = useProperty();
  const [question, setQuestion] = React.useState<Question | null>(null);
  const [phase, setPhase] = React.useState<Phase>('idle');

  // Ask the server for this session's single question, once.
  React.useEffect(() => {
    const pid = activePropertyId;
    if (!pid) return;
    const store = browserSessionStore();
    if (alreadyAskedThisSession(store, pid)) return;
    // Spend the session's question BEFORE the request resolves: a double mount
    // (React strict mode, a fast re-render) must not produce two cards.
    markAskedThisSession(store, pid);

    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithAuth(
          `/api/memory/question?propertyId=${encodeURIComponent(pid)}`,
        );
        const body = await readEnvelope<{ question: Question | null }>(res);
        if (cancelled || body.error || !body.data?.question) return;
        setQuestion(body.data.question);
        setPhase('showing');
      } catch {
        // Offline, aborted, session bounced — say nothing.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activePropertyId]);

  // Held so the confirmation timer is cleared if the manager navigates away.
  const timer = React.useRef<number | null>(null);
  React.useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  const answer = React.useCallback(
    async (verdict: 'yes' | 'no') => {
      const pid = activePropertyId;
      if (!pid || !question) return;
      setPhase('saving');
      let saved = false;
      try {
        const res = await fetchWithAuth('/api/memory/question', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ propertyId: pid, topic: question.topic, answer: verdict }),
        });
        saved = res.ok;
      } catch {
        // Offline, session bounced, 500 — see below.
      }
      if (!saved) {
        // Never say "saved" when nothing was saved. The manager did not ask for
        // this card, so an error toast would be the app blaming them for its own
        // hiccup; the card just leaves, and the question comes back another day.
        setPhase('gone');
        return;
      }
      setPhase('thanks');
      timer.current = window.setTimeout(() => setPhase('gone'), THANKS_MS);
    },
    [activePropertyId, question],
  );

  if (!question || phase === 'idle' || phase === 'gone') return null;

  if (phase === 'thanks') {
    return (
      <div className="cx-dec cx-done" style={{ marginTop: 18 }}>
        <div className="cx-dchip cx-sage">
          <CxIcon name="staxis" size={17} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="cx-dec-t">{es ? 'Guardado. Gracias.' : 'Saved. Thank you.'}</div>
          <div className="cx-dec-s">
            {es
              ? 'Staxis no volverá a preguntar esto.'
              : 'Staxis will not ask this again.'}
          </div>
        </div>
      </div>
    );
  }

  const busy = phase === 'saving';

  return (
    <div className="cx-dec" style={{ marginTop: 18 }}>
      <div className="cx-dchip cx-sage">
        <CxIcon name="staxis" size={17} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="cx-dec-eyebrow">{es ? 'STAXIS PREGUNTA' : 'STAXIS ASKS'}</div>
        <div className="cx-dec-t">{es ? question.es : question.en}</div>
        <div className="cx-dec-s">
          {es
            ? 'Una pregunta, un toque. Puedes ignorarla. Desaparece sola.'
            : 'One question, one tap. Ignore it if you like. It goes away on its own.'}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="cx-okbtn"
            disabled={busy}
            onClick={() => void answer('yes')}
          >
            {es ? 'Sí' : 'Yes'}
          </button>
          <button
            type="button"
            className="cx-nobtn"
            disabled={busy}
            onClick={() => void answer('no')}
          >
            {es ? 'No' : 'No'}
          </button>
          <button
            type="button"
            className="cx-nobtn"
            disabled={busy}
            onClick={() => setPhase('gone')}
            aria-label={es ? 'Descartar la pregunta' : 'Dismiss the question'}
          >
            {es ? 'Ahora no' : 'Not now'}
          </button>
        </div>
      </div>
    </div>
  );
}
