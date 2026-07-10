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
  const { locale, setLocale, lang } = useLang();
  const [open, setOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const itemRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const meta = LOCALE_META[locale];

  const closeMenu = React.useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  React.useEffect(() => {
    if (!open) return;
    const activeIndex = Math.max(0, SUPPORTED_LOCALES.indexOf(locale));
    requestAnimationFrame(() => itemRefs.current[activeIndex]?.focus());
  }, [open, locale]);

  const moveFocus = (next: number) => {
    const count = SUPPORTED_LOCALES.length;
    itemRefs.current[(next + count) % count]?.focus();
  };

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const current = itemRefs.current.findIndex((item) => item === document.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveFocus(current < 0 ? 0 : current + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveFocus(current < 0 ? SUPPORTED_LOCALES.length - 1 : current - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      moveFocus(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      moveFocus(SUPPORTED_LOCALES.length - 1);
    }
  };

  const ink = 'var(--snow-ink)';
  const ink2 = 'var(--snow-ink2)';
  const rule = 'var(--snow-rule)';
  const sans = 'var(--font-geist), -apple-system, BlinkMacSystemFont, sans-serif';

  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          setOpen(true);
        }}
        title={lang === 'es' ? 'Idioma' : 'Language'}
        aria-label={lang === 'es' ? 'Cambiar idioma' : 'Change language'}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          minHeight: '44px', padding: '6px 10px', borderRadius: '10px', border: compact ? 'none' : `1px solid ${rule}`,
          background: compact ? 'transparent' : 'color-mix(in srgb, var(--snow-bg) 82%, transparent)', cursor: 'pointer',
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
          <div style={{ position: 'fixed', inset: 0, zIndex: 48 }} onClick={() => closeMenu(true)} />
          <div
            role="menu"
            aria-label={lang === 'es' ? 'Seleccionar idioma' : 'Select language'}
            onKeyDown={handleMenuKeyDown}
            style={{
              position: 'absolute', right: 0, top: 'calc(100% + 8px)',
              background: 'var(--snow-bg)', border: `1px solid ${rule}`,
              borderRadius: '12px', minWidth: '220px', overflow: 'hidden', zIndex: 50,
              boxShadow: '0 8px 24px rgba(31,35,28,0.10)',
            }}
          >
            <div style={{ padding: '10px 16px', borderBottom: `1px solid ${rule}`, fontSize: '11px', color: ink2, fontFamily: sans, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
              {lang === 'es' ? 'Idioma' : 'Language'}
            </div>
            {SUPPORTED_LOCALES.map((code: HousekeeperLocale) => {
              const m = LOCALE_META[code];
              const active = code === locale;
              return (
                <button
                  ref={(node) => { itemRefs.current[SUPPORTED_LOCALES.indexOf(code)] = node; }}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  tabIndex={active ? 0 : -1}
                  key={code}
                  onClick={() => { setLocale(code); closeMenu(true); }}
                  style={{
                    width: '100%', minHeight: '52px', padding: '10px 16px', textAlign: 'left',
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
