'use client';

// ═══════════════════════════════════════════════════════════════════════════
// FindingCards — what Staxis noticed, as cards a manager can act on.
//
// THE FIVE PROMISES THIS COMPONENT KEEPS
//
//   1. Nothing chases you. No popup, no toast, and nothing that has to be
//      CLEARED. The Staxis pill does carry a count of decisions waiting
//      (/api/findings/badge), but it is a mirror of this list and nothing
//      else: it falls on its own as cards are dealt with, there is no "mark
//      all read", and no notification is ever pushed at anybody. The cards sit
//      in the Staxis tab; ignoring one costs nothing and the screen never
//      mentions it again until the numbers change.
//
//   2. One problem, one card, for as long as it is true. A re-find UPDATES
//      the card ("now 5 work orders") — that guarantee is a unique index in
//      migration 0360, not something this file is polite enough to honour.
//
//   3. A price is always a RANGE, with its basis shown. "$200–400, based on
//      your last 3 plumber invoices." Never a point estimate; the midpoint
//      exists only as a sort key and is never rendered. No basis in the
//      hotel's own numbers means no money is mentioned at all.
//
//   4. Every card can be put down, and the three ways of putting it down mean
//      three different things. "I handled it" ends the finding; if it comes
//      back it comes back as a NEW card, because the handling did not take.
//      "Seen" / "Known problem" is permanent quiet EXCEPT escalation — arming
//      the silencer at 4 work orders is consent to 4, not to 9 — and it never
//      claims the problem is over. "Not doing this" / "Mute" is unconditional
//      and therefore asks first. Which buttons a given card offers is decided
//      in finding-cards.ts, not here.
//
//   5. A quiet system and a dead one look different. The line above the cards
//      says what was checked and when. If the last check was days ago it says
//      that instead. If there has never been a check it says NOTHING — an
//      empty queue on an unscanned hotel must never read as "all clear".
//
// Reads and writes go through /api/findings (service-role behind
// requireSession + the manager gate) — never the browser Supabase client. The
// findings table is deny-all to the browser, so a direct read would return an
// empty list with a 200 and this screen would quietly lie.
// ═══════════════════════════════════════════════════════════════════════════

import React from 'react';

import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { canManageTeam } from '@/lib/roles';
import { useActiveHotelStanding } from '@/lib/capabilities/useCan';
import { useApiResource } from '@/lib/hooks/use-api-resource';
import { useReportedValue } from '@/lib/hooks/use-reported-value';
import {
  fetchWithAuth,
  INTERACTIVE_ACTION_TIMEOUT_MS,
  SessionEndedError,
} from '@/lib/api-fetch';
import { readEnvelope } from '@/lib/api-envelope';
import { buildOneList, partitionTimeline, type ListRow } from '@/lib/feed/one-list';
import type { LogEntryDTO } from '@/lib/comms/types';
import type { KnowledgeEventDTO } from '@/lib/knowledge/types';
import type { WorklistItem } from '@/lib/worklist/types';

import { CxIcon } from './icons';
import {
  DAILY_CARD_CAP,
  basisInLang,
  cardEyebrowLabel,
  cardPhrasing,
  closureButtons,
  dataAgeNote,
  declinedExplanation,
  distinctDetectors,
  focusedSplit,
  formatPriceRange,
  formatShortDate,
  isCardRenderable,
  isSignOffLocked,
  livenessLine,
  occurrenceLine,
  offersApproval,
  offersUndo,
  rankFindings,
  severityChipClass,
  signOffNotice,
  skippedNote,
  type ClosureButton,
  type ClosureVerdict,
  type Lang,
  type QueueFinding,
  type QueueRun,
} from './finding-cards';

interface QueuePayload {
  findings: QueueFinding[];
  run: QueueRun | null;
  cap: number;
}

/**
 * What a manager can tell Staxis about a card. The three verdicts and their
 * wording per card kind live in finding-cards.ts (`closureButtons`) — this file
 * renders whatever that returns and never decides which buttons a card gets.
 */
type Verdict = ClosureVerdict;

/**
 * How long a card stays optimistically hidden after a verdict.
 *
 * Long enough to cover the reload that follows the write, short enough that the
 * server is authoritative again well before anybody could act on a stale
 * screen. It is a render bridge, not a record of anything.
 */
export const SETTLED_HIDE_MS = 15_000;

// ─── Copy ───────────────────────────────────────────────────────────────────

/**
 * Every fixed string this surface can put on a screen, in both languages.
 *
 * Exported ONLY so the copy guard (findings-copy-rules.test.ts) can walk it.
 * A guard that greps this file's source would pass on a dash arriving through
 * an interpolation and fail on a harmless rename; walking the real table is
 * what makes it a test of the copy rather than of the text of the file.
 */
export const S = {
  heading: { en: 'What Staxis noticed', },
  cancel: { en: 'Cancel', },
  seeNumbers: { en: 'See the numbers', },
  hideNumbers: { en: 'Hide the numbers', },
  // ── the ink card (2026-08-01 redesign) ──
  // Everything Staxis says is dark; everything you owe is light. The badge is
  // what makes the card's voice explicit rather than implied by its colour.
  foundBadge: { en: 'Staxis found', },
  theNumbers: { en: 'The numbers', },
  // The ink card opens its provenance line with this, where the light card had
  // it mid-sentence after the price. Same claim, sentence case.
  basedOnLead: { en: 'Based on', },
  moreActions: { en: 'More ways to put this down', },
  earlier: { en: 'Earlier today', },
  tapToSee: { en: 'Tap to see them.', },
  basedOn: { en: 'based on', },
  updated: { en: 'UPDATED', },
  showAll: { en: 'Show all', },
  showFewer: { en: 'Show fewer', },
  asOf: { en: 'Numbers as of', },
  receiptQuery: { en: 'Check', },
  // What an empty cell in the receipt says. It used to be a bare em dash, which
  // in a column of numbers reads as a zero rather than as an absence, and which
  // the founder's 2026-07-28 copy ruling took out of user-facing text anyway.
  noValue: { en: 'not recorded', },
  saveFailed: {
    en: 'That did not save. Nothing changed. Try again in a moment.',

  },
  loadFailed: {
    en: 'Staxis could not check just now. Do not read this as "nothing is wrong".',

  },
  // Said ONLY when there has never been a check here. Deliberately not an
  // all-clear and deliberately not an apology: it reports that the watching
  // has not begun, which is the one true thing available to say.
  neverChecked: {
    en: 'Staxis has not started checking this hotel yet. Nothing here means "all clear". It means nothing has been looked at.',

  },

  // ── the hands ──
  doIt: { en: 'Yes, do it', },
  notNow: { en: 'Not now', },
  working: { en: 'Doing it…', },
  undo: { en: 'Undo', },
  undoing: { en: 'Undoing…', },
  undone: {
    en: 'Undone. Nothing was left behind.',

  },
  actionFailed: {
    en: 'That did not go through, and nothing was changed. Try again in a moment.',

  },

  // ── reading, not deciding ──
  // Shown in place of the controls to somebody whose job opens this screen to
  // READ. The sentence says whose call it is, so nothing looks broken.
  readOnly: {
    en: 'Yours to read. Closing this out is the operator\u2019s call.',

  },
} as const;

// ─── Scoped styles ──────────────────────────────────────────────────────────

