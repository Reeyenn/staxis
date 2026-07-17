'use client';

// ═══════════════════════════════════════════════════════════════════════════
// AskHero — the glowing Ask Staxis bar on the home hub.
//
// AskHeroView is presentational. The connected
// AskHero hands real input off to the ONE live chat surface — the global
// AskStaxisBar — over a window event ('staxis:ask'), so there's a single
// conversation brain, history, and approval flow no matter where you typed.
// ═══════════════════════════════════════════════════════════════════════════

import React from 'react';
import { useLang } from '@/contexts/LanguageContext';

export interface AskHeroViewProps {
  placeholder: string;
  onSubmit: (text: string) => void;
}

export function AskHeroView({ placeholder, onSubmit }: AskHeroViewProps) {
  const [value, setValue] = React.useState('');
  const submit = () => {
    const text = value.trim();
    if (!text) return;
    setValue('');
    onSubmit(text);
  };
  return (
    <div className="cx-ask">
      <span className="cx-spark" aria-hidden>✦</span>
      <input
        value={value}
        placeholder={placeholder}
        aria-label="Ask Staxis"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
      />
    </div>
  );
}

/** Fired at the global AskStaxisBar, which owns the live conversation. */
export const ASK_EVENT = 'staxis:ask';

export function AskHero() {
  const { lang } = useLang();
  return (
    <AskHeroView
      placeholder={lang === 'es'
        ? 'Pregunta o da una orden — “¿quién limpia la 204?”'
        : 'Ask or command — “who’s cleaning 204?”'}
      onSubmit={(text) => {
        window.dispatchEvent(new CustomEvent(ASK_EVENT, { detail: { text } }));
      }}
    />
  );
}
