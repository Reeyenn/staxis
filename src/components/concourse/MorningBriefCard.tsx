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
//   3. Invent a line. It prints exactly what the payload holds, in the
//      manager's language, in order.
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

const S = {
  heading: { en: 'This morning', es: 'Esta mañana' },
  jump: { en: 'Show me', es: 'Muéstramelo' },
} as const;

const MB_CSS = `
.mb-card{background:#fff;border:1px solid rgba(62,92,72,.22);border-radius:18px;
  padding:16px 17px 15px;margin-top:20px;display:flex;gap:14px;align-items:flex-start;
  box-shadow:0 10px 26px -22px rgba(31,35,28,.5);}
.mb-chip{width:36px;height:36px;border-radius:12px;flex-shrink:0;display:grid;place-items:center;
  color:#3E5C48;background:rgba(158,183,166,.22);}
.mb-body{flex:1;min-width:0;}
.mb-eyebrow{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:9.5px;
  letter-spacing:.14em;text-transform:uppercase;color:#8A9187;}
.mb-line{font-size:13.5px;line-height:1.6;color:#1F231C;margin-top:6px;display:flex;gap:8px;
  align-items:baseline;}
.mb-line:first-of-type{margin-top:8px;font-weight:600;}
.mb-bullet{width:4px;height:4px;border-radius:50%;background:#9EB7A6;flex-shrink:0;
  transform:translateY(-3px);}
.mb-jump{background:transparent;border:none;padding:0;margin:0;text-align:left;cursor:pointer;
  font:inherit;color:#1F231C;text-decoration:underline;text-decoration-color:rgba(62,92,72,.35);
  text-underline-offset:3px;}
.mb-jump:hover{text-decoration-color:#3E5C48;}
.mb-jump:focus-visible{outline:2px solid #3E5C48;outline-offset:2px;border-radius:4px;}
.mb-last{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:11.5px;color:#8A9187;
  margin-top:9px;letter-spacing:.01em;}
`;

export interface MorningBriefViewProps {
  brief: MorningBrief | null;
  lang: Lang;
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
  lang,
  readFailed = false,
  onFocusFinding,
}: MorningBriefViewProps) {
  const es = lang === 'es';
  if (readFailed || !brief || brief.lines.length === 0) return null;

  // The liveness line is the brief's own proof-of-life and reads as machine
  // output, not prose — so it is set apart rather than sitting in the list as
  // if it were a fourth thing to worry about.
  const body = brief.lines.slice(0, brief.lines.length - 1);
  const last = brief.lines[brief.lines.length - 1];
  const lines = brief.kind === 'quiet' ? brief.lines : body;

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: MB_CSS }} />
      <div className="mb-card">
        <div className="mb-chip">
          <CxIcon name="staxis" size={17} />
        </div>
        <div className="mb-body">
          <div className="mb-eyebrow">{es ? S.heading.es : S.heading.en}</div>

          {lines.map((line, index) => {
            const text = es ? line.es : line.en;
            const id = line.findingId;
            return (
              <div className="mb-line" key={`${index}-${text.slice(0, 24)}`}>
                {index > 0 && <span className="mb-bullet" aria-hidden />}
                {id && onFocusFinding ? (
                  <button
                    type="button"
                    className="mb-jump"
                    title={es ? S.jump.es : S.jump.en}
                    onClick={() => onFocusFinding(id)}
                  >
                    {text}
                  </button>
                ) : (
                  <span>{text}</span>
                )}
              </div>
            );
          })}

          {brief.kind !== 'quiet' && last && (
            <div className="mb-last">{es ? last.es : last.en}</div>
          )}
        </div>
      </div>
    </>
  );
}

