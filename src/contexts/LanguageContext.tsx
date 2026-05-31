'use client';

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import type { Language, HousekeeperLocale } from '@/lib/translations';
import { supabase } from '@/lib/supabase';
import { useAuth } from './AuthContext';

// ─── App-wide language ──────────────────────────────────────────────────────
// `locale` is the user's real choice across all 5 supported languages.
// `lang` is the NARROW ('en'|'es') value the rest of the app's inline
// `lang === 'es' ? … : …` ternaries key off — it's derived from locale
// (es → es, everything else → en). HT/TL/VI therefore render the English
// branch of those ternaries, and the GlobalAutoTranslate layer machine-
// translates that on-screen text into the chosen language (no English gaps).
// New code should prefer `locale` + the static t() dictionary, which already
// ships HT/TL/VI for the housekeeper-facing subset.

const SUPPORTED: HousekeeperLocale[] = ['en', 'es', 'ht', 'tl', 'vi'];
const LS_KEY = 'staxis-locale';

interface LanguageContextType {
  lang: Language;
  locale: HousekeeperLocale;
  setLang: (l: Language) => void;
  setLocale: (l: HousekeeperLocale) => void;
}

const LanguageContext = createContext<LanguageContextType>({
  lang: 'en',
  locale: 'en',
  setLang: () => {},
  setLocale: () => {},
});

function narrow(l: HousekeeperLocale): Language {
  return l === 'es' ? 'es' : 'en';
}

async function authFetch(url: string, init?: RequestInit): Promise<Response> {
  let token: string | undefined;
  try {
    const { data } = await supabase.auth.getSession();
    token = data.session?.access_token;
  } catch { /* not signed in */ }
  return fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [locale, setLocaleState] = useState<HousekeeperLocale>('en');

  // 1) Instant: localStorage (+ migrate the legacy 'hotelops-lang' key).
  useEffect(() => {
    const stored = localStorage.getItem(LS_KEY) as HousekeeperLocale | null;
    if (stored && SUPPORTED.includes(stored)) { setLocaleState(stored); return; }
    const legacy = localStorage.getItem('hotelops-lang');
    if (legacy === 'es') setLocaleState('es');
  }, []);

  // 2) When signed in, adopt the server-saved preference (cross-device).
  useEffect(() => {
    if (!user) return;
    let alive = true;
    (async () => {
      try {
        const res = await authFetch('/api/comms/language');
        if (!res.ok) return;
        const json = (await res.json()) as { ok?: boolean; data?: { language?: string } };
        const srv = json?.data?.language;
        if (alive && srv && SUPPORTED.includes(srv as HousekeeperLocale)) {
          setLocaleState(srv as HousekeeperLocale);
          localStorage.setItem(LS_KEY, srv);
        }
      } catch { /* best-effort */ }
    })();
    return () => { alive = false; };
  }, [user]);

  // Cross-tab sync.
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== LS_KEY) return;
      if (e.newValue && SUPPORTED.includes(e.newValue as HousekeeperLocale)) {
        setLocaleState(e.newValue as HousekeeperLocale);
      }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  // Reflect onto <html lang> for a11y.
  useEffect(() => {
    if (typeof document !== 'undefined') document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((l: HousekeeperLocale) => {
    setLocaleState(l);
    localStorage.setItem(LS_KEY, l);
    // Also keep the legacy key in sync for any code still reading it.
    localStorage.setItem('hotelops-lang', narrow(l));
    // Persist server-side (best-effort; ignored when signed out).
    void authFetch('/api/comms/language', { method: 'POST', body: JSON.stringify({ language: l }) }).catch(() => {});
  }, []);

  const setLang = useCallback((l: Language) => setLocale(l), [setLocale]);

  return (
    <LanguageContext.Provider value={{ lang: narrow(locale), locale, setLang, setLocale }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLang() {
  return useContext(LanguageContext);
}
