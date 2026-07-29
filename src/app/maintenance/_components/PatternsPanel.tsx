'use client';

/**
 * The body of the "Patterns Staxis has spotted" popup — everything it says,
 * with no hooks, no fetch and no modal shell.
 *
 * WHY IT IS A SEPARATE FILE FROM PatternsModal
 * Same reason `FindingCardsView` is separate from `FindingCards`: the half
 * that decides what the manager READS can then be exercised directly in a
 * test, with no renderer and no browser. It also keeps this file clear of
 * `_mt-snow`, whose error-boundary class cannot even be imported under the
 * suite's react-server condition — so a component that lived beside the modal
 * shell could not be tested at all.
 *
 * Two halves, and the split is the point:
 *   STANDING NOW   the maintenance findings currently on the books, drawn by
 *                  the very same card component the Staxis queue uses, so a
 *                  manager reads one card language across the app rather than
 *                  a second dialect invented for this popup.
 *   BEFORE THIS    one plain line per pattern saying when it was caught, what
 *                  became of it, and whether it came back.
 *
 * READ-ONLY, ON PURPOSE. Every card renders without its verdict buttons and
 * without its attached fix. Deciding on a finding stays in exactly one place —
 * the Staxis tab — because two surfaces that can both close a card are two
 * surfaces that have to agree about rate limits, company sign-off and undo
 * forever. A line at the bottom says where to go, so nothing looks broken.
 *
 * THE EMPTY STATE IS THE COMMON CASE. The findings runner is switched off at
 * the fleet level right now, so most hotels open this to nothing. It says one
 * calm sentence. It must never grow a warning icon, a "checks are not running"
 * banner, or filler content: a manager who opens a popup and is told something
 * is broken will not open it again, and nothing IS broken.
 *
 * NO MONEY IS DRAWN HERE. The standing cards carry their own stored ranges
 * through the ordinary card projection. The history lines carry none at all —
 * a dollar figure on this screen that did not come out of the row it describes
 * would be a number Staxis invented.
 */

import React from 'react';

import { T, FONT_SANS } from '@/app/housekeeping/_components/_snow';
import { FindingCardsView } from '@/components/concourse/FindingCards';
import type { QueueFinding, QueueRun } from '@/components/concourse/finding-cards';
import {
  historyLine,
  timesCaughtLabel,
  type PatternHistory,
} from '@/lib/findings/maintenance-lens';

export interface PatternsPayload {
  findings: QueueFinding[];
  history: PatternHistory[];
  run: QueueRun | null;
  cap: number;
}

/** What the read is doing. 'failed' is never drawn as 'ready with nothing'. */
export type PatternsReadState = 'loading' | 'failed' | 'ready';

export type PanelLang = 'en' | 'es';

const S = {
  title: {
    en: 'Patterns Staxis has spotted',
    es: 'Patrones que Staxis ha detectado',
  },
  subtitle: {
    en: 'Repeat maintenance problems at this hotel, and what happened to each one.',
    es: 'Problemas de mantenimiento que se repiten en este hotel, y qué pasó con cada uno.',
  },
  button: { en: 'Patterns spotted', es: 'Patrones detectados' },
  close: { en: 'Close', es: 'Cerrar' },
  standing: { en: 'Open now', es: 'Abiertos ahora' },
  before: { en: 'History', es: 'Historial' },
  nothingStanding: {
    en: 'Nothing open right now.',
    es: 'Nada abierto ahora mismo.',
  },
  // The one line a hotel with no findings ever sees. Calm, complete, no alarm.
  empty: {
    en: 'Staxis hasn’t caught any repeat maintenance problems here yet.',
    es: 'Staxis todavía no ha detectado problemas de mantenimiento que se repitan aquí.',
  },
  // An error is NOT an empty list. Saying "no patterns" when the read failed
  // would be Staxis claiming the building is fine on the strength of a broken
  // query — the same lie the queue route refuses to tell.
  failed: {
    en: 'Couldn’t check just now. Try again in a moment.',
    es: 'No se pudo comprobar ahora mismo. Inténtalo de nuevo en un momento.',
  },
  loading: { en: 'One moment…', es: 'Un momento…' },
  whereToAct: {
    en: 'Read only here. Close these out on the Staxis tab.',
    es: 'Solo lectura aquí. Ciérralos en la pestaña Staxis.',
  },
  cameBack: { en: 'Came back', es: 'Volvió' },
} as const;

