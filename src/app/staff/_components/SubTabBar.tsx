// Staff sub-tab bar (manager-only): Schedule | Directory.
// Matches the design's StaffSubTabBar — 1.5px black underline on active,
// ink2 on inactive, 28px gap between tabs.

import React from 'react';
import { useLang } from '@/contexts/LanguageContext';
import { T, fonts } from './_tokens';

export type StaffTab = 'schedule' | 'directory';

export function SubTabBar({
  tab, onTab, availableTabs = ['schedule', 'directory'],
}: {
  tab: StaffTab;
  onTab: (next: StaffTab) => void;
  availableTabs?: readonly StaffTab[];
}) {
  const { lang } = useLang();
  const allTabs: { key: StaffTab; label: string }[] = [
    { key: 'schedule',    label: lang === 'es' ? 'Horario'    : 'Schedule' },
    { key: 'directory',   label: lang === 'es' ? 'Directorio' : 'Directory' },
  ];
  const tabs = allTabs.filter(item => availableTabs.includes(item.key));
  const activateFromKeyboard = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = tabs[nextIndex];
    onTab(next.key);
    requestAnimationFrame(() => document.getElementById(`staff-tab-${next.key}`)?.focus());
  };

  return (
    <div style={{
      padding: '18px 48px 0',
      background: 'transparent',
      borderBottom: `1px solid ${T.rule}`,
    }}>
      <div role="tablist" aria-label={lang === 'es' ? 'Vistas de personal' : 'Staff views'} style={{ display: 'flex', gap: 28 }}>
        {tabs.map((t, index) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              id={`staff-tab-${t.key}`}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`staff-panel-${t.key}`}
              tabIndex={active ? 0 : -1}
              onClick={() => onTab(t.key)}
              onKeyDown={(event) => activateFromKeyboard(event, index)}
              style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                minHeight: 44, padding: '8px 0 14px',
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
