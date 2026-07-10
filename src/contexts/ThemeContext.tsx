'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export type StaxisTheme = 'light' | 'dark';

const STORAGE_KEY = 'staxis-theme';

interface ThemeContextValue {
  theme: StaxisTheme;
  ready: boolean;
  setTheme: (theme: StaxisTheme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'light',
  ready: false,
  setTheme: () => {},
  toggleTheme: () => {},
});

function applyTheme(theme: StaxisTheme) {
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<StaxisTheme>('light');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const rootTheme = document.documentElement.dataset.theme;
    const stored = localStorage.getItem(STORAGE_KEY);
    const next: StaxisTheme = rootTheme === 'dark' || stored === 'dark' ? 'dark' : 'light';
    setThemeState(next);
    applyTheme(next);
    setReady(true);
  }, []);

  const setTheme = useCallback((next: StaxisTheme) => {
    setThemeState(next);
    applyTheme(next);
    localStorage.setItem(STORAGE_KEY, next);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }, [setTheme, theme]);

  const value = useMemo(() => ({ theme, ready, setTheme, toggleTheme }), [theme, ready, setTheme, toggleTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
