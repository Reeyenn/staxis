'use client';

/**
 * feature/housekeeping-levels (2026-07-24) — the one-time Housekeeping
 * questionnaire.
 *
 * Shown full-bleed INSTEAD of the Housekeeping tabs the first time a manager
 * opens the section for a hotel (the gate lives in ../page.tsx). Six questions,
 * one per screen, then a screen where they choose how much of Staxis to adopt.
 * It saves once and is never shown again.
 *
 * WHY IT LOOKS LIKE THIS
 * This is the first thing a new hotel ever does inside Housekeeping, and the
 * answers here drive every hour and every dollar we later report. So it gets the
 * onboarding wizard's treatment (/onboard: animated blurred wash + paper grain +
 * a frosted card) rather than the flat in-app forms — a screen that feels
 * considered gets considered answers.
 *
 * RULES THIS FILE DOES NOT OWN
 * Every level rule (which levels are offerable, why one is locked, which one we
 * recommend) comes from `@/lib/housekeeping/setup-gate` — the same module the
 * write route validates with. Nothing here re-derives them. A second copy of
 * "level 3 is locked when housekeepers enter status themselves" is a bug waiting
 * for the two copies to drift.
 *
 * MOTION POLICY
 * No entrance choreography on mount. Load-time cascades were retired across the
 * app after they read as a glitch (see the header of
 * src/app/inventory/_components/motion.ts). Motion here fires only in response to
 * a tap: the screen slides in the direction you travelled, and a chip pops when
 * you pick it. `prefers-reduced-motion: reduce` drops every transform and leaves
 * a plain cross-fade.
 *
 * NOTHING MOVES THE SCREEN EXCEPT THE PERSON USING IT
 * Picking an answer selects it and stops there. An earlier build advanced to the
 * next question a moment after a chip was tapped, and it was the founder's
 * clearest complaint: an answer he had just chosen slid away before he was done
 * looking at it, and there was no way to sit on a question and change his mind.
 * Every move now comes from Continue, Back, the progress rail, or Enter — and
 * because the flow no longer moves as confirmation, a picked chip carries a
 * visible check and Continue lights up. Do not reintroduce a timed jump; a
 * failed photo upload does not move the screen either (it says so instead).
 *
 * NETWORK
 * Both calls go through `fetchWithAuth` (bearer token + 401 recovery). The board
 * photo is best-effort by design and NEVER shows an error — it is optional, and
 * a scary red message on an optional step just teaches people to distrust the
 * product. The final save is the opposite: it must either confirm or visibly
 * fail with a retry, because silently dropping six answered questions is
 * unforgivable.
 */

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { fetchWithAuth, SessionEndedError } from '@/lib/api-fetch';
import { T, FONT_SANS, FONT_MONO, Btn, Caps, Card } from './_snow';
import {
  DEFAULT_CHECKOUT_MINUTES,
  DEFAULT_SHIFT_START,
  DEFAULT_STAYOVER_MINUTES,
  MAX_CLEAN_MINUTES,
  MAX_CUSTOM_DUTIES,
  MAX_CUSTOM_LABEL_LENGTH,
  MAX_CUSTOM_ROOM_TYPES,
  MIN_CLEAN_MINUTES,
  customEntryKey,
  isLevelOfferable,
  isReservedDutyLabel,
  isReservedRoomTypeLabel,
  isValidCleanMinutes,
  isValidCustomLabel,
  isValidShiftStart,
  levelLockReason,
  normalizeCustomLabel,
  recommendLevel,
  type BoardBuiltBy,
  type CustomRoomType,
  type HkLevel,
  type HousekeepingSetup as HousekeepingSetupValue,
  type InspectionPolicy,
  type SideDuty,
  type StatusEntryMethod,
} from '@/lib/housekeeping/setup-gate';
import { hkst, type HkSetupStrings } from './_hk-setup-i18n';

const TOTAL_SCREENS = 7;

/* ───────────────────────── Backdrop + stylesheet ───────────────────────── */

/**
 * Softly drifting colour wash + fractal-noise grain, on the Snow palette (the
 * /onboard backdrop uses raw brand hexes; these are the same hues read through
 * the --snow-* tokens so a palette change reaches this screen too).
 */
function SetupBackdrop() {
  return (
    <>
      <div className="hks-blob" aria-hidden style={{ position: 'absolute', top: '-14%', left: '-8%', width: 660, height: 660, background: 'radial-gradient(circle, rgba(158,183,166,0.55) 0%, transparent 62%)', filter: 'blur(64px)', animation: 'hks-b1 27s ease-in-out infinite', pointerEvents: 'none' }} />
      <div className="hks-blob" aria-hidden style={{ position: 'absolute', bottom: '-18%', left: '12%', width: 700, height: 700, background: 'radial-gradient(circle, rgba(201,150,68,0.38) 0%, transparent 62%)', filter: 'blur(64px)', animation: 'hks-b2 31s ease-in-out infinite', pointerEvents: 'none' }} />
      <div className="hks-blob" aria-hidden style={{ position: 'absolute', top: '2%', right: '-10%', width: 620, height: 620, background: 'radial-gradient(circle, rgba(184,92,61,0.30) 0%, transparent 62%)', filter: 'blur(64px)', animation: 'hks-b3 29s ease-in-out infinite', pointerEvents: 'none' }} />
      <div className="hks-blob" aria-hidden style={{ position: 'absolute', bottom: '-6%', right: '4%', width: 540, height: 540, background: 'radial-gradient(circle, rgba(92,122,96,0.28) 0%, transparent 64%)', filter: 'blur(64px)', animation: 'hks-b4 34s ease-in-out infinite', pointerEvents: 'none' }} />
      <svg aria-hidden style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0.05, mixBlendMode: 'multiply', pointerEvents: 'none' }}>
        <filter id="hks-grain"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" /></filter>
        <rect width="100%" height="100%" filter="url(#hks-grain)" />
      </svg>
    </>
  );
}

// One stylesheet for the whole component — the house pattern for a page that
// needs keyframes (inline styles can't express them). Everything is namespaced
// `hks-` so it can't reach any other housekeeping screen.
const SETUP_STYLE = `
  @keyframes hks-b1{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(110px,70px) scale(1.10)}}
  @keyframes hks-b2{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(-92px,54px) scale(1.14)}}
  @keyframes hks-b3{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(76px,-84px) scale(1.06)}}
  @keyframes hks-b4{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(-84px,-62px) scale(1.12)}}
  @keyframes hks-in-fwd{from{opacity:0;transform:translate3d(26px,0,0)}to{opacity:1;transform:none}}
  @keyframes hks-in-back{from{opacity:0;transform:translate3d(-26px,0,0)}to{opacity:1;transform:none}}
  @keyframes hks-fade{from{opacity:0}to{opacity:1}}
  @keyframes hks-pop{0%{transform:scale(1)}42%{transform:scale(.975)}100%{transform:scale(1)}}
  @keyframes hks-spin{to{transform:rotate(360deg)}}
  .hks-screen-fwd{animation:hks-in-fwd .42s cubic-bezier(.16,.84,.3,1) both}
  .hks-screen-back{animation:hks-in-back .42s cubic-bezier(.16,.84,.3,1) both}
  .hks-chip{transition:background .28s cubic-bezier(.22,1,.36,1),border-color .28s cubic-bezier(.22,1,.36,1),color .28s cubic-bezier(.22,1,.36,1),box-shadow .28s cubic-bezier(.22,1,.36,1);}
  .hks-chip:hover:not(:disabled){border-color:rgba(92,122,96,.45);}
  .hks-chip:active:not(:disabled){transform:scale(.995);}
  .hks-chip.is-picked{animation:hks-pop .3s cubic-bezier(.22,1,.36,1)}
  .hks-chip:focus-visible,.hks-dot:focus-visible,.hks-plain:focus-visible{outline:2px solid #5C7A60;outline-offset:3px;}
  .hks-num:focus,.hks-text:focus{border-color:#5C7A60;box-shadow:0 0 0 4px rgba(92,122,96,.16);background:#fff;}
  /* The tick that says "this is the one you chose". It occupies its slot at all
     times and only fades in, so picking an answer never reflows the label next
     to it — a row that jumps on tap reads as a mis-tap. */
  .hks-mark{transition:opacity .24s cubic-bezier(.22,1,.36,1)}
  .hks-spin{display:inline-block;animation:hks-spin 1.1s linear infinite}
  .hks-dot{transition:background .3s cubic-bezier(.22,1,.36,1),width .3s cubic-bezier(.22,1,.36,1)}
  @media (prefers-reduced-motion: reduce){
    .hks-blob{animation:none!important}
    .hks-screen-fwd,.hks-screen-back{animation:hks-fade .2s linear both!important}
    .hks-chip.is-picked{animation:none!important}
    .hks-chip:active:not(:disabled){transform:none!important}
    .hks-chip,.hks-dot,.hks-mark{transition:none!important}
    .hks-spin{animation-duration:2.4s}
  }
  /* Q7 option cards. The wrapper div carries the card visuals because the fold
     toggle is a SIBLING of the radio button, not a child (nested buttons are
     invalid HTML). The unfold animates only on the manager's tap. */
  @keyframes hks-unfold{from{opacity:0;transform:translateY(-5px)}to{opacity:1;transform:none}}
  .hks-lvl{transition:background .28s cubic-bezier(.22,1,.36,1),border-color .28s cubic-bezier(.22,1,.36,1),box-shadow .28s cubic-bezier(.22,1,.36,1)}
  .hks-lvl:hover:not(.is-locked){border-color:rgba(92,122,96,.45)}
  .hks-detail-open{animation:hks-unfold .26s cubic-bezier(.22,1,.36,1) both}
  .hks-more{transition:color .2s ease}
  .hks-more:hover{color:#3E5C48}
  @media (prefers-reduced-motion: reduce){
    .hks-lvl,.hks-more{transition:none!important}
    .hks-detail-open{animation:hks-fade .15s linear both!important}
  }
`;

