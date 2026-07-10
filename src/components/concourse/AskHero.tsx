'use client';

// ═══════════════════════════════════════════════════════════════════════════
// AskHero — the glowing Ask Staxis bar on the home hub.
//
// AskHeroView is presentational (shared with /demo/concourse). The connected
// AskHero hands real input off to the ONE live chat surface — the global
// AskStaxisBar — over a window event ('staxis:ask'), so there's a single
// conversation brain, history, and approval flow no matter where you typed.
// Talk opens the real ElevenLabs voice overlay.
// ═══════════════════════════════════════════════════════════════════════════

import React from 'react';
import { useLang } from '@/contexts/LanguageContext';
import { useVoicePanel } from '@/components/agent/VoicePanelContext';
import { CxIcon } from './icons';

export interface AskHeroViewProps {
  placeholder: string;
  talkLabel: string;
  onSubmit: (text: string) => void;
  onTalk: () => void;
}

export function AskHeroView({ placeholder, talkLabel, onSubmit, onTalk }: AskHeroViewProps) {
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
      <button type="button" className="cx-talk" onClick={onTalk}>
        <CxIcon name="mic" size={13} />
        {talkLabel}
      </button>
    </div>
  );
}

/** Fired at the global AskStaxisBar, which owns the live conversation. */
export const ASK_EVENT = 'staxis:ask';

export function AskHero() {
  const { lang } = useLang();
  const voicePanel = useVoicePanel();
  return (
    <AskHeroView
      placeholder={lang === 'es'
        ? 'Pregunta o da una orden — “¿quién limpia la 204?”'
        : 'Ask or command — “who’s cleaning 204?”'}
      talkLabel={lang === 'es' ? 'Hablar' : 'Talk'}
      onSubmit={(text) => {
        window.dispatchEvent(new CustomEvent(ASK_EVENT, { detail: { text } }));
      }}
      onTalk={() => voicePanel?.openVoiceMode()}
    />
  );
}
