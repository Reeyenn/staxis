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
  distinctDetectors,
  formatPriceRange,
  formatShortDate,
  isCardRenderable,
  isQuiet,
  livenessLine,
  occurrenceLine,
  offersResolve,
  rankFindings,
  severityChipClass,
  severityLabel,
  skippedNote,
  splitByCap,
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

// ─── One card ───────────────────────────────────────────────────────────────

interface CardProps {
  finding: QueueFinding;
  lang: Lang;
  busy: boolean;
  onVerdict: (findingId: string, verdict: Verdict) => void;
}

function FindingCard({ finding, lang, busy, onVerdict }: CardProps) {
  const es = lang === 'es';
  const L = <K extends keyof typeof S>(k: K) => (es ? S[k].es : S[k].en);

  const [showReceipt, setShowReceipt] = React.useState(false);
  const [confirmingMute, setConfirmingMute] = React.useState(false);

  const price = formatPriceRange(finding.price);
  const seen = occurrenceLine(finding, lang);
  const age = dataAgeNote(finding, lang);
  const quiet = isQuiet(finding);

  return (
    <div className="cx-dec">
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
                onClick={() => setShowReceipt((v) => !v)}
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
  onVerdict: (findingId: string, verdict: Verdict) => void;
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
  onVerdict,
}: FindingCardsViewProps) {
  const es = lang === 'es';
  const L = <K extends keyof typeof S>(k: K) => (es ? S[k].es : S[k].en);
  const [showAll, setShowAll] = React.useState(false);

  const all = findings.filter(isCardRenderable);
  const ranked = rankFindings(all);
  const { prominent, folded } = splitByCap(ranked, cap);
  const visible = showAll ? ranked : prominent;

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

      {liveness.text && (
        <>
          <div className={`fd-live${liveness.kind === 'stale' ? ' fd-stale' : ''}`}>
            <span className="fd-livedot" />
            <span>{liveness.text}</span>
          </div>
          {skipped && <div className="fd-skipped">{skipped}</div>}
        </>
      )}

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
          onVerdict={onVerdict}
        />
      ))}

      {folded.length > 0 && (
        <div className="fd-fold">
          <button type="button" className="fd-act" onClick={() => setShowAll((v) => !v)}>
            {showAll ? L('showFewer') : `${L('showAll')} (${ranked.length})`}
          </button>
        </div>
      )}
    </>
  );
}

export function FindingCards({ lang }: { lang: Lang }) {
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
      onVerdict={onVerdict}
    />
  );
}
