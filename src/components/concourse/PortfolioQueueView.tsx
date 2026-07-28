'use client';

// ═══════════════════════════════════════════════════════════════════════════
// PortfolioQueueView — the Staxis tab for somebody who owns more than one hotel.
//
// Same card, same language, same ranking as a GM's feed. Three differences, and
// each one exists because the reader's question is different:
//
//   1. EVERY CARD SAYS WHICH HOTEL. A VP reading "Room 214 has had 4 HVAC work
//      orders" without a building name is reading a riddle.
//   2. EVERY CARD SAYS WHY IT IS HERE. "Waiting for your sign-off", "Still
//      unresolved 12 days after Staxis first saw it". A portfolio queue that
//      does not answer "why am I seeing this?" trains its reader to stop asking.
//   3. EVERY HOTEL CARD LINKS BACK. One tap lands on that hotel's own feed with
//      the card focused, which is where the GM is looking at the same problem.
//
// THE EMPTY STATE IS HONEST. A company whose hotels have never been checked
// gets no brief and a sentence that says so — never "all clear across your 12
// hotels", which is a claim about having looked.
//
// Reads and writes go through /api/company/queue (service-role behind
// requireSession + the company-hat gate) — never the browser Supabase client.
// `findings` and `company_findings` are both deny-all to the browser, so a
// direct read would come back as an empty list with a 200 and this screen would
// quietly lie.
// ═══════════════════════════════════════════════════════════════════════════

import React from 'react';

import { useApiResource } from '@/lib/hooks/use-api-resource';
import {
  fetchWithAuth,
  INTERACTIVE_ACTION_TIMEOUT_MS,
  SessionEndedError,
} from '@/lib/api-fetch';
import { readEnvelope } from '@/lib/api-envelope';
import { climbReasonLine, drillDownHref, type PortfolioCard } from '@/lib/company/vp-queue';
import type { PortfolioBrief } from '@/lib/company/vp-brief';
import type { PortfolioRun } from '@/lib/company/vp-queue-server';

import { CxStyle } from './concourse-css';
import { FindingCardsView } from './FindingCards';
import { MorningBriefView } from './MorningBriefCard';
import { DAILY_CARD_CAP, type ClosureVerdict, type Lang, type QueueFinding } from './finding-cards';
import {
  portfolioRequestState,
  readWithPortfolioDeadline,
} from './portfolio-queue-request';

export interface PortfolioScope {
  organizationId: string;
  organizationName: string;
  companyRole: 'owner' | 'vp' | 'finance';
  hotelCount: number;
}

export interface PortfolioPayload {
  scope: PortfolioScope | null;
  cards: PortfolioCard[];
  brief: PortfolioBrief | null;
  run: PortfolioRun | null;
  cap?: number;
  /**
   * May this reader cast a verdict? Comes from the ROUTE, which asks the
   * caller's company hat — owner and VP act, finance reads. Absent on an older
   * server bundle, and absent means "act", which is what every payload meant
   * before this field existed.
   *
   * It is a RENDERING of the rule, not the rule: /api/company/queue refuses a
   * finance verdict again on the POST. What this field buys is that she is never
   * shown three buttons that 403.
   */
  canAct?: boolean;
}

const S = {
  heading: { en: 'Across your hotels', es: 'En tus hoteles' },
  subEmpty: {
    en: 'Nothing across your hotels has reached you this morning.',
    es: 'Nada de tus hoteles ha llegado hasta ti esta mañana.',
  },
  neverChecked: {
    en: 'None of your hotels has been checked yet. Do not read this as an all-clear.',
    es: 'Ninguno de tus hoteles ha sido revisado todavía. No lo tomes como que todo está bien.',
  },
  openHotel: { en: 'Open in this hotel', es: 'Ver en este hotel' },
  loadFailed: {
    en: 'Staxis could not read your hotels just now. Do not read this as "nothing is wrong".',
    es: 'Staxis no pudo leer tus hoteles ahora. No lo tomes como "no pasa nada".',
  },
  loading: {
    en: 'Loading your Staxis queue…',
    es: 'Cargando tu cola de Staxis…',
  },
  errorTitle: {
    en: 'Your queue did not open',
    es: 'Tu cola no se abrió',
  },
  retry: { en: 'Try again', es: 'Intentar de nuevo' },
  retrying: { en: 'Trying again…', es: 'Intentando de nuevo…' },
} as const;

