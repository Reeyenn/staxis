'use client';

// Step 3 — trigger: a schedule (time + days) OR an event from the catalog.

import React from 'react';
import { T, fonts, Caps } from '../_tokens';
import { pickBilingual } from '../../_lib/format';
import { s, type Lang } from '../../_lib/strings';
import type { TriggerKind } from '../../_lib/wizardState';
import { AGENT_EVENT_CATALOG, type AgentEventName } from '@/lib/agents/types';

const DAY_KEYS: Record<Lang, string[]> = {
  en: ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'],
  es: ['Do', 'Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sa'],
};

function tab(on: boolean): React.CSSProperties {
  return {
    padding: '7px 16px', borderRadius: 999, cursor: 'pointer',
    border: `1px solid ${on ? T.ink : T.rule}`, background: on ? T.ink : 'transparent',
    color: on ? T.bg : T.ink2, fontFamily: fonts.sans, fontSize: 13, fontWeight: 600,
  };
}

export function TriggerEditor({
  kind, atLocalTime, daysOfWeek, eventName, onKind, onTime, onToggleDay, onEvent, lang,
}: {
  kind: TriggerKind;
  atLocalTime: string;
  daysOfWeek: number[];
  eventName: AgentEventName | '';
  onKind: (k: TriggerKind) => void;
  onTime: (v: string) => void;
  onToggleDay: (d: number) => void;
  onEvent: (name: AgentEventName) => void;
  lang: Lang;
}) {
  const selectedEvent = AGENT_EVENT_CATALOG.find((e) => e.name === eventName);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 520 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" onClick={() => onKind('schedule')} style={tab(kind === 'schedule')}>{s(lang, 'triggerSchedule')}</button>
        <button type="button" onClick={() => onKind('event')} style={tab(kind === 'event')}>{s(lang, 'triggerEvent')}</button>
      </div>

      {kind === 'schedule' ? (
        <>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 200 }}>
            <Caps>{s(lang, 'timeOfDay')}</Caps>
            <input
              type="time"
              value={atLocalTime}
              onChange={(e) => onTime(e.target.value)}
              style={{ border: `1px solid ${T.rule}`, borderRadius: 10, padding: '8px 10px', fontFamily: fonts.sans, fontSize: 14, color: T.ink, background: T.paper }}
            />
          </label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Caps>{s(lang, 'daysLabel')}</Caps>
            <div role="group" aria-label={s(lang, 'daysLabel')} style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {DAY_KEYS[lang].map((label, i) => {
                const on = daysOfWeek.includes(i);
                return (
                  <button
                    key={i}
                    type="button"
                    aria-pressed={on}
                    onClick={() => onToggleDay(i)}
                    style={{
                      width: 40, height: 40, borderRadius: '50%', cursor: 'pointer',
                      border: `1px solid ${on ? T.ink : T.rule}`, background: on ? T.ink : 'transparent',
                      color: on ? T.bg : T.ink2, fontFamily: fonts.sans, fontSize: 12.5, fontWeight: 600,
                    }}
                  >{label}</button>
                );
              })}
            </div>
            <span style={{ fontFamily: fonts.sans, fontSize: 12, color: T.ink3 }}>
              {daysOfWeek.length === 0 ? s(lang, 'everyDay') : ''}
            </span>
          </div>
        </>
      ) : (
        <>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Caps>{s(lang, 'eventLabel')}</Caps>
            <select
              value={eventName}
              onChange={(e) => onEvent(e.target.value as AgentEventName)}
              style={{ border: `1px solid ${T.rule}`, borderRadius: 10, padding: '9px 12px', fontFamily: fonts.sans, fontSize: 14, color: T.ink, background: T.paper }}
            >
              <option value="">—</option>
              {AGENT_EVENT_CATALOG.map((ev) => (
                <option key={ev.name} value={ev.name}>{pickBilingual(ev.label, lang)}</option>
              ))}
            </select>
          </label>
          {selectedEvent && (
            <div style={{ fontFamily: fonts.sans, fontSize: 12.5, color: T.ink2 }}>
              <span style={{ color: T.ink3 }}>{s(lang, 'eventGives')} </span>
              {selectedEvent.payloadKeys.join(', ')}
            </div>
          )}
        </>
      )}
    </div>
  );
}
