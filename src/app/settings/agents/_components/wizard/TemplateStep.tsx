'use client';

// Step 1 — template-first. Named templates come from the catalog (empty today);
// the generic 'custom' planner is surfaced as a clearly-secondary, guided CTA.

import React from 'react';
import { Bot, Sparkles } from 'lucide-react';
import { T, fonts, Caps } from '../_tokens';
import { pickBilingual } from '../../_lib/format';
import { s, type Lang } from '../../_lib/strings';
import type { AgentTemplateMeta } from '@/lib/agents/types';

function selButton(on: boolean): React.CSSProperties {
  return {
    textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 6, padding: '14px 16px',
    borderRadius: 14, cursor: 'pointer', width: '100%',
    border: `1.5px solid ${on ? T.ink : T.rule}`, background: on ? T.ruleSoft : T.paper,
  };
}

export function TemplateStep({
  templates, selected, onSelect, lang,
}: {
  templates: AgentTemplateMeta[];
  selected: string | null;
  onSelect: (key: string) => void;
  lang: Lang;
}) {
  const named = templates.filter((t) => t.key !== 'custom');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Caps>{s(lang, 'templatePick')}</Caps>
      {named.length === 0 ? (
        <p style={{ fontFamily: fonts.sans, fontSize: 13.5, color: T.ink2, margin: 0, lineHeight: 1.5 }}>{s(lang, 'templateNone')}</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
          {named.map((tmpl) => {
            const on = selected === tmpl.key;
            return (
              <button key={tmpl.key} type="button" onClick={() => onSelect(tmpl.key)} aria-pressed={on} style={selButton(on)}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Sparkles size={15} color={T.caramelDeep} />
                  <span style={{ fontFamily: fonts.sans, fontWeight: 600, fontSize: 14, color: T.ink }}>{pickBilingual(tmpl.name, lang)}</span>
                </span>
                <span style={{ fontFamily: fonts.sans, fontSize: 12.5, color: T.ink2, lineHeight: 1.45 }}>{pickBilingual(tmpl.description, lang)}</span>
              </button>
            );
          })}
        </div>
      )}

      <button type="button" onClick={() => onSelect('custom')} aria-pressed={selected === 'custom'} style={selButton(selected === 'custom')}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Bot size={16} color={T.sageDeep} />
          <span style={{ fontFamily: fonts.sans, fontWeight: 600, fontSize: 14, color: T.ink }}>{s(lang, 'buildCustom')}</span>
        </span>
        <span style={{ fontFamily: fonts.sans, fontSize: 12.5, color: T.ink2, lineHeight: 1.45 }}>{s(lang, 'buildCustomDesc')}</span>
      </button>
    </div>
  );
}
