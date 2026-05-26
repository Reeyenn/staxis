'use client';

import React, { useMemo, useRef, useState, useEffect, useCallback } from 'react';
import { Globe, X, Check } from 'lucide-react';
import {
  LOCALE_META,
  SUPPORTED_LOCALES,
  type HousekeeperLocale,
  t,
} from '@/lib/translations';

/**
 * LanguageSwitcher — globe icon button + bottom-sheet picker with search.
 *
 * Replaces the EN/ES toggle that lived inline in the housekeeper page
 * header. Tapping the globe opens a list of every supported locale with
 * a search box that filters by english/native name + ISO code +
 * pre-registered aliases (so typing "creole" finds Haitian).
 *
 * Native names render in the language's own script so a housekeeper
 * who can't read English still recognizes their language. The flag pill
 * on machine-translated locales tells the user the translation may be
 * imperfect.
 */
interface Props {
  current: HousekeeperLocale;
  onChange: (next: HousekeeperLocale) => void | Promise<void>;
}

export function LanguageSwitcher({ current, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open && inputRef.current) {
      // Focus the search input on open so a phone keyboard pops up. iOS
      // ignores .focus() unless we use a microtask-deferred call.
      const id = window.setTimeout(() => inputRef.current?.focus(), 100);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [open]);

  const matches = useMemo(() => {
    const normalize = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
    const q = normalize(query.trim());
    return SUPPORTED_LOCALES.filter((code) => {
      const meta = LOCALE_META[code];
      if (!q) return true;
      const haystack = [
        meta.code,
        meta.englishName,
        meta.nativeName,
        ...meta.searchAliases,
      ]
        .map(normalize)
        .join(' ');
      return haystack.includes(q);
    });
  }, [query]);

  const handlePick = useCallback(
    async (next: HousekeeperLocale) => {
      setOpen(false);
      setQuery('');
      if (next === current) return;
      try {
        await onChange(next);
      } catch {
        // Caller handles error toast; we just close the picker.
      }
    },
    [current, onChange],
  );

  const meta = LOCALE_META[current];

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label={t('langPickerTitle', current)}
        title={meta.nativeName}
        style={{
          background: 'rgba(255,255,255,0.18)',
          border: '1.5px solid rgba(255,255,255,0.35)',
          borderRadius: '12px',
          color: 'white',
          fontWeight: 700,
          fontSize: '14px',
          padding: '10px 14px',
          cursor: 'pointer',
          letterSpacing: '0.04em',
          flexShrink: 0,
          WebkitTapHighlightColor: 'transparent',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
        }}
      >
        <Globe size={18} aria-hidden />
        <span style={{ fontSize: '12px', fontWeight: 700, lineHeight: 1 }}>
          {meta.code.toUpperCase()}
        </span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('langPickerTitle', current)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15,23,42,0.55)',
            zIndex: 260,
            display: 'flex',
            alignItems: 'flex-end',
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setOpen(false);
              setQuery('');
            }
          }}
        >
          <div
            style={{
              width: '100%',
              maxWidth: 560,
              margin: '0 auto',
              background: 'white',
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
              maxHeight: '85dvh',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div
              style={{
                padding: '16px 18px 12px',
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                borderBottom: '1px solid #E5E7EB',
              }}
            >
              <div>
                <h2 style={{ fontSize: 18, fontWeight: 800, margin: 0, color: '#0F172A' }}>
                  {t('langPickerTitle', current)}
                </h2>
              </div>
              <button
                onClick={() => {
                  setOpen(false);
                  setQuery('');
                }}
                aria-label="Close"
                style={{
                  minHeight: 44,
                  minWidth: 44,
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <X size={22} color="#374151" />
              </button>
            </div>

            <div style={{ padding: '10px 18px', borderBottom: '1px solid #E5E7EB' }}>
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('langPickerSearchPlaceholder', current)}
                style={{
                  width: '100%',
                  padding: '12px 14px',
                  fontSize: 16,
                  border: '1.5px solid #D1D5DB',
                  borderRadius: 12,
                  outline: 'none',
                  fontFamily: 'inherit',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            <div style={{ overflowY: 'auto', padding: '8px 12px 24px' }}>
              {matches.length === 0 && (
                <div
                  style={{
                    padding: 24,
                    textAlign: 'center',
                    color: '#6B7280',
                    fontSize: 14,
                  }}
                >
                  {t('langPickerNoResults', current)}
                </div>
              )}

              {matches.map((code) => {
                const m = LOCALE_META[code];
                const isActive = code === current;
                return (
                  <button
                    key={code}
                    onClick={() => handlePick(code)}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      padding: '14px 14px',
                      background: isActive ? '#EFF6FF' : 'white',
                      border: isActive ? '2px solid #2563EB' : '1.5px solid #E5E7EB',
                      borderRadius: 12,
                      marginBottom: 6,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      WebkitTapHighlightColor: 'transparent',
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 16, fontWeight: 700, color: '#111827' }}>
                        {m.nativeName}
                      </div>
                      <div style={{ fontSize: 12, color: '#6B7280', marginTop: 2 }}>
                        {m.englishName}
                        {m.machineTranslated && (
                          <span
                            style={{
                              marginLeft: 8,
                              padding: '1px 6px',
                              background: '#FFFBEB',
                              color: '#92400E',
                              border: '1px solid #FCD34D',
                              borderRadius: 4,
                              fontSize: 10,
                              fontWeight: 700,
                              letterSpacing: '0.04em',
                            }}
                          >
                            BETA
                          </span>
                        )}
                      </div>
                    </div>
                    {isActive && <Check size={18} color="#2563EB" />}
                  </button>
                );
              })}

              <div
                style={{
                  marginTop: 14,
                  padding: '10px 12px',
                  background: '#F9FAFB',
                  borderRadius: 10,
                  fontSize: 12,
                  color: '#6B7280',
                  lineHeight: 1.4,
                }}
              >
                {t('langMachineTranslatedNotice', current)}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
