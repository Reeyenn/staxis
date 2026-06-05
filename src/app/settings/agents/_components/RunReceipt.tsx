'use client';

// Renders an AgentRunReceipt (run + steps). Shared by run history and
// test-on-a-date. run.summary is rendered directly (EN today; summaryKey is
// always null and isn't a typed translation key). Per-step ES comes from
// describeEs via stepDescribe(). Failed live steps use isActionFailed().

import React from 'react';
import { AlertTriangle, XCircle } from 'lucide-react';
import { T, fonts, Pill, Caps } from './_tokens';
import { MoneyGuestBadges } from './AgentStatusPill';
import {
  runStatusTone, runStatusLabel, actionStatusTone, actionStatusLabel,
  stepDescribe, formatDateTime,
} from '../_lib/format';
import { s, type Lang } from '../_lib/strings';
import { isActionFailed, type AgentRunReceipt } from '@/lib/agents/types';

export function RunReceipt({ receipt, lang }: { receipt: AgentRunReceipt; lang: Lang }) {
  const { run, steps } = receipt;
  const sim = run.mode === 'dry_run';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {sim && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
          background: T.purpleDim, border: `1px solid ${T.purple}40`, borderRadius: 10,
          color: T.purple, fontFamily: fonts.sans, fontSize: 12.5, fontWeight: 600,
        }}>
          <AlertTriangle size={14} /> {s(lang, 'simulation')}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Pill tone={runStatusTone(run.status)}>{runStatusLabel(run.status, lang)}</Pill>
          <Caps>{sim ? (lang === 'es' ? 'SIMULACIÓN' : 'SIMULATION') : s(lang, 'liveRun')}</Caps>
        </span>
        <span style={{ fontFamily: fonts.mono, fontSize: 11, color: T.ink3 }}>{formatDateTime(run.startedAt, lang)}</span>
      </div>

      {run.summary && (
        <p style={{ fontFamily: fonts.sans, fontSize: 14, color: T.ink, margin: 0, lineHeight: 1.5 }}>{run.summary}</p>
      )}

      {run.approximations.length > 0 && (
        <div style={{ padding: '10px 12px', background: 'rgba(215,176,126,0.14)', border: `1px solid ${T.caramel}40`, borderRadius: 10 }}>
          <Caps c={T.caramelDeep} style={{ marginBottom: 6, display: 'block' }}>{s(lang, 'caveats')}</Caps>
          <ul style={{ margin: 0, paddingLeft: 18, color: T.ink2, fontFamily: fonts.sans, fontSize: 12.5, lineHeight: 1.5 }}>
            {run.approximations.map((a, i) => <li key={i}>{a}</li>)}
          </ul>
        </div>
      )}

      <Caps>{sim ? s(lang, 'whatItWouldDo') : s(lang, 'whatItDid')}</Caps>
      {steps.length === 0 ? (
        <p style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink3, margin: 0 }}>{s(lang, 'noSteps')}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {steps.map((step) => {
            const failed = isActionFailed(step);
            const errText = failed && step.result && typeof step.result === 'object'
              ? String((step.result as { error?: unknown }).error ?? '')
              : '';
            return (
              <div key={step.id} style={{ border: `1px solid ${T.rule}`, borderRadius: 12, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontFamily: fonts.sans, fontSize: 13.5, color: T.ink, lineHeight: 1.4 }}>{stepDescribe(step, lang)}</span>
                  {failed
                    ? <Pill tone="red"><XCircle size={11} /> {s(lang, 'failed')}</Pill>
                    : <Pill tone={actionStatusTone(step.status)}>{actionStatusLabel(step.status, lang)}</Pill>}
                </div>
                {(step.spendsMoney || step.contactsGuest) && (
                  <MoneyGuestBadges spendsMoney={step.spendsMoney} contactsGuest={step.contactsGuest} lang={lang} />
                )}
                {errText && <span style={{ fontFamily: fonts.mono, fontSize: 11, color: T.red }}>{errText}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
