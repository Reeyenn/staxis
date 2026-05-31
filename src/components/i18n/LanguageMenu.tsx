'use client';

import React from 'react';
import { Globe, Check } from 'lucide-react';
import { useLang } from '@/contexts/LanguageContext';
import { LOCALE_META, SUPPORTED_LOCALES, type HousekeeperLocale } from '@/lib/translations';

/**
 * App-wide language switcher button → dropdown of all 5 supported languages.
 * Lives in the top bar. Selecting a language flips the whole app (static
 * dictionary for EN/ES + the housekeeper subset; GlobalAutoTranslate fills
 * the rest for HT/TL/VI) and persists per-user server-side.
 */
export function LanguageMenu({ compact = false }: { compact?: boolean }) {
  const { locale, setLocale } = useLang();
  const [open, setOpen] = React.useState(false);
  const meta = LOCALE_META[locale];

  const ink = 'var(--snow-ink)';
  const ink2 = 'var(--snow-ink2)';
  const rule = 'var(--snow-rule)';
  const sans = 'var(--font-geist), -apple-system, BlinkMacSystemFont, sans-serif';

  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        title="Language"
        aria-label="Change language"
        style={{
          padding: '6px 10px', borderRadius: '8px', border: 'none',
          background: 'transparent', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: '6px',
          fontFamily: sans, fontWeight: 600, fontSize: '11px', color: ink2,
          letterSpacing: '0.04em',
        }}
      >
        <Globe size={16} color={ink2} />
        {compact ? locale.toUpperCase() : meta.nativeName}
      </button>

      {open && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 48 }} onClick={() => setOpen(false)} />
          <div
            style={{
              position: 'absolute', right: 0, top: 'calc(100% + 8px)',
              background: 'var(--snow-bg)', border: `1px solid ${rule}`,
              borderRadius: '12px', minWidth: '220px', overflow: 'hidden', zIndex: 50,
              boxShadow: '0 8px 24px rgba(31,35,28,0.10)',
            }}
          >
            <div style={{ padding: '10px 16px', borderBottom: `1px solid ${rule}`, fontSize: '11px', color: ink2, fontFamily: sans, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
              Language
            </div>
            {SUPPORTED_LOCALES.map((code: HousekeeperLocale) => {
              const m = LOCALE_META[code];
              const active = code === locale;
              return (
                <button
                  key={code}
                  onClick={() => { setLocale(code); setOpen(false); }}
                  style={{
                    width: '100%', padding: '10px 16px', textAlign: 'left',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px',
                    background: active ? 'rgba(158,183,166,0.12)' : 'transparent',
                    border: 'none', borderBottom: `1px solid var(--snow-rule-soft)`,
                    cursor: 'pointer', fontFamily: sans,
                  }}
                >
                  <span style={{ display: 'flex', flexDirection: 'column' }}>
                    <span style={{ fontSize: '13px', fontWeight: active ? 600 : 500, color: ink }}>{m.nativeName}</span>
                    <span style={{ fontSize: '11px', color: ink2 }}>{m.englishName}{m.machineTranslated ? ' · beta' : ''}</span>
                  </span>
                  {active && <Check size={15} color="var(--snow-sage-deep)" />}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