/* ──────────────────────────── Local primitives ─────────────────────────── */
// These mirror ChipChoose / Field / TextInput from
// src/app/maintenance/_components/_mt-snow.tsx, re-cut at questionnaire scale:
// full-width stacked rows with a hint line, ≥56px tall so they're comfortable
// on a phone. Kept local rather than imported so the housekeeping section does
// not take a runtime dependency on the maintenance section (whose _mt-snow
// already imports *from* housekeeping/_snow).

/** Arrow-key roving focus over the chips inside, per WAI radio-group behavior. */
function ChipGroup({
  children, role, labelledBy, label,
}: {
  children: React.ReactNode;
  role: 'radiogroup' | 'group';
  labelledBy?: string;
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const chips = Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>('button[data-chip]:not([disabled])') ?? [],
    );
    if (chips.length === 0) return;
    const at = chips.indexOf(document.activeElement as HTMLButtonElement);
    if (at === -1) return;
    e.preventDefault();
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
    chips[(at + step + chips.length) % chips.length].focus();
  }
  return (
    <div
      ref={ref}
      role={role}
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : label}
      onKeyDown={onKeyDown}
      style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
    >
      {children}
    </div>
  );
}

/**
 * The tick on a chosen answer.
 *
 * Load-bearing, not decoration. While picking an answer also moved the flow to
 * the next question, the movement itself was the confirmation. Now that nothing
 * moves until Continue is pressed, colour and weight alone were carrying the
 * whole "yes, that one is yours" — and on a sunlit phone at a front desk, a
 * pale sage wash is not a signal. This is.
 *
 * It keeps its slot whether or not it is showing, so choosing an answer never
 * reflows the words beside it.
 */
function PickMark({ shown }: { shown: boolean }) {
  return (
    <span
      aria-hidden
      className="hks-mark"
      style={{
        width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: T.sageDeep, color: '#fff',
        fontSize: 12.5, fontWeight: 700, lineHeight: 1,
        opacity: shown ? 1 : 0,
      }}
    >
      ✓
    </span>
  );
}

function Chip({
  label, hint, active, picked, onPick, multi,
}: {
  label: string;
  hint?: string;
  active: boolean;
  /** True only for a pick made on THIS screen — drives the one-shot pop. */
  picked: boolean;
  onPick: () => void;
  multi?: boolean;
}) {
  return (
    <button
      type="button"
      data-chip
      className={`hks-chip${picked ? ' is-picked' : ''}`}
      role={multi ? undefined : 'radio'}
      aria-checked={multi ? undefined : active}
      aria-pressed={multi ? active : undefined}
      onClick={onPick}
      style={{
        display: 'flex', alignItems: 'center', gap: 12,
        width: '100%', minHeight: 56, padding: '13px 18px',
        textAlign: 'left', cursor: 'pointer', borderRadius: 14,
        background: active ? 'rgba(92,122,96,0.12)' : 'rgba(255,255,255,0.72)',
        border: `1px solid ${active ? 'rgba(92,122,96,0.55)' : 'rgba(31,35,28,0.12)'}`,
        boxShadow: active ? '0 8px 20px -14px rgba(62,92,72,0.7)' : 'none',
        fontFamily: FONT_SANS,
      }}
    >
      <span style={{
        display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 3,
        flex: 1, minWidth: 0,
      }}>
        <span style={{ fontSize: 15.5, fontWeight: active ? 600 : 500, color: T.ink, lineHeight: 1.35 }}>
          {label}
        </span>
        {hint && <span style={{ fontSize: 12.5, color: T.ink2, lineHeight: 1.35 }}>{hint}</span>}
      </span>
      <PickMark shown={active} />
    </button>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      display: 'block', fontFamily: FONT_MONO, fontSize: 9.5, fontWeight: 600,
      letterSpacing: '0.14em', textTransform: 'uppercase', color: T.ink2, marginBottom: 7,
    }}>{children}</span>
  );
}

/* ─────────────────────────── Board-photo reading ───────────────────────── */

interface BoardExtractView {
  sections: number | null;
  /** Already formatted for display ("1-3", "1 / 3"). */
  floors: string | null;
  /** How many floors that string covers — drives floor/floors, nothing else. */
  floorCount: number;
  people: number | null;
}

/**
 * "1", "2", "3" -> "1-3"; anything not a clean run of numbers -> "1 / 3 / 4".
 *
 * The confirmation sentence chains its parts with commas, so comma-joining the
 * floors too produced "floors 1, 2, 3, 2 people" — which reads as though there
 * were a floor called "2 people". Both forms here are comma-free, so the
 * sentence can only be parsed one way. This is presentation only; nothing is
 * stored from it.
 */
function formatFloors(list: string[]): string {
  const nums = list.map((f) => Number(f));
  if (list.length > 1 && nums.every((n) => Number.isInteger(n))) {
    const sorted = [...nums].sort((a, b) => a - b);
    const contiguous = sorted.every((n, i) => i === 0 || n === sorted[i - 1] + 1);
    if (contiguous) return `${sorted[0]}-${sorted[sorted.length - 1]}`;
    return sorted.join(' / ');
  }
  return list.join(' / ');
}

/**
 * Turn the board-photo route's `extracted` payload into the numbers behind the
 * one sentence we read back to the manager.
 *
 * The route returns `{ sections: BoardSection[], floors: string[] } | null` (see
 * /api/housekeeping/setup/board-photo) and collapses "read nothing" to null, so
 * there is exactly one empty case to test. This stays tolerant anyway — the two
 * halves of the feature ship on the same branch but not necessarily in the same
 * deploy, and an unrecognised payload must degrade to a plain "got it" rather
 * than break an optional screen.
 */
function readExtract(raw: unknown): BoardExtractView | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  const rawSections = Array.isArray(o.sections) ? o.sections : [];
  const sections = rawSections.length > 0 ? rawSections.length : null;

  const floorList = Array.isArray(o.floors)
    ? o.floors.filter((f): f is string => typeof f === 'string' && f.trim() !== '').map((f) => f.trim())
    : [];
  const floors = floorList.length > 0 ? formatFloors(floorList).slice(0, 90) : null;

  // "People" is how many names are written on the board — distinct first names
  // across the sections. Counting sections instead would double-count anyone
  // who was given two.
  const names = new Set<string>();
  for (const s of rawSections) {
    if (!s || typeof s !== 'object') continue;
    const n = (s as Record<string, unknown>).staffFirstName;
    if (typeof n === 'string' && n.trim() !== '') names.add(n.trim().toLowerCase());
  }
  const people = names.size > 0 ? names.size : null;

  if (sections === null && floors === null && people === null) return null;
  return { sections, floors, floorCount: floorList.length, people };
}

function extractSentence(x: BoardExtractView, S: HkSetupStrings): string {
  const parts: string[] = [];
  if (x.sections !== null) parts.push(`${x.sections} ${x.sections === 1 ? S.q3Section : S.q3Sections}`);
  if (x.floors) parts.push(`${x.floorCount === 1 ? S.q3Floor : S.q3Floors} ${x.floors}`);
  if (x.people !== null) parts.push(`${x.people} ${x.people === 1 ? S.q3Person : S.q3People}`);
  if (parts.length === 0) return S.q3Generic;
  return `${S.q3ReadLead} ${parts.join(', ')} ${S.q3ReadTail}`;
}

/* ─────────────────── Q2's "+": custom room types, while typing ───────────────
 *
 * A row is held as raw text until it is submitted, and every rule it is checked
 * against is imported from `@/lib/housekeeping/setup-gate` — the same functions
 * the server runs a moment later. Nothing here re-implements a rule: if the two
 * ever drifted, the screen would happily accept a room type the save then
 * refused, and the manager would have no way to work out which word was wrong.
 */

interface CustomRoomDraft {
  /** Stable across re-renders so React keeps the right input focused. */
  id: string;
  label: string;
  /** Text, not a number: "" is a row that hasn't been filled in yet. */
  minutes: string;
}

/**
 * What (if anything) is wrong with one row.
 *
 *   incomplete — blank name and/or blank time. NOT an error: they just added
 *                the row. It still blocks Continue, so it has to say so, but it
 *                is shown in grey rather than as a fault.
 *   tooLong / reserved / duplicate / minutes — real problems, shown as alerts.
 *
 * Checked in this order so the message always names the thing furthest from
 * storable: a 60-character name with no time yet is a naming problem, and
 * telling them to "add a time" would send them at the wrong half of the row.
 */
type RoomRowProblem = 'incomplete' | 'tooLong' | 'reserved' | 'duplicate' | 'minutes' | null;

/** Digits only, 1–3 of them — the same gate the built-in minutes boxes use. */
function parseMinutesText(text: string): number {
  return /^\d{1,3}$/.test(text.trim()) ? Number(text.trim()) : NaN;
}

/**
 * What a custom-label box will accept from a keystroke or a paste.
 *
 * Control characters are dropped on the way IN rather than reported on the way
 * out. `isValidCustomLabel` rejects them (a NUL pasted from a spreadsheet makes
 * Postgres refuse the whole save), but they are invisible — a message saying
 * "that name isn't allowed" about a character nobody can see is unanswerable.
 * Stripping them here leaves LENGTH as the only way a typed name can be
 * invalid, which is a thing the manager can actually see and fix.
 *
 * The generous 120-character ceiling is not the real cap: it only stops a paste
 * from putting a novel in React state. The real cap is
 * MAX_CUSTOM_LABEL_LENGTH, and going past it shows a message rather than
 * truncating, because silently eating the end of someone's typing is how they
 * end up saving a name they never wrote.
 */
