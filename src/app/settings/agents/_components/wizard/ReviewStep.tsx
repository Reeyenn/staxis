'use client';

// Step 6 — plain-language review of the agent before saving.

import React from 'react';
import { T, fonts, Caps, Pill } from '../_tokens';
import { formatTrigger, pickBilingual, modeLabel } from '../../_lib/format';
import { s, type Lang } from '../../_lib/strings';
import type { WizardState } from '../../_lib/wizardState';
import { buildAgentConfig, type ActionFloors } from '../../_lib/config';
import type { AgentActionMeta, AgentScopeMeta } from '@/lib/agents/types';

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <Caps>{label}</Caps>
      <span style={{ fontFamily: fonts.sans, fontSize: 14, color: T.ink }}>{value}</span>
    </div>
  );
}

export function ReviewStep({
  state, actionMeta, scopeMeta, floors, lang,
}: {
  state: WizardState;
  actionMeta: AgentActionMeta[];
  scopeMeta: AgentScopeMeta[];
  floors: ActionFloors;
  lang: Lang;
}) {
  const config = buildAgentConfig(state, floors);
  const actByKey = new Map(actionMeta.map((a) => [a.key, a]));
  const scopeByKey = new Map(scopeMeta.map((sc) => [sc.key, sc]));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <p style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink2, margin: 0 }}>{s(lang, 'reviewIntro')}</p>
      <Row label={s(lang, 'nameLabel')} value={state.name || s(lang, 'nothing')} />
      <Row label={s(lang, 'reviewTrigger')} value={formatTrigger(config.trigger, lang)} />

      <div>
        <Caps>{s(lang, 'reviewSees')}</Caps>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
          {state.scopes.length === 0
            ? <span style={{ color: T.ink3, fontFamily: fonts.sans, fontSize: 13 }}>{s(lang, 'nothing')}</span>
            : state.scopes.map((k) => <Pill key={k}>{pickBilingual(scopeByKey.get(k)?.label, lang) || k}</Pill>)}
        </div>
      </div>

      <div>
        <Caps>{s(lang, 'reviewDoes')}</Caps>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
          {state.actions.length === 0
            ? <span style={{ color: T.ink3, fontFamily: fonts.sans, fontSize: 13 }}>{s(lang, 'nothing')}</span>
            : state.actions.map((k) => (
              <div key={k} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, border: `1px solid ${T.rule}`, borderRadius: 10, padding: '8px 12px' }}>
                <span style={{ fontFamily: fonts.sans, fontSize: 13.5, color: T.ink }}>{pickBilingual(actByKey.get(k)?.label, lang) || k}</span>
                <Pill tone="neutral">{modeLabel(config.approvalRules.perAction[k] ?? 'suggest', lang)}</Pill>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
