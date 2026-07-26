'use client';

// ═══════════════════════════════════════════════════════════════════════════
// FindingCards — what Staxis noticed, as cards a manager can act on.
//
// THE FIVE PROMISES THIS COMPONENT KEEPS
//
//   1. Nothing chases you. No popup, no toast, no badge that must be cleared.
//      The cards sit in the Staxis tab; ignoring one costs nothing and the
//      screen never mentions it again until the numbers change.
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
//   4. "Known problem" is permanent quiet, EXCEPT escalation. Arming the
//      silencer at 4 work orders is consent to 4, not to 9. "Mute" is
//      unconditional and therefore asks first.
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
import { useApiResource } from '@/lib/hooks/use-api-resource';
import { fetchWithAuth, SessionEndedError } from '@/lib/api-fetch';
import { readEnvelope } from '@/lib/api-envelope';

import { CxIcon } from './icons';
import {
  DAILY_CARD_CAP,
  cardPhrasing,
  dataAgeNote,
  declinedExplanation,
  distinctDetectors,
  focusedSplit,
  formatPriceRange,
  formatShortDate,
  isCardRenderable,
  isQuiet,
  livenessLine,
  occurrenceLine,
  offersApproval,
  offersResolve,
  offersUndo,
  rankFindings,
  severityChipClass,
  severityLabel,
  skippedNote,
  type Lang,
  type QueueFinding,
  type QueueRun,
} from './finding-cards';

interface QueuePayload {
  findings: QueueFinding[];
  run: QueueRun | null;
  cap: number;
}

type Verdict = 'known_problem' | 'muted' | 'resolved';

// ─── Copy ───────────────────────────────────────────────────────────────────

