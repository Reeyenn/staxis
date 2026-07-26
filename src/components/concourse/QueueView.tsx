'use client';

// ═══════════════════════════════════════════════════════════════════════════
// QueueView — the Staxis section: the AI approval queue.
//
// Honest pilot state until the live agent_nudges wiring lands: no sample
// cards, no fabricated stats, and critically no "all clear" claim. A missing
// queue connection cannot tell a manager whether decisions are pending.
//
// THREE real things live here, and NONE of them is an approval:
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
//     behalf: it reports, the manager acts, and nothing is executed from here.
//     Renders nothing when there is nothing to report AND nothing to say about
//     when we last looked.
//
// So the honest empty state below is still what a manager sees on an ordinary
// day, and it stays honest either way — a question is not an approval, a
// finding is not an approval, and clearing either clears no approval queue.
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
// ═══════════════════════════════════════════════════════════════════════════

import React from 'react';

import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { canManageTeam } from '@/lib/roles';
import { useApiResource } from '@/lib/hooks/use-api-resource';

import { CxStyle } from './concourse-css';
import { CxIcon } from './icons';
import { DripQuestionCard } from './DripQuestionCard';
import { FindingCards } from './FindingCards';
import { MorningBriefView, type BriefPayload } from './MorningBriefCard';
import { parseFocusParam } from './finding-cards';

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

export function QueueView({ lang }: { lang: 'en' | 'es' }) {
  const es = lang === 'es';
  const [focusId, setFocusId] = useFocusedFinding();

  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  // Gate at the FETCH, not the render: a housekeeper who opens this tab never
  // asks for a brief at all, so a 403 in the logs always means something real.
  const canSee = !!user && canManageTeam(user.role);

  const { data, error } = useApiResource<BriefPayload>(
    `/api/findings/brief?propertyId=${activePropertyId}`,
    { enabled: canSee && !!activePropertyId },
  );
  const brief = canSee ? data?.brief ?? null : null;

  return (
    <div className="cx-page cx-swap">
      <CxStyle />
      <div className="cx-ptitle" style={{ marginTop: 0 }}>Staxis</div>
      <div className="cx-psub">
        {es
          ? 'Las aprobaciones en vivo todavía no están conectadas para este piloto.'
          : 'Live approvals are not connected for this pilot yet.'}
      </div>

      {/* Pinned above everything. A brief line that names a card jumps to it. */}
      <MorningBriefView
        brief={brief}
        lang={lang}
        readFailed={!!error}
        onFocusFinding={setFocusId}
      />

      <FindingCards lang={lang} focusId={focusId} hideLiveness={!!brief} />

      <DripQuestionCard lang={lang} />

      <div className="cx-dec" style={{ justifyContent: 'center', textAlign: 'center' }}>
        <div style={{ padding: '18px 8px' }}>
          <div className="cx-dchip" style={{ margin: '0 auto 10px', background: 'rgba(201,150,68,.14)', color: '#8C6A33' }}>
            <CxIcon name="housekeeping" size={17} />
          </div>
          <div className="cx-dec-t">
            {es ? 'Aprobaciones no disponibles' : 'Approvals unavailable'}
          </div>
          <div className="cx-dec-s">
            {es
              ? 'No uses esta pantalla como confirmación de que todo está al día. Continúa con el proceso normal del gerente durante el piloto.'
              : 'Do not use this screen as an all-clear. Continue the normal manager approval process during the pilot.'}
          </div>
        </div>
      </div>
    </div>
  );
}