function acceptLabelInput(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length && out.length < 120; i += 1) {
    const code = raw.charCodeAt(i);
    out += code < 32 || code === 127 ? ' ' : raw[i];
  }
  return out;
}

/**
 * Problems for every row, in row order. Duplicates are pinned on the LATER row:
 * the first "Suite" is the one they meant to keep, and flagging both would make
 * a two-row list look entirely broken.
 */
function findRoomRowProblems(rows: readonly CustomRoomDraft[]): RoomRowProblem[] {
  const seen = new Set<string>();
  return rows.map((row) => {
    const label = normalizeCustomLabel(row.label);
    const minutesText = row.minutes.trim();
    if (label !== '') {
      if (!isValidCustomLabel(label)) return 'tooLong';
      if (isReservedRoomTypeLabel(label)) return 'reserved';
      const key = customEntryKey(label);
      if (seen.has(key)) return 'duplicate';
      seen.add(key);
    }
    if (label === '' || minutesText === '') return 'incomplete';
    if (!isValidCleanMinutes(parseMinutesText(minutesText))) return 'minutes';
    return null;
  });
}

/* ──────────────────────────────── Component ────────────────────────────── */

export interface HousekeepingSetupProps {
  propertyId: string;
  lang: 'en' | 'es';
  /** Called ONLY after the server confirms the save. */
  onComplete: () => void;
}

