'use client';

import { Moon, Sun } from 'lucide-react';
import { useLang } from '@/contexts/LanguageContext';
import { useTheme } from '@/contexts/ThemeContext';

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { theme, ready, toggleTheme } = useTheme();
  const { lang } = useLang();
  const dark = theme === 'dark';
  const label = dark
    ? (lang === 'es' ? 'Usar tema claro' : 'Use light theme')
    : (lang === 'es' ? 'Usar tema oscuro' : 'Use dark theme');

  return (
    <button
      type="button"
      className={`stx-theme-toggle${compact ? ' stx-theme-toggle--compact' : ''}`}
      onClick={toggleTheme}
      aria-label={ready ? label : (lang === 'es' ? 'Cargando tema' : 'Loading theme')}
      title={ready ? label : undefined}
      disabled={!ready}
      aria-busy={!ready}
    >
      <span aria-hidden="true" className="stx-theme-toggle__icon">
        {dark ? <Sun size={17} /> : <Moon size={17} />}
      </span>
      {!compact && <span>{ready ? (dark ? (lang === 'es' ? 'Claro' : 'Light') : (lang === 'es' ? 'Oscuro' : 'Dark')) : '…'}</span>}
    </button>
  );
}
