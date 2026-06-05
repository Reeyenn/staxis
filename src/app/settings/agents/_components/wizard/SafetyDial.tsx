'use client';

// 3-way safety dial (radiogroup). 'Auto' is disabled — with a lock + tooltip —
// when the action's approvalFloor is 'approve_first' (spends money / contacts a
// guest). Color is not the only signal: the active option is filled AND the
// disabled one shows a lock icon.

import React from 'react';
import { Lock } from 'lucide-react';
import { T, fonts } from '../_tokens';
import { allowedModes } from '../../_lib/safety';
import { modeLabel } from '../../_lib/format';
import { s, type Lang } from '../../_lib/strings';
import type { ActionApprovalMode } from '@/lib/agents/types';

const MODES: ActionApprovalMode[] = ['suggest', 'approve_first', 'auto'];

export function SafetyDial({
  value, floor, onChange, lang,
}: {
  value: ActionApprovalMode;
  floor: ActionApprovalMode;
  onChange: (m: ActionApprovalMode) => void;
  lang: Lang;
}) {
  const allowed = allowedModes({ approvalFloor: floor });
  return (
    <div
      role="radiogroup"
      aria-label={s(lang, 'safetyDial')}
      style={{ display: 'inline-flex', border: `1px solid ${T.rule}`, borderRadius: 999, padding: 3, gap: 2, background: T.paper }}
    >
      {MODES.map((m) => {
        const disabled = !allowed.includes(m);
        const active = value === m;
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={active}
            aria-disabled={disabled}
            disabled={disabled}
            title={disabled ? s(lang, 'autoLocked') : undefined}
            onClick={() => { if (!disabled) onChange(m); }}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              padding: '5px 12px', borderRadius: 999, border: 'none',
              background: active ? T.ink : 'transparent',
              color: active ? T.bg : disabled ? T.ink3 : T.ink2,
              fontFamily: fonts.sans, fontSize: 12.5, fontWeight: 500,
              cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1,
              whiteSpace: 'nowrap',
            }}
          >
            {m === 'auto' && disabled && <Lock size={11} />}
            {modeLabel(m, lang)}
          </button>
        );
      })}
    </div>
  );
}