export function HousekeepingSetup({ propertyId, lang, onComplete }: HousekeepingSetupProps) {
  const S = hkst(lang);
  const headingId = useId();

  // ── Navigation ────────────────────────────────────────────────────────
  const [screen, setScreen] = useState(0);
  const [dir, setDir] = useState<1 | -1>(1);
  const [furthest, setFurthest] = useState(0);
  // The slide-in is a response to a tap, not an entrance: until the first
  // navigation happens there is no direction to travel in, and animating the
  // first screen on mount would be exactly the load-time choreography the
  // header says this file doesn't do.
  const [hasMoved, setHasMoved] = useState(false);
  // Which option was picked on the CURRENT screen — cleared on every move so a
  // chip never pops just because you navigated back to a screen you'd answered.
  const [pulse, setPulse] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // ── Answers ───────────────────────────────────────────────────────────
  const [statusEntry, setStatusEntry] = useState<StatusEntryMethod | null>(null);
  const [checkoutText, setCheckoutText] = useState(String(DEFAULT_CHECKOUT_MINUTES));
  const [stayoverText, setStayoverText] = useState(String(DEFAULT_STAYOVER_MINUTES));
  const [minutesTouched, setMinutesTouched] = useState(false);
  const [shiftStartTime, setShiftStartTime] = useState(DEFAULT_SHIFT_START);
  const [boardBuiltBy, setBoardBuiltBy] = useState<BoardBuiltBy | null>(null);
  const [inspection, setInspection] = useState<InspectionPolicy | null>(null);
  const [sideDuties, setSideDuties] = useState<SideDuty[]>([]);
  // Q2's "+" list, held as TEXT while it is being typed (same reason the two
  // built-in minutes boxes are text: a half-typed "4" must not become a number
  // that fails validation while their finger is still on the keyboard).
  const [customRooms, setCustomRooms] = useState<CustomRoomDraft[]>([]);
  const customRowSeq = useRef(0);
  // Q6's "+" list. Committed entries only — a duty is validated at the moment
  // it is added, so anything in here is already storable.
  const [customDuties, setCustomDuties] = useState<string[]>([]);
  const [dutyDraft, setDutyDraft] = useState('');
  const [dutyDraftOpen, setDutyDraftOpen] = useState(false);
  const [dutyDraftError, setDutyDraftError] = useState<string | null>(null);
  const dutyInputRef = useRef<HTMLInputElement>(null);
  // "Just rooms" must not look pre-answered. It is the answer that decides
  // whether laundry and breakfast time gets counted as room time, and showing it
  // as already chosen before the manager touches anything means the screen
  // silently answers its own question — in the direction that makes honest
  // people look slow. Continue stays enabled either way; only the highlight
  // waits for a real tap.
  const [dutiesTouched, setDutiesTouched] = useState(false);
  const [boardPhotoPath, setBoardPhotoPath] = useState<string | null>(null);
  const [levelChoice, setLevelChoice] = useState<HkLevel | null>(null);

  // ── Photo + save state ────────────────────────────────────────────────
  const [photoState, setPhotoState] = useState<'idle' | 'uploading' | 'done'>('idle');
  const [extract, setExtract] = useState<BoardExtractView | null>(null);
  // Why a photo didn't land, in one grey line. Two wordings: the file format
  // can't be read at all (an iPhone HEIC picked from the library), or anything
  // else went wrong. Neither is styled as an error — the step is optional.
  const [photoNote, setPhotoNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Whether pressing the button again could plausibly help. A network blip: yes.
  // A cleared answer or a missing permission: no — and offering "Try again" for
  // those is how a screen turns into an infinite loop.
  const [saveRetryable, setSaveRetryable] = useState(true);

  const checkoutMinutes = /^\d{1,3}$/.test(checkoutText.trim()) ? Number(checkoutText.trim()) : NaN;
  const stayoverMinutes = /^\d{1,3}$/.test(stayoverText.trim()) ? Number(stayoverText.trim()) : NaN;
  const minutesValid = isValidCleanMinutes(checkoutMinutes) && isValidCleanMinutes(stayoverMinutes);

  // Q2's "+" rows, re-checked on every keystroke against the shared rules. An
  // unfinished or impossible row holds Continue on Q2 — the alternative is
  // letting them walk away from a half-typed room type and lose it at the save,
  // six screens later, with a message about a screen they can't see.
  const roomProblems = useMemo(() => findRoomRowProblems(customRooms), [customRooms]);
  const customRoomsValid = roomProblems.every((p) => p === null);
  const customRoomTypes: CustomRoomType[] = useMemo(
    () => (customRoomsValid
      ? customRooms.map((r) => ({
        label: normalizeCustomLabel(r.label),
        minutes: parseMinutesText(r.minutes),
      }))
      : []),
    [customRooms, customRoomsValid],
  );

  // The level rules are read straight off the shared module — never re-derived.
  const recommended: HkLevel = recommendLevel({
    statusEntry: statusEntry ?? 'unsure',
    boardBuiltBy: boardBuiltBy ?? 'unsure',
  });
  // A choice made before an earlier answer changed can become impossible (they
  // went back and said housekeepers enter status themselves). Fall back to the
  // recommendation rather than carrying a locked level forward.
  const chosenLevel: HkLevel =
    levelChoice !== null && isLevelOfferable(levelChoice, statusEntry ?? 'unsure')
      ? levelChoice
      : recommended;

  const goto = useCallback((next: number) => {
    if (next < 0 || next >= TOTAL_SCREENS) return;
    setDir((d) => (next === screen ? d : next > screen ? 1 : -1));
    setHasMoved(true);
    setPulse(null);
    setSaveError(null);
    setScreen(next);
    setFurthest((f) => Math.max(f, next));
  }, [screen]);

  // Move focus to the new question so a screen reader announces it and the
  // keyboard caret is at the top of the new screen, not stranded on the old
  // Continue button. Not an entrance animation — no visual motion is triggered,
  // and `preventScroll` stops the browser jumping the page on first mount.
  useEffect(() => { headingRef.current?.focus({ preventScroll: true }); }, [screen]);

  // Opening Q6's "add something else" box puts the caret in it, so the tap that
  // asked for a text field is the same tap that lets you start typing. Done in
  // an effect rather than in the click handler because the input does not exist
  // until this update has been committed to the DOM. Keyed on the open flag
  // alone, so navigating back to Q6 with the box already open leaves focus on
  // the question heading where the screen-change effect above put it.
  useEffect(() => { if (dutyDraftOpen) dutyInputRef.current?.focus(); }, [dutyDraftOpen]);

  /**
   * Pick an answer on a single-answer screen. It selects, it pops, and it stops
   * there — the person moves the flow, never the flow itself. See NOTHING MOVES
   * THE SCREEN in the header before adding anything to this function.
   */
  const pick = useCallback((token: string, apply: () => void) => {
    apply();
    setPulse(token);
  }, []);

  const toggleDuty = useCallback((duty: SideDuty) => {
    setPulse(duty);
    setDutiesTouched(true);
    setSideDuties((cur) => (cur.includes(duty) ? cur.filter((d) => d !== duty) : [...cur, duty]));
  }, []);

  /* ── Q2's "+" — add / edit / remove a custom room type ────────────────── */

  const addCustomRoom = useCallback(() => {
    setCustomRooms((cur) => {
      if (cur.length >= MAX_CUSTOM_ROOM_TYPES) return cur;
      customRowSeq.current += 1;
      // Deliberately EMPTY, not prefilled with 30. A prefilled time under a name
      // the hotel typed themselves looks like their own answer, and would be
      // saved as a standard they never chose.
      return [...cur, { id: `room-${customRowSeq.current}`, label: '', minutes: '' }];
    });
  }, []);

  const editCustomRoom = useCallback((id: string, patch: Partial<CustomRoomDraft>) => {
    setCustomRooms((cur) => cur.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }, []);

  const removeCustomRoom = useCallback((id: string) => {
    setCustomRooms((cur) => cur.filter((r) => r.id !== id));
  }, []);

  /* ── Q6's "+" — add / remove a custom duty ────────────────────────────── */

  /**
   * Commit whatever is in the little text box as a duty.
   *
   * Validated against the shared module the instant it is added, so everything
   * in `customDuties` is already storable and the final save can never fail on
   * one of these. A rejected entry stays in the box with the reason underneath —
   * clearing it would throw away what they typed.
   *
   * Returns false only when there was something in the box that could not be
   * accepted. That is what lets Continue flush a duty the manager typed but
   * never pressed Add on (see `advance`) without ever swallowing a bad one.
   */
  const commitDuty = useCallback((): boolean => {
    const label = normalizeCustomLabel(dutyDraft);
    if (label === '') return true;
    if (!isValidCustomLabel(label)) {
      setDutyDraftError(`${S.customTooLongLead} ${MAX_CUSTOM_LABEL_LENGTH} ${S.customTooLongTail}`);
      return false;
    }
    if (isReservedDutyLabel(label)) {
      setDutyDraftError(`“${label}” ${S.q6DutyReserved}`);
      return false;
    }
    const key = customEntryKey(label);
    if (customDuties.some((d) => customEntryKey(d) === key)) {
      setDutyDraftError(`“${label}” ${S.q6DutyDuplicate}`);
      return false;
    }
    // Unreachable today — the box is replaced by the cap message before a ninth
    // duty can be typed — but `advance` refuses to leave Q6 whenever this
    // returns false, so a silent `return false` here would be a dead Continue
    // button with nothing on screen explaining it. It says the cap out loud.
    if (customDuties.length >= MAX_CUSTOM_DUTIES) {
      setDutyDraftError(`${S.q6CapLead} ${MAX_CUSTOM_DUTIES} ${S.q6CapTail}`);
      return false;
    }

    setCustomDuties((cur) => [...cur, label]);
    // Adding an "other" duty answers the same question "Just rooms" answers, so
    // it clears it — the screen must never claim both that they only do rooms
    // and that they also do pool towels. (The "Just rooms" chip reads its
    // selected state from BOTH lists being empty, so appending here is what
    // deselects it.)
    setDutiesTouched(true);
    setDutyDraft('');
    setDutyDraftError(null);
    dutyInputRef.current?.focus();
    return true;
  }, [dutyDraft, customDuties, S]);

  const removeCustomDuty = useCallback((label: string) => {
    setCustomDuties((cur) => cur.filter((d) => d !== label));
  }, []);

  /** "Just rooms" is the answer that excludes every other answer, customs included. */
  const pickJustRooms = useCallback(() => {
    setSideDuties([]);
    setCustomDuties([]);
    setDutyDraft('');
    setDutyDraftError(null);
    setDutyDraftOpen(false);
    setDutiesTouched(true);
    setPulse('__none');
  }, []);

  /* ── Board photo — best effort, never blocks, never errors ───────────── */

  /**
   * A photo that didn't work out is a NON-EVENT, not a failure: the whole screen
   * is optional and skippable in one tap.
   *
   * It used to move them on to the next question by itself, on the grounds that
   * dropping back to idle makes their tap look like it missed. That was the same
   * timed jump the header now forbids everywhere else, so it is gone: the screen
   * stays put and says one calm grey line instead. Nothing here is an error — it
   * is not red, it does not block Continue, and Skip is still one tap away.
   */
  const photoFailed = useCallback(() => {
    setPhotoState('idle');
    setPhotoNote(S.q3ReadFailNote);
  }, [S]);

  const handleFile = useCallback(async (file: File) => {
    setPhotoState('uploading');
    setPhotoNote(null);
    try {
      const form = new FormData();
      form.append('propertyId', propertyId);
      form.append('file', file);
      // No Content-Type header on purpose — the browser must set the multipart
      // boundary itself.
      const res = await fetchWithAuth('/api/housekeeping/setup/board-photo', {
        method: 'POST',
        body: form,
      });
      // Envelope from src/lib/api-response.ts: { ok, requestId, data? }.
      const body = await res.json().catch(() => null) as
        { ok?: boolean; data?: Record<string, unknown> } | null;
      const data = body?.data ?? {};
      const path = typeof data.path === 'string' && data.path.trim() !== '' ? data.path : null;
      // 415 = we can't read this kind of file at all (an iPhone HEIC out of the
      // photo library is the realistic case). It gets its own wording because
      // it is the one failure with an action attached: picking a JPEG works.
      if (res.status === 415) {
        setPhotoState('idle');
        setPhotoNote(S.q3FormatNote);
        return;
      }
      if (!res.ok || body?.ok !== true || !path) {
        photoFailed();
        return;
      }
      // The photo is the point; `extracted` is a bonus the route returns as null
      // whenever it read nothing usable. Either way the step succeeded.
      setBoardPhotoPath(path);
      setExtract(readExtract(data.extracted));
      setPhotoState('done');
    } catch (e) {
      if (e instanceof SessionEndedError) return;   // page is navigating away
      photoFailed();
    }
  }, [propertyId, photoFailed, S]);

  /* ── Final save ──────────────────────────────────────────────────────── */
  const submit = useCallback(async () => {
    if (saving) return;

    // A local problem, not a network one. The progress rail lets you jump
    // forward to any screen you've already reached, so an answer can be cleared
    // (empty the minutes box, clear the time field) and then left behind. If we
    // showed the network message here, "Try again" would fail identically
    // forever with nothing on screen pointing at the real cause two questions
    // back. So: take them to the question that needs fixing, and say so.
    //
    // The last test is the backstop for Q6's little text box. Leaving Q6 always
    // tries to fold a typed duty in (see `navigate`), so anything still sitting
    // there is an entry that could NOT be accepted — and finishing on top of it
    // would close the questionnaire forever on a word they typed and we threw
    // away. Back to Q6, where the reason is already printed under the box.
    const badScreen =
      !statusEntry ? 0
      : !isValidCleanMinutes(checkoutMinutes) || !isValidCleanMinutes(stayoverMinutes) ? 1
      : !customRoomsValid ? 1
      : !isValidShiftStart(shiftStartTime) || !boardBuiltBy ? 3
      : !inspection ? 4
      : normalizeCustomLabel(dutyDraft) !== '' ? 5
      : null;
    // The three `!x` tests are redundant with `badScreen` above (each maps to a
    // screen index there) and are kept only so the compiler can narrow the three
    // nullable answers for the payload below.
    if (badScreen !== null || !statusEntry || !boardBuiltBy || !inspection) {
      goto(badScreen ?? 0);
      setSaveError(S.answerCheck);
      setSaveRetryable(false);
      return;
    }
    const setup: HousekeepingSetupValue = {
      version: 1,
      completedAt: new Date().toISOString(),
      level: chosenLevel,
      recommendedLevel: recommended,
      statusEntry,
      checkoutMinutes,
      stayoverMinutes,
      shiftStartTime,
      boardBuiltBy,
      inspection,
      sideDuties,
      // The two "+" lists. Both are already normalized and already checked
      // against the same rules the server will apply (custom rooms on every
      // keystroke, custom duties at the moment each one is added), so neither
      // can be the reason this save fails.
      customRoomTypes,
      customDuties,
      boardPhotoPath,
    };

    setSaving(true);
    setSaveError(null);
    setSaveRetryable(true);
    try {
      const res = await fetchWithAuth('/api/housekeeping/setup', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // { propertyId, <named payload> } — the house body shape, and exactly
        // what PUT /api/housekeeping/setup reads. The server re-validates this
        // with validateSetupSubmission and re-stamps completedAt from its own
        // clock, so nothing here is trusted on the strength of being sent.
        body: JSON.stringify({ propertyId, setup }),
      });
      const body = await res.json().catch(() => null) as { ok?: boolean } | null;
      if (!res.ok || body?.ok !== true) {
        // 403 can only mean this person may not finish setup here. Retrying can
        // never succeed, so we say who can unblock them instead of inviting
        // them to press the same button until they give up.
        const forbidden = res.status === 403;
        setSaveError(forbidden ? S.noPermission : S.saveError);
        setSaveRetryable(!forbidden);
        return;
      }
      onComplete();
    } catch (e) {
      if (e instanceof SessionEndedError) return;
      setSaveError(S.saveError);
    } finally {
      setSaving(false);
    }
  }, [
    saving, statusEntry, boardBuiltBy, inspection, checkoutMinutes, stayoverMinutes,
    shiftStartTime, sideDuties, customRoomsValid, customRoomTypes, customDuties,
    dutyDraft, boardPhotoPath, chosenLevel, recommended, propertyId, onComplete, goto, S,
  ]);

  /* ── Per-screen gating ───────────────────────────────────────────────── */
  const canAdvance = useMemo(() => {
    switch (screen) {
      case 0: return statusEntry !== null;
      case 1: return minutesValid && customRoomsValid;
      case 2: return photoState !== 'uploading';
      case 3: return isValidShiftStart(shiftStartTime) && boardBuiltBy !== null;
      case 4: return inspection !== null;
      // Q6 can't be wrong: no duties at all is a real answer, and a custom duty
      // is validated before it ever becomes a chip.
      case 5: return true;
      default: return true;
    }
  }, [
    screen, statusEntry, minutesValid, customRoomsValid, photoState,
    shiftStartTime, boardBuiltBy, inspection,
  ]);

  const advance = useCallback(() => {
    // Leaving Q6 with words still sitting in the "add something else" box and
    // Add never pressed: keep them. The only way text gets in there is that
    // someone typed it in answer to the question, and dropping it on the floor
    // is a silent loss they would never think to check for. If it can't be
    // accepted, commitDuty says why and we stay on the question — the same deal
    // Q2 gives a half-finished room type.
    if (screen === 5 && !commitDuty()) return;
    if (screen === TOTAL_SCREENS - 1) { void submit(); return; }
    if (canAdvance) goto(screen + 1);
  }, [screen, canAdvance, goto, submit, commitDuty]);

  /**
   * Leave the current screen by Back or by the progress rail.
   *
   * These are the two ways out that are NOT Continue, and until now they were
   * the two that skipped Q6's flush: a duty typed into the "add something else"
   * box and never Added stayed invisible in state, then vanished at the save
   * with the questionnaire already closed behind it. Exactly the silent loss
   * `advance` was written to prevent — the guard was just on one door of three.
   *
   * Unlike Continue this never REFUSES to move. Back and the rail are
   * navigation, not submission, and a question that won't let you leave it is
   * the one thing worse than the bug. So a good entry is folded in and a bad one
   * keeps its place in the box with the reason under it, and `submit` declines
   * to finish while anything is still sitting there.
   */
  const navigate = useCallback((next: number) => {
    if (screen === 5 && next !== 5) commitDuty();
    goto(next);
  }, [screen, goto, commitDuty]);

  // Enter advances from anywhere on the card except a button (buttons handle
  // their own Enter natively — otherwise picking a chip would also skip ahead).
  const onCardKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter') return;
    const target = e.target as HTMLElement;
    if (target.tagName === 'BUTTON' || target.tagName === 'A' || target.tagName === 'TEXTAREA') return;
    e.preventDefault();
    advance();
  };

  const recommendReason = boardBuiltBy === 'head_housekeeper'
    ? S.reasonHeadHousekeeper
    : S.reasonSafeStart;

  /* ───────────────────────────── Screens ─────────────────────────────── */

  const screens: React.ReactNode[] = [
    // Q1 — how a clean room is recorded today
    <Question key="q1" id={headingId} title={S.q1Title} sub={S.q1Sub} headingRef={headingRef}>
      <ChipGroup role="radiogroup" labelledBy={headingId}>
        <Chip label={S.q1RadioLabel} hint={S.q1RadioHint} active={statusEntry === 'housekeeper_radio'} picked={pulse === 'housekeeper_radio'} onPick={() => pick('housekeeper_radio', () => setStatusEntry('housekeeper_radio'))} />
        <Chip label={S.q1SupervisorLabel} hint={S.q1SupervisorHint} active={statusEntry === 'supervisor_keys'} picked={pulse === 'supervisor_keys'} onPick={() => pick('supervisor_keys', () => setStatusEntry('supervisor_keys'))} />
        <Chip label={S.q1DirectLabel} hint={S.q1DirectHint} active={statusEntry === 'housekeeper_direct'} picked={pulse === 'housekeeper_direct'} onPick={() => pick('housekeeper_direct', () => setStatusEntry('housekeeper_direct'))} />
        <Chip label={S.q1UnsureLabel} hint={S.q1UnsureHint} active={statusEntry === 'unsure'} picked={pulse === 'unsure'} onPick={() => pick('unsure', () => setStatusEntry('unsure'))} />
      </ChipGroup>
    </Question>,

    // Q2 — standard room times
    <Question key="q2" id={headingId} title={S.q2Title} sub={S.q2Sub} headingRef={headingRef}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 26 }}>
        <MinutesInput
          label={S.q2CheckoutLabel} hint={S.q2CheckoutHint} suffix={S.q2Minutes}
          value={checkoutText}
          onChange={(v) => { setCheckoutText(v); setMinutesTouched(true); }}
          invalid={minutesTouched && !isValidCleanMinutes(checkoutMinutes)}
        />
        <MinutesInput
          label={S.q2StayoverLabel} hint={S.q2StayoverHint} suffix={S.q2Minutes}
          value={stayoverText}
          onChange={(v) => { setStayoverText(v); setMinutesTouched(true); }}
          invalid={minutesTouched && !isValidCleanMinutes(stayoverMinutes)}
        />
      </div>
      {minutesTouched && !minutesValid && (
        <p role="alert" style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.warm, margin: '16px 0 0' }}>
          {`${S.q2InvalidLead} ${MIN_CLEAN_MINUTES} ${S.q2InvalidJoin} ${MAX_CLEAN_MINUTES}.`}
        </p>
      )}

      {/* The "+". Checkout and stayover above are untouched — this is only for
          the rooms a hotel has that those two words don't describe. */}
      <div style={{ marginTop: 26, paddingTop: 22, borderTop: `1px solid ${T.rule}` }}>
        {customRooms.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 16 }}>
            {customRooms.map((row, i) => (
              <CustomRoomRow
                key={row.id}
                row={row}
                index={i}
                problem={roomProblems[i]}
                S={S}
                onLabel={(v) => editCustomRoom(row.id, { label: acceptLabelInput(v) })}
                onMinutes={(v) => editCustomRoom(row.id, { minutes: v.replace(/[^\d]/g, '').slice(0, 3) })}
                onRemove={() => removeCustomRoom(row.id)}
              />
            ))}
          </div>
        )}
        {customRooms.length < MAX_CUSTOM_ROOM_TYPES ? (
          <Btn variant="ghost" size="lg" onClick={addCustomRoom}>{S.q2AddRoom}</Btn>
        ) : (
          <p style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink2, margin: 0 }}>
            {`${S.q2CapLead} ${MAX_CUSTOM_ROOM_TYPES} ${S.q2CapTail}`}
          </p>
        )}
        {/* Only once they've actually added one — the 90% of hotels who add
            none should not have to read a caveat about a thing they skipped.
            The screen has just promised that every hour and every dollar comes
            from the two times above, and a room type typed underneath it looks
            exactly like a third number that counts. It isn't one yet, and this
            is the only place a manager will ever be told that. */}
        {customRooms.length > 0 && (
          <p style={{ fontFamily: FONT_SANS, fontSize: 12.5, color: T.ink3, margin: '14px 0 0', lineHeight: 1.5 }}>
            {S.q2CustomNote}
          </p>
        )}
      </div>
    </Question>,

    // Q3 — photo of the paper board (optional, silent on failure)
    <Question key="q3" id={headingId} title={S.q3Title} sub={S.q3Sub} headingRef={headingRef}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'flex-start' }}>
        <Btn
          variant={photoState === 'done' ? 'ghost' : 'primary'}
          size="lg"
          disabled={photoState === 'uploading'}
          onClick={() => fileRef.current?.click()}
        >
          <span aria-hidden style={{ fontSize: 16 }}>📷</span>
          {photoState === 'uploading' ? S.q3Uploading : photoState === 'done' ? S.q3Retake : S.q3Take}
        </Btn>
        {photoState === 'uploading' && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontFamily: FONT_SANS, fontSize: 13, color: T.ink2 }}>
            <span className="hks-spin" aria-hidden style={{ width: 12, height: 12, borderRadius: '50%', border: `2px solid ${T.rule}`, borderTopColor: T.sageDeep }} />
            {S.q3Uploading}
          </span>
        )}
        {photoState === 'done' && (
          <Card padding="14px 18px" style={{ background: 'rgba(92,122,96,0.08)', border: '1px solid rgba(92,122,96,0.25)' }}>
            <span style={{ fontFamily: FONT_SANS, fontSize: 13.5, color: T.ink, lineHeight: 1.45 }}>
              {extract ? extractSentence(extract, S) : S.q3Generic}
            </span>
          </Card>
        )}
        {photoNote && (
          // Deliberately grey, not red: this step is optional, and a scary error
          // on something nobody has to do just teaches people to distrust us.
          <p style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink2, margin: 0, lineHeight: 1.45 }}>
            {photoNote}
          </p>
        )}
        {/* No `capture` attribute on purpose. It forces the camera on iOS and
            most of Android with no photo-library option, which contradicts the
            button ("Take or choose a photo") and blocks the common case: a
            manager who photographed the board earlier this morning. */}
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
            if (e.target) e.target.value = '';
          }}
        />
      </div>
    </Question>,

    // Q4 — shift start + who builds the board
    <Question key="q4" id={headingId} title={S.q4Title} sub={S.q4Sub} headingRef={headingRef}>
      <div style={{ marginBottom: 26, maxWidth: 220 }}>
        <FieldLabel>{S.q4TimeLabel}</FieldLabel>
        <input
          className="hks-num"
          type="time"
          value={shiftStartTime}
          onChange={(e) => setShiftStartTime(e.target.value)}
          aria-label={S.q4TimeLabel}
          style={{
            height: 52, padding: '0 14px', borderRadius: 12, width: '100%',
            background: 'rgba(255,255,255,0.8)', border: '1px solid rgba(31,35,28,0.14)',
            fontFamily: FONT_SANS, fontSize: 19, fontWeight: 600, color: T.ink,
            boxSizing: 'border-box', outline: 'none',
          }}
        />
        {!isValidShiftStart(shiftStartTime) && (
          <p role="alert" style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.warm, margin: '8px 0 0' }}>
            {S.q4TimeInvalid}
          </p>
        )}
      </div>
      <FieldLabel>{S.q4WhoLabel}</FieldLabel>
      <ChipGroup role="radiogroup" label={S.q4WhoLabel}>
        <Chip label={S.q4HeadLabel} hint={S.q4HeadHint} active={boardBuiltBy === 'head_housekeeper'} picked={pulse === 'head_housekeeper'} onPick={() => { setBoardBuiltBy('head_housekeeper'); setPulse('head_housekeeper'); }} />
        <Chip label={S.q4GmLabel} hint={S.q4GmHint} active={boardBuiltBy === 'gm'} picked={pulse === 'gm'} onPick={() => { setBoardBuiltBy('gm'); setPulse('gm'); }} />
        <Chip label={S.q4NobodyLabel} hint={S.q4NobodyHint} active={boardBuiltBy === 'nobody'} picked={pulse === 'nobody'} onPick={() => { setBoardBuiltBy('nobody'); setPulse('nobody'); }} />
        <Chip label={S.q4UnsureLabel} hint={S.q4UnsureHint} active={boardBuiltBy === 'unsure'} picked={pulse === 'unsure'} onPick={() => { setBoardBuiltBy('unsure'); setPulse('unsure'); }} />
      </ChipGroup>
    </Question>,

    // Q5 — inspection policy
    <Question key="q5" id={headingId} title={S.q5Title} sub={S.q5Sub} headingRef={headingRef}>
      <ChipGroup role="radiogroup" labelledBy={headingId}>
        <Chip label={S.q5NoneLabel} hint={S.q5NoneHint} active={inspection === 'none'} picked={pulse === 'none'} onPick={() => pick('none', () => setInspection('none'))} />
        <Chip label={S.q5SpotLabel} hint={S.q5SpotHint} active={inspection === 'spot_check'} picked={pulse === 'spot_check'} onPick={() => pick('spot_check', () => setInspection('spot_check'))} />
        <Chip label={S.q5EveryLabel} hint={S.q5EveryHint} active={inspection === 'every_room'} picked={pulse === 'every_room'} onPick={() => pick('every_room', () => setInspection('every_room'))} />
      </ChipGroup>
    </Question>,

    // Q6 — side duties (multi-select, with a mutually exclusive "just rooms")
    <Question key="q6" id={headingId} title={S.q6Title} sub={S.q6Sub} headingRef={headingRef}>
      <ChipGroup role="group" labelledBy={headingId}>
        <Chip multi label={S.q6Laundry} active={sideDuties.includes('laundry')} picked={pulse === 'laundry'} onPick={() => toggleDuty('laundry')} />
        <Chip multi label={S.q6Breakfast} active={sideDuties.includes('breakfast')} picked={pulse === 'breakfast'} onPick={() => toggleDuty('breakfast')} />
        <Chip multi label={S.q6Lobby} active={sideDuties.includes('lobby')} picked={pulse === 'lobby'} onPick={() => toggleDuty('lobby')} />
        <Chip multi label={S.q6PublicAreas} active={sideDuties.includes('public_areas')} picked={pulse === 'public_areas'} onPick={() => toggleDuty('public_areas')} />
        <Chip multi label={S.q6Shuttle} active={sideDuties.includes('shuttle')} picked={pulse === 'shuttle'} onPick={() => toggleDuty('shuttle')} />

        {/* The hotel's own duties, rendered as already-chosen rows: they only
            exist because someone typed them, so there is no unselected state to
            show. Removing the row IS the way to unpick one. It is a div, not a
            Chip — a remove button inside a chip button would be a button inside
            a button, which is invalid HTML and unreachable by keyboard. */}
        {customDuties.map((duty) => (
          <CustomDutyRow
            key={customEntryKey(duty)}
            label={duty}
            removeLabel={S.q6RemoveDuty}
            onRemove={() => removeCustomDuty(duty)}
          />
        ))}

        {/* "Just rooms" sits last and clears everything above it, customs
            included — it is the answer that contradicts every other answer. */}
        <Chip
          multi
          label={S.q6None}
          active={dutiesTouched && sideDuties.length === 0 && customDuties.length === 0}
          picked={pulse === '__none'}
          onPick={pickJustRooms}
        />
      </ChipGroup>

      <div style={{ marginTop: 14 }}>
        {customDuties.length >= MAX_CUSTOM_DUTIES ? (
          <p style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink2, margin: 0 }}>
            {`${S.q6CapLead} ${MAX_CUSTOM_DUTIES} ${S.q6CapTail}`}
          </p>
        ) : !dutyDraftOpen ? (
          <Btn variant="ghost" size="lg" onClick={() => setDutyDraftOpen(true)}>
            {S.q6AddOther}
          </Btn>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <FieldLabel>{S.q6AddLabel}</FieldLabel>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                ref={dutyInputRef}
                className="hks-text"
                type="text"
                autoComplete="off"
                value={dutyDraft}
                aria-label={S.q6AddLabel}
                aria-invalid={dutyDraftError !== null || undefined}
                placeholder={S.q6AddPlaceholder}
                onChange={(e) => { setDutyDraft(acceptLabelInput(e.target.value)); setDutyDraftError(null); }}
                // Enter adds the duty instead of jumping to the next question.
                // stopPropagation is what keeps the card's Enter-to-continue
                // handler off it — without that, typing "Pool towels" and
                // pressing Enter would leave the screen and lose the entry.
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  e.stopPropagation();
                  commitDuty();
                }}
                style={{
                  flex: '1 1 200px', minWidth: 0, height: 56, padding: '0 14px', borderRadius: 12,
                  background: 'rgba(255,255,255,0.8)',
                  border: `1px solid ${dutyDraftError ? 'rgba(184,92,61,0.6)' : 'rgba(31,35,28,0.14)'}`,
                  fontFamily: FONT_SANS, fontSize: 16, color: T.ink,
                  boxSizing: 'border-box', outline: 'none',
                }}
              />
              <Btn
                variant="primary"
                size="lg"
                disabled={normalizeCustomLabel(dutyDraft) === ''}
                onClick={commitDuty}
              >
                {S.q6AddConfirm}
              </Btn>
              <Btn
                variant="ghost"
                size="lg"
                onClick={() => { setDutyDraftOpen(false); setDutyDraft(''); setDutyDraftError(null); }}
              >
                {S.q6AddCancel}
              </Btn>
            </div>
            {dutyDraftError && (
              <p role="alert" style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.warm, margin: 0, lineHeight: 1.45 }}>
                {dutyDraftError}
              </p>
            )}
          </div>
        )}
      </div>
    </Question>,

    // Q7 — the three levels.
    //
    // Each card collapses to the four lines that actually decide this: name,
    // who opens Staxis (the one axis the three differ on — the sub-heading says
    // so and the dot row makes it visible), the single thing you get, and the
    // single honest trade-off. Everything else sits behind "The full picture",
    // one tap away — findable, never deleted.
    //
    // The visible trade line REUSES a key from the full list (l1Bad2 / l2Bad1 /
    // l3Bad0), so the headline caveat and the detail list can never drift apart.
    // l3Bad0 in particular must stay on the card face, never in the fold: the
    // tap does not reach the hotel's own system, and a manager who learns that
    // in week one instead of here feels lied to.
    <Question key="q7" id={headingId} title={S.q7Title} sub={S.q7Sub} headingRef={headingRef}>
      <ChipGroup role="radiogroup" labelledBy={headingId}>
        <LevelCard
          level={1} name={S.l1Name} who={S.l1Who} whoCount={1}
          get={S.l1Get} trade={S.l1Bad2}
          detailGood={[S.l1Good1, S.l1Good2, S.l1Good3]} detailBad={[S.l1Bad1]}
          goodLabel={S.goodLabel} badLabel={S.badLabel} detailsLabel={S.detailsLabel}
          selected={chosenLevel === 1} recommended={recommended === 1} recommendedLabel={S.recommended}
          reason={recommended === 1 ? recommendReason : null}
          lockedLabel={null} lockedBody={null}
          onPick={() => setLevelChoice(1)}
        />
        <LevelCard
          level={2} name={S.l2Name} who={S.l2Who} whoCount={2}
          get={S.l2Get} trade={S.l2Bad1}
          detailGood={[S.l2Good1, S.l2Good2, S.l2Good3]} detailBad={[S.l2Bad2]}
          goodLabel={S.goodLabel} badLabel={S.badLabel} detailsLabel={S.detailsLabel}
          selected={chosenLevel === 2} recommended={recommended === 2} recommendedLabel={S.recommended}
          reason={recommended === 2 ? recommendReason : null}
          lockedLabel={null} lockedBody={null}
          onPick={() => setLevelChoice(2)}
        />
        <LevelCard
          level={3} name={S.l3Name} who={S.l3Who} whoCount={6}
          get={S.l3Get} trade={S.l3Bad0}
          detailGood={[S.l3Good1, S.l3Good2]} detailBad={[S.l3Bad1, S.l3Bad2]}
          goodLabel={S.goodLabel} badLabel={S.badLabel} detailsLabel={S.detailsLabel}
          selected={chosenLevel === 3} recommended={recommended === 3} recommendedLabel={S.recommended}
          reason={recommended === 3 ? recommendReason : null}
          lockedLabel={levelLockReason(3, statusEntry ?? 'unsure') === 'double_entry' ? S.lockedLabel : null}
          lockedBody={levelLockReason(3, statusEntry ?? 'unsure') === 'double_entry' ? S.lockedBody : null}
          onPick={() => setLevelChoice(3)}
        />
      </ChipGroup>
    </Question>,
  ];

  const isLast = screen === TOTAL_SCREENS - 1;
  const primaryLabel = isLast
    ? (saving ? S.saving : saveError && saveRetryable ? S.retry : S.finish)
    : S.next;

  return (
    <div style={{
      position: 'relative', flex: '1 1 auto', minHeight: '78dvh', overflow: 'hidden',
      background: T.bg, fontFamily: FONT_SANS, color: T.ink,
      padding: '40px 20px 56px',
      display: 'flex', flexDirection: 'column', alignItems: 'center',
    }}>
      <SetupBackdrop />

      <div style={{ position: 'relative', width: '100%', maxWidth: 640 }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 22 }}>
          <Caps size={10} tracking="0.18em">{S.eyebrow}</Caps>
          <h1 style={{ fontFamily: FONT_SANS, fontSize: 30, fontWeight: 600, letterSpacing: '-0.02em', color: T.ink, margin: '8px 0 0', lineHeight: 1.15 }}>
            {S.title}
          </h1>
          <p style={{ fontSize: 13.5, color: T.ink2, margin: '7px 0 0' }}>{S.subtitle}</p>
        </div>

        {/* Progress rail — 7 dots. Visited ones step back; the rest are inert.
            The count is spelled out next to them: seven 6px dots on a phone are
            not something anyone counts, and "how much is left" is the whole
            reason a rail is here. */}
        <div
          role="group"
          aria-label={`${S.stepWord} ${screen + 1} ${S.ofWord} ${TOTAL_SCREENS}`}
          style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, marginBottom: 18 }}
        >
          <span
            aria-hidden
            style={{
              fontFamily: FONT_MONO, fontSize: 9.5, fontWeight: 600, letterSpacing: '0.12em',
              textTransform: 'uppercase', color: T.ink3, marginRight: 4, whiteSpace: 'nowrap',
            }}
          >
            {`${S.stepWord} ${screen + 1} ${S.ofWord} ${TOTAL_SCREENS}`}
          </span>
          {Array.from({ length: TOTAL_SCREENS }, (_, i) => {
            const done = i < screen;
            const here = i === screen;
            const reachable = i <= furthest && i !== screen;
            const dot = (
              <span
                className="hks-dot"
                style={{
                  display: 'block', height: 6, borderRadius: 999,
                  width: here ? 30 : 6,
                  background: here ? T.sageDeep : done ? 'rgba(92,122,96,0.45)' : 'rgba(31,35,28,0.14)',
                }}
              />
            );
            return reachable ? (
              <button
                key={i}
                type="button"
                className="hks-dot-btn hks-plain"
                aria-label={`${S.goToStep} ${i + 1}`}
                onClick={() => navigate(i)}
                // Padding + matching negative margin: the hit area grows to
                // 14×26 for a thumb while the box it occupies stays exactly the
                // dot's own 10×6, so the rail doesn't move.
                style={{ background: 'none', border: 0, padding: '10px 4px', margin: '-10px -2px', cursor: 'pointer', lineHeight: 0 }}
              >
                {dot}
              </button>
            ) : (
              <span key={i} aria-hidden style={{ padding: '10px 4px', margin: '-10px -2px', lineHeight: 0, display: 'block' }}>{dot}</span>
            );
          })}
        </div>

        {/* Frosted card */}
        <div
          onKeyDown={onCardKeyDown}
          style={{
            position: 'relative',
            background: 'rgba(255,255,255,0.55)',
            backdropFilter: 'blur(28px) saturate(150%)',
            WebkitBackdropFilter: 'blur(28px) saturate(150%)',
            border: '1px solid rgba(255,255,255,0.7)',
            borderRadius: 24,
            padding: 32,
            boxShadow: '0 30px 70px -30px rgba(31,35,28,0.35), 0 1px 0 rgba(255,255,255,0.8) inset',
          }}
        >
          <div key={screen} className={!hasMoved ? undefined : dir === 1 ? 'hks-screen-fwd' : 'hks-screen-back'}>
            {screens[screen]}
          </div>

          {/* Save problems live OUTSIDE the screen list, because a local
              validation failure sends the manager back to the question that
              needs fixing — and a message that only rendered on the last screen
              would be invisible exactly when it is needed. */}
          {saveError && (
            <p role="alert" style={{ fontFamily: FONT_SANS, fontSize: 13.5, color: T.warm, margin: '18px 0 0', lineHeight: 1.45 }}>
              {saveError}
            </p>
          )}

          {/* Footer — one primary action, back on the left, skip where it applies */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
            marginTop: 28, paddingTop: 20, borderTop: `1px solid ${T.rule}`,
          }}>
            {screen > 0 && (
              <Btn variant="ghost" size="lg" onClick={() => navigate(screen - 1)}>← {S.back}</Btn>
            )}
            <div style={{ flex: 1 }} />
            {/* Skip stays available right through the upload, so a slow or
                stuck photo can never trap anyone on an optional screen. It
                disappears once a photo actually landed — at that point
                "Skip this" would be describing the wrong thing (the photo is
                kept either way) and Continue is the only honest label. */}
            {screen === 2 && photoState !== 'done' && (
              <Btn variant="ghost" size="lg" onClick={() => goto(screen + 1)}>{S.skip}</Btn>
            )}
            {/* The sage ring is the other half of "the screen no longer moves
                by itself": with nothing advancing on its own, Continue has to
                look like the next thing to do the moment an answer is in. It is
                a static ring, not a pulse — the footer must not twitch every
                time someone changes their mind about a chip. */}
            <Btn
              variant="primary"
              size="lg"
              disabled={(!canAdvance && !isLast) || saving}
              onClick={advance}
              style={canAdvance && !saving
                ? { boxShadow: '0 0 0 3px rgba(92,122,96,0.22)' }
                : undefined}
            >
              {primaryLabel}{!isLast && ' →'}
            </Btn>
          </div>
        </div>
      </div>

      <style>{SETUP_STYLE}</style>
    </div>
  );
}

