'use client';

import React, { createContext, useContext } from 'react';
interface LanguageContextType {
  lang: 'en';
  locale: 'en';
}

const LanguageContext = createContext<LanguageContextType>({
  lang: 'en',
  locale: 'en',
});

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  return (
    <LanguageContext.Provider value={{ lang: 'en', locale: 'en' }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLang() {
  return useContext(LanguageContext);
}
