'use client';

// ═══════════════════════════════════════════════════════════════════════════
// QueueView — the Staxis section: what Staxis noticed, and what it wants a
// decision on.
//
// THREE real things live here:
//
//   MorningBriefView — six to eight lines, once a day, on the hotel's clock:
//     what happened overnight, the two or three things most worth attention,
//     anything that cleared on its own, and the line that proves the watcher
//     ran. Renders NOTHING on a hotel that has never been checked — an empty
//     morning on an unscanned hotel is not a quiet morning.
//
//   DripQuestionCard — the single question Staxis occasionally asks about a
//     pattern it noticed in the hotel's own records. Renders nothing when
//     there is nothing to ask.
//
//   FindingCards — what Staxis currently believes is wrong at this hotel,
//     biggest-dollars first, each card carrying the numbers behind it. A card
//     is a FINDING, not a decision Staxis wants to make on the manager's
//     behalf: it reports, the manager acts. Where Staxis has a fix it can
//     perform, the card carries the offer and the manager approves it.
//     Renders nothing when there is nothing to report AND nothing to say about
//     when we last looked.
//
// ─── why the brief is fetched HERE and not inside its own card ─────────────
// Both the brief and the card list end in the same sentence — "Checked 34
// things last night — 33 look normal." The brief's copy is a SNAPSHOT of this
// morning; the card list's is LIVE. The moment a manager silences the last
// card from some check, the live one moves and the snapshot does not, and the
// screen shows two nearly identical sentences with different numbers in them.
// Both are true; together they read as a bug. So this component owns the brief
// read, and when a brief is on screen the card list stops repeating its last
// line. Nothing is lost: the two lines come from the same function, over the
// same run row.
//
// ─── the ?focus= seam ──────────────────────────────────────────────────────
// Anything elsewhere in the app that knows a finding id can link here as
// /feed?focus=<id> and land the manager on that exact card: it is scrolled to
// and outlined, and if it was folded behind "show all" the fold opens for it.
// Owned HERE, in the one place that renders the cards, so a link from any
// other tab is a URL and nothing more — no cross-component reach, no second
// copy of the card list, nothing for a sibling screen to keep in sync.
//
// ─── the ?pid= seam, and the bug it closes ─────────────────────────────────
// The portfolio queue's "Open in this hotel" links here as
// /feed?pid=<hotelId>&focus=<findingId>. Nothing used to read `pid`, so the
// page re-rendered the PORTFOLIO queue — a view that never shows that card —
// and the button looked broken. Now `pid` selects the hotel, server-verified
// against /api/property-selector/bootstrap (the one read that resolves a
// reader's coverage), and `focus` lands on the card inside it. A company-scope
// reader gets an explicit way back to their portfolio, because a drill-down
// with no exit is a trap.
// ═══════════════════════════════════════════════════════════════════════════

import React from 'react';

import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { buildCompanyAccessViewerKey } from '@/lib/company-access/viewer-key';
import { canManageTeam } from '@/lib/roles';
import { useApiResource } from '@/lib/hooks/use-api-resource';

import { CxStyle } from './concourse-css';
import { DripQuestionCard } from './DripQuestionCard';
import { FindingCards, type QueueReadState } from './FindingCards';
import { MorningBriefView, type BriefPayload } from './MorningBriefCard';
import { PortfolioQueueView, type PortfolioScope } from './PortfolioQueueView';
import { parseFocusParam, parsePidParam, resolveDrillDown } from './finding-cards';
import {
  hotelFallbackState,
  portfolioScopeForViewer,
  shouldRenderQueueIdentityLoading,
  shouldRenderPortfolioProbe,
} from './portfolio-queue-request';

/** A finding id from `?focus=`, or null. Read from the URL rather than taken as
 *  a prop so any tab can deep-link here without this component knowing it
 *  exists — the link is a URL and nothing more. */