export default HousekeepingSetup;

/* ──────────────────────────── Screen scaffolding ───────────────────────── */

function Question({
  id, title, sub, headingRef, children,
}: {
  id: string;
  title: string;
  sub?: string;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h2
        id={id}
        ref={headingRef}
        tabIndex={-1}
        style={{
          fontFamily: FONT_SANS, fontSize: 23, fontWeight: 600, letterSpacing: '-0.02em',
          color: T.ink, margin: 0, lineHeight: 1.25, outline: 'none',
        }}
      >
        {title}
      </h2>
      {sub && (
        <p style={{ fontFamily: FONT_SANS, fontSize: 14, color: T.ink2, lineHeight: 1.5, margin: '9px 0 0' }}>
          {sub}
        </p>
      )}
      <div style={{ marginTop: 22 }}>{children}</div>
    </div>
  );
}

function MinutesInput({
  label, hint, suffix, value, onChange, invalid,
}: {
  label: string; hint: string; suffix: string;
  value: string; onChange: (v: string) => void; invalid: boolean;
}) {
  return (
    <div style={{ minWidth: 180 }}>
      <FieldLabel>{label}</FieldLabel>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <input
          className="hks-num"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={value}
          aria-label={label}
          aria-invalid={invalid || undefined}
          onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, '').slice(0, 3))}
          style={{
            width: 92, height: 56, padding: '0 14px', borderRadius: 12,
            background: 'rgba(255,255,255,0.8)',
            border: `1px solid ${invalid ? 'rgba(184,92,61,0.6)' : 'rgba(31,35,28,0.14)'}`,
            fontFamily: FONT_SANS, fontSize: 24, fontWeight: 600, color: T.ink,
            textAlign: 'center', boxSizing: 'border-box', outline: 'none',
          }}
        />
        <span style={{ fontFamily: FONT_SANS, fontSize: 14, color: T.ink2 }}>{suffix}</span>
      </div>
      <span style={{ display: 'block', fontFamily: FONT_SANS, fontSize: 12.5, color: T.ink3, marginTop: 7 }}>
        {hint}
      </span>
    </div>
  );
}

