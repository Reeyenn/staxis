'use client';

import React from 'react';

export type StaxisThemePreference = 'system' | 'light' | 'dark';
export type StaxisResolvedTheme = 'light' | 'dark';

interface ThemeContextValue {
  preference: StaxisThemePreference;
  resolvedTheme: StaxisResolvedTheme;
  setPreference: (preference: StaxisThemePreference) => void;
  toggleTheme: () => void;
}

const STORAGE_KEY = 'staxis-theme-preference';

const ThemeContext = React.createContext<ThemeContextValue>({
  preference: 'system',
  resolvedTheme: 'light',
  setPreference: () => {},
  toggleTheme: () => {},
});

function storedPreference(): StaxisThemePreference {
  if (typeof window === 'undefined') return 'system';
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
  } catch {
    return 'system';
  }
}

function systemTheme(): StaxisResolvedTheme {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreferenceState] = React.useState<StaxisThemePreference>('system');
  const [system, setSystem] = React.useState<StaxisResolvedTheme>('light');
  const [hydrated, setHydrated] = React.useState(false);

  React.useEffect(() => {
    setPreferenceState(storedPreference());
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => setSystem(query.matches ? 'dark' : 'light');
    sync();
    setHydrated(true);
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  const resolvedTheme = preference === 'system' ? system : preference;

  React.useEffect(() => {
    if (!hydrated) return;
    const root = document.documentElement;
    root.dataset.theme = resolvedTheme;
    root.style.colorScheme = resolvedTheme;
    document.querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', resolvedTheme === 'dark' ? '#111512' : '#F5F7F4');
  }, [hydrated, resolvedTheme]);

  const setPreference = React.useCallback((next: StaxisThemePreference) => {
    setPreferenceState(next);
    try { window.localStorage.setItem(STORAGE_KEY, next); } catch { /* storage unavailable */ }
  }, []);

  const toggleTheme = React.useCallback(() => {
    setPreference(resolvedTheme === 'dark' ? 'light' : 'dark');
  }, [resolvedTheme, setPreference]);

  const value = React.useMemo<ThemeContextValue>(() => ({
    preference,
    resolvedTheme,
    setPreference,
    toggleTheme,
  }), [preference, resolvedTheme, setPreference, toggleTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return React.useContext(ThemeContext);
}
