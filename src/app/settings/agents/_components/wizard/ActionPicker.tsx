'use client';

// Step 5 — what the agent can DO. Select actions; for each selected action,
// collect its inputs (PayloadFields) and set the SafetyDial. Money/guest actions
// show badges and their dial can't be set to Auto (handled inside SafetyDial).

import React from 'react';
import { Check } from 'lucide-react';
import { T, fonts, Caps } from '../_tokens';
import { MoneyGuestBadges } from '../AgentStatusPill';
import { PayloadFields } from './PayloadFields';
import { SafetyDial } from './SafetyDial';
import { pickBilingual } from '../../_lib/format';
import { s, type Lang } from '../../_lib/strings';
import type { AgentActionMeta, ActionApprovalMode } from '@/lib/agents/types';

export function ActionPicker({
  actions, selected, modes, payloads, onToggle, onMode, onPayload, lang,
}: {
  actions: AgentActionMeta[];
  selected: string[];
  modes: Record<string, ActionApprovalMode>;
  payloads: Record<string, Record<string, unknown>>;
  onToggle: (key: string) => void;
  onMode: (key: string, mode: ActionApprovalMode) => void;
  onPayload: (key: string, field: string, value: unknown) => void;
  lang: Lang;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink2, margin: 0 }}>{s(lang, 'actionsIntro')}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {actions.map((a) => {
          const on = selected.includes(a.key);
          const mode = modes[a.key] ?? a.approvalFloor;
          return (
            <div key={a.key} style={{ border: `1.5px solid ${on ? T.ink : T.rule}`, borderRadius: 14, padding: '12px 14px', background: on ? T.ruleSoft : T.paper }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => onToggle(a.key)}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left', padding: 0 }}
                >
                  <span style={{ width: 20, height: 20, borderRadius: 6, border: `1.5px solid ${on ? T.ink : T.rule}`, background: on ? T.ink : 'transparent', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    {on && <Check size={13} color={T.bg} />}
                  </span>
                  <span style={{ fontFamily: fonts.sans, fontSize: 14, fontWeight: 600, color: T.ink }}>{pickBilingual(a.label, lang)}</span>
                </button>
                <MoneyGuestBadges spendsMoney={a.spendsMoney} contactsGuest={a.contactsGuest} lang={lang} />
              </div>

              {on && (
                <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12, paddingLeft: 28 }}>
                  <PayloadFields meta={a} payload={payloads[a.key] ?? {}} onChange={(f, v) => onPayload(a.key, f, v)} lang={lang} />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <Caps>{s(lang, 'safetyDial')}</Caps>
                    <SafetyDial value={mode} floor={a.approvalFloor} onChange={(m) => onMode(a.key, m)} lang={lang} />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