/* ────────────────────── The two "+" rows (Q2 and Q6) ────────────────────── */

/** A 44×44 hit target for removing a row — thumb-sized, keyboard-reachable. */
function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="hks-plain"
      aria-label={label}
      onClick={onClick}
      style={{
        width: 44, height: 44, flexShrink: 0, borderRadius: 12,
        background: 'transparent', border: `1px solid ${T.rule}`,
        color: T.ink2, cursor: 'pointer',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: FONT_SANS, fontSize: 17, lineHeight: 1,
      }}
    >
      <span aria-hidden>✕</span>
    </button>
  );
}

/**
 * One custom room type: what the hotel calls it, and how long it takes.
 *
 * The message under the row is what stops a half-typed room type from being
 * discovered at the save six screens later. It is grey while the row is merely
 * unfinished and warm when something is actually wrong — an empty row someone
 * added two seconds ago is not a mistake, and colouring it like one trains
 * people to ignore the colour when it matters.
 */
function CustomRoomRow({
  row, index, problem, S, onLabel, onMinutes, onRemove,
}: {
  row: CustomRoomDraft;
  /** 0-based position, used only to keep the rows' spoken labels distinct. */
  index: number;
  problem: RoomRowProblem;
  S: HkSetupStrings;
  onLabel: (v: string) => void;
  onMinutes: (v: string) => void;
  onRemove: () => void;
}) {
  const label = normalizeCustomLabel(row.label);
  const named = label !== '' ? `“${label}”` : '';
  // Every row would otherwise announce the same two field names, so a screen
  // reader user on their third room type hears "What you call it" three times
  // with no way to tell which row they are in. Once a row has a name, the name
  // itself is the best disambiguator; before that, its position is.
  const rowTag = label !== '' ? label : String(index + 1);
  const message =
    problem === 'incomplete' ? S.q2RoomIncomplete
    : problem === 'tooLong' ? `${S.customTooLongLead} ${MAX_CUSTOM_LABEL_LENGTH} ${S.customTooLongTail}`
    : problem === 'reserved' ? S.q2RoomReserved
    : problem === 'duplicate' ? `${named} ${S.q2RoomDuplicate}`
    : problem === 'minutes' ? `${named} — ${S.q2InvalidLead} ${MIN_CLEAN_MINUTES} ${S.q2InvalidJoin} ${MAX_CLEAN_MINUTES}.`
    : null;
  const isFault = problem !== null && problem !== 'incomplete';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 190px', minWidth: 0 }}>
          <FieldLabel>{S.q2CustomNameLabel}</FieldLabel>
          <input
            className="hks-text"
            type="text"
            autoComplete="off"
            value={row.label}
            aria-label={`${S.q2CustomNameLabel} — ${rowTag}`}
            aria-invalid={(isFault && problem !== 'minutes') || undefined}
            placeholder={S.q2CustomNamePlaceholder}
            onChange={(e) => onLabel(e.target.value)}
            style={{
              width: '100%', height: 56, padding: '0 14px', borderRadius: 12,
              background: 'rgba(255,255,255,0.8)',
              border: `1px solid ${isFault && problem !== 'minutes' ? 'rgba(184,92,61,0.6)' : 'rgba(31,35,28,0.14)'}`,
              fontFamily: FONT_SANS, fontSize: 16, color: T.ink,
              boxSizing: 'border-box', outline: 'none',
            }}
          />
        </div>
        <div>
          <FieldLabel>{S.q2CustomTimeLabel}</FieldLabel>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              className="hks-num"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={row.minutes}
              aria-label={`${S.q2CustomTimeLabel} ${S.q2Minutes} — ${rowTag}`}
              aria-invalid={(problem === 'minutes') || undefined}
              onChange={(e) => onMinutes(e.target.value)}
              style={{
                width: 84, height: 56, padding: '0 12px', borderRadius: 12,
                background: 'rgba(255,255,255,0.8)',
                border: `1px solid ${problem === 'minutes' ? 'rgba(184,92,61,0.6)' : 'rgba(31,35,28,0.14)'}`,
                fontFamily: FONT_SANS, fontSize: 22, fontWeight: 600, color: T.ink,
                textAlign: 'center', boxSizing: 'border-box', outline: 'none',
              }}
            />
            <span style={{ fontFamily: FONT_SANS, fontSize: 13.5, color: T.ink2 }}>{S.q2Minutes}</span>
          </div>
        </div>
        <RemoveButton label={`${S.q2RemoveRoom} — ${rowTag}`} onClick={onRemove} />
      </div>
      {message && (
        <p
          role={isFault ? 'alert' : undefined}
          style={{
            fontFamily: FONT_SANS, fontSize: 13, margin: 0, lineHeight: 1.45,
            color: isFault ? T.warm : T.ink2,
          }}
        >
          {message}
        </p>
      )}
    </div>
  );
}

