'use client';

// Test-on-a-date: dry-run an agent against a chosen past day and render the
// receipt ("what it WOULD have done"). Guards the empty-runId case (engine
// returns runId:'' when agents are disabled / not active / already handled) by
// showing the outcome summary and NOT chasing a receipt at an empty path.

import React, { useState } from 'react';
import { T, fonts, Btn, Caps } from './_tokens';
import { RunReceipt } from './RunReceipt';
import { ErrorBanner, Loading } from './states';
import { agentsApi, isSessionEnded } from '../_lib/api';
import { errorToMessage, todayLocalYmd, daysAgoLocalYmd } from '../_lib/format';
import { s, type Lang } from '../_lib/strings';
import type { AgentRunReceipt } from '@/lib/agents/types';

export function TestOnADate({ agentId, lang }: { agentId: string; lang: Lang }) {
  const [date, setDate] = useState(daysAgoLocalYmd(1));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<AgentRunReceipt | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const run = async () => {
    setBusy(true); setError(null); setReceipt(null); setNote(null);
    try {
      const r = await agentsApi.run(agentId, { mode: 'dry_run', date });
      if (!r.ok) { setError(errorToMessage(r.error, lang)); setBusy(false); return; }
      const outcome = r.data.outcome;
      if (!outcome.runId) { setNote(outcome.summary || s(lang, 'somethingWrong')); setBusy(false); return; }
      const rec = await agentsApi.receipt(outcome.runId);
      if (rec.ok) setReceipt(rec.data.receipt);
      else setError(errorToMessage(rec.error, lang));
    } catch (e) {
      if (isSessionEnded(e)) throw e;
      setError(s(lang, 'somethingWrong'));
    }
    setBusy(false);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <p style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink2, margin: 0, lineHeight: 1.5 }}>{s(lang, 'testIntro')}</p>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Caps>{s(lang, 'pickDate')}</Caps>
          <input
            type="date"
            value={date}
            max={todayLocalYmd()}
            min={daysAgoLocalYmd(400)}
            onChange={(e) => setDate(e.target.value)}
            style={{ border: `1px solid ${T.rule}`, borderRadius: 10, padding: '8px 10px', fontFamily: fonts.sans, fontSize: 13, color: T.ink, background: T.paper }}
          />
        </label>
        <Btn variant="primary" onClick={run} disabled={busy || !date}>
          {busy ? s(lang, 'loading') : s(lang, 'runTest')}
        </Btn>
      </div>
      {error && <ErrorBanner message={error} lang={lang} />}
      {note && (
        <div style={{ padding: '10px 12px', background: T.ruleSoft, borderRadius: 10, fontFamily: fonts.sans, fontSize: 13, color: T.ink2 }}>{note}</div>
      )}
      {busy && !error && <Loading lang={lang} />}
      {receipt && <RunReceipt receipt={receipt} lang={lang} />}
    </div>
  );
}