const FD_CSS = `
.fd-live{display:flex;align-items:center;gap:8px;margin-top:18px;font-size:12px;color:#8A9187;
  font-family:var(--font-geist-mono),ui-monospace,monospace;letter-spacing:.01em;}
.fd-live.fd-stale{color:#8C6A33;}
.fd-livedot{width:6px;height:6px;border-radius:50%;background:#9EB7A6;flex-shrink:0;}
.fd-live.fd-stale .fd-livedot{background:#C99644;}
.fd-skipped{font-size:11.5px;color:#A6ABA6;margin-top:4px;}
.fd-empty{margin-top:20px;border-radius:16px;border:1px solid rgba(31,35,28,.08);background:#FAFBF9;
  padding:16px 17px;font-size:13px;line-height:1.6;color:#5C625C;}
.fd-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-top:22px;flex-wrap:wrap;}
.fd-headt{font-size:15px;font-weight:600;color:#1F231C;}
.fd-price{display:inline-flex;align-items:baseline;gap:7px;margin-top:7px;flex-wrap:wrap;}
.fd-pricev{font-size:15px;font-weight:600;color:#1F231C;letter-spacing:-0.01em;
  font-family:var(--font-geist-mono),ui-monospace,monospace;}
.fd-priceb{font-size:11.5px;color:#8A9187;}
.fd-meta{display:flex;gap:10px;margin-top:9px;flex-wrap:wrap;align-items:center;}
.fd-metai{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:10px;color:#A6ABA6;}
.fd-metai.fd-age{color:#8C6A33;}
.fd-acts{display:flex;gap:7px;margin-top:12px;flex-wrap:wrap;align-items:center;}
.fd-act{height:30px;padding:0 12px;border-radius:999px;cursor:pointer;font-size:12px;font-weight:500;
  border:1px solid rgba(31,35,28,.14);background:transparent;color:#5C625C;white-space:nowrap;
  font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;transition:background .2s,color .2s;}
.fd-act:hover:not(:disabled){background:rgba(31,35,28,.05);}
.fd-act:disabled{opacity:.5;cursor:default;}
.fd-act.fd-yes{background:#5C7A60;border-color:#5C7A60;color:#fff;font-weight:600;}
.fd-act.fd-yes:hover:not(:disabled){background:#4E6952;}
.fd-act.fd-danger{color:#B85C3D;}
.fd-act:focus-visible{outline:2px solid #3E5C48;outline-offset:2px;}
.fd-sure{font-size:12px;color:#8E432B;align-self:center;}
.fd-rcpt{margin-top:11px;border-radius:12px;border:1px solid rgba(31,35,28,.08);background:#FAFBF9;
  padding:11px 13px;}
.fd-rrow{display:flex;justify-content:space-between;gap:14px;padding:4px 0;font-size:12px;
  border-bottom:1px solid rgba(31,35,28,.05);}
.fd-rrow:last-child{border-bottom:none;}
.fd-rk{color:#8A9187;font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:10.5px;
  text-transform:uppercase;letter-spacing:.06em;}
.fd-rv{color:#1F231C;text-align:right;word-break:break-word;min-width:0;}
.fd-rfoot{font-size:10.5px;color:#A6ABA6;margin-top:8px;
  font-family:var(--font-geist-mono),ui-monospace,monospace;}
.fd-fold{margin-top:14px;}
/* Clearance for the fixed ask-composer, whose top edge the page cannot see.
   Derived from the dock's own CSS (AskStaxisBar's ASX_CSS), not guessed: the
   glass bar is 46px, the suggestion-chip row adds 42px and the resume row
   another 33px once the bar is no longer idle, and the whole thing sits 22px off
   the bottom — 143px of viewport before a thread is even open. The cx-page rule
   already contributes 130px of bottom padding, which is 13px SHORT of that, and
   13px is exactly enough to put a verdict button under a floating pill. This
   spacer takes the total past 250px, which also clears a one-message thread.
   The safe-area inset is added because the dock uses it too, so on a notched
   phone the spacer grows exactly as much as the dock does. */
.fd-headroom{height:calc(132px + env(safe-area-inset-bottom, 0px));}
.fd-err{margin-top:10px;border-radius:12px;padding:9px 12px;font-size:12.5px;line-height:1.5;
  background:rgba(184,92,61,.10);color:#8E432B;}
.fd-focused{border-color:rgba(62,92,72,.55);box-shadow:0 0 0 3px rgba(158,183,166,.28);}

/* ── the hands ── */
.fd-offer{margin-top:11px;border-radius:12px;border:1px solid rgba(62,92,72,.22);
  background:rgba(158,183,166,.12);padding:11px 13px;font-size:13px;line-height:1.5;color:#1F231C;}
.fd-settled{margin-top:11px;border-radius:12px;padding:10px 13px;font-size:12.5px;line-height:1.5;}
.fd-settled.fd-done{background:rgba(92,122,96,.12);color:#3E5C48;}
.fd-settled.fd-declined{background:rgba(201,150,68,.14);color:#7A5518;}
.fd-settled.fd-broke{background:rgba(184,92,61,.10);color:#8E432B;}
.fd-settled .fd-act{margin-top:8px;}

/* ── the company's signature standing on the button ── */
.fd-locked{display:flex;align-items:center;gap:7px;margin-top:9px;padding:8px 12px;border-radius:999px;
  background:rgba(201,150,68,.14);color:#7A5518;font-size:12.5px;font-weight:500;line-height:1.4;}

/* ── portfolio: which hotel, and why it climbed ── */
.fd-hotel{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;
  letter-spacing:.05em;text-transform:uppercase;color:#5C7A60;
  font-family:var(--font-geist-mono),ui-monospace,monospace;}
.fd-note{font-size:11.5px;color:#8A9187;margin-top:5px;}
.fd-drill{font-size:12px;color:#3E5C48;text-decoration:none;border-bottom:1px solid rgba(62,92,72,.3);}
.fd-drill:hover{border-bottom-color:#3E5C48;}
`;

// ─── Receipt rendering ──────────────────────────────────────────────────────

