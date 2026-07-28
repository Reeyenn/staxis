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
import { fetchWithAuth, SessionEndedError } from '@/lib/api-fetch';
import { readEnvelope } from '@/lib/api-envelope';
import { climbReasonLine, drillDownHref, type PortfolioCard } from '@/lib/company/vp-queue';
import type { PortfolioBrief } from '@/lib/company/vp-brief';
import type { PortfolioRun } from '@/lib/company/vp-queue-server';

import { CxStyle } from './concourse-css';
import { FindingCardsView } from './FindingCards';
import { MorningBriefView } from './MorningBriefCard';
import { DAILY_CARD_CAP, type ClosureVerdict, type Lang, type QueueFinding } from './finding-cards';

export interface PortfolioScope {
  organizationId: string;
  organizationName: string;
  companyRole: 'owner' | 'vp' | 'finance';
  hotelCount: number;
}

export interface PortfolioCoverage {
  /** Hotels this caller is authorized to see in the selected company. */
  authorizedHotelCount: number;
  /** Authorized hotels inside this response's bounded read window. */
  attemptedHotelCount: number;
  /** Hotels whose hotel-local queue data was actually read for this response. */
  processedHotelCount: number;
  /** Authorized hotels intentionally left out of this bounded response. */
  omittedHotelCount: number;
  /** Attempted hotels whose data source did not answer completely. */
  unavailableHotelCount: number;
  /** Reproducible completion state for the deterministic company-level checks. */
  portfolioChecksStatus: 'completed' | 'held' | 'in_progress' | 'incomplete' | 'unavailable';
  /** True only when processedHotelCount covers the full authorized set. */
  complete: boolean;
}

export interface PortfolioPayload {
  scope: PortfolioScope | null;
  cards: PortfolioCard[];
  brief: PortfolioBrief | null;
  run: PortfolioRun | null;
  coverage: PortfolioCoverage | null;
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
} as const;

