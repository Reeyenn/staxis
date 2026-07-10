'use client';

// ═══════════════════════════════════════════════════════════════════════════
// QueueView — the Staxis section: the AI approval queue, presentational.
//
// Stats strip (to approve / handled automatically / time saved) + decision
// cards with Approve and a per-card secondary action (Adjust / Deny / Snooze).
// Approve/dismiss is optimistic-local: the card dims but stays visible, and
// the pending count is broadcast so the pill-bar badge tracks it.
// Shared by /feed and /demo/concourse. Sample decisions are Phase 1 — the
// same footing as the previous feed; live agent_nudges wiring is Phase 2.
// ═══════════════════════════════════════════════════════════════════════════

import React from 'react';
import { CxStyle } from './concourse-css';
import { CxIcon } from './icons';
import { SAMPLE_DECISIONS, broadcastQueueCount } from './sample-decisions';

export function QueueView({ lang }: { lang: 'en' | 'es' }) {
  const es = lang === 'es';
  const [done, setDone] = React.useState<Record<string, 'ok' | 'no'>>({});

  const pending = SAMPLE_DECISIONS.filter((d) => !done[d.id]).length;

  // Broadcast on mount AND on every change so the pill-bar badge can never
  // desync from what the queue actually shows (e.g. after a remount resets
  // the sample cards).
  React.useEffect(() => { broadcastQueueCount(pending); }, [pending]);

  const decide = (id: string, verdict: 'ok' | 'no') => {
    setDone((prev) => (prev[id] ? prev : { ...prev, [id]: verdict }));
  };

  const stats: Array<{ k: string; v: string; d?: string; tone?: 'ok' }> = [
    { k: es ? 'Por aprobar' : 'To approve', v: String(pending) },
    { k: es ? 'Gestionado solo' : 'Handled automatically', v: '12', d: es ? 'hoy' : 'today', tone: 'ok' },
    { k: es ? 'Tiempo ahorrado' : 'Time saved', v: '~2.4h', tone: 'ok' },
  ];

  return (
    <div className="cx-page cx-swap">
      <CxStyle />
      <div className="cx-ptitle" style={{ marginTop: 0 }}>Staxis</div>
      <div className="cx-psub">
        {es
          ? 'La IA gestionó cada departamento durante la noche. Estas decisiones te esperan.'
          : 'The AI ran every department overnight. These decisions need you.'}
      </div>

      <div className="cx-stats">
        {stats.map((s) => (
          <div key={s.k} className="cx-stat">
            <div className="cx-stat-k">{s.k}</div>
            <div className="cx-stat-row">
              <span className="cx-stat-v">{s.v}</span>
              {s.d && <span className={`cx-stat-d cx-${s.tone ?? 'ok'}`}>{s.d}</span>}
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: '10px' }}>
        {SAMPLE_DECISIONS.map((d) => {
          const verdict = done[d.id];
          return (
            <div key={d.id} className={`cx-dec${verdict ? ' cx-done' : ''}`}>
              <div className={`cx-dchip cx-${d.chip}`}>
                <CxIcon name={d.dept} size={17} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="cx-dec-eyebrow">{es ? d.dept_es : d.dept_en}</div>
                <div className="cx-dec-t">{es ? d.title_es : d.title_en}</div>
                <div className="cx-dec-s">{es ? d.sub_es : d.sub_en}</div>
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexShrink: 0 }}>
                <button
                  type="button"
                  className={`cx-okbtn${verdict === 'ok' ? ' cx-done' : ''}`}
                  onClick={() => decide(d.id, 'ok')}
                >
                  {verdict === 'ok' ? (es ? '✓ Aprobado' : '✓ Approved') : (es ? 'Aprobar' : 'Approve')}
                </button>
                <button type="button" className="cx-nobtn" onClick={() => decide(d.id, 'no')}>
                  {verdict === 'no' ? (es ? 'Descartado' : 'Dismissed') : (es ? d.no_es : d.no_en)}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
