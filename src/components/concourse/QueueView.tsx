'use client';

// ═══════════════════════════════════════════════════════════════════════════
// QueueView — the Staxis section: the AI approval queue.
//
// Honest pilot state until the live agent_nudges wiring lands: no sample
// cards, no fabricated stats, and critically no "all clear" claim. A missing
// queue connection cannot tell a manager whether decisions are pending.
// ═══════════════════════════════════════════════════════════════════════════

import { CxStyle } from './concourse-css';
import { CxIcon } from './icons';

export function QueueView({ lang }: { lang: 'en' | 'es' }) {
  const es = lang === 'es';

  return (
    <div className="cx-page cx-swap">
      <CxStyle />
      <div className="cx-ptitle" style={{ marginTop: 0 }}>Staxis</div>
      <div className="cx-psub">
        {es
          ? 'Las aprobaciones en vivo todavía no están conectadas para este piloto.'
          : 'Live approvals are not connected for this pilot yet.'}
      </div>

      <div className="cx-dec" style={{ justifyContent: 'center', textAlign: 'center' }}>
        <div style={{ padding: '18px 8px' }}>
          <div className="cx-dchip" style={{ margin: '0 auto 10px', background: 'rgba(201,150,68,.14)', color: '#8C6A33' }}>
            <CxIcon name="housekeeping" size={17} />
          </div>
          <div className="cx-dec-t">
            {es ? 'Aprobaciones no disponibles' : 'Approvals unavailable'}
          </div>
          <div className="cx-dec-s">
            {es
              ? 'No uses esta pantalla como confirmación de que todo está al día. Continúa con el proceso normal del gerente durante el piloto.'
              : 'Do not use this screen as an all-clear. Continue the normal manager approval process during the pilot.'}
          </div>
        </div>
      </div>
    </div>
  );
}
