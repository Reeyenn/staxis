'use client';

// Property-wide approval queue — the safety surface. Reads through agentsApi.
// After any approve/reject it REFETCHES the whole queue (never optimistic-diff:
// a run leaves awaiting_approval only when ALL its steps resolve).

import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Clock } from 'lucide-react';
import { T, fonts, Card, Btn, Pill } from './_tokens';
import { MoneyGuestBadges } from './AgentStatusPill';
import { Loading, ErrorBanner } from './states';
import { agentsApi, isSessionEnded } from '../_lib/api';
import { stepDescribe, formatDateTime, errorToMessage } from '../_lib/format';
import { s, type Lang } from '../_lib/strings';
import type { AgentApprovalQueueItem } from '@/lib/agents/types';

export function ApprovalInbox({ pid, lang, onChange }: { pid: string; lang: Lang; onChange?: () => void }) {
  const [items, setItems] = useState<AgentApprovalQueueItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyStep, setBusyStep] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await agentsApi.queue(pid);
      if (r.ok) setItems(r.data.items);
      else { setError(errorToMessage(r.error, lang)); setItems([]); }
    } catch (e) { if (isSessionEnded(e)) throw e; setError(s(lang, 'somethingWrong')); setItems([]); }
  }, [pid, lang]);

  useEffect(() => { void load(); }, [load]);

  const decide = async (runId: string, actionId: string, kind: 'approve' | 'reject') => {
    setBusyStep(actionId); setError(null);
    try {
      const r = kind === 'approve' ? await agentsApi.approve(runId, actionId) : await agentsApi.reject(runId, actionId);
      if (!r.ok) setError(errorToMessage(r.error, lang));
      await load();        // refetch — never optimistic-diff
      onChange?.();
    } catch (e) { if (isSessionEnded(e)) throw e; setError(s(lang, 'somethingWrong')); }
    setBusyStep(null);
  };

  if (items === null && !error) return <Loading lang={lang} />;

  const pendingCount = items ? items.reduce((n, it) => n + it.pendingSteps.length, 0) : 0;

  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '14px 18px 12px', borderBottom: `1px solid ${T.rule}`, display: 'flex', alignItems: 'center', gap: 8 }}>
        <Clock size={16} color={T.caramelDeep} />
        <span style={{ fontFamily: fonts.sans, fontWeight: 600, fontSize: 15, color: T.ink }}>{s(lang, 'approvalsTitle')}</span>
        {pendingCount > 0 && <Pill tone="caramel">{pendingCount}</Pill>}
      </div>

      {error && <div style={{ padding: '12px 18px' }}><ErrorBanner message={error} onRetry={load} lang={lang} /></div>}

      {items && items.length === 0 && !error && (
        <div style={{ padding: '22px 18px', display: 'flex', alignItems: 'center', gap: 8, color: T.ink2, fontFamily: fonts.sans, fontSize: 13.5 }}>
          <CheckCircle2 size={16} color={T.sageDeep} /> {s(lang, 'approvalsCaught')}
        </div>
      )}

      {items && items.map((item) => (
        <div key={item.run.id} style={{ borderTop: `1px solid ${T.ruleSoft}`, padding: '12px 18px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
            <span style={{ fontFamily: fonts.sans, fontSize: 13, fontWeight: 600, color: T.ink }}>{item.run.agentName}</span>
            <span style={{ fontFamily: fonts.mono, fontSize: 11, color: T.ink3 }}>{formatDateTime(item.run.startedAt, lang)}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {item.pendingSteps.map((step) => {
              const desc = stepDescribe(step, lang);
              return (
                <div key={step.id} style={{ border: `1px solid ${T.rule}`, borderRadius: 12, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <span style={{ fontFamily: fonts.sans, fontSize: 13.5, color: T.ink, lineHeight: 1.4 }}>{desc}</span>
                  <MoneyGuestBadges spendsMoney={step.spendsMoney} contactsGuest={step.contactsGuest} lang={lang} />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Btn variant="sage" size="sm" disabled={busyStep === step.id} onClick={() => decide(item.run.id, step.id, 'approve')} title={`${s(lang, 'approve')} — ${item.run.agentName}: ${desc}`}>
                      {s(lang, 'approve')}
                    </Btn>
                    <Btn variant="ghost" size="sm" disabled={busyStep === step.id} onClick={() => decide(item.run.id, step.id, 'reject')} title={`${s(lang, 'reject')} — ${item.run.agentName}: ${desc}`}>
                      {s(lang, 'reject')}
                    </Btn>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </Card>
  );
}