/**
 * One duty the hotel typed in. Styled as a chosen chip because that is exactly
 * what it is — it only exists because someone added it — but it is a plain div
 * carrying its own remove button, since a button inside a button is invalid
 * markup and leaves the remove control unreachable from a keyboard.
 */
function CustomDutyRow({
  label, removeLabel, onRemove,
}: {
  label: string;
  removeLabel: string;
  onRemove: () => void;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      width: '100%', minHeight: 56, padding: '7px 10px 7px 18px',
      borderRadius: 14, boxSizing: 'border-box',
      background: 'rgba(92,122,96,0.12)',
      border: '1px solid rgba(92,122,96,0.55)',
      boxShadow: '0 8px 20px -14px rgba(62,92,72,0.7)',
      fontFamily: FONT_SANS,
    }}>
      <span style={{
        flex: 1, minWidth: 0, fontSize: 15.5, fontWeight: 600, color: T.ink,
        lineHeight: 1.35, overflowWrap: 'anywhere',
      }}>
        {label}
      </span>
      <PickMark shown />
      <RemoveButton label={`${removeLabel} ${label}`} onClick={onRemove} />
    </div>
  );
}

/* ───────────────────────────── Level chooser ───────────────────────────── */

function BulletBlock({
  label, items, mark, markColor, textColor, marginTop,
}: {
  label: string; items: string[]; mark: string;
  markColor: string; textColor: string; marginTop: number;
}) {
  return (
    <span style={{ display: 'block', marginTop }}>
      <Caps size={9.5} tracking="0.14em">{label}</Caps>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 7 }}>
        {items.map((item) => (
          <span key={item} style={{ display: 'flex', gap: 8, fontSize: 13.5, color: textColor, lineHeight: 1.45 }}>
            <span aria-hidden style={{ color: markColor, flexShrink: 0 }}>{mark}</span>
            <span>{item}</span>
          </span>
        ))}
      </span>
    </span>
  );
}

