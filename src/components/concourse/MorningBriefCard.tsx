'use client';

// ═══════════════════════════════════════════════════════════════════════════
// The morning brief card — pinned above everything in the Staxis tab.
//
// Six to eight lines, rebuilt once a morning on the hotel's clock, and it is
// the same six to eight lines all day. Everything it says was decided by
// src/lib/findings/brief.ts and checked by /api/findings/brief; this file draws
// it and does nothing else.
//
// THE THREE THINGS IT MUST NOT DO
//   1. Render on a hotel that has never been checked. `brief` comes back null
//      and this component renders NOTHING — not an empty card, not a skeleton,
//      not "no data yet". A blank morning summary on an unscanned hotel reads
//      as a clean night, and it is not one.
//   2. Render on a failed read. Same reason: an error is not a quiet night.
//   3. Invent a line. It prints exactly what the payload holds, in order.
//
// THE WHOLE CARD IS IN ENGLISH — the lines, the eyebrow, the link title —
// whatever language the reader has the app set to. Founder ruling; the reasoning
// is in the header of src/lib/findings/brief.ts. Everything else on this screen
// (the cards below, the chips, the buttons) is unchanged and still bilingual, so
// this card is the exception and it is meant to look like one from here.
//
// Read through /api/findings/brief (service-role behind requireSession + the
// manager gate) — never the browser Supabase client. `findings` and
// `finding_runs` are deny-all to the browser, so a direct read would come back
// as an empty list with a 200 and this card would quietly lie.
// ═══════════════════════════════════════════════════════════════════════════

import React from 'react';

import type { MorningBrief } from '@/lib/findings/brief';
import type { Lang } from './finding-cards';

import { CxIcon } from './icons';

/** What GET /api/findings/brief hands back. QueueView owns the fetch — see the
 *  note on the liveness line there. */
export interface BriefPayload {
  brief: MorningBrief | null;
  cached: boolean;
}

/** The card's own chrome. English, like the lines it sits around — a Spanish
 *  eyebrow over eight English sentences would read as a rendering bug. */
const S = {
  // The badge on the ink card. It says what this card IS, because it now sits
  // at the BOTTOM of the day rather than pinned at the top: by the afternoon a
  // manager scrolling down to it needs to be told they have reached the
  // morning, not that they are looking at "this morning" right now.
  heading: 'The morning brief',
  stamp: 'where the day started',
  jump: 'Show me',
} as const;

/**
 * Only the two fields this card draws.
 *
 * Structural rather than `MorningBrief`, because the PORTFOLIO brief
 * (src/lib/company/vp-brief.ts) is a different assembly with a different scope
 * key and the identical line shape — and a company-scope reader should see the
 * same pinned card their GMs do, not a second one that looks almost like it.
 */
export type RenderableBrief = Pick<MorningBrief, 'kind' | 'lines'> & {
  /** When it was built. Optional: the portfolio brief predates the stamp. */
  generatedAt?: string;
};

export interface MorningBriefViewProps {
  brief: RenderableBrief | null;
  /**
   * The reader's language — ACCEPTED AND DELIBERATELY IGNORED.
   *
   * It stays on the props for one reason: it is how the English-only ruling gets
   * said out loud and tested. Both callers already hold a language and pass it,
   * and a test that hands this card `lang: 'es'` and gets back the full English
   * brief is an assertion about behaviour rather than a note in a comment. Drop
   * the prop and the ruling becomes untestable from the outside; honour it and
   * the test goes red, which is the point.
   */
  lang?: Lang;
  /** True when the read failed. Renders nothing — an error is not a quiet night. */
  readFailed?: boolean;
  /** Told which card a line points at, so the queue below can jump to it. */
  onFocusFinding?: (findingId: string) => void;
}

/**
 * The card, given data. Split from the fetching wrapper so the line rendering,
 * the null case and the jump links can be exercised with real payloads and no
 * session in the way.
 */
export function MorningBriefView({
  brief,
  readFailed = false,
  onFocusFinding,
}: MorningBriefViewProps) {
  if (readFailed || !brief || brief.lines.length === 0) return null;

  // The liveness line is the brief's own proof-of-life and reads as machine
  // output, not prose — so it is set apart rather than sitting in the list as
  // if it were a fourth thing to worry about.
  const body = brief.lines.slice(0, brief.lines.length - 1);
  const last = brief.lines[brief.lines.length - 1];
  const lines = brief.kind === 'quiet' ? brief.lines : body;

  // The first line is what the night came to. It gets the serif sentence; the
  // rest become chips, which is the honest shape — they are three separate
  // facts, not a paragraph.
  const [headline, ...rest] = lines;

  return (
    <div className="fx-ink-card" data-staxis-surface="brief" data-brief-kind={brief.kind}>
      <span className="fx-scan fx-slow" aria-hidden />

      <div className="fx-inkhead">
        <span className="fx-badge">
          <CxIcon name="staxis" size={11} strokeWidth={2.2} />
          {S.heading}
        </span>
        <span className="fx-stamp">
          {[clockStamp(brief.generatedAt), S.stamp].filter(Boolean).join(' · ')}
        </span>
        {brief.kind !== 'quiet' && last && (
          <span className="fx-tally">{last.text}</span>
        )}
      </div>

      {headline && (
        headline.findingId && onFocusFinding ? (
          <button
            type="button"
            className="fx-brief"
            title={S.jump}
            onClick={() => onFocusFinding(headline.findingId!)}
          >
            {headline.text}
          </button>
        ) : (
          <div className="fx-brief">{headline.text}</div>
        )
      )}

      {rest.length > 0 && (
        <div className="fx-bchips">
          {rest.map((line, index) => {
            const id = line.findingId;
            // A line that names a card is a thing still open, so it wears the
            // amber dot. One that names nothing already resolved itself or is
            // context, and stays sage. Nothing is invented: the difference is
            // whether the brief could point at a finding.
            const cls = `fx-bchip${id ? ' fx-flag' : ''}`;
            const inner = (
              <>
                <span className="fx-bdot" aria-hidden />
                {line.text}
              </>
            );
            return id && onFocusFinding ? (
              <button
                key={`${index}-${line.text.slice(0, 24)}`}
                type="button"
                className={cls}
                title={S.jump}
                onClick={() => onFocusFinding(id)}
              >
                {inner}
              </button>
            ) : (
              <span key={`${index}-${line.text.slice(0, 24)}`} className={cls}>{inner}</span>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** "6:04 AM", or empty when there is no usable stamp. */
function clockStamp(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

