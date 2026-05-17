'use client';

import React, { createContext, useContext, useState, useEffect } from 'react';
import type { Language } from '@/lib/translations';

interface LanguageContextType {
  lang: Language;
  setLang: (l: Language) => void;
}

const LanguageContext = createContext<LanguageContextType>({
  lang: 'en',
  setLang: () => {},
});

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Language>('en');

  useEffect(() => {
    const stored = localStorage.getItem('hotelops-lang') as Language | null;
    if (stored === 'en' || stored === 'es') setLangState(stored);
  }, []);

  // Cross-tab sync (audit/concurrency #12). The `storage` event fires
  // in OTHER tabs when one tab calls localStorage.setItem, so a language
  // switch in Tab A immediately propagates to Tabs B/C/… without
  // requiring a refresh. Without this, each tab's lang state diverged
  // from the persisted value the moment another tab changed it.
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== 'hotelops-lang') return;
      if (e.newValue === 'en' || e.newValue === 'es') {
        setLangState(e.newValue as Language);
      }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  // Mirror the active language onto <html lang> so screen readers (and
  // anything else that keys off the document language) pick up the
  // switch. layout.tsx hardcodes lang="en" at SSR; this overrides it
  // client-side once the user toggles. Belt-and-suspenders: also runs
  // on first load so the SSR'd "en" doesn't linger if the saved pref
  // was Spanish.
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = lang;
    }
  }, [lang]);

  const setLang = (l: Language) => {
    setLangState(l);
    localStorage.setItem('hotelops-lang', l);
  };

  return (
    <LanguageContext.Provider value={{ lang, setLang }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLang() {
  return useContext(LanguageContext);
}