const PQ_CSS = `
.pq-sub{font-size:12.5px;color:#8A9187;margin-top:4px;}
.pq-coverage{margin-top:14px;border-radius:14px;border:1px solid rgba(201,150,68,.35);background:#FDFAF4;
  padding:12px 14px;font-size:12.5px;line-height:1.55;color:#5C4B2E;}
.pq-empty{margin-top:20px;border-radius:16px;border:1px solid rgba(31,35,28,.08);background:#FAFBF9;
  padding:16px 17px;font-size:13px;line-height:1.6;color:#5C625C;}
`;

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
  coverage,
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
  coverage: PortfolioCoverage;
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
  const partialCoverage = !coverage.complete
    || coverage.omittedHotelCount > 0
    || coverage.unavailableHotelCount > 0
    || (coverage.portfolioChecksStatus !== 'completed' && coverage.portfolioChecksStatus !== 'held');
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
      const href = card ? drillDownHref(card) : null;
      return href
        ? `${href}&organizationId=${encodeURIComponent(scope.organizationId)}`
        : null;
    },
    [byId, scope.organizationId],
  );

  return (
    <div className="cx-page cx-swap">
      <CxStyle />
      <style dangerouslySetInnerHTML={{ __html: PQ_CSS }} />

      <div className="cx-ptitle" style={{ marginTop: 0 }}>{scope.organizationName}</div>
      <div className="pq-sub">
        {es
          ? `${scope.hotelCount} ${scope.hotelCount === 1 ? 'hotel' : 'hoteles'}`
          : `${scope.hotelCount} ${scope.hotelCount === 1 ? 'hotel' : 'hotels'}`}
      </div>

      {partialCoverage && (
        <div className="pq-coverage" role="status">
          {es
            ? `Se leyeron datos completos de ${coverage.processedHotelCount} de ${coverage.authorizedHotelCount} hoteles. `
              + (coverage.omittedHotelCount > 0
                ? `${coverage.omittedHotelCount} ${coverage.omittedHotelCount === 1 ? 'hotel quedó fuera' : 'hoteles quedaron fuera'} del límite de esta carga. `
                : '')
              + (coverage.unavailableHotelCount > 0
                ? `${coverage.unavailableHotelCount} ${coverage.unavailableHotelCount === 1 ? 'hotel no respondió' : 'hoteles no respondieron'} por completo. `
                : '')
              + (coverage.portfolioChecksStatus === 'in_progress'
                ? 'Las comprobaciones de empresa todavía estaban en curso. '
                : coverage.portfolioChecksStatus === 'incomplete'
                  ? 'Las comprobaciones de empresa no terminaron por completo. '
                  : coverage.portfolioChecksStatus === 'unavailable'
                    ? 'No se pudo verificar el estado de las comprobaciones de empresa. '
                    : '')
              + 'No lo interpretes como cobertura completa de la empresa.'
            : `Complete data was read from ${coverage.processedHotelCount} of ${coverage.authorizedHotelCount} hotels. `
              + (coverage.omittedHotelCount > 0
                ? `${coverage.omittedHotelCount} ${coverage.omittedHotelCount === 1 ? 'hotel was' : 'hotels were'} outside this load's limit. `
                : '')
              + (coverage.unavailableHotelCount > 0
                ? `${coverage.unavailableHotelCount} ${coverage.unavailableHotelCount === 1 ? 'hotel did' : 'hotels did'} not answer completely. `
                : '')
              + (coverage.portfolioChecksStatus === 'in_progress'
                ? 'Company-level checks were still in progress. '
                : coverage.portfolioChecksStatus === 'incomplete'
                  ? 'Company-level checks did not finish completely. '
                  : coverage.portfolioChecksStatus === 'unavailable'
                    ? 'Company-level check status could not be verified. '
                    : '')
              + 'Do not read this as whole-company coverage.'}
        </div>
      )}

      {/* A portfolio brief contains whole-company rollups. Suppress it unless
          the coverage receipt proves every authorized hotel was processed. */}
      <MorningBriefView brief={partialCoverage ? null : brief} lang={lang} readFailed={readFailed} />

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
            ? partialCoverage
              ? (es
                ? `Nada de los ${coverage.processedHotelCount} hoteles procesados llegó hasta ti esta mañana.`
                : `Nothing from the ${coverage.processedHotelCount} processed hotels reached you this morning.`)
              : (es ? S.subEmpty.es : S.subEmpty.en)
            : partialCoverage
              ? (es
                ? `Ninguno de los ${coverage.processedHotelCount} hoteles procesados ha sido revisado todavía. No lo tomes como que todo está bien.`
                : `None of the ${coverage.processedHotelCount} processed hotels has been checked yet. Do not read this as an all-clear.`)
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
  organizationId,
  onScope,
}: {
  lang: Lang;
  /** Explicit picker selection. Null is allowed only for single-company fallback. */
  organizationId: string | null;
  onScope?: (scope: PortfolioScope | null | undefined) => void;
}) {
  const queueUrl = organizationId === null
    ? '/api/company/queue'
    : `/api/company/queue?organizationId=${encodeURIComponent(organizationId)}`;
  const { data, error, reload } = useApiResource<PortfolioPayload>(
    queueUrl,
    // Authorization is rechecked by every response. If that check fails, do
    // not keep a prior company's cards rendered under a stale receipt.
    { keepDataOnError: false },
  );

  const scope = data?.scope ?? null;
  const resolvedOrganizationId = scope?.organizationId ?? null;
  // A URL company change invalidates the previous scope synchronously from the
  // parent's point of view. Never leave a prior company's successful probe in
  // place while the replacement receipt is loading.
  React.useEffect(() => {
    onScope?.(undefined);
  }, [organizationId, onScope]);
  React.useEffect(() => {
    if (error) onScope?.(undefined);
    else if (data) onScope?.(scope);
  }, [data, error, scope, onScope]);

  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [saveFailed, setSaveFailed] = React.useState(false);
  const [settled, setSettled] = React.useState<Set<string>>(new Set());

  const cards = React.useMemo(
    () => (data?.cards ?? []).filter((c) => !settled.has(c.id)),
    [data, settled],
  );

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
      if (!card.hotel && !resolvedOrganizationId) return;
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
            })
            : await fetchWithAuth('/api/company/queue', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                organizationId: resolvedOrganizationId,
                findingId,
                action: verdict,
              }),
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
    [data, reload, resolvedOrganizationId],
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

  if (!scope) {
    if (!error) return null;
    return (
      <div className="cx-page cx-swap">
        <CxStyle />
        <style dangerouslySetInnerHTML={{ __html: PQ_CSS }} />
        <div className="pq-empty">{lang === 'es' ? S.loadFailed.es : S.loadFailed.en}</div>
      </div>
    );
  }

  return (
    <PortfolioQueueBody
      scope={scope}
      cards={cards}
      brief={data?.brief ?? null}
      run={data?.run ?? null}
      coverage={data?.coverage ?? {
        authorizedHotelCount: scope.hotelCount,
        attemptedHotelCount: 0,
        processedHotelCount: 0,
        omittedHotelCount: scope.hotelCount,
        unavailableHotelCount: 0,
        portfolioChecksStatus: 'unavailable',
        complete: false,
      }}
      cap={data?.cap ?? DAILY_CARD_CAP}
      lang={lang}
      canAct={data?.canAct ?? true}
      readFailed={!!error}
      saveFailed={saveFailed}
      busyId={busyId}
      onVerdict={onVerdict}
      onAction={onAction}
    />
  );
}