function useFocusedFinding(): [string | null, (id: string | null) => void] {
  const [focusId, setFocusId] = React.useState<string | null>(null);

  React.useEffect(() => {
    const read = () => setFocusId(parseFocusParam(window.location.search));
    read();
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, []);

  return [focusId, setFocusId];
}

/** The hotel id from `?pid=`, or null. Same seam, same reasons. */
function useRequestedHotel(): string | null {
  const [pid, setPid] = React.useState<string | null>(null);

  React.useEffect(() => {
    const read = () => setPid(parsePidParam(window.location.search));
    read();
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, []);

  return pid;
}

/**
 * The company selected by the command centre, including an intentionally
 * empty/invalid value. Validation belongs to the server; collapsing a bad
 * explicit selection to "omitted" here could make the server fall back to a
 * different company. `undefined` is only the pre-hydration state, so the
 * company probe cannot race ahead without the selection carried in the URL.
 */
function useRequestedOrganization(): string | null | undefined {
  const [organizationId, setOrganizationId] = React.useState<string | null | undefined>(undefined);

  React.useEffect(() => {
    const read = () => {
      const params = new URLSearchParams(window.location.search);
      const values = params.getAll('organizationId');
      // Keep an explicit invalid sentinel for duplicate selection rather than
      // collapsing it to the first value. Both the queue and drill-down
      // coverage routes will then reject it instead of silently choosing one.
      setOrganizationId(values.length === 0 ? null : values.length === 1 ? values[0]! : '');
    };
    read();
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, []);

  return organizationId;
}

/** Only the part of the picker payload this screen needs. */
interface CoveragePayload {
  hotels: Array<{ propertyId: string; name: string }>;
  company: { organizationName: string } | null;
}

const S = {
  // ── the honest subtitle. It replaced a pilot-era sentence claiming live
  //    approvals were not wired up yet; see the note on HotelQueue below. ──
  hotelSub: {
    en: 'What Staxis noticed here, and anything waiting on your decision.',
    es: 'Lo que Staxis notó aquí y lo que espera tu decisión.',
  },
  loading: { en: 'One moment…', es: 'Un momento…' },
  // ── the drill-down ──
  backTo: { en: 'Back to', es: 'Volver a' },
  backToPortfolio: { en: 'Back to your hotels', es: 'Volver a tus hoteles' },
  refusedTitle: { en: 'You do not cover that hotel', es: 'No tienes acceso a ese hotel' },
  refusedBody: {
    en: 'That link points at a hotel outside the ones you oversee, so Staxis did not open it.',
    es: 'Ese enlace apunta a un hotel fuera de los que supervisas, así que Staxis no lo abrió.',
  },
  unavailableTitle: { en: 'Staxis could not open that hotel', es: 'Staxis no pudo abrir ese hotel' },
  unavailableBody: {
    en: 'The check on which hotels you cover did not answer. This is not "you do not have access" — try again in a moment.',
    es: 'La comprobación de tus hoteles no respondió. Esto no significa "no tienes acceso": inténtalo de nuevo en un momento.',
  },
  // Said to somebody whose job is to READ the portfolio — a company's finance
  // lead — who followed a card into one hotel. Names whose screen it is rather
  // than implying she took a wrong turn.
  readerOnlyBody: {
    en: 'This hotel’s own queue belongs to the people who run it. Everything that reached you about it is on your company queue.',
    es: 'La cola de este hotel es de las personas que lo operan. Todo lo que llegó hasta ti sobre él está en la cola de tu empresa.',
  },
  noHotelQueueTitle: {
    en: 'The hotel findings queue is for managers',
    es: 'La cola de hallazgos del hotel es para gerentes',
  },
  noHotelQueueBody: {
    en: 'This account has no company queue and does not manage this hotel’s findings. Your assigned hotel sections are still available above.',
    es: 'Esta cuenta no tiene una cola de empresa y no administra los hallazgos de este hotel. Tus secciones asignadas siguen disponibles arriba.',
  },
} as const;

const QV_CSS = `
.qv-back{display:inline-flex;align-items:center;gap:7px;margin-top:2px;font-size:12.5px;
  font-weight:600;color:#3E5C48;text-decoration:none;}
.qv-back:hover{text-decoration:underline;text-underline-offset:3px;}
.qv-back:focus-visible{outline:2px solid #3E5C48;outline-offset:3px;border-radius:4px;}
.qv-wait{margin-top:20px;font-size:12.5px;color:#A6ABA6;
  font-family:var(--font-geist-mono),ui-monospace,monospace;}
.qv-stop{margin-top:20px;border-radius:16px;border:1px solid rgba(201,150,68,.35);background:#FDFAF4;
  padding:16px 17px;}
.qv-empty{margin-top:20px;border-radius:16px;border:1px solid rgba(31,35,28,.08);background:#FAFBF9;
  padding:16px 17px;}
.qv-stopt{font-size:14px;font-weight:600;color:#1F231C;}
.qv-stops{font-size:12.5px;color:#5C625C;line-height:1.6;margin-top:4px;}
`;

export function QueueView({ lang }: { lang: 'en' | 'es' }) {
  const es = lang === 'es';
  const L = <K extends keyof typeof S>(k: K) => (es ? S[k].es : S[k].en);

  const [focusId, setFocusId] = useFocusedFinding();
  const requestedPid = useRequestedHotel();
  const requestedOrganizationId = useRequestedOrganization();
  const portfolioHref = requestedOrganizationId === null || requestedOrganizationId === undefined
    ? '/feed'
    : `/feed?organizationId=${encodeURIComponent(requestedOrganizationId)}`;
  const coverageUrl = requestedOrganizationId === null || requestedOrganizationId === undefined
    ? '/api/property-selector/bootstrap'
    : `/api/property-selector/bootstrap?organizationId=${encodeURIComponent(requestedOrganizationId)}`;

  const { user } = useAuth();
  const {
    activePropertyId,
    properties,
    loading: propertiesLoading,
    setActivePropertyId,
  } = useProperty();

  // Stable endpoints below are still authorization-scoped resources. Include
  // both the legacy explicit grants and the server-resolved hotel set: company
  // hats can grant hotels that are absent from accounts.property_access. The
  // active hotel is part of an admin's viewer identity because their hotel
  // surfaces are an explicit preview target.
  const resolvedPropertyKey = properties.map((property) => property.id).sort().join(',');
  const viewerAuthorizationKey = user && !propertiesLoading
    ? buildCompanyAccessViewerKey({
        uid: user.uid,
        accountId: user.accountId,
        role: user.role,
        propertyAccess: user.propertyAccess,
        resolvedPropertyKey,
        adminTargetPropertyId: user.role === 'admin' ? activePropertyId : null,
      })
    : null;
  const portfolioAuthorizationKey = viewerAuthorizationKey
    && requestedOrganizationId !== undefined
    ? `${viewerAuthorizationKey}|organization:${requestedOrganizationId ?? 'omitted'}`
    : null;

  // Gate at the FETCH, not the render: a housekeeper who opens this tab never
  // asks for a HOTEL brief at all, so a 403 in the logs always means something
  // real.
  //
  // ⚠️ This is deliberately NOT the gate on the portfolio probe below, NOR on
  // the coverage read just under it. It reads `accounts.role`, and the company
  // vocabulary degrades least-privilege into that column — a `finance` hat
  // carries a legacy role of `front_desk`. Gating the probe on it meant a
  // company's finance lead mounted neither view and got a BLANK Staxis tab: the
  // picker let her in, this screen showed her nothing, and nothing on it said
  // why. The probe now runs for everybody and answers from the person's hats;
  // only the hotel brief stays manager-gated.
  const canSeeHotelBrief = !!user && canManageTeam(user.role);

  // ── who may open which hotel: asked ONLY when a link named one ────────────
  // The same read the hotel picker uses, so "which hotels do I cover" has one
  // answer in the product rather than one per screen. Not fetched at all on an
  // ordinary load, which is every load that did not come from a portfolio card.
  //
  // Gated on `!!user` and NOT on the manager role, for exactly the reason above:
  // /api/property-selector/bootstrap resolves coverage through
  // `accessibleProperties` behind `loadSessionAccount` — chosen over
  // `loadManagerCaller` precisely so a company's finance lead is not refused —
  // and asking the manager gate here would put her back in front of a screen
  // that cannot explain itself.
  const { data: coverage, error: coverageError } = useApiResource<CoveragePayload>(
    coverageUrl,
    {
      enabled: !!portfolioAuthorizationKey && !!requestedPid,
      identityKey: portfolioAuthorizationKey,
    },
  );

  // Two independent questions, asked in one place: does this reader COVER the
  // hotel (the bootstrap list), and is a hotel's own feed a screen they work on
  // (the manager gate). A finance lead answers yes and no.
  const drill = resolveDrillDown(
    requestedPid,
    coverage?.hotels,
    !!coverageError,
    canSeeHotelBrief,
  );

  // Follow the link with the whole app where we can. The context switch is
  // best-effort ON PURPOSE: a company account's `properties` list is built from
  // `accounts.property_access`, which is legitimately EMPTY for a VP whose
  // access is entirely a company hat, and setting an active hotel the list does
  // not contain would leave `activeProperty` null for every other tab. So the
  // queue below is told the hotel EXPLICITLY (it always works), and the global
  // switch happens only when it is safe.
  const openPid = drill.state === 'open' ? drill.propertyId : null;
  React.useEffect(() => {
    if (!openPid) return;
    if (openPid === activePropertyId) return;
    if (!properties.some((p) => p.id === openPid)) return;
    setActivePropertyId(openPid);
    // setActivePropertyId is stable enough in practice, and re-running this on
    // its identity would fight the guard above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPid, activePropertyId, properties]);

  // ── company-scope people get a different screen entirely ─────────────────
  // Not a variant of this one: a portfolio reader's question is "which of my
  // twelve hotels needs me", and a hotel feed cannot answer it however many
  // labels you staple on. The probe is one request that returns `scope: null`
  // for everybody without a COMPANY-scope job — every single-hotel account in
  // the product today — and those people fall straight through to the hotel
  // queue below with nothing changed.
  //
  // `undefined` means the probe has not answered yet. PortfolioQueueView owns
  // an explicit loading state during that interval rather than rendering a
  // blank page or flashing the hotel feed and swapping it out from under a VP.
  const [companyScopeSnapshot, setCompanyScopeSnapshot] = React.useState<{
    viewerKey: string;
    scope: PortfolioScope | null;
  } | null>(null);
  const companyScope = portfolioScopeForViewer(
    companyScopeSnapshot,
    portfolioAuthorizationKey,
  );
  const setCurrentCompanyScope = React.useCallback((
    scope: PortfolioScope | null | undefined,
  ) => {
    if (!portfolioAuthorizationKey) return;
    if (scope === undefined) {
      setCompanyScopeSnapshot(null);
      return;
    }
    setCompanyScopeSnapshot({ viewerKey: portfolioAuthorizationKey, scope });
  }, [portfolioAuthorizationKey]);
  // A drill-down skips the portfolio probe entirely: the expensive half of
  // /api/company/queue (the day's checks, the approver directory, sign-off per
  // proposal, judged phrasing) exists to render a screen we are not rendering.
  // The coverage read already tells us whether this reader has a company.
  const drilling = drill.state !== 'none';
  const hotelBrand = drilling ? (coverage?.company?.organizationName ?? null) : null;

  // Not fetched until the probe has said this is a hotel person. A VP would
  // otherwise pull one arbitrary hotel's morning brief on every load. The GET
  // is deterministic, but it is still work for a screen the VP does not use.
  const fallback = hotelFallbackState(companyScope, canSeeHotelBrief);
  const showPortfolioProbe = shouldRenderPortfolioProbe(companyScope);
  const isHotelPerson = !drilling && fallback === 'hotel';
  const briefFor = drill.state === 'open' ? drill.propertyId : (isHotelPerson ? activePropertyId : null);

  const { data, error } = useApiResource<BriefPayload>(
    `/api/findings/brief?propertyId=${briefFor}`,
    {
      enabled: canSeeHotelBrief && !!briefFor && !!viewerAuthorizationKey,
      identityKey: viewerAuthorizationKey,
    },
  );
  const brief = briefFor ? data?.brief ?? null : null;

  // PropertyContext intentionally masks its old hotel set before its passive
  // load effect runs. Keep that safe interval visible: mounting the portfolio
  // probe without an exact identity would risk stale tenant data, while
  // rendering nothing made a healthy bounded property load look like a stuck
  // navigation.
  if (shouldRenderQueueIdentityLoading(!!user, portfolioAuthorizationKey)) {
    return (
      <div className="cx-page cx-swap" data-feed-state="loading">
        <CxStyle />
        <style dangerouslySetInnerHTML={{ __html: QV_CSS }} />
        <div className="qv-wait" role="status" aria-live="polite" aria-busy="true">
          {L('loading')}
        </div>
      </div>
    );
  }

  if (drill.state === 'checking') {
    // Deliberately not the portfolio queue and not the hotel queue: we do not
    // yet know which one is right, and guessing then swapping is the flicker
    // this whole branch exists to avoid.
    return (
      <div className="cx-page cx-swap">
        <CxStyle />
        <style dangerouslySetInnerHTML={{ __html: QV_CSS }} />
        <div className="qv-wait">{L('loading')}</div>
      </div>
    );
  }

  if (drill.state === 'refused' || drill.state === 'unavailable') {
    const refused = drill.state === 'refused';
    return (
      <div className="cx-page cx-swap">
        <CxStyle />
        <style dangerouslySetInnerHTML={{ __html: QV_CSS }} />
        <div className="qv-stop">
          <div className="qv-stopt">{refused ? L('refusedTitle') : L('unavailableTitle')}</div>
          <div className="qv-stops">{refused ? L('refusedBody') : L('unavailableBody')}</div>
        </div>
        <div style={{ marginTop: 14 }}>
          <a className="qv-back" href={portfolioHref}>← {L('backToPortfolio')}</a>
        </div>
      </div>
    );
  }

  // The reader COVERS this hotel and still cannot open its feed — see
  // `resolveDrillDown`. A sentence and the way back, rather than the blank page
  // /api/findings' manager gate would otherwise produce.
  if (drill.state === 'not_your_screen') {
    return (
      <div className="cx-page cx-swap">
        <CxStyle />
        <style dangerouslySetInnerHTML={{ __html: QV_CSS }} />
        <div className="qv-stop">
          <div className="qv-stopt">{drill.hotelName}</div>
          <div className="qv-stops">{L('readerOnlyBody')}</div>
        </div>
        <div style={{ marginTop: 14 }}>
          <a className="qv-back" href={portfolioHref}>
            ← {hotelBrand ? `${L('backTo')} ${hotelBrand}` : L('backToPortfolio')}
          </a>
        </div>
      </div>
    );
  }

  if (drill.state === 'open') {
    return (
      <HotelQueue
        lang={lang}
        propertyId={drill.propertyId}
        hotelName={drill.hotelName}
        backLabel={hotelBrand ? `${L('backTo')} ${hotelBrand}` : L('backToPortfolio')}
        brief={brief}
        readFailed={!!error}
        focusId={focusId}
        setFocusId={setFocusId}
        backHref={portfolioHref}
      />
    );
  }

  // The portfolio view mounts for every signed-in person, reports what it
  // found, and renders itself ONLY when there is a company behind them — so for
  // the whole product as it stands today it is one cheap probe (two indexed
  // reads, no cards, no model call) that returns null and draws nothing. One
  // endpoint, and no way for the two screens to both be on the page.
  return (
    <>
      {!!portfolioAuthorizationKey && showPortfolioProbe && (
        <PortfolioQueueView
          key={portfolioAuthorizationKey}
          lang={lang}
          organizationId={requestedOrganizationId ?? null}
          authorizationKey={portfolioAuthorizationKey}
          onScope={setCurrentCompanyScope}
        />
      )}
      {isHotelPerson && (
        <HotelQueue
          lang={lang}
          propertyId={activePropertyId ?? undefined}
          brief={brief}
          readFailed={!!error}
          focusId={focusId}
          setFocusId={setFocusId}
        />
      )}
      {!drilling && fallback === 'empty' && (
        <div className="cx-page cx-swap" data-feed-state="empty">
          <CxStyle />
          <style dangerouslySetInnerHTML={{ __html: QV_CSS }} />
          <div className="qv-empty" role="status">
            <div className="qv-stopt">{L('noHotelQueueTitle')}</div>
            <div className="qv-stops">{L('noHotelQueueBody')}</div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * One hotel's feed.
 *
 * ─── WHAT THE COPY HERE USED TO CLAIM, AND WHY IT HAD TO GO ───────────────
 * The subtitle told the manager that live approvals were not wired up yet, and
 * the tail claimed approvals were unavailable and told the manager not to read
 * the screen as a clean bill of health, during "the pilot". Both were
 * written before the queue was wired and both were FALSE by the time a manager
 * read them: the cards below are live findings, and the ones Staxis can fix
 * carry a real approve button. Worse, the tail rendered while the read was
 * still in flight, so every load flashed that warning over a queue
 * that was about to appear.
 *
 * The honest replacement is smaller: say what the screen is, say "one moment"
 * while the read is in flight, and then say nothing — because FindingCards
 * already owns every claim that can be made about an empty queue, and it
 * carefully makes none on a hotel nobody has checked.
 */
function HotelQueue({
  lang,
  propertyId,
  hotelName,
  backLabel,
  brief,
  readFailed,
  focusId,
  setFocusId,
  backHref = '/feed',
}: {
  lang: 'en' | 'es';
  /** Set only on a portfolio drill-down. Absent = the hotel the app is in. */
  propertyId?: string;
  hotelName?: string;
  backLabel?: string;
  brief: BriefPayload['brief'];
  readFailed: boolean;
  focusId: string | null;
  setFocusId: (id: string | null) => void;
  backHref?: string;
}) {
  const es = lang === 'es';
  const L = <K extends keyof typeof S>(k: K) => (es ? S[k].es : S[k].en);
  const [readState, setReadState] = React.useState<QueueReadState>('idle');

  return (
    <div
      className="cx-page cx-swap"
      data-feed-state={
        readState === 'failed'
          ? 'error'
          : readState === 'ready'
            ? 'ready'
            : 'loading'
      }
    >
      <CxStyle />
      <style dangerouslySetInnerHTML={{ __html: QV_CSS }} />

      {/* The way out of a drill-down, above the title, where a back control
          belongs. A company reader who tapped a card in their portfolio queue
          must be able to get back to it without the browser button. */}
      {backLabel && (
        <div style={{ marginBottom: 6 }}>
          <a className="qv-back" href={backHref}>← {backLabel}</a>
        </div>
      )}

      <div className="cx-ptitle" style={{ marginTop: 0 }}>{hotelName ?? 'Staxis'}</div>
      <div className="cx-psub">{L('hotelSub')}</div>

      {/* Pinned above everything. A brief line that names a card jumps to it. */}
      <MorningBriefView
        brief={brief}
        lang={lang}
        readFailed={readFailed}
        onFocusFinding={setFocusId}
      />

      <FindingCards
        key={propertyId ?? 'no-property'}
        lang={lang}
        propertyId={propertyId}
        focusId={focusId}
        hideLiveness={!!brief}
        bottomHeadroom
        onReadState={setReadState}
      />

      {/* A neutral wait, and nothing else. It says only that we have not
          finished reading — never "unavailable", which is a claim about the
          system, and never a clean bill of health, which is the claim that
          would actually cost somebody money. */}
      {readState === 'loading' && <div className="qv-wait">{L('loading')}</div>}

      <DripQuestionCard key={propertyId ?? 'no-property'} lang={lang} propertyId={propertyId} />
    </div>
  );
}
