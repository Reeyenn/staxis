// Staff sub-tab bar (manager-only): Schedule | Directory | Recognition.
// Matches the design's StaffSubTabBar — 1.5px black underline on active,
// ink2 on inactive, 28px gap between tabs.

import React from 'react';
import { useLang } from '@/contexts/LanguageContext';
import { T, fonts } from './_tokens';

export type StaffTab = 'schedule' | 'directory' | 'recognition';

export function SubTabBar({
  tab, onTab,
}: {
  tab: StaffTab;
  onTab: (next: StaffTab) => void;
}) {
  const { lang } = useLang();
  const tabs: { key: StaffTab; label: string }[] = [
    { key: 'schedule',    label: lang === 'es' ? 'Horario'        : 'Schedule' },
    { key: 'directory',   label: lang === 'es' ? 'Directorio'     : 'Directory' },
    { key: 'recognition', label: lang === 'es' ? 'Reconocimiento' : 'Recognition' },
  ];
  return (
    <div style={{
      padding: '18px 48px 0',
      background: 'transparent',
      borderBottom: `1px solid ${T.rule}`,
    }}>
      <div style={{ display: 'flex', gap: 28 }}>
        {tabs.map(t => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => onTab(t.key)}
              style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                padding: '8px 0 14px',
                fontFamily: fonts.sans, fontSize: 14,
                fontWeight: active ? 600 : 500,
                color: active ? T.ink : T.ink2,
                borderBottom: active
                  ? '1.5px solid #3E5C48'
                  : '1.5px solid transparent',
                marginBottom: -1,
                whiteSpace: 'nowrap',
                transition: 'color .3s cubic-bezier(.22,1,.36,1)',
              }}
            >{t.label}</button>
          );
        })}
      </div>
    </div>
  );
}
