'use client';

// ═══════════════════════════════════════════════════════════════════════════
// QueueView — the Staxis section: the AI approval queue.
//
// Honest empty state until the live agent_nudges wiring lands: no sample
// cards, no fabricated stats (the Phase-1 demo cards were removed in the
// 2026-07 dead-code purge). The pending count is broadcast so the pill-bar
// badge always mirrors the real queue — today that count is 0.
// ═══════════════════════════════════════════════════════════════════════════

import React from 'react';
import { CxStyle } from './concourse-css';
import { CxIcon } from './icons';
import { broadcastQueueCount } from './queue-count';

export function QueueView({ lang }: { lang: 'en' | 'es' }) {
  const es = lang === 'es';

  // Nothing real is queued yet — keep the badge cleared.
  React.useEffect(() => { broadcastQueueCount(0); }, []);

  return (
    <div className="cx-page cx-swap">
      <CxStyle />
      <div className="cx-ptitle" style={{ marginTop: 0 }}>Staxis</div>
      <div className="cx-psub">
        {es
          ? 'Cuando la IA necesite tu decisión, aparecerá aquí.'
          : 'When the AI needs a decision from you, it will appear here.'}
      </div>

      <div className="cx-dec" style={{ justifyContent: 'center', textAlign: 'center' }}>
        <div style={{ padding: '18px 8px' }}>
          <div className="cx-dchip cx-sage" style={{ margin: '0 auto 10px' }}>
            <CxIcon name="housekeeping" size={17} />
          </div>
          <div className="cx-dec-t">
            {es ? 'Todo al día' : 'All caught up'}
          </div>
          <div className="cx-dec-s">
            {es
              ? 'No hay nada que necesite tu aprobación ahora mismo.'
              : 'Nothing needs your approval right now.'}
          </div>
        </div>
      </div>
    </div>
  );
}