const PQ_CSS = `
.pq-sub{font-size:12.5px;color:#8A9187;margin-top:4px;}
.pq-empty{margin-top:20px;border-radius:16px;border:1px solid rgba(31,35,28,.08);background:#FAFBF9;
  padding:16px 17px;font-size:13px;line-height:1.6;color:#5C625C;}
.pq-request{margin-top:20px;border-radius:16px;border:1px solid rgba(31,35,28,.08);background:#FAFBF9;
  padding:16px 17px;color:#5C625C;}
.pq-request-load{display:flex;align-items:center;gap:10px;font-family:var(--font-geist-mono),ui-monospace,monospace;
  font-size:12.5px;color:#8A9187;}
.pq-spinner{width:16px;height:16px;box-sizing:border-box;border:2px solid rgba(62,92,72,.2);
  border-top-color:#3E5C48;border-radius:50%;animation:pq-spin .75s linear infinite;flex:none;}
.pq-request-title{font-size:14px;font-weight:600;color:#1F231C;}
.pq-request-body{font-size:12.5px;line-height:1.6;margin-top:4px;max-width:620px;}
.pq-retry{min-width:44px;min-height:44px;margin-top:14px;padding:0 18px;border:0;border-radius:10px;
  background:#3E5C48;color:#fff;font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;
  font-size:13px;font-weight:600;cursor:pointer;transition:background 150ms ease-out,transform 150ms ease-out;}
.pq-retry:hover{background:#356B4C;}.pq-retry:active{transform:scale(.98);}
.pq-retry:focus-visible{outline:2px solid #3E5C48;outline-offset:2px;}
.pq-retry:disabled{opacity:.5;cursor:wait;transform:none;}
@keyframes pq-spin{to{transform:rotate(360deg);}}
@media (prefers-reduced-motion:reduce){.pq-spinner{animation:none;}.pq-retry{transition:none;}.pq-retry:active{transform:none;}}
`;