/**
 * The row of heads that makes "one more group of people" visible before a
 * single word is read: 1 dot → 2 dots → the whole crew. The first dot is the
 * manager (solid); everyone they'd be asking to join is lighter. Decorative —
 * the `who` text next to it carries the meaning for a screen reader.
 */
function WhoDots({ count }: { count: number }) {
  return (
    <span aria-hidden style={{ display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          style={{
            width: 7, height: 7, borderRadius: 999,
            background: i === 0 ? T.sageDeep : 'rgba(92,122,96,0.45)',
          }}
        />
      ))}
    </span>
  );
}

/**
 * One adoption option. Collapsed, it is exactly the four lines a manager needs
 * to compare: name · who opens Staxis · what you get · the honest trade-off.
 * The rest of the old bullet wall lives behind a per-card "The full picture"
 * toggle — a sibling of the radio button, never nested inside it (nested
 * buttons are invalid HTML), inside a wrapper <div> that carries the card
 * visuals for both.
 *
 * Locked cards say only two things — "you don't need this one" and why — and
 * offer no detail fold: more prose on an option we're telling them to ignore
 * would just re-open the question the lock already answered.
 */
function LevelCard({
  level, name, who, whoCount, get, trade, detailGood, detailBad,
  goodLabel, badLabel, detailsLabel,
  selected, recommended, recommendedLabel, reason,
  lockedLabel, lockedBody, onPick,
}: {
  level: HkLevel;
  name: string;
  who: string;
  whoCount: number;
  get: string;
  trade: string;
  detailGood: string[];
  detailBad: string[];
  goodLabel: string;
  badLabel: string;
  detailsLabel: string;
  selected: boolean;
  recommended: boolean;
  recommendedLabel: string;
  reason: string | null;
  lockedLabel: string | null;
  lockedBody: string | null;
  onPick: () => void;
}) {
  const locked = lockedLabel !== null;
  const [open, setOpen] = useState(false);
  const detailId = useId();
  return (
    <div
      className={`hks-lvl${locked ? ' is-locked' : ''}`}
      data-level={level}
      style={{
        borderRadius: 16,
        background: locked
          ? 'rgba(31,35,28,0.035)'
          : selected ? 'rgba(92,122,96,0.12)' : 'rgba(255,255,255,0.72)',
        border: `1px solid ${locked ? 'rgba(31,35,28,0.10)' : selected ? 'rgba(92,122,96,0.55)' : 'rgba(31,35,28,0.12)'}`,
        boxShadow: selected && !locked ? '0 10px 26px -18px rgba(62,92,72,0.8)' : 'none',
        opacity: locked ? 0.72 : 1,
      }}
    >
      <button
        type="button"
        data-chip
        className="hks-chip"
        role="radio"
        aria-checked={selected}
        disabled={locked}
        onClick={onPick}
        style={{
          display: 'block', width: '100%', textAlign: 'left',
          padding: locked ? '16px 18px 18px' : '16px 18px 15px',
          background: 'none', border: 0, borderRadius: 16,
          cursor: locked ? 'not-allowed' : 'pointer',
          fontFamily: FONT_SANS,
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 16.5, fontWeight: 600, color: T.ink, letterSpacing: '-0.01em' }}>{name}</span>
          {recommended && !locked && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', height: 21, padding: '0 9px', borderRadius: 999,
              background: 'rgba(92,122,96,0.16)', color: T.sageDeep,
              fontFamily: FONT_MONO, fontSize: 9.5, fontWeight: 600,
              letterSpacing: '0.1em', textTransform: 'uppercase',
            }}>{recommendedLabel}</span>
          )}
          {locked && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 5, height: 21, padding: '0 9px', borderRadius: 999,
              background: 'rgba(31,35,28,0.07)', color: T.ink2,
              fontFamily: FONT_MONO, fontSize: 9.5, fontWeight: 600,
              letterSpacing: '0.1em', textTransform: 'uppercase',
            }}>
              <span aria-hidden>🔒</span>{lockedLabel}
            </span>
          )}
        </span>

        {locked ? (
          // The whole locked story in one breath: not needed, and why.
          lockedBody && (
            <span style={{ display: 'block', fontSize: 13, color: T.ink2, lineHeight: 1.5, marginTop: 9 }}>
              {lockedBody}
            </span>
          )
        ) : (
          <>
            {/* The axis the three options differ on, made visible. */}
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 7 }}>
              <WhoDots count={whoCount} />
              <span style={{ fontSize: 12.5, color: T.ink2 }}>{who}</span>
            </span>

            {reason && (
              <span style={{ display: 'block', fontSize: 13, color: T.sageDeep, lineHeight: 1.45, marginTop: 9 }}>
                {reason}
              </span>
            )}

            <span style={{ display: 'block', fontSize: 13.5, color: T.ink, lineHeight: 1.5, marginTop: 10 }}>
              {get}
            </span>

            <span style={{ display: 'flex', gap: 8, fontSize: 13, color: T.ink2, lineHeight: 1.5, marginTop: 7 }}>
              <span aria-hidden style={{ color: T.warm, flexShrink: 0 }}>−</span>
              <span>{trade}</span>
            </span>
          </>
        )}
      </button>

      {!locked && (
        <>
          <button
            type="button"
            className="hks-more hks-plain"
            aria-expanded={open}
            aria-controls={detailId}
            aria-label={`${detailsLabel} — ${name}`}
            onClick={() => setOpen((o) => !o)}
            style={{
              display: 'flex', alignItems: 'center', gap: 7, width: '100%',
              textAlign: 'left', padding: '11px 18px 13px',
              background: 'none', border: 0, borderTop: `1px solid ${T.rule}`,
              cursor: 'pointer',
              fontFamily: FONT_MONO, fontSize: 9.5, fontWeight: 600,
              letterSpacing: '0.12em', textTransform: 'uppercase', color: T.ink2,
            }}
          >
            <span aria-hidden style={{ fontSize: 10, color: T.ink3, lineHeight: 1 }}>{open ? '▴' : '▾'}</span>
            {detailsLabel}
          </button>

          {open && (
            <div id={detailId} className="hks-detail-open" style={{ padding: '0 18px 16px' }}>
              <BulletBlock label={goodLabel} items={detailGood} mark="+" markColor={T.sageDeep} textColor={T.ink} marginTop={4} />
              {/* The trade line above is part of this list too — it stays on the
                  card face so the fold repeats nothing and hides nothing. */}
              {detailBad.length > 0 && (
                <BulletBlock label={badLabel} items={detailBad} mark="−" markColor={T.warm} textColor={T.ink2} marginTop={12} />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