export type PanelTextKey = keyof typeof S;

/**
 * Every key in S, so a test can walk the whole copy deck rather than the two
 * or three strings somebody remembered to assert on. Derived from S itself —
 * a hand-written list would go stale the first time a string is added.
 */
export const PANEL_TEXT_KEYS = Object.keys(S) as PanelTextKey[];

export const panelText = <K extends PanelTextKey>(k: K, lang: PanelLang) =>
  (lang === 'es' ? S[k].es : S[k].en);

export function MaintenancePatternsBody({
  state,
  payload,
  lang,
}: {
  state: PatternsReadState;
  payload: PatternsPayload | null;
  lang: PanelLang;
}) {
  if (state === 'loading') return <Note text={panelText('loading', lang)} />;
  if (state === 'failed' || !payload) return <Note text={panelText('failed', lang)} />;

  const { findings, history } = payload;
  if (findings.length === 0 && history.length === 0) {
    return <Note text={panelText('empty', lang)} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>
      <section>
        {findings.length === 0 ? (
          <>
            <SectionLabel text={panelText('standing', lang)} />
            <Note text={panelText('nothingStanding', lang)} />
          </>
        ) : (
          <>
            {/* The heading is FindingCardsView's, not ours — it renders one
                itself whenever a card is visible, and a second label above it
                printed "Standing now" twice. */}
            <FindingCardsView
              findings={findings}
              run={payload.run}
              cap={payload.cap}
              lang={lang}
              readOnly
              hideLiveness
              heading={panelText('standing', lang)}
              // Read-only surface: nothing here reaches a write path, so the
              // handler exists only to satisfy the contract.
              onVerdict={noop}
            />
            <p style={{
              fontFamily: FONT_SANS, fontSize: 12, color: T.ink3,
              margin: '12px 0 0',
            }}>{panelText('whereToAct', lang)}</p>
          </>
        )}
      </section>

      {history.length > 0 && (
        <section>
          <SectionLabel text={panelText('before', lang)} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {history.map((p) => (
              <HistoryRow key={p.dedupeKey} pattern={p} lang={lang} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function noop() { /* read-only */ }

function HistoryRow({ pattern, lang }: { pattern: PatternHistory; lang: PanelLang }) {
  const times = timesCaughtLabel(pattern, lang);
  return (
    <div style={{
      borderLeft: `2px solid ${pattern.cameBack ? '#B08968' : T.rule}`,
      paddingLeft: 12,
    }}>
      <div style={{
        fontFamily: FONT_SANS, fontSize: 13.5, color: T.ink,
        fontWeight: 600, lineHeight: 1.4,
      }}>{lang === 'es' ? pattern.titleEs : pattern.titleEn}</div>
      <div style={{
        fontFamily: FONT_SANS, fontSize: 12.5, color: T.ink2,
        margin: '4px 0 0', lineHeight: 1.5,
      }}>{historyLine(pattern, lang)}</div>
      {(times || pattern.cameBack) && (
        <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
          {pattern.cameBack && <Chip text={panelText('cameBack', lang)} tone="warn" />}
          {times && <Chip text={times} tone="plain" />}
        </div>
      )}
    </div>
  );
}

function Chip({ text, tone }: { text: string; tone: 'warn' | 'plain' }) {
  return (
    <span style={{
      fontFamily: FONT_SANS, fontSize: 11, fontWeight: 600,
      padding: '3px 9px', borderRadius: 999,
      background: tone === 'warn' ? 'rgba(176,137,104,0.14)' : 'rgba(31,35,28,0.05)',
      color: tone === 'warn' ? '#8A6440' : T.ink2,
    }}>{text}</span>
  );
}

/** Matches `.fd-headt` inside FindingCardsView, so the popup's two section
 *  headings read as one family rather than two design systems meeting. */
function SectionLabel({ text }: { text: string }) {
  return (
    <div style={{
      fontFamily: FONT_SANS, fontSize: 15, fontWeight: 600,
      color: T.ink, marginBottom: 10,
    }}>{text}</div>
  );
}

function Note({ text }: { text: string }) {
  return (
    <p style={{
      fontFamily: FONT_SANS, fontSize: 13.5, color: T.ink2,
      margin: '6px 0', lineHeight: 1.5,
    }}>{text}</p>
  );
}
