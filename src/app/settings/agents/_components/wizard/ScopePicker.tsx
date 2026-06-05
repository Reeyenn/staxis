'use client';

// Step 4 — what the agent can SEE. Stub scopes (not yet implemented in the
// foundation) are shown but disabled so managers aren't misled.

import React from 'react';
import { Check } from 'lucide-react';
import { T, fonts } from '../_tokens';
import { pickBilingual } from '../../_lib/format';
import { s, type Lang } from '../../_lib/strings';
import type { AgentScopeMeta, ScopeKey } from '@/lib/agents/types';

const STUB_SCOPES: ReadonlySet<string> = new Set(['work_orders', 'inventory', 'complaints']);

export function ScopePicker({
  scopes, selected, onToggle, lang,
}: {
  scopes: AgentScopeMeta[];
  selected: ScopeKey[];
  onToggle: (k: ScopeKey) => void;
  lang: Lang;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink2, margin: 0 }}>{s(lang, 'scopesIntro')}</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
        {scopes.map((sc) => {
          const stub = STUB_SCOPES.has(sc.key);
          const on = selected.includes(sc.key);
          return (
            <button
              key={sc.key}
              type="button"
              disabled={stub}
              aria-pressed={on}
              aria-disabled={stub}
              onClick={() => { if (!stub) onToggle(sc.key); }}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                padding: '11px 13px', borderRadius: 12, textAlign: 'left',
                border: `1.5px solid ${on ? T.sageDeep : T.rule}`, background: on ? T.sageDim : T.paper,
                cursor: stub ? 'not-allowed' : 'pointer', opacity: stub ? 0.6 : 1,
              }}
            >
              <span style={{ fontFamily: fonts.sans, fontSize: 13.5, color: T.ink }}>
                {pickBilingual(sc.label, lang)}
                {stub && <span style={{ color: T.ink3 }}> · {s(lang, 'comingSoon')}</span>}
              </span>
              {on && <Check size={15} color={T.sageDeep} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