/** Render one evidence value without pretending to understand its shape. */
function renderValue(value: unknown, lang: Lang): string {
  if (value === null || value === undefined) return S.noValue.en;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** "hvac_work_orders_30d" → "hvac work orders 30d". */
function humanKey(key: string): string {
  return key.replace(/[_-]+/g, ' ').trim();
}

/**
 * The numbers behind one card. Exported for its own test: it is hook-free, so
 * it can be called directly and its element tree walked — which is the only
 * way to prove the fallback line below actually reaches a Spanish reader.
 */
export function Receipt({ finding, lang, ink = false }: { finding: QueueFinding; lang: Lang; ink?: boolean }) {
  const es = false;
  const entries = [
    ...Object.entries(finding.evidence.values ?? {}),
    ...Object.entries(finding.evidence.params ?? {}),
  ];
  const asOf = formatShortDate(finding.asOf, lang);
  const c = ink
    ? { box: 'fx-inkbox', row: 'fx-inkrow', k: 'fx-inkk', v: 'fx-inkv', foot: 'fx-inkfoot' }
    : { box: 'fd-rcpt', row: 'fd-rrow', k: 'fd-rk', v: 'fd-rv', foot: 'fd-rfoot' };
  return (
    <div className={c.box}>
      {entries.length === 0 ? (
        <div className={c.v} style={{ textAlign: 'left', fontSize: 12, color: ink ? '#B9C0B8' : '#8A9187' }}>
          {/* The same basis line the card above shows, through the same
              language pick. Reading `evidence.basis` straight — which this
              branch used to do — printed English into a Spanish receipt for
              exactly the findings that have no numbered rows to fall back on. */}
          {basisInLang(finding.evidence.basis, finding.evidence.basisEs, lang)}
        </div>
      ) : (
        entries.map(([k, v]) => (
          <div className={c.row} key={k}>
            <span className={c.k}>{humanKey(k)}</span>
            <span className={c.v}>{renderValue(v, lang)}</span>
          </div>
        ))
      )}
      <div className={c.foot}>
        {(S.receiptQuery.en)}: {finding.evidence.queryId || (S.noValue.en)}
        {asOf ? ` · ${S.asOf.en} ${asOf}` : ''}
      </div>
    </div>
  );
}

// ─── The attached fix ───────────────────────────────────────────────────────

/**
 * The one-tap fix, and everything that can become of it.
 *
 * ONE TAP, NOT TWO. The offer sentence sits directly above the button, so the
 * tap is already informed — the confirmation IS the card, inline, rather than a
 * dialog stacked on top of it. That is the opposite of the Mute button below,
 * which asks first, and the difference is deliberate: mute is permanent and
 * this is not. Everything here is undoable, and the Undo appears on this same
 * card the moment it runs.
 *
 * The sentence and the button label come from the SERVER, derived from the
 * frozen plan through the same catalog entry that defines what the button does.
 * Nothing here composes its own description of the action, which is how "what
 * runs is what was shown" survives contact with a UI.
 */
function ActionRow({
  finding,
  lang,
  busy,
  readOnly = false,
  onAction,
}: {
  finding: QueueFinding;
  lang: Lang;
  busy: boolean;
  /** The reader may not act. Same sentences, no buttons — see FindingCard. */
  readOnly?: boolean;
  onAction?: (actionId: string, intent: 'execute' | 'undo') => void;
}) {
  const es = false;
  const L = <K extends keyof typeof S>(k: K) => (S[k].en);
  const action = finding.action;
  if (!action) return null;

  // ── locked, not hidden ──
  // The company's rulebook routed this signature to somebody else. The offer
  // sentence still renders in full — the manager sees exactly what Staxis would
  // do and exactly who has to say yes — and the button is replaced rather than
  // removed. Hiding the card would teach a GM that Staxis withholds things,
  // which costs more than the button was worth. This is the RENDERING of the
  // rule; /api/findings/actions enforces it again before anything runs.
  if (isSignOffLocked(finding) && action.state === 'proposed') {
    return (
      <>
        <div className="fd-offer">{action.offerEn}</div>
        <div className="fd-locked">
          <CxIcon name="staxis" size={14} />
          <span>{signOffNotice(finding.signOff!, lang)}</span>
        </div>
      </>
    );
  }

  if (offersApproval(finding)) {
    return (
      <>
        <div className="fd-offer">{action.offerEn}</div>
        {/* Same shape as the sign-off lock above, and for the same reason: the
            offer sentence still renders in full so the reader sees exactly what
            Staxis would do, and the button is REPLACED rather than removed. */}
        {readOnly ? (
          <div className="fd-locked">
            <CxIcon name="staxis" size={14} />
            <span>{L('readOnly')}</span>
          </div>
        ) : (
          <div className="fd-acts">
            <button
              type="button"
              className="fd-act fd-yes"
              disabled={busy}
              onClick={() => onAction?.(action.id, 'execute')}
            >
              {busy ? L('working') : action.labelEn}
            </button>
          </div>
        )}
      </>
    );
  }

  if (offersUndo(finding)) {
    return (
      <div className="fd-settled fd-done">
        <div>{(action.receiptEn) ?? ''}</div>
        {!readOnly && (
          <button
            type="button"
            className="fd-act"
            disabled={busy}
            onClick={() => onAction?.(action.id, 'undo')}
          >
            {busy ? L('undoing') : L('undo')}
          </button>
        )}
      </div>
    );
  }

  if (action.state === 'undone') {
    return <div className="fd-settled fd-done">{L('undone')}</div>;
  }

  // The whole point of re-verifying inside the transaction: Staxis declined,
  // and says what moved. A manager reading this learns that the system checked
  // — which is worth more than the action would have been.
  if (action.state === 'declined_changed') {
    return <div className="fd-settled fd-declined">{declinedExplanation(action, lang)}</div>;
  }

  if (action.state === 'failed') {
    // Deliberately the generic sentence, not `failureReason`: that column holds
    // a Postgres error, which is a fact for an operator and noise for a
    // manager. What matters to them is the part that is always true here —
    // nothing was half-done.
    return <div className="fd-settled fd-broke">{L('actionFailed')}</div>;
  }

  return null;
}

// ─── One card ───────────────────────────────────────────────────────────────

/** Closure-button tone → the class that draws it. The only place the two meet. */
function toneClass(tone: ClosureButton['tone']): string {
  if (tone === 'primary') return 'fd-act fd-yes';
  if (tone === 'danger') return 'fd-act fd-danger';
  return 'fd-act';
}

/** "9:12 AM", or empty when the stamp is unusable. */
function clockStamp(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/**
 * The ink card — a finding as it appears on the /feed timeline.
 *
 * HOOK-FREE AND FULLY CONTROLLED, like the row views next door: every piece of
 * state it draws is passed in from `FindingCard`, so the whole card can be
 * walked in a test that cannot mount a component.
 *
 * ─── one primary action, and only one ──────────────────────────────────────
 * The old card put every verb the finding supported in a row of same-weight
 * pills: `Handled it`, `Seen`, `Not doing this`, `See the numbers`, plus the
 * approve button when there was one. Five things of equal loudness is not a
 * choice, it is a wall. The founder's ruling is one solid primary; the rest
 * move behind `···`. Nothing is removed: every verdict `closureButtons`
 * returns is still reachable, and the confirm step still belongs to the button
 * that asked for it.
 */
function InkCard({
  cardRef, finding, lang, busy, focused, readOnly, note, href, hrefLabel,
  price, seen, priceBasis, evidenceBasis, age, closures, pending,
  showReceipt, menuOpen, onToggleMenu, onStartConfirm, onToggleReceipt, onVerdict, onAction,
}: {
  cardRef: React.RefObject<HTMLDivElement | null>;
  finding: QueueFinding;
  lang: Lang;
  busy: boolean;
  focused: boolean;
  readOnly: boolean;
  note: string | null;
  href: string | null;
  hrefLabel?: string;
  price: string | null;
  seen: string | null;
  priceBasis: string | null;
  evidenceBasis: string | null;
  age: string | null;
  closures: ClosureButton[];
  pending: ClosureButton | null;
  showReceipt: boolean;
  menuOpen: boolean;
  onToggleMenu: (open: boolean) => void;
  onStartConfirm: (verdict: ClosureVerdict | null) => void;
  onToggleReceipt: () => void;
  onVerdict: (findingId: string, verdict: Verdict) => void;
  onAction?: (actionId: string, intent: 'execute' | 'undo') => void;
}) {
  const L = <K extends keyof typeof S>(k: K) => (S[k].en);
  const action = finding.action ?? null;
  const locked = !!action && isSignOffLocked(finding) && action.state === 'proposed';
  const approvable = !!action && offersApproval(finding) && !locked;
  const undoable = !!action && offersUndo(finding);

  // The offer sentence renders in FULL even when the button is taken away, so
  // a reader always sees exactly what Staxis would do and exactly who has to
  // say yes. Hiding it would teach a GM that Staxis withholds things.
  const suggestion = action && (approvable || locked || action.state === 'proposed') ? action.offerEn : null;

  // Which verbs are on the face, and which are behind the `···`.
  const primaryClosure = approvable || undoable ? null : (closures[0] ?? null);
  const faceClosures = approvable || undoable ? closures.slice(0, 1) : closures.slice(1, 2);
  const menuClosures = approvable || undoable ? closures.slice(1) : closures.slice(2);
  const stamp = clockStamp(finding.lastSeenAt || finding.firstSeenAt);
  const tail = [price ? seen : null, age].filter(Boolean).join(' · ');
  // Two claims, two lines, tight together. They are the SAME sentence on most
  // cards ("your last 4 HVAC invoices" both prices the fix and is the
  // evidence), so the duplicate is dropped rather than printed twice — a card
  // that says the same thing twice reads as a card that is padding. They are
  // kept on separate lines rather than joined, because `evidence.basis` is
  // sometimes a phrase and sometimes a sentence, and gluing a phrase onto the
  // end of a sentence produces a line no writer would have written.
  const provenance = [
    priceBasis ? `${L('basedOnLead')} ${priceBasis}.` : null,
    evidenceBasis && evidenceBasis !== priceBasis ? evidenceBasis : null,
  ].filter((line): line is string => !!line);

  return (
    <div
      ref={cardRef}
      data-finding-id={finding.id}
      className={`fx-ink-card${focused ? ' fx-focused' : ''}`}
    >
      <span className="fx-scan" aria-hidden />

      <div className="fx-inkhead">
        <span className="fx-badge">
          <CxIcon name="staxis" size={11} strokeWidth={2.2} />
          {L('foundBadge')}
        </span>
        <span className="fx-cat">
          {cardEyebrowLabel(finding, lang)}
          {finding.status === 'updated' ? ` · ${L('updated')}` : ''}
        </span>
        {stamp && <span className="fx-stamp">{stamp}</span>}
        {price
          ? <span className="fx-money">{price}</span>
          : seen ? <span className="fx-tally">{seen}</span> : null}
      </div>

      {/* Only ever set on a screen showing more than one hotel. */}
      {finding.hotel && <div className="fx-cat" style={{ marginTop: 9 }}>{finding.hotel.name}</div>}

      <div className="fx-headline">{cardPhrasing(finding, lang)}</div>

      {note && <div className="fx-prov">{note}</div>}

      {/* Where the number came from. A price is a RANGE with its basis
          attached, or it is not mentioned at all.
          The two bases are the SAME sentence on most cards ("your last 4 HVAC
          invoices" prices the fix and is also the evidence), so printing both
          produced "Based on your last 4 HVAC invoices. your last 4 HVAC
          invoices". The dedupe is not cosmetic: a card that says the same thing
          twice reads as a card that is padding. */}
      {provenance.map((line, index) => (
        <div className="fx-prov" key={line} style={index > 0 ? { marginTop: 2 } : undefined}>
          {line}
          {/* The hint rides the LAST line, so it always sits at the end of the
              block whichever of the two bases the card actually has. */}
          {evidenceBasis && index === provenance.length - 1
            ? <span className="fx-hintw"> {L('tapToSee')}</span>
            : null}
        </div>
      ))}

      {tail && <div className="fx-prov"><span className="fx-hintw">{tail}</span></div>}

      {suggestion && (
        <div className="fx-sugg">
          <span className="fx-suggi" aria-hidden><CxIcon name="staxis" size={14} strokeWidth={1.9} /></span>
          <span className="fx-suggt">{suggestion}</span>
        </div>
      )}

      {locked && (
        <div className="fx-inknote fx-hold">{signOffNotice(finding.signOff!, lang)}</div>
      )}
      {readOnly && (approvable || closures.length > 0) && (
        <div className="fx-inknote fx-hold">{L('readOnly')}</div>
      )}

      {/* What became of the fix. Never optimistic: the tap may honestly come
          back "I did not do that, and here is why". */}
      {undoable && <div className="fx-inknote fx-ok">{action!.receiptEn ?? ''}</div>}
      {action?.state === 'undone' && <div className="fx-inknote fx-ok">{L('undone')}</div>}
      {action?.state === 'declined_changed' && (
        <div className="fx-inknote fx-hold">{declinedExplanation(action, lang)}</div>
      )}
      {action?.state === 'failed' && <div className="fx-inknote fx-bad">{L('actionFailed')}</div>}

      {showReceipt && <Receipt finding={finding} lang={lang} ink />}

      <div className="fx-inkacts">
        {pending ? (
          <>
            <span className="fx-sure">{pending.confirm!.prompt}</span>
            <button
              type="button"
              className="fx-ib fx-warn"
              disabled={busy}
              onClick={() => { onStartConfirm(null); onVerdict(finding.id, pending.verdict); }}
            >
              {pending.confirm!.yes}
            </button>
            <button type="button" className="fx-ib" onClick={() => onStartConfirm(null)}>
              {L('cancel')}
            </button>
          </>
        ) : (
          <>
            {!readOnly && approvable && (
              <button
                type="button"
                className="fx-ib fx-go"
                disabled={busy}
                onClick={() => onAction?.(action!.id, 'execute')}
              >
                <CxIcon name="check" size={14} strokeWidth={2.4} />
                {busy ? L('working') : action!.labelEn}
              </button>
            )}
            {!readOnly && undoable && (
              <button
                type="button"
                className="fx-ib fx-go"
                disabled={busy}
                onClick={() => onAction?.(action!.id, 'undo')}
              >
                {busy ? L('undoing') : L('undo')}
              </button>
            )}
            {!readOnly && primaryClosure && (
              <button
                type="button"
                className="fx-ib fx-go"
                disabled={busy}
                title={primaryClosure.hint ?? undefined}
                onClick={() =>
                  primaryClosure.confirm ? onStartConfirm(primaryClosure.verdict) : onVerdict(finding.id, primaryClosure.verdict)
                }
              >
                {primaryClosure.label}
              </button>
            )}
            {!readOnly && faceClosures.map((b) => (
              <button
                key={b.verdict}
                type="button"
                className="fx-ib"
                disabled={busy}
                title={b.hint ?? undefined}
                onClick={() => (b.confirm ? onStartConfirm(b.verdict) : onVerdict(finding.id, b.verdict))}
              >
                {b.label}
              </button>
            ))}

            {/* Reading is the whole point of a read-only card, so this one
                control never goes away. */}
            <button
              type="button"
              className="fx-ib fx-link"
              onClick={onToggleReceipt}
              aria-expanded={showReceipt}
            >
              <CxIcon name="chart" size={14} strokeWidth={1.9} />
              {showReceipt ? L('hideNumbers') : L('theNumbers')}
            </button>

            {href && (
              <a className="fx-ib fx-link" href={href}>{hrefLabel ?? 'Open in this hotel'}</a>
            )}

            {!readOnly && menuClosures.length > 0 && (
              <>
                <button
                  type="button"
                  className="fx-ib fx-more"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  aria-label={L('moreActions')}
                  onClick={() => onToggleMenu(!menuOpen)}
                >
                  <span aria-hidden>···</span>
                </button>
                {menuOpen && (
                  <>
                    {/* Click anywhere else and the menu goes away. A menu with
                        no way out that is not one of its own items is a trap. */}
                    <button
                      type="button"
                      aria-label={L('cancel')}
                      onClick={() => onToggleMenu(false)}
                      style={{ position: 'fixed', inset: 0, zIndex: 19, background: 'transparent', border: 'none', cursor: 'default' }}
                    />
                    <div className="fx-menu" role="menu">
                      {menuClosures.map((b) => (
                        <button
                          key={b.verdict}
                          type="button"
                          role="menuitem"
                          className={b.tone === 'danger' ? 'fx-danger' : undefined}
                          disabled={busy}
                          title={b.hint ?? undefined}
                          onClick={() => {
                            onToggleMenu(false);
                            if (b.confirm) onStartConfirm(b.verdict);
                            else onVerdict(finding.id, b.verdict);
                          }}
                        >
                          {b.label}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

interface CardProps {
  finding: QueueFinding;
  lang: Lang;
  busy: boolean;
  /** True when a `?focus=` link (or a morning-brief line) named this card. */
  focused?: boolean;
  /**
   * The reader may READ this card and not decide it. Everything factual stays —
   * headline, evidence, price, the numbers, the offer sentence — and every
   * control that would change something is replaced by one line naming whose
   * call it is. A finance hat on the portfolio queue is the case this exists
   * for: `/api/company/queue` refuses her verdicts, so drawing the buttons
   * would be drawing three things that 403.
   */
  readOnly?: boolean;
  onVerdict: (findingId: string, verdict: Verdict) => void;
  /** Fired the first time this card's numbers are opened. Optional so the view
   *  can be rendered in a test without a network. */
  onEngage?: (findingId: string) => void;
  /** Approve or undo the attached fix. Optional for the same reason. */
  onAction?: (actionId: string, intent: 'execute' | 'undo') => void;
  /**
   * One quiet line under the headline, for a screen that has to say WHY this
   * card is in front of you. Only the portfolio queue passes it — a hotel's own
   * feed has one answer ("it is wrong here") and printing it would be noise.
   */
  note?: string | null;
  /** Where to go to see this card in its own hotel's feed. Portfolio only. */
  href?: string | null;
  /** "Open in this hotel", already in the reader's language. */
  hrefLabel?: string;
  /**
   * Suppress the "Seen N times since Jul 9" line.
   *
   * Set by the PORTFOLIO queue, and the reason is the founder's rule at the top
   * of src/lib/company/vp-queue.ts: "Seen silences the FEED, never the boss. A
   * GM tap must not add to, hide from, or DRESS UP the VP's view." The count
   * underneath that line is the detector's own re-sighting count rather than a
   * GM's taps — but the word on the screen is "Seen", and a boss reading "Seen 6
   * times" reads six people looking at it and doing nothing. The portfolio card
   * already answers the persistence question in its own words ("Still unresolved
   * 12 days after Staxis first saw it"), so nothing is lost by not saying it
   * twice in a sentence that invites the wrong reading.
   */
  hideOccurrence?: boolean;
  /**
   * Draw the card in INK — the /feed timeline's voice for everything Staxis
   * says, against the white rows of everything a person owes.
   *
   * Off by default, so the portfolio queue and the maintenance-patterns popup
   * render exactly what they rendered before this existed. Those screens have
   * their own chrome and their own question; the ink/paper split is an answer
   * to "which of these two lists am I looking at", which only the one list has.
   */
  ink?: boolean;
}

function FindingCard({
  finding,
  lang,
  busy,
  focused = false,
  readOnly = false,
  onVerdict,
  onEngage,
  onAction,
  note = null,
  href = null,
  hrefLabel,
  hideOccurrence = false,
  ink = false,
}: CardProps) {
  const es = false;
  const L = <K extends keyof typeof S>(k: K) => (S[k].en);

  const [showReceipt, setShowReceipt] = React.useState(false);
  // Which verdict is waiting on its second tap, if any. Keyed on the verdict
  // rather than a boolean so the confirm step belongs to the button that asked
  // for it — "Not doing this" and "Mute" are the same verdict wearing different
  // words, and a shared boolean would put one button's prompt under the other.
  const [confirming, setConfirming] = React.useState<ClosureVerdict | null>(null);
  // The ink card's `···`. One primary action per card was the founder's ruling;
  // the remaining verbs live in here rather than as four more look-alike pills.
  const [menuOpen, setMenuOpen] = React.useState(false);
  // Once per card, not once per toggle. Opening and closing the receipt three
  // times is one manager reading it, and counting three would be inventing
  // engagement out of a fidget.
  const engaged = React.useRef(false);

  const price = formatPriceRange(finding.price);
  const seen = hideOccurrence ? null : occurrenceLine(finding, lang);
  const priceBasis = basisInLang(finding.price?.basis, finding.price?.basisEs, lang);
  const evidenceBasis = basisInLang(finding.evidence.basis, finding.evidence.basisEs, lang);
  const age = dataAgeNote(finding, lang);
  const closures = closureButtons(finding, lang);
  const pending = closures.find((b) => b.verdict === confirming) ?? null;

  // Bring the linked card into view when it becomes the focused one.
  //
  // TWICE, and the second one on a TIMER. Two different arrivals, two different
  // failure modes:
  //
  //   • tapped a brief line — the page is laid out and settled. The immediate
  //     scroll is the right one and anything deferred is just latency.
  //   • followed a ?focus= link — this card mounts while the list is still
  //     growing (the fold has just been forced open, the cards below have not
  //     laid out). A scroll computed against a document that is still getting
  //     taller lands hundreds of pixels short: measured 110px against the 774px
  //     the card actually needed.
  //
  // The retry is a timer rather than requestAnimationFrame on purpose — rAF
  // does not fire in a tab that is not painting, so an rAF-only version
  // silently does nothing there. `nearest` means the retry is a no-op when the
  // first attempt already worked.
  //
  // `behavior: 'auto'` rather than 'smooth' for the same reason: smooth
  // scrolling is animation-driven and is a NO-OP wherever frames are not being
  // produced — verified, not assumed (a smooth version moved the page zero
  // pixels; the same call with 'auto' moved it 774). A jump-to-card is a
  // navigation anyway, and an instant one that always happens beats a graceful
  // one that sometimes does not.
  //
  // `nearest` rather than `center` for the same reason the rest of this app
  // uses it: on iOS Safari a centering scroll inside an already-scrolled shell
  // fights the shell's own scroll and lands nowhere.
  const ref = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!focused) return;
    const bring = () => ref.current?.scrollIntoView({ behavior: 'auto', block: 'nearest' });
    bring();
    const retry = setTimeout(bring, 150);
    return () => clearTimeout(retry);
  }, [focused]);

  if (ink) {
    return (
      <InkCard
        cardRef={ref}
        finding={finding}
        lang={lang}
        busy={busy}
        focused={focused}
        readOnly={readOnly}
        note={note}
        href={href}
        hrefLabel={hrefLabel}
        price={price}
        seen={seen}
        priceBasis={priceBasis}
        evidenceBasis={evidenceBasis}
        age={age}
        closures={closures}
        pending={pending}
        showReceipt={showReceipt}
        menuOpen={menuOpen}
        onToggleMenu={setMenuOpen}
        onStartConfirm={setConfirming}
        onToggleReceipt={() => {
          setShowReceipt((v) => {
            if (!v && !engaged.current) {
              engaged.current = true;
              onEngage?.(finding.id);
            }
            return !v;
          });
        }}
        onVerdict={onVerdict}
        onAction={onAction}
      />
    );
  }

  return (
    <div
      ref={ref}
      data-finding-id={finding.id}
      className={focused ? 'cx-dec fd-focused' : 'cx-dec'}
    >
      <div className={`cx-dchip ${severityChipClass(finding.severity)}`}>
        <CxIcon name="staxis" size={17} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="cx-dec-eyebrow">
          {cardEyebrowLabel(finding, lang)}
          {finding.status === 'updated' ? ` · ${L('updated')}` : ''}
        </div>

        {/* Which building this is about. Only ever set on a screen showing more
            than one — on a hotel's own feed every card is about the hotel the
            manager is already standing in, and labelling them all would be
            noise. */}
        {finding.hotel && <div className="fd-hotel">{finding.hotel.name}</div>}

        <div className="cx-dec-t">{cardPhrasing(finding, lang)}</div>

        {note && <div className="fd-note">{note}</div>}

        {/* A price is a RANGE with its basis attached, or it is not mentioned. */}
        {price && (
          <div className="fd-price">
            <span className="fd-pricev">{price}</span>
            {priceBasis ? (
              <span className="fd-priceb">
                {L('basedOn')} {priceBasis}
              </span>
            ) : null}
          </div>
        )}

        {/* The evidence summary — what the claim actually rests on. */}
        {evidenceBasis && (
          <div className="cx-dec-s">
            {evidenceBasis} <span style={{ color: '#A6ABA6' }}>{L('tapToSee')}</span>
          </div>
        )}

        {(seen || age) && (
          <div className="fd-meta">
            {seen && <span className="fd-metai">{seen}</span>}
            {age && <span className="fd-metai fd-age">{age}</span>}
          </div>
        )}

        {showReceipt && <Receipt finding={finding} lang={lang} />}

        <ActionRow finding={finding} lang={lang} busy={busy} readOnly={readOnly} onAction={onAction} />

        <div className="fd-acts">
          {pending ? (
            <>
              <span className="fd-sure">{pending.confirm!.prompt}</span>
              <button
                type="button"
                className="fd-act fd-danger"
                disabled={busy}
                onClick={() => onVerdict(finding.id, pending.verdict)}
              >
                {pending.confirm!.yes}
              </button>
              <button type="button" className="fd-act" onClick={() => setConfirming(null)}>
                {L('cancel')}
              </button>
            </>
          ) : (
            <>
              {/* Which buttons, in which order, with which words: all of it
                  comes from closureButtons(). Nothing about the card kind is
                  decided here — except whether the reader may decide at all.
                  "See the numbers" below always stays: reading is the whole
                  point of a read-only card. */}
              {!readOnly && closures.map((b) => (
                <button
                  key={b.verdict}
                  type="button"
                  className={toneClass(b.tone)}
                  disabled={busy}
                  title={b.hint ?? undefined}
                  onClick={() =>
                    b.confirm ? setConfirming(b.verdict) : onVerdict(finding.id, b.verdict)
                  }
                >
                  {b.label}
                </button>
              ))}

              <button
                type="button"
                className="fd-act"
                onClick={() => {
                  setShowReceipt((v) => {
                    if (!v && !engaged.current) {
                      engaged.current = true;
                      onEngage?.(finding.id);
                    }
                    return !v;
                  });
                }}
                aria-expanded={showReceipt}
              >
                {showReceipt ? L('hideNumbers') : L('seeNumbers')}
              </button>

              {/* The drill-down. A plain link, because the property switcher
                  already exists and the hotel's own feed already knows how to
                  land on one card (?focus=). */}
              {href && (
                <a className="fd-drill" href={href}>
                  {hrefLabel ?? ('Open in this hotel')}
                </a>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── The list ───────────────────────────────────────────────────────────────

export interface FindingCardsViewProps {
  findings: QueueFinding[];
  run: QueueRun | null;
  cap?: number;
  lang: Lang;
  /** True when the READ failed. Renders an honest note; an error is not an
   *  empty queue and must never be shown as one. */
  readFailed?: boolean;
  /** True when the last verdict did not save. */
  saveFailed?: boolean;
  busyId?: string | null;
  /**
   * The card a `?focus=` link (or a morning-brief line) points at. It is
   * outlined, scrolled to, and — critically — the fold OPENS for it: a link
   * that lands on a card hidden behind "show all" is a link that appears to do
   * nothing, which is worse than not offering it.
   */
  focusId?: string | null;
  /**
   * Suppress the "checked N things" line because something above already said
   * it — the morning brief ends with the same sentence, built by the same
   * function over the same run row. Two copies drift apart the moment a manager
   * silences a card (the brief is this morning's snapshot, this one is live)
   * and a manager reading two nearly identical lines with different numbers
   * reads a bug, not a nuance. The "checks couldn't run yet" note is NOT
   * suppressed: nothing else says it, and it is a different claim.
   */
  hideLiveness?: boolean;
  /** Draw every card as readable-but-not-decidable. See FindingCard.readOnly. */
  readOnly?: boolean;
  /** Optional per-card deny used by mixed-scope portfolio views. */
  readOnlyFor?: (finding: QueueFinding) => boolean;
  onVerdict: (findingId: string, verdict: Verdict) => void;
  /** Told when a manager opens a card's numbers. Counted as engagement, which
   *  is what keeps a check somebody reads from demoting itself (0362). */
  onEngage?: (findingId: string) => void;
  /** Approve or undo the fix attached to a card. */
  onAction?: (actionId: string, intent: 'execute' | 'undo') => void;
  /**
   * Two hooks the PORTFOLIO queue uses and nothing else does: the line that
   * says why a card climbed, and the link back into its hotel's own feed.
   *
   * Render props rather than fields on the card, so `finding-cards.ts` never
   * has to learn what a climb reason is — that vocabulary belongs to
   * src/lib/company/vp-queue.ts, which already imports this module and
   * therefore cannot be imported back.
   */
  noteFor?: (f: QueueFinding) => string | null;
  hrefFor?: (f: QueueFinding) => string | null;
  hrefLabel?: string;
  /** Replaces "What Staxis noticed" on a screen that is not about one hotel. */
  heading?: string;
  /**
   * What to say when there is NOTHING — no cards and no run to describe, i.e.
   * this hotel has never been checked.
   *
   * Opt-in because the two callers are in different positions. The portfolio
   * queue writes its own two empty states (it distinguishes "we looked and
   * nothing reached you" from "nothing has been checked"), so it passes
   * nothing and this component stays silent for it. The hotel queue does NOT:
   * it prints a title, a subtitle, and then whatever this component renders —
   * which was `null`, leaving the paying hotel's Staxis tab a heading over
   * blank space with no way to tell "quiet" from "never started".
   *
   * Whatever is passed must never read as an all-clear.
   */
  emptyNote?: string;
  /** True on the portfolio queue — see `hideOccurrence` on the card. */
  hideOccurrence?: boolean;
  /**
   * Extra room under the last card so the floating ask-composer cannot sit on
   * its buttons. See the note in QueueView.
   */
  bottomHeadroom?: boolean;
  /**
   * THE ONE LIST. Everything else that needs a person, ranked together with the
   * cards rather than parked in a second block underneath them.
   *
   * Absent on every findings-only caller (the portfolio queue, the maintenance
   * patterns popup) and the code path is then byte-for-byte what it was — the
   * cards' own ordering, fold and empty states are untouched by construction,
   * not by care. When present, `buildOneList` decides the interleaving and this
   * component still owns the fold, the liveness line and the empty state.
   *
   * The renderers are passed in rather than imported so this module never has
   * to learn what a to-do is; it already exports the vocabulary those rows are
   * ranked by, and importing them back would be a cycle.
   */
  interleave?: {
    items: readonly WorklistItem[];
    logEntries?: readonly LogEntryDTO[];
    /** The hotel's own dated things on the day being shown. */
    events?: readonly KnowledgeEventDTO[];
    renderItem: (item: WorklistItem) => React.ReactNode;
    renderLog?: (entry: LogEntryDTO) => React.ReactNode;
    renderEvent?: (event: KnowledgeEventDTO) => React.ReactNode;
  };
  /** The inline "+" composer row, pinned directly under the heading. */
  composer?: React.ReactNode;
  /**
   * Draw the list as the /feed TIMELINE: one vertical spine, a marker per
   * entry, findings in ink, and the day split into what is still owed (top)
   * and what has already happened (under an "Earlier today" rule).
   *
   * Off by default. The portfolio queue and the maintenance-patterns popup pass
   * nothing and get the plain stacked cards they always got — the split only
   * makes sense on a screen that is one hotel's ONE DAY.
   */
  spine?: boolean;
  /**
   * The last thing on the spine. The morning brief goes here: it is generated
   * once and then stays pinned at the bottom as the day's historical record.
   */
  tail?: React.ReactNode;
}

/**
 * What the list does when it has NOTHING: no card survived the filters and
 * there is no run to describe, i.e. this hotel has never been checked.
 *
 * It used to be an unconditional `return null`, justified in a comment saying
 * "QueueView's own do-not-read-this-as-an-all-clear block below is what the
 * manager sees". That block was deleted when QueueView's pilot-era copy was
 * rewritten — on the grounds that FindingCards owned every claim about an
 * empty queue. Each file then deferred to the other and neither said
 * anything, so the paying hotel's Staxis tab became a title over blank space:
 * a manager reads that as "nothing is wrong here", which is the one thing this
 * screen must never say about a hotel nobody has looked at.
 *
 * A caller that owns its own empty copy — the portfolio queue writes two, one
 * for "we looked and nothing reached you" and one for "nothing has been
 * checked" — passes no note and still gets silence.
 *
 * A FAILED read is never blank: the error note owns that screen, and an error
 * shown as an empty queue is the same lie in a different costume.
 *
 * Exported so this decision can be exercised without a renderer.
 */
export type BlankQueueOutcome =
  | { kind: 'cards' }
  | { kind: 'silent' }
  | { kind: 'note'; note: string };

export function blankQueueOutcome(opts: {
  readFailed: boolean;
  livenessText: string | null;
  visibleCount: number;
  emptyNote?: string;
}): BlankQueueOutcome {
  const blank = !opts.readFailed && !opts.livenessText && opts.visibleCount === 0;
  if (!blank) return { kind: 'cards' };
  const note = (opts.emptyNote ?? '').trim();
  return note ? { kind: 'note', note } : { kind: 'silent' };
}

/**
 * The screen, given data. Split from the fetching wrapper so the ordering,
 * the fold, the liveness line and the card itself can be exercised with real
 * rows and no session in the way.
 */
export function FindingCardsView({
  findings,
  run,
  cap = DAILY_CARD_CAP,
  lang,
  readFailed = false,
  saveFailed = false,
  busyId = null,
  focusId = null,
  hideLiveness = false,
  readOnly = false,
  readOnlyFor,
  onVerdict,
  onEngage,
  onAction,
  noteFor,
  hrefFor,
  hrefLabel,
  heading,
  emptyNote,
  hideOccurrence = false,
  bottomHeadroom = false,
  interleave,
  composer,
  spine = false,
  tail,
}: FindingCardsViewProps) {
  const es = false;
  const L = <K extends keyof typeof S>(k: K) => (S[k].en);
  const [showAll, setShowAll] = React.useState(false);

  const all = findings.filter(isCardRenderable);
  const ranked = rankFindings(all);
  const { visible, showFoldToggle } = focusedSplit(ranked, cap, focusId, showAll);

  // The fold is decided FIRST, over the cards alone, then the survivors are
  // interleaved. Two separate jobs kept separate: `focusedSplit` owns "which
  // cards are above the fold and does a ?focus= link force it open",
  // `buildOneList` owns "in what order does everything on screen go". Handing
  // work items to the cap would let a busy morning's to-dos push findings
  // behind "show all", which is the AI going quiet for the wrong reason.
  const merged = interleave
    ? buildOneList({
        findings: visible,
        items: interleave.items,
        logEntries: interleave.logEntries,
        events: interleave.events,
        findingCap: visible.length,
      })
    : null;
  const rows: ListRow[] = merged
    ? merged.rows
    : visible.map((f) => ({ kind: 'finding', key: `finding:${f.id}`, finding: f }));
  const split = spine ? partitionTimeline(rows) : null;

  const liveness = livenessLine(run, distinctDetectors(all), lang);
  const skipped = skippedNote(run, lang);

  const blank = blankQueueOutcome({
    readFailed,
    livenessText: liveness.text,
    // A composer counts as something on the screen: a page whose only content
    // is a "+" is not blank, and printing "nothing has been checked" above a
    // live control reads as a broken page rather than a quiet hotel.
    visibleCount: rows.length + (composer ? 1 : 0),
    emptyNote,
  });
  if (blank.kind === 'silent') return null;
  if (blank.kind === 'note') {
    return (
      <>
        <style dangerouslySetInnerHTML={{ __html: FD_CSS }} />
        <div className="fd-empty">{blank.note}</div>
      </>
    );
  }

  /** One row, drawn. Shared by the plain list and the spine. */
  const drawRow = (row: ListRow): React.ReactNode => {
    if (row.kind === 'item') return interleave?.renderItem(row.item);
    if (row.kind === 'log') return interleave?.renderLog?.(row.entry);
    if (row.kind === 'event') return interleave?.renderEvent?.(row.event);
    const f = row.finding;
    return (
      <FindingCard
        finding={f}
        lang={lang}
        busy={busyId === f.id}
        focused={focusId === f.id}
        readOnly={readOnly || readOnlyFor?.(f) === true}
        onVerdict={onVerdict}
        onEngage={onEngage}
        onAction={onAction}
        note={noteFor ? noteFor(f) : null}
        href={hrefFor ? hrefFor(f) : null}
        hrefLabel={hrefLabel}
        hideOccurrence={hideOccurrence}
        ink={spine}
      />
    );
  };

  /** The marker that sits on the spine beside a row. Three shapes, total. */
  const drawEntry = (row: ListRow) => (
    <div className={`fx-entry${row.kind === 'finding' ? ' fx-ink' : ''}`} key={row.key}>
      <div className="fx-mark" aria-hidden>
        {row.kind === 'finding' && <span className="fx-m-diamond" />}
        {row.kind === 'item' && <span className={`fx-m-open${row.item.overdue ? ' fx-late' : ''}`} />}
        {row.kind === 'event' && <span className="fx-m-event" />}
        {row.kind === 'log' && <span className="fx-m-tick" />}
      </div>
      <div className="fx-slot">{drawRow(row)}</div>
    </div>
  );

  const fold = showFoldToggle ? (
    <div className={spine ? 'fx-entry' : 'fd-fold'}>
      {spine && <div className="fx-mark" aria-hidden><span className="fx-m-tick" /></div>}
      <div className={spine ? 'fx-slot' : undefined}>
        <button
          type="button"
          className={spine ? 'fx-btn' : 'fd-act'}
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll ? L('showFewer') : `${L('showAll')} (${ranked.length})`}
        </button>
      </div>
    </div>
  ) : null;

  if (spine) {
    const owed = split?.owed ?? [];
    const past = split?.past ?? [];
    return (
      <>
        <style dangerouslySetInnerHTML={{ __html: FD_CSS }} />
        <div className="fx-lane">
          <span className="fx-spine" aria-hidden />

          {readFailed && <div className="fd-err">{L('loadFailed')}</div>}
          {saveFailed && <div className="fd-err">{L('saveFailed')}</div>}

          {owed.map(drawEntry)}

          {/* The composer sits at the bottom of what is still owed, because
              that is what adding something does: it joins the owed cluster. */}
          {composer && (
            <div className="fx-entry" style={{ marginTop: owed.length > 0 ? 14 : 0 }}>
              <div className="fx-mark" aria-hidden><span className="fx-m-add">+</span></div>
              <div className="fx-slot">{composer}</div>
            </div>
          )}

          {split?.showDivider && (
            <div className="fx-entry fx-divider">
              <div className="fx-mark" aria-hidden><span className="fx-m-tick" /></div>
              <div className="fx-slot fx-div">
                <span className="fx-divl">{L('earlier')}</span>
                <span className="fx-divr" aria-hidden />
              </div>
            </div>
          )}

          {past.map(drawEntry)}

          {fold}

          {/* The morning brief: generated once, then the bottom of the day. */}
          {tail && (
            <div className="fx-entry fx-ink">
              <div className="fx-mark" aria-hidden><span className="fx-m-diamond" /></div>
              <div className="fx-slot">{tail}</div>
            </div>
          )}

          {/* The liveness line closes the spine rather than opening it: it is
              the proof the watcher ran, and proof belongs after the evidence. */}
          {liveness.text && !hideLiveness && (
            <div className={`fd-live${liveness.kind === 'stale' ? ' fd-stale' : ''}`} style={{ marginLeft: 46 }}>
              <span className="fd-livedot" />
              <span>{liveness.text}</span>
            </div>
          )}
          {liveness.text && skipped && <div className="fd-skipped" style={{ marginLeft: 46 }}>{skipped}</div>}

          {bottomHeadroom && rows.length > 0 && <div className="fd-headroom" aria-hidden />}
        </div>
      </>
    );
  }

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: FD_CSS }} />

      {readFailed && <div className="fd-err">{L('loadFailed')}</div>}

      {liveness.text && !hideLiveness && (
        <div className={`fd-live${liveness.kind === 'stale' ? ' fd-stale' : ''}`}>
          <span className="fd-livedot" />
          <span>{liveness.text}</span>
        </div>
      )}
      {liveness.text && skipped && <div className="fd-skipped">{skipped}</div>}

      {(rows.length > 0 || composer) && (
        <div className="fd-head">
          <span className="fd-headt">{heading ?? L('heading')}</span>
        </div>
      )}

      {composer}

      {saveFailed && <div className="fd-err">{L('saveFailed')}</div>}

      {rows.map((row) => <React.Fragment key={row.key}>{drawRow(row)}</React.Fragment>)}

      {fold}

      {/* Room for the floating ask-composer to sit over nothing.
          The dock is `position: fixed` at the bottom of the viewport and it does
          not scroll; `.cx-page`'s 130px of bottom padding was not enough once
          the dock grew its suggestion chips, so the LAST card's verdict buttons
          were underneath it and unclickable at the bottom of the scroll. A
          spacer here rather than more global page padding: the overlap is a
          property of a list whose last row is interactive, and every other
          section page ends in something you do not have to press. */}
      {bottomHeadroom && rows.length > 0 && <div className="fd-headroom" aria-hidden />}
    </>
  );
}

/** What the queue read is doing, for a caller that has to say something honest
 *  about it. 'loading' is the only state a page may describe as "one moment"; the
 *  other two are already described by this component itself. */
export type QueueReadState = 'idle' | 'loading' | 'ready' | 'failed';

export function FindingCards({
  lang,
  focusId = null,
  hideLiveness = false,
  propertyId,
  bottomHeadroom = false,
  onReadState,
  interleave,
  composer,
  emptyNote,
  heading,
  spine = false,
  tail,
  showFindings = true,
}: {
  lang: Lang;
  focusId?: string | null;
  hideLiveness?: boolean;
  /**
   * Which hotel to show, when it is NOT the one the app is standing in.
   *
   * Set by a company-scope reader drilling into one of their hotels from the
   * portfolio queue (`/feed?pid=…&focus=…`). Explicit rather than relying on the
   * property switcher because a company account's `properties` list is built
   * from `accounts.property_access` — a snapshot that is legitimately EMPTY for
   * a VP whose access comes entirely from a company hat — so switching the
   * context alone would render a queue for no hotel at all. The server gates the
   * read either way: /api/findings refuses a hotel the caller cannot reach.
   */
  propertyId?: string | null;
  bottomHeadroom?: boolean;
  onReadState?: (state: QueueReadState) => void;
  /** THE ONE LIST. See FindingCardsViewProps.interleave. */
  interleave?: FindingCardsViewProps['interleave'];
  composer?: React.ReactNode;
  /**
   * Overrides the "nothing has been checked here" line. The Staxis list says
   * something different, because on that screen an empty queue is not only a
   * statement about the AI: there is also no work on it.
   */
  emptyNote?: string;
  /**
   * Overrides the section heading. Findings are manager-only, so a reader who
   * cannot be shown them must not be given a heading that announces them.
   */
  heading?: string;
  /** Draw the /feed timeline. See FindingCardsViewProps.spine. */
  spine?: boolean;
  /** The last entry on the spine. See FindingCardsViewProps.tail. */
  tail?: React.ReactNode;
  /**
   * Keep the cards off the screen without giving up the read.
   *
   * Set by the day timeline when it is anchored on a day that is NOT today.
   * A finding is what Staxis believes about the hotel RIGHT NOW, stamped with
   * the moment it noticed — putting this morning's 9:12 card under "Earlier
   * today" on next Saturday's page would be filing it on a day it did not
   * happen. The fetch is deliberately still made, so stepping back to today is
   * instant rather than a fresh wait.
   */
  showFindings?: boolean;
}) {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const hotelStanding = useActiveHotelStanding();
  const hotelId = propertyId ?? activePropertyId;
  // Gate at the FETCH, not the render: a housekeeper who opens this tab never
  // asks for findings at all, so a 403 in the logs always means something real.
  const canSee = !!user
    && hotelStanding.hotelMutationAllowed
    && !!hotelStanding.role
    && canManageTeam(hotelStanding.role);

  const { data, error, reload } = useApiResource<QueuePayload>(
    `/api/findings?propertyId=${hotelId}`,
    { enabled: canSee && !!hotelId, keepDataOnError: true },
  );

  // Reported rather than rendered here: the honest sentence for "we have not
  // finished reading yet" belongs to whichever page owns the surrounding copy,
  // and this component's own empty state is deliberately silent.
  const readState: QueueReadState = !canSee || !hotelId
    ? 'idle'
    : error
      ? 'failed'
      : data
        ? 'ready'
        : 'loading';
  // Reported through the ref hook, NOT a bare effect with onReadState in its
  // deps: this is the readState feedback edge, and a caller passing an inline
  // arrow would turn it into a render loop. See hotel-queue-keys.ts.
  useReportedValue(readState, onReadState);

  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [saveFailed, setSaveFailed] = React.useState(false);
  // Optimistically hidden after a verdict lands, so the card leaves the moment
  // the manager acts rather than after the refetch. It covers the gap until the
  // reload returns and NOTHING MORE — see the expiry below.
  const [settled, setSettled] = React.useState<Set<string>>(new Set());

  const onVerdict = React.useCallback(
    (findingId: string, verdict: Verdict) => {
      if (!hotelId) return;
      void (async () => {
        setBusyId(findingId);
        setSaveFailed(false);
        try {
          const res = await fetchWithAuth('/api/findings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ propertyId: hotelId, findingId, action: verdict }),
            timeoutMs: INTERACTIVE_ACTION_TIMEOUT_MS,
          });
          const body = await readEnvelope<{ status: string }>(res);
          if (body.error !== undefined) {
            // Never remove a card we did not actually silence — the manager
            // would believe Staxis had stopped watching when it had not.
            setSaveFailed(true);
            return;
          }
          setSettled((prev) => new Set(prev).add(findingId));
          await reload();
        } catch (e) {
          if (e instanceof SessionEndedError) throw e;
          setSaveFailed(true);
        } finally {
          setBusyId(null);
        }
      })();
    },
    [hotelId, reload],
  );

  /**
   * Approve or undo the fix attached to a card.
   *
   * The RESULT is whatever the database decided — executed, declined because
   * the facts moved, or failed — and the card re-renders from the reloaded row
   * rather than from an optimistic guess. There is deliberately NO optimistic
   * hide here (unlike a verdict): the whole promise of this layer is that the
   * tap may honestly come back "I did not do that, and here is why", and a UI
   * that had already congratulated itself would be unable to say so.
   */
  const onAction = React.useCallback(
    (actionId: string, intent: 'execute' | 'undo') => {
      if (!hotelId) return;
      const findingId =
        (data?.findings ?? []).find((f) => f.action?.id === actionId)?.id ?? actionId;
      void (async () => {
        setBusyId(findingId);
        setSaveFailed(false);
        try {
          const res = await fetchWithAuth('/api/findings/actions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ propertyId: hotelId, actionId, intent }),
            timeoutMs: INTERACTIVE_ACTION_TIMEOUT_MS,
          });
          const body = await readEnvelope<{ state: string }>(res);
          if (body.error !== undefined) setSaveFailed(true);
          // Reload either way. On a decline or a failure the row moved to a
          // state the card must show, and on success the receipt is on it.
          await reload();
        } catch (e) {
          if (e instanceof SessionEndedError) throw e;
          setSaveFailed(true);
        } finally {
          setBusyId(null);
        }
      })();
    },
    [hotelId, data, reload],
  );

  /**
   * A manager opened the numbers. Nothing about the card changes, so this is
   * deliberately fire-and-forget: no busy state, no reload, and a failure is
   * swallowed. The worst case is that a check earns its rest slightly sooner
   * than it should have, and stopping the manager's read to report a failed
   * counter write would be a far worse trade.
   */
  const onEngage = React.useCallback(
    (findingId: string) => {
      if (!hotelId) return;
      void fetchWithAuth('/api/findings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          propertyId: hotelId,
          findingId,
          action: 'receipt_opened',
        }),
        timeoutMs: INTERACTIVE_ACTION_TIMEOUT_MS,
      }).catch(() => {});
    },
    [hotelId],
  );

  // ── the optimistic hide EXPIRES ──────────────────────────────────────────
  // It only ever had one job: bridge the moment between the tap and the reload.
  // Held forever, it became a second, invisible silencer that outranked the
  // server's — escalation reuses the SAME finding row, so a problem the manager
  // silenced and that later grew serious enough to come back was filtered out
  // by its own id and never seen again on that tab. Clearing the set shortly
  // after the last verdict hands authority back to the payload, which is the
  // only thing that actually knows whether a finding is still quiet.
  React.useEffect(() => {
    if (settled.size === 0) return;
    const t = setTimeout(() => setSettled(new Set()), SETTLED_HIDE_MS);
    return () => clearTimeout(t);
  }, [settled]);

  // A person who may not read findings still gets the LIST when one is passed:
  // returning null here would take their own to-dos, the composer and the work
  // rows with it. Nothing about the findings half renders for them, because
  // `findings` is empty and the read never fired.
  if (!canSee && !interleave && !composer) return null;

  return (
    <FindingCardsView
      findings={showFindings ? (data?.findings ?? []).filter((f) => !settled.has(f.id)) : []}
      run={showFindings ? (data?.run ?? null) : null}
      cap={data?.cap ?? DAILY_CARD_CAP}
      lang={lang}
      readFailed={!!error}
      saveFailed={saveFailed}
      busyId={busyId}
      focusId={focusId}
      heading={heading}
      hideLiveness={hideLiveness}
      bottomHeadroom={bottomHeadroom}
      // Only once the read has actually landed. Passed while `data` is still
      // undefined, "nothing has been checked here" would flash on every load
      // of a hotel that IS checked — a worse lie than the silence it replaces.
      emptyNote={readState === 'ready' ? (emptyNote ?? S.neverChecked.en) : undefined}
      onVerdict={onVerdict}
      onEngage={onEngage}
      onAction={onAction}
      interleave={interleave}
      composer={composer}
      spine={spine}
      tail={tail}
    />
  );
}
