// Staff sub-tab bar (manager-only): Schedule | Directory.
// Matches the design's StaffSubTabBar — 1.5px black underline on active,
// ink2 on inactive, 28px gap between tabs.

import React from 'react';
import { T, fonts } from './_tokens';

export type StaffTab = 'schedule' | 'directory';

export function SubTabBar({
  tab, onTab,
}: {
  tab: StaffTab;
  onTab: (next: StaffTab) => void;
}) {
  const tabs: { key: StaffTab; label: string }[] = [
    { key: 'schedule',  label: 'Schedule' },
    { key: 'directory', label: 'Directory' },
  ];
  return (
    <div style={{
      padding: '18px 48px 0',
      background: T.bg,
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
                  ? `1.5px solid ${T.ink}`
                  : '1.5px solid transparent',
                marginBottom: -1,
                whiteSpace: 'nowrap',
              }}
            >{t.label}</button>
          );
        })}
      </div>
    </div>
  );
}
