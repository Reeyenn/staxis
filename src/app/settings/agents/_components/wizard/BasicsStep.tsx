'use client';

// Step 2 — name + description.

import React from 'react';
import { T, fonts, Caps } from '../_tokens';
import { s, type Lang } from '../../_lib/strings';

const inputStyle: React.CSSProperties = {
  border: `1px solid ${T.rule}`, borderRadius: 10, padding: '9px 12px',
  fontFamily: fonts.sans, fontSize: 14, color: T.ink, background: T.paper, outline: 'none',
};

export function BasicsStep({
  name, description, onName, onDescription, lang,
}: {
  name: string;
  description: string;
  onName: (v: string) => void;
  onDescription: (v: string) => void;
  lang: Lang;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 480 }}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Caps>{s(lang, 'nameLabel')}</Caps>
        <input value={name} onChange={(e) => onName(e.target.value)} placeholder={s(lang, 'namePlaceholder')} maxLength={120} style={inputStyle} />
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Caps>{s(lang, 'descLabel')}</Caps>
        <textarea value={description} onChange={(e) => onDescription(e.target.value)} placeholder={s(lang, 'descPlaceholder')} maxLength={500} rows={3} style={{ ...inputStyle, resize: 'vertical' }} />
      </label>
    </div>
  );
}