const S = {
  heading: { en: 'What Staxis noticed', es: 'Lo que Staxis notó' },
  knownProblem: { en: 'Known problem', es: 'Ya lo sé' },
  knownProblemHint: {
    en: 'Staxis stops bringing this up — unless it gets meaningfully worse.',
    es: 'Staxis deja de mencionarlo, salvo que empeore de forma clara.',
  },
  mute: { en: 'Mute', es: 'Silenciar' },
  muteSure: {
    en: 'Staxis will stop watching this — sure?',
    es: 'Staxis dejará de vigilar esto. ¿Seguro?',
  },
  muteYes: { en: 'Yes, mute it', es: 'Sí, silenciar' },
  cancel: { en: 'Cancel', es: 'Cancelar' },
  fixed: { en: 'Fixed', es: 'Resuelto' },
  gotIt: { en: 'Got it', es: 'Entendido' },
  seeNumbers: { en: 'See the numbers', es: 'Ver los números' },
  hideNumbers: { en: 'Hide the numbers', es: 'Ocultar los números' },
  tapToSee: { en: 'Tap to see them.', es: 'Toca para verlos.' },
  basedOn: { en: 'based on', es: 'según' },
  updated: { en: 'UPDATED', es: 'ACTUALIZADO' },
  showAll: { en: 'Show all', es: 'Ver todo' },
  showFewer: { en: 'Show fewer', es: 'Ver menos' },
  asOf: { en: 'Numbers as of', es: 'Números al' },
  receiptQuery: { en: 'Check', es: 'Comprobación' },
  saveFailed: {
    en: 'That did not save. Nothing changed — try again in a moment.',
    es: 'No se guardó. Nada cambió: inténtalo de nuevo en un momento.',
  },
  loadFailed: {
    en: 'Staxis could not check just now. Do not read this as "nothing is wrong".',
    es: 'Staxis no pudo revisar ahora. No lo tomes como "no pasa nada".',
  },

  // ── the hands ──
  doIt: { en: 'Yes, do it', es: 'Sí, hazlo' },
  notNow: { en: 'Not now', es: 'Ahora no' },
  working: { en: 'Doing it…', es: 'Haciéndolo…' },
  undo: { en: 'Undo', es: 'Deshacer' },
  undoing: { en: 'Undoing…', es: 'Deshaciendo…' },
  undone: {
    en: 'Undone. Nothing was left behind.',
    es: 'Deshecho. No quedó nada.',
  },
  actionFailed: {
    en: 'That did not go through, and nothing was changed. Try again in a moment.',
    es: 'No se completó y no se cambió nada. Inténtalo de nuevo en un momento.',
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
`;

// ─── Receipt rendering ──────────────────────────────────────────────────────

/** Render one evidence value without pretending to understand its shape. */
function renderValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
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

function Receipt({ finding, lang }: { finding: QueueFinding; lang: Lang }) {
  const es = lang === 'es';
  const entries = [
    ...Object.entries(finding.evidence.values ?? {}),
    ...Object.entries(finding.evidence.params ?? {}),
  ];
  const asOf = formatShortDate(finding.asOf, lang);
  return (
    <div className="fd-rcpt">
      {entries.length === 0 ? (
        <div className="fd-rv" style={{ textAlign: 'left', fontSize: 12, color: '#8A9187' }}>
          {finding.evidence.basis}
        </div>
      ) : (
        entries.map(([k, v]) => (
          <div className="fd-rrow" key={k}>
            <span className="fd-rk">{humanKey(k)}</span>
            <span className="fd-rv">{renderValue(v)}</span>
          </div>
        ))
      )}
      <div className="fd-rfoot">
        {(es ? S.receiptQuery.es : S.receiptQuery.en)}: {finding.evidence.queryId || '—'}
        {asOf ? ` · ${es ? S.asOf.es : S.asOf.en} ${asOf}` : ''}
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
  onAction,
}: {
  finding: QueueFinding;
  lang: Lang;
  busy: boolean;
  onAction?: (actionId: string, intent: 'execute' | 'undo') => void;
}) {
  const es = lang === 'es';
  const L = <K extends keyof typeof S>(k: K) => (es ? S[k].es : S[k].en);
  const action = finding.action;
  if (!action) return null;

  if (offersApproval(finding)) {
    return (
      <>
        <div className="fd-offer">{es ? action.offerEs : action.offerEn}</div>
        <div className="fd-acts">
          <button
            type="button"
            className="fd-act fd-yes"
            disabled={busy}
            onClick={() => onAction?.(action.id, 'execute')}
          >
            {busy ? L('working') : es ? action.labelEs : action.labelEn}
          </button>
        </div>
      </>
    );
  }

  if (offersUndo(finding)) {
    return (
      <div className="fd-settled fd-done">
        <div>{(es ? action.receiptEs : action.receiptEn) ?? ''}</div>
        <button
          type="button"
          className="fd-act"
          disabled={busy}
          onClick={() => onAction?.(action.id, 'undo')}
        >
          {busy ? L('undoing') : L('undo')}
        </button>
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

interface CardProps {
  finding: QueueFinding;
  lang: Lang;
  busy: boolean;
  /** True when a `?focus=` link (or a morning-brief line) named this card. */
  focused?: boolean;
  onVerdict: (findingId: string, verdict: Verdict) => void;
  /** Fired the first time this card's numbers are opened. Optional so the view
   *  can be rendered in a test without a network. */
  onEngage?: (findingId: string) => void;
  /** Approve or undo the attached fix. Optional for the same reason. */
  onAction?: (actionId: string, intent: 'execute' | 'undo') => void;
}

function FindingCard({
  finding,
  lang,
  busy,
  focused = false,
  onVerdict,
  onEngage,
  onAction,
}: CardProps) {
  const es = lang === 'es';
  const L = <K extends keyof typeof S>(k: K) => (es ? S[k].es : S[k].en);

  const [showReceipt, setShowReceipt] = React.useState(false);
  const [confirmingMute, setConfirmingMute] = React.useState(false);
  // Once per card, not once per toggle. Opening and closing the receipt three
  // times is one manager reading it, and counting three would be inventing
  // engagement out of a fidget.
  const engaged = React.useRef(false);

  const price = formatPriceRange(finding.price);
  const seen = occurrenceLine(finding, lang);
  const age = dataAgeNote(finding, lang);
  const quiet = isQuiet(finding);

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
          {severityLabel(finding.severity, lang)}
          {finding.status === 'updated' ? ` · ${L('updated')}` : ''}
        </div>

        <div className="cx-dec-t">{cardPhrasing(finding, lang)}</div>

        {/* A price is a RANGE with its basis attached, or it is not mentioned. */}
        {price && (
          <div className="fd-price">
            <span className="fd-pricev">{price}</span>
            {finding.price?.basis ? (
              <span className="fd-priceb">
                {L('basedOn')} {finding.price.basis}
              </span>
            ) : null}
          </div>
        )}

        {/* The evidence summary — what the claim actually rests on. */}
        {finding.evidence.basis && (
          <div className="cx-dec-s">
            {finding.evidence.basis} <span style={{ color: '#A6ABA6' }}>{L('tapToSee')}</span>
          </div>
        )}

        {(seen || age) && (
          <div className="fd-meta">
            {seen && <span className="fd-metai">{seen}</span>}
            {age && <span className="fd-metai fd-age">{age}</span>}
          </div>
        )}

        {showReceipt && <Receipt finding={finding} lang={lang} />}

        <ActionRow finding={finding} lang={lang} busy={busy} onAction={onAction} />

        <div className="fd-acts">
          {confirmingMute ? (
            <>
              <span className="fd-sure">{L('muteSure')}</span>
              <button
                type="button"
                className="fd-act fd-danger"
                disabled={busy}
                onClick={() => onVerdict(finding.id, 'muted')}
              >
                {L('muteYes')}
              </button>
              <button type="button" className="fd-act" onClick={() => setConfirmingMute(false)}>
                {L('cancel')}
              </button>
            </>
          ) : (
            <>
              {/* An FYI is information, not a task. One quiet way to put it
                  away, and nothing that looks like it wants a decision. */}
              <button
                type="button"
                className={quiet ? 'fd-act' : 'fd-act fd-yes'}
                disabled={busy}
                title={L('knownProblemHint')}
                onClick={() => onVerdict(finding.id, 'known_problem')}
              >
                {quiet ? L('gotIt') : L('knownProblem')}
              </button>

              {offersResolve(finding) && (
                <button
                  type="button"
                  className="fd-act"
                  disabled={busy}
                  onClick={() => onVerdict(finding.id, 'resolved')}
                >
                  {L('fixed')}
                </button>
              )}

              {!quiet && (
                <button
                  type="button"
                  className="fd-act fd-danger"
                  disabled={busy}
                  onClick={() => setConfirmingMute(true)}
                >
                  {L('mute')}
                </button>
              )}

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
  onVerdict: (findingId: string, verdict: Verdict) => void;
  /** Told when a manager opens a card's numbers. Counted as engagement, which
   *  is what keeps a check somebody reads from demoting itself (0362). */
  onEngage?: (findingId: string) => void;
  /** Approve or undo the fix attached to a card. */
  onAction?: (actionId: string, intent: 'execute' | 'undo') => void;
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
  onVerdict,
  onEngage,
  onAction,
}: FindingCardsViewProps) {
  const es = lang === 'es';
  const L = <K extends keyof typeof S>(k: K) => (es ? S[k].es : S[k].en);
  const [showAll, setShowAll] = React.useState(false);

  const all = findings.filter(isCardRenderable);
  const ranked = rankFindings(all);
  const { visible, showFoldToggle } = focusedSplit(ranked, cap, focusId, showAll);

  const liveness = livenessLine(run, distinctDetectors(all), lang);
  const skipped = skippedNote(run, lang);

  if (!readFailed && !liveness.text && visible.length === 0) {
    // Never checked here, nothing found. Rendering nothing is the honest
    // outcome: QueueView's own "do not read this as an all-clear" block below
    // is what the manager sees, and it does not claim anything we can't back.
    return null;
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

      {visible.length > 0 && (
        <div className="fd-head">
          <span className="fd-headt">{L('heading')}</span>
        </div>
      )}

      {saveFailed && <div className="fd-err">{L('saveFailed')}</div>}

      {visible.map((f) => (
        <FindingCard
          key={f.id}
          finding={f}
          lang={lang}
          busy={busyId === f.id}
          focused={focusId === f.id}
          onVerdict={onVerdict}
          onEngage={onEngage}
          onAction={onAction}
        />
      ))}

      {showFoldToggle && (
        <div className="fd-fold">
          <button type="button" className="fd-act" onClick={() => setShowAll((v) => !v)}>
            {showAll ? L('showFewer') : `${L('showAll')} (${ranked.length})`}
          </button>
        </div>
      )}
    </>
  );
}

export function FindingCards({
  lang,
  focusId = null,
  hideLiveness = false,
}: {
  lang: Lang;
  focusId?: string | null;
  hideLiveness?: boolean;
}) {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  // Gate at the FETCH, not the render: a housekeeper who opens this tab never
  // asks for findings at all, so a 403 in the logs always means something real.
  const canSee = !!user && canManageTeam(user.role);

  const { data, error, reload } = useApiResource<QueuePayload>(
    `/api/findings?propertyId=${activePropertyId}`,
    { enabled: canSee && !!activePropertyId, keepDataOnError: true },
  );

  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [saveFailed, setSaveFailed] = React.useState(false);
  // Optimistically hidden after a verdict lands, so the card leaves the moment
  // the manager acts rather than after the refetch.
  const [settled, setSettled] = React.useState<Set<string>>(new Set());

  const onVerdict = React.useCallback(
    (findingId: string, verdict: Verdict) => {
      if (!activePropertyId) return;
      void (async () => {
        setBusyId(findingId);
        setSaveFailed(false);
        try {
          const res = await fetchWithAuth('/api/findings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ propertyId: activePropertyId, findingId, action: verdict }),
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
    [activePropertyId, reload],
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
      if (!activePropertyId) return;
      const findingId =
        (data?.findings ?? []).find((f) => f.action?.id === actionId)?.id ?? actionId;
      void (async () => {
        setBusyId(findingId);
        setSaveFailed(false);
        try {
          const res = await fetchWithAuth('/api/findings/actions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ propertyId: activePropertyId, actionId, intent }),
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
    [activePropertyId, data, reload],
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
      if (!activePropertyId) return;
      void fetchWithAuth('/api/findings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          propertyId: activePropertyId,
          findingId,
          action: 'receipt_opened',
        }),
      }).catch(() => {});
    },
    [activePropertyId],
  );

  if (!canSee) return null;

  return (
    <FindingCardsView
      findings={(data?.findings ?? []).filter((f) => !settled.has(f.id))}
      run={data?.run ?? null}
      cap={data?.cap ?? DAILY_CARD_CAP}
      lang={lang}
      readFailed={!!error}
      saveFailed={saveFailed}
      busyId={busyId}
      focusId={focusId}
      hideLiveness={hideLiveness}
      onVerdict={onVerdict}
      onEngage={onEngage}
      onAction={onAction}
    />
  );
}
