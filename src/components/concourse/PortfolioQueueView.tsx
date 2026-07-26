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

export interface PortfolioPayload {
  scope: PortfolioScope | null;
  cards: PortfolioCard[];
  brief: PortfolioBrief | null;
  run: PortfolioRun | null;
  cap?: number;
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
  cap = DAILY_CARD_CAP,
  lang,
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
    <div className="cx-page cx-swap">
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
        hideLiveness
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
  onScope,
}: {
  lang: Lang;
  onScope?: (scope: PortfolioScope | null) => void;
}) {
  const { data, error, reload } = useApiResource<PortfolioPayload>(
    '/api/company/queue',
    { keepDataOnError: true },
  );

  const scope = data?.scope ?? null;
  React.useEffect(() => {
    if (data) onScope?.(scope);
  }, [data, scope, onScope]);

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
              body: JSON.stringify({ findingId, action: verdict }),
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

  if (!scope) return null;

  return (
    <PortfolioQueueBody
      scope={scope}
      cards={cards}
      brief={data?.brief ?? null}
      run={data?.run ?? null}
      cap={data?.cap ?? DAILY_CARD_CAP}
      lang={lang}
      readFailed={!!error}
      saveFailed={saveFailed}
      busyId={busyId}
      onVerdict={onVerdict}
      onAction={onAction}
    />
  );
}