function PortfolioRequestNotice({
  lang,
  kind,
  retrying = false,
  onRetry,
}: {
  lang: Lang;
  kind: 'loading' | 'error';
  retrying?: boolean;
  onRetry?: () => void;
}) {
  const es = lang === 'es';
  if (kind === 'loading') {
    return (
      <div className="cx-page cx-swap" data-feed-state="loading">
        <CxStyle />
        <style dangerouslySetInnerHTML={{ __html: PQ_CSS }} />
        <div className="pq-request pq-request-load" role="status" aria-live="polite" aria-busy="true">
          <span className="pq-spinner" aria-hidden="true" />
          <span>{es ? S.loading.es : S.loading.en}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="cx-page cx-swap" data-feed-state="error">
      <CxStyle />
      <style dangerouslySetInnerHTML={{ __html: PQ_CSS }} />
      <div className="pq-request" role="alert">
        <div className="pq-request-title">{es ? S.errorTitle.es : S.errorTitle.en}</div>
        <div className="pq-request-body">{es ? S.loadFailed.es : S.loadFailed.en}</div>
        <button
          type="button"
          className="pq-retry"
          disabled={retrying}
          aria-busy={retrying}
          onClick={onRetry}
        >
          {retrying ? (es ? S.retrying.es : S.retrying.en) : (es ? S.retry.es : S.retry.en)}
        </button>
      </div>
    </div>
  );
}

/**
 * The screen, given data. Split from the fetching wrapper so the hotel labels,
 * the climb-reason lines, the drill-downs and the empty states can be exercised
 * with real cards and no session in the way.
 */
export function PortfolioQueueBody({
  scope,
  cards,
  brief,
  run,
  cap = DAILY_CARD_CAP,
  lang,
  canAct = true,
  readFailed = false,
  saveFailed = false,
  busyId = null,
  focusId = null,
  onVerdict,
  onAction,
}: {
  scope: PortfolioScope;
  cards: PortfolioCard[];
  brief: PortfolioBrief | null;
  run: PortfolioRun | null;
  cap?: number;
  lang: Lang;
  /** False for a finance hat: every card, every number, no verdict controls. */
  canAct?: boolean;
  readFailed?: boolean;
  saveFailed?: boolean;
  busyId?: string | null;
  focusId?: string | null;
  onVerdict: (findingId: string, verdict: ClosureVerdict) => void;
  onAction?: (actionId: string, intent: 'execute' | 'undo') => void;
}) {
  const es = lang === 'es';
  const byId = React.useMemo(
    () => new Map(cards.map((card) => [card.id, card])),
    [cards],
  );

  const noteFor = React.useCallback(
    (f: QueueFinding) => {
      const card = byId.get(f.id);
      return card ? climbReasonLine(card, lang) : null;
    },
    [byId, lang],
  );

  const hrefFor = React.useCallback(
    (f: QueueFinding) => {
      const card = byId.get(f.id);
      return card ? drillDownHref(card) : null;
    },
    [byId],
  );

  return (
    <div
      className="cx-page cx-swap"
      data-feed-state={readFailed ? 'error' : cards.length === 0 ? 'empty' : 'ready'}
    >
      <CxStyle />
      <style dangerouslySetInnerHTML={{ __html: PQ_CSS }} />

      <div className="cx-ptitle" style={{ marginTop: 0 }}>{scope.organizationName}</div>
      <div className="pq-sub">
        {es
          ? `${scope.hotelCount} ${scope.hotelCount === 1 ? 'hotel' : 'hoteles'}`
          : `${scope.hotelCount} ${scope.hotelCount === 1 ? 'hotel' : 'hotels'}`}
      </div>

      <MorningBriefView brief={brief} lang={lang} readFailed={readFailed} />

      {/* The liveness rollup is inside the brief (its last line), so the card
          list is told not to repeat it — same reasoning as the hotel queue. */}
      <FindingCardsView
        findings={cards}
        run={null}
        cap={cap}
        lang={lang}
        readFailed={readFailed}
        saveFailed={saveFailed}
        busyId={busyId}
        focusId={focusId}
        readOnly={!canAct}
        hideLiveness
        // The founder's rule at the top of vp-queue.ts: a GM tap must not add
        // to, hide from, or DRESS UP the VP's view. "Seen 6 times since Jul 9"
        // was on this screen; the climb-reason line above already answers the
        // persistence question in words that cannot be read as "six people
        // looked at this and shrugged".
        hideOccurrence
        bottomHeadroom
        heading={es ? S.heading.es : S.heading.en}
        noteFor={noteFor}
        hrefFor={hrefFor}
        hrefLabel={es ? S.openHotel.es : S.openHotel.en}
        onVerdict={onVerdict}
        onAction={onAction}
      />

      {/* Two DIFFERENT empty states, because they are two different facts.
          "We looked across your hotels and nothing reached you" is good news.
          "Nothing has been checked yet" is not news at all, and printing the
          first sentence in the second situation would be the single most
          damaging thing this screen could say. */}
      {!readFailed && cards.length === 0 && (
        <div className="pq-empty">
          {run
            ? (es ? S.subEmpty.es : S.subEmpty.en)
            : (es ? S.neverChecked.es : S.neverChecked.en)}
        </div>
      )}
      {readFailed && (
        <div className="pq-empty">{es ? S.loadFailed.es : S.loadFailed.en}</div>
      )}
    </div>
  );
}

/**
 * The fetching wrapper.
 *
 * `onReady` reports whether this person actually oversees a company, so the
 * Staxis tab can fall back to the ordinary hotel queue for everyone who does
 * not — a hotel GM, a front-desk lead, an administrator, and every single-hotel
 * account in the product today.
 */
export function PortfolioQueueView({
  lang,
  authorizationKey,
  onScope,
}: {
  lang: Lang;
  /** Exact viewer + authorization scope that owns this request and its data. */
  authorizationKey: string;
  onScope?: (scope: PortfolioScope | null) => void;
}) {
  const readPortfolio = React.useCallback(
    () => readWithPortfolioDeadline<PortfolioPayload>((signal) =>
      fetchWithAuth('/api/company/queue', {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal,
      }).then((response) => readEnvelope<PortfolioPayload>(response))),
    [],
  );
  const { data, loading, error, reload } = useApiResource<PortfolioPayload>(
    readPortfolio,
    { identityKey: authorizationKey, keepDataOnError: true },
  );

  const scope = data?.scope ?? null;
  React.useEffect(() => {
    if (data) onScope?.(scope);
  }, [data, scope, onScope]);

  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [saveFailed, setSaveFailed] = React.useState(false);
  const [settled, setSettled] = React.useState<Set<string>>(new Set());
  const [retrying, setRetrying] = React.useState(false);

  const cards = React.useMemo(
    () => (data?.cards ?? []).filter((c) => !settled.has(c.id)),
    [data, settled],
  );

  const retry = React.useCallback(() => {
    if (retrying) return;
    setRetrying(true);
    void reload().finally(() => setRetrying(false));
  }, [reload, retrying]);

  /**
   * A verdict, routed to whichever ledger the card actually lives in.
   *
   * A climbed card is a HOTEL's row and is silenced through that hotel's own
   * door — the same door its GM uses — because one problem has one row and one
   * verdict whoever is looking at it. A company card has no hotel and goes to
   * the company route. Two endpoints, one because it is the same problem the GM
   * sees and one because it is not.
   */
  const onVerdict = React.useCallback(
    (findingId: string, verdict: ClosureVerdict) => {
      const card = (data?.cards ?? []).find((c) => c.id === findingId);
      if (!card) return;
      void (async () => {
        setBusyId(findingId);
        setSaveFailed(false);
        try {
          const res = card.hotel
            ? await fetchWithAuth('/api/findings', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                propertyId: card.hotel.propertyId,
                findingId,
                action: verdict,
              }),
              timeoutMs: INTERACTIVE_ACTION_TIMEOUT_MS,
            })
            : await fetchWithAuth('/api/company/queue', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ findingId, action: verdict }),
              timeoutMs: INTERACTIVE_ACTION_TIMEOUT_MS,
            });
          const body = await readEnvelope<{ status: string }>(res);
          if (body.error !== undefined) {
            // Never remove a card we did not actually silence — the reader
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
    [data, reload],
  );

  /**
   * Approving a fix from up here goes through the HOTEL's action route, which
   * re-resolves the company's sign-off rule before it calls the database. So
   * the same gate that locks the GM's copy of this card is what admits the
   * approver's tap — one rule, one enforcement point, whichever screen it
   * arrives from.
   */
  const onAction = React.useCallback(
    (actionId: string, intent: 'execute' | 'undo') => {
      const card = (data?.cards ?? []).find((c) => c.action?.id === actionId);
      if (!card?.hotel) return;
      void (async () => {
        setBusyId(card.id);
        setSaveFailed(false);
        try {
          const res = await fetchWithAuth('/api/findings/actions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ propertyId: card.hotel!.propertyId, actionId, intent }),
            timeoutMs: INTERACTIVE_ACTION_TIMEOUT_MS,
          });
          const body = await readEnvelope<{ state: string }>(res);
          if (body.error !== undefined) setSaveFailed(true);
          await reload();
        } catch (e) {
          if (e instanceof SessionEndedError) throw e;
          setSaveFailed(true);
        } finally {
          setBusyId(null);
        }
      })();
    },
    [data, reload],
  );

  const request = portfolioRequestState({ data, loading, error });
  if (request.kind === 'loading') {
    return <PortfolioRequestNotice lang={lang} kind="loading" />;
  }
  if (request.kind === 'error') {
    return (
      <PortfolioRequestNotice
        lang={lang}
        kind="error"
        retrying={retrying}
        onRetry={retry}
      />
    );
  }
  // The parent learns this is a hotel-scoped account in an effect. Keep a
  // visible handoff state for that one render instead of briefly blanking Feed.
  if (request.kind === 'hotel') {
    return <PortfolioRequestNotice lang={lang} kind="loading" />;
  }

  const portfolio = request.data;
  if (!portfolio.scope) {
    return <PortfolioRequestNotice lang={lang} kind="error" onRetry={retry} />;
  }

  return (
    <PortfolioQueueBody
      scope={portfolio.scope}
      cards={cards}
      brief={portfolio.brief ?? null}
      run={portfolio.run ?? null}
      cap={portfolio.cap ?? DAILY_CARD_CAP}
      lang={lang}
      canAct={portfolio.canAct ?? true}
      readFailed={!!error}
      saveFailed={saveFailed}
      busyId={busyId}
      onVerdict={onVerdict}
      onAction={onAction}
    />
  );
}
