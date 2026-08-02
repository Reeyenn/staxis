'use client';

// ═══════════════════════════════════════════════════════════════════════════
// StaxisList — the one list, wired up.
//
// This is the page they run the hotel on. Everything that needs a person is
// here, in one order, with no lanes, no tags and no filters: the AI's findings,
// to-dos somebody was handed, due reminders, complaints, work orders, rooms
// waiting on an inspection, preventive work, and decisions waiting on a
// manager. Plus, if this person switched it on, the log book.
//
// ─── same page, sized to the person ────────────────────────────────────────
// There is ONE component and one page. What differs is what the reads return:
//
//   owner / VP / GM     findings + approvals + the whole hotel's work + theirs
//   front desk          their work. No findings, no money, no approvals.
//   maintenance         their work, to-dos only.
//   housekeeping        NOT THIS PAGE AT ALL. They work from the housekeeping
//                       board, and this screen never renders for them.
//
// None of that is branching in here. `canSeeFindings` gates the findings FETCH
// (the same manager gate /api/findings enforces), and /api/worklist already
// narrows its own sources by role and by viewer. A role lens is not re-derived
// here; there would then be two of them.
//
// ─── what this file does NOT own ───────────────────────────────────────────
// The ORDER (lib/feed/one-list.ts), the SENTENCES (lib/feed/one-list-copy.ts),
// and the ROWS (list-rows.tsx) are all elsewhere and all pure, so each is
// testable without a browser. This file is fetches, state, and writes.
// ═══════════════════════════════════════════════════════════════════════════

import React from 'react';
import dynamic from 'next/dynamic';

import { useAuth } from '@/contexts/AuthContext';
import { useApiResource } from '@/lib/hooks/use-api-resource';
import { fetchWithAuth, INTERACTIVE_ACTION_TIMEOUT_MS, SessionEndedError } from '@/lib/api-fetch';
import { reportCompanionFlow } from '@/components/companion/companion-events';
import { readEnvelope } from '@/lib/api-envelope';
import type { LogEntryDTO } from '@/lib/comms/types';
import type { AssignedByMeItem, WorklistItem } from '@/lib/worklist/types';
import type { FeedPrefs } from '@/lib/feed/prefs';
import { emptyListNote } from '@/lib/feed/one-list-copy';

import type { KnowledgeEventDTO } from '@/lib/knowledge/types';

import { FindingCards, type QueueReadState } from './FindingCards';
import { KnowsPanel } from './KnowsView';

// Loaded on first open, not on every /feed load. The popup's pane pulls in the
// Communications design layer AND three next/font families (13 faces), and Next
// emits a preload link for every one of them on any route in whose module graph
// they appear. On /feed those fonts are never used and the popup is rarely
// opened, so all of it was being paid for by everybody, on every visit, for
// nothing. Same shape as the inventory overlays.
const LogbookPopup = dynamic(
  () => import('./LogbookPopup').then((m) => m.LogbookPopup),
  { ssr: false, loading: () => null },
);
import {
  CalendarView,
  WeekStrip,
  dayOf,
  dayStamp,
  dayTitle,
  isoDay,
  weekCells,
  weekRangeLabel,
} from './list-calendar';
import { CxIcon } from './icons';
import { EventEditor } from '@/app/communications/_components/CalendarPane';
import {
  AssignedRailPanel,
  ComposerView,
  EventRowView,
  KnowsRailButton,
  LIST_CSS,
  LogRowView,
  LogbookRailPanel,
  WorkRowView,
  composerDefaults,
  composerPayload,
  type ComposerPerson,
  type ComposerState,
} from './list-rows';

export interface StaxisListProps {
  propertyId: string;
  lang: 'en' | 'es';
  focusId: string | null;
  onReadState?: (state: QueueReadState) => void;
  /** Manager+ only. Gates the findings FETCH, not just the render. */
  canSeeFindings: boolean;
  /** The hotel's name, for the day header's context line. */
  hotelName?: string | null;
  /**
   * The morning brief, already built by QueueView (which owns the read, so the
   * brief and the liveness line cannot drift apart). Rendered as the LAST entry
   * on the spine: it is where the day started.
   */
  brief?: React.ReactNode;
}

export function StaxisList({
  propertyId, lang, focusId, onReadState, canSeeFindings, hotelName = null, brief,
}: StaxisListProps) {
  const { user } = useAuth();

  // ── the work ─────────────────────────────────────────────────────────────
  const { data: worklist, reload: reloadWorklist } = useApiResource<{
    items: WorklistItem[];
    notices: AssignedByMeItem[];
  }>(
    `/api/worklist?pid=${propertyId}`,
    { enabled: !!propertyId, pollMs: 60_000, keepDataOnError: true },
  );
  const items = React.useMemo(() => worklist?.items ?? [], [worklist]);
  const notices = React.useMemo(() => worklist?.notices ?? [], [worklist]);

  // Re-read the wall clock every time the work refetches, rather than once at
  // mount. A front-desk terminal left open overnight would otherwise keep
  // rendering "due today" and "3 days late" against yesterday's clock, and the
  // people most likely to leave a tab open all day are exactly the people this
  // screen is for. `worklist` is the dependency ON PURPOSE and is not used in
  // the body: it is the 60-second poll, which is the cheapest tick available
  // and is already the moment every date on the screen can change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = React.useMemo(() => new Date(), [worklist]);
  const todayIso = React.useMemo(() => localIso(now), [now]);

  // ── this person's switches ───────────────────────────────────────────────
  const { data: prefsData, reload: reloadPrefs } = useApiResource<{ prefs: FeedPrefs }>(
    `/api/feed/prefs?pid=${propertyId}`,
    { enabled: !!propertyId, keepDataOnError: true },
  );
  const logbookInList = prefsData?.prefs.logbookInList === true;

  // Always read now, not only when the merge switch is on: the rail's log-book
  // panel shows today's notes on its face, which was the point of making it a
  // PANEL rather than a button. The switch below still decides whether those
  // notes also become rows on the timeline.
  const { data: logData } = useApiResource<{ entries: LogEntryDTO[] }>(
    `/api/comms/logbook?pid=${propertyId}`,
    { enabled: !!propertyId, pollMs: 120_000, keepDataOnError: true },
  );
  // Bounded on purpose: the log book is a place you go. Merging every note
  // ever written into the list would bury the work under the diary.
  const logEntries = React.useMemo(() => (logbookInList ? (logData?.entries ?? []).slice(0, 5) : []), [logbookInList, logData]);
  // What the rail panel shows: today's notes, whatever the switch says.
  const railLog = React.useMemo(
    () => (logData?.entries ?? []).filter((e) => localIso(new Date(e.createdAt)) === todayIso),
    [logData, todayIso],
  );

  // ── who a task can go to, and who I am ───────────────────────────────────
  // Housekeepers are already absent from what this returns; the exclusion lives
  // server-side in listAssignees so it holds however the list is reached, not
  // just in this dropdown. See HOUSEKEEPER_NOTE in list-rows.tsx.
  const { data: assignees } = useApiResource<{ me: { staffId: string }; people: ComposerPerson[] }>(
    `/api/worklist?pid=${propertyId}&view=assignees`,
    { enabled: !!propertyId, keepDataOnError: true },
  );
  const people = React.useMemo(() => assignees?.people ?? [], [assignees]);
  const meStaffId = assignees?.me.staffId ?? null;

  // ── local state ──────────────────────────────────────────────────────────
  const [busyRow, setBusyRow] = React.useState<string | null>(null);
  const [reasonFor, setReasonFor] = React.useState<string | null>(null);
  const [reasonDraft, setReasonDraft] = React.useState('');
  const [rowError, setRowError] = React.useState<string | null>(null);

  const [composerOpen, setComposerOpen] = React.useState(false);
  const [composer, setComposer] = React.useState<ComposerState>(() => composerDefaults(todayIso, now.getDay()));
  const [composerBusy, setComposerBusy] = React.useState(false);
  const [composerError, setComposerError] = React.useState<string | null>(null);

  // ── which day the timeline is showing ────────────────────────────────────
  // The `List` / `Calendar` toggle is gone (2026-08-01). The week strip in the
  // day header is the ambient calendar and is always on screen; the MONTH grid
  // opens over it. Clicking a day in either re-anchors this list.
  const [anchorIso, setAnchorIso] = React.useState<string>(() => isoDay(now));
  const [monthOpen, setMonthOpen] = React.useState(false);
  const [month, setMonth] = React.useState<{ year: number; monthIndex: number }>(
    () => ({ year: now.getFullYear(), monthIndex: now.getMonth() }),
  );
  const [addingEvent, setAddingEvent] = React.useState(false);

  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [logbookOpen, setLogbookOpen] = React.useState(false);
  // Knows is an overlay, not a route and not a tab. The page stays mounted
  // behind it, so it is never somewhere you have to navigate back from.
  const [knowsOpen, setKnowsOpen] = React.useState(false);
  // Reported up by the panel the first time it reads. Never guessed: until
  // Knows has actually answered, the rail button says nothing about how much
  // Staxis knows rather than printing a number it has not been told.
  const [factCount, setFactCount] = React.useState<number | null>(null);

  const isToday = anchorIso === todayIso;

  // ── ?view= opens the thing the link named ────────────────────────────────
  // The dashboard's "Go to Log Book" and "Go to Calendar" buttons point here.
  // Without this they landed on the plain queue: the calendar and the log book
  // live in local state only, so the destination was reachable by button but
  // not by link, and a link that visibly does nothing reads as broken.
  //
  // Read in an effect rather than during render, for the same reason the tab
  // does one level up: useSearchParams would force a Suspense boundary, and
  // touching window during render is a hydration mismatch.
  React.useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const v = params.get('view');
      if (v === 'calendar') setMonthOpen(true);
      else if (v === 'logbook') setLogbookOpen(true);
      // ?tab=knows used to select a TAB on this page. The tab is gone; the
      // link still has to land somebody on what Staxis knows, so it opens the
      // panel instead. The old Communications Knowledge and Contacts screens
      // still redirect here.
      if (params.get('tab') === 'knows') setKnowsOpen(true);
    } catch { /* no search params available — keep the defaults */ }
  }, []);
  const [mergeBusy, setMergeBusy] = React.useState(false);
  const [mergeError, setMergeError] = React.useState<string | null>(null);

  const { data: assignedData, error: assignedError, reload: reloadAssigned } =
    useApiResource<{ assigned: AssignedByMeItem[] }>(
      `/api/worklist?pid=${propertyId}&view=assigned-by-me`,
      { enabled: !!propertyId && drawerOpen, keepDataOnError: true },
    );

  // The hotel's own dated events. Fetched on every load now, not only when a
  // calendar was open: the week strip is permanent chrome and a 2pm vendor
  // visit is a timeline row, so "is anything on today" is a question this page
  // always has to answer.
  const { data: eventData, reload: reloadEvents } = useApiResource<{ events: KnowledgeEventDTO[] }>(
    `/api/knowledge/events?pid=${propertyId}`,
    { enabled: !!propertyId, keepDataOnError: true },
  );
  const events = React.useMemo(() => eventData?.events ?? [], [eventData]);

  // ── writes ───────────────────────────────────────────────────────────────
  const settle = React.useCallback(
    (item: WorklistItem, outcome: 'done' | 'cant', reason?: string) => {
      void (async () => {
        setBusyRow(item.id);
        setRowError(null);
        try {
          const res = await fetchWithAuth('/api/worklist/complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              pid: propertyId,
              sourceType: item.sourceType,
              sourceId: item.sourceId,
              outcome,
              ...(reason ? { reason } : {}),
            }),
            timeoutMs: INTERACTIVE_ACTION_TIMEOUT_MS,
          });
          const envelope = await readEnvelope<{ completed: boolean }>(res);
          if (envelope.error !== undefined) {
            // Never drop a row we did not actually settle. The person would
            // believe the work was recorded when it was not.
            setRowError('That did not save. Nothing changed. Try again in a moment.');
            return;
          }
          setReasonFor(null);
          setReasonDraft('');
          await reloadWorklist();
          if (drawerOpen) await reloadAssigned();
        } catch (e) {
          if (e instanceof SessionEndedError) throw e;
          setRowError('That did not save. Nothing changed. Try again in a moment.');
        } finally {
          setBusyRow(null);
        }
      })();
    },
    [propertyId, reloadWorklist, reloadAssigned, drawerOpen],
  );

  const submitComposer = React.useCallback(() => {
    const payload = composerPayload(composer, meStaffId);
    if (!payload) return;
    void (async () => {
      setComposerBusy(true);
      setComposerError(null);
      try {
        const res = await fetchWithAuth('/api/comms/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pid: propertyId, ...payload }),
          timeoutMs: INTERACTIVE_ACTION_TIMEOUT_MS,
        });
        const envelope = await readEnvelope<{ id?: string; templateId?: string }>(res);
        if (envelope.error !== undefined) {
          setComposerError(envelope.error || 'That did not save. Try again in a moment.');
          return;
        }
        setComposer(composerDefaults(todayIso, now.getDay()));
        setComposerOpen(false);
        // Somebody just wrote a task by hand that they could have asked for in
        // a sentence. Fired AFTER the composer closes and only on success, so
        // the tip never lands as an obstacle and never follows a failed save.
        // The companion decides whether to say anything; it will say it at most
        // once, ever. See decideTeachMoment.
        reportCompanionFlow('create_task');
        await reloadWorklist();
      } catch (e) {
        if (e instanceof SessionEndedError) throw e;
        setComposerError('That did not save. Try again in a moment.');
      } finally {
        setComposerBusy(false);
      }
    })();
  }, [composer, propertyId, reloadWorklist, meStaffId, todayIso, now]);

  /** Opening the drawer IS having seen it. Stamp, then let the poll clear the
   *  strip. Fire and forget: a failed stamp costs one repeated line, and
   *  blocking the drawer on a preference write would be the worse trade. */
  const openDrawer = React.useCallback(() => {
    setDrawerOpen(true);
    if (notices.length === 0) return;
    void (async () => {
      try {
        await fetchWithAuth('/api/feed/prefs', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pid: propertyId, markAssignedSeen: true }),
          timeoutMs: INTERACTIVE_ACTION_TIMEOUT_MS,
        });
        await reloadWorklist();
      } catch (e) {
        if (e instanceof SessionEndedError) throw e;
      }
    })();
  }, [notices.length, propertyId, reloadWorklist]);

  const removeEvent = React.useCallback((ev: KnowledgeEventDTO) => {
    void (async () => {
      try {
        const res = await fetchWithAuth(
          `/api/knowledge/events?pid=${encodeURIComponent(propertyId)}&id=${encodeURIComponent(ev.id)}`,
          { method: 'DELETE', timeoutMs: INTERACTIVE_ACTION_TIMEOUT_MS },
        );
        const envelope = await readEnvelope<{ deleted: boolean }>(res);
        if (envelope.error !== undefined) {
          setRowError('That event was not removed. Nothing changed.');
          return;
        }
        await reloadEvents();
      } catch (e) {
        if (e instanceof SessionEndedError) throw e;
        setRowError('That event was not removed. Nothing changed.');
      }
    })();
  }, [propertyId, reloadEvents]);

  const closeLogbook = React.useCallback(() => setLogbookOpen(false), []);
  const openLogbook = React.useCallback(() => setLogbookOpen(true), []);

  const toggleMerge = React.useCallback((next: boolean) => {
    void (async () => {
      setMergeBusy(true);
      setMergeError(null);
      try {
        const res = await fetchWithAuth('/api/feed/prefs', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pid: propertyId, logbookInList: next }),
          timeoutMs: INTERACTIVE_ACTION_TIMEOUT_MS,
        });
        const envelope = await readEnvelope<{ prefs: FeedPrefs }>(res);
        if (envelope.error !== undefined) {
          setMergeError('That switch did not save. Try again in a moment.');
          return;
        }
        await reloadPrefs();
      } catch (e) {
        if (e instanceof SessionEndedError) throw e;
        setMergeError('That switch did not save. Try again in a moment.');
      } finally {
        setMergeBusy(false);
      }
    })();
  }, [propertyId, reloadPrefs]);

  // ── render ───────────────────────────────────────────────────────────────
  const meName = user?.displayName ?? 'You';

  // One renderer, both views. A to-do has to look like the same object whether
  // it is in the list or on a Tuesday.
  const renderItem = (item: WorklistItem) => (
    <WorkRowView
      item={item}
      now={now}
      busy={busyRow === item.id}
      askingReason={reasonFor === item.id}
      reasonDraft={reasonDraft}
      onDone={(i) => settle(i, 'done')}
      onAskReason={(i) => { setReasonFor(i.id); setReasonDraft(''); }}
      onReasonChange={setReasonDraft}
      onCantSubmit={(i) => settle(i, 'cant', reasonDraft.trim())}
      onCancelReason={() => { setReasonFor(null); setReasonDraft(''); }}
    />
  );

  const stepMonth = (delta: number) => setMonth((m) => {
    const d = new Date(m.year, m.monthIndex + delta, 1);
    return { year: d.getFullYear(), monthIndex: d.getMonth() };
  });

  /** Re-anchor the whole page on a day. The title, the context line and the
   *  spine all follow, from either the week strip or the month grid. */
  const anchorOn = React.useCallback((iso: string) => {
    setAnchorIso(iso);
    setMonthOpen(false);
    const d = new Date(`${iso}T12:00:00`);
    if (!Number.isNaN(d.getTime())) setMonth({ year: d.getFullYear(), monthIndex: d.getMonth() });
  }, []);

  const stepWeek = (delta: number) => {
    const d = new Date(`${anchorIso}T12:00:00`);
    d.setDate(d.getDate() + delta * 7);
    anchorOn(isoDay(d));
  };

  // ── what belongs on the day being shown ──────────────────────────────────
  // TODAY is the live page and shows everything still open, however old — the
  // late fire-extinguisher check from Tuesday is the first thing anybody needs
  // to see on Thursday, and hiding it behind its own date would be the bug.
  // ANY OTHER DAY shows only what that day names, which is what a person means
  // when they click Saturday.
  const dayItems = React.useMemo(
    () => (isToday ? items : items.filter((it) => dayOf(it) === anchorIso)),
    [isToday, items, anchorIso],
  );
  const dayEvents = React.useMemo(
    () => events.filter((ev) => anchorIso >= ev.eventDate && anchorIso <= (ev.endDate ?? ev.eventDate)),
    [events, anchorIso],
  );
  const cells = React.useMemo(
    () => weekCells(anchorIso, todayIso, items, events),
    [anchorIso, todayIso, items, events],
  );

  const context = [
    dayStamp(anchorIso),
    hotelName,
  ].filter(Boolean).join(' · ');

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: LIST_CSS }} />

      {/* ── the day header ── */}
      <div className="fx-head">
        <div>
          <h1 className="fx-day">{dayTitle(anchorIso)}</h1>
          <div className="fx-context">{context}</div>
        </div>

        <div className="fx-headr">
          <div className="fx-cal">
            <button type="button" className="fx-step" aria-label="Previous week" onClick={() => stepWeek(-1)}>
              <CxIcon name="back" size={12} />
            </button>
            <span className="fx-range">{weekRangeLabel(cells)}</span>
            <button type="button" className="fx-step" aria-label="Next week" onClick={() => stepWeek(1)}>
              <CxIcon name="forward" size={12} />
            </button>
            <span className="fx-vrule" aria-hidden />
            <button
              type="button"
              className="fx-month"
              aria-expanded={monthOpen}
              onClick={() => setMonthOpen((v) => !v)}
            >
              <CxIcon name="calendar" size={13} />
              Month
            </button>
          </div>

          <WeekStrip cells={cells} selectedIso={anchorIso} onSelectDay={anchorOn} />

          {monthOpen && (
            <div className="fx-monthpop">
              <CalendarView
                year={month.year}
                monthIndex={month.monthIndex}
                todayIso={todayIso}
                selectedIso={anchorIso}
                items={items}
                events={events}
                onSelectDay={anchorOn}
                onStepMonth={stepMonth}
                renderItem={renderItem}
                canManageEvents={canSeeFindings}
                onDeleteEvent={removeEvent}
                onAddEvent={() => { setMonthOpen(false); setAddingEvent(true); }}
                gridOnly
              />
            </div>
          )}
        </div>
      </div>

      {/* ── the two lanes ── */}
      <div className="fx-body">
        <div>
          {rowError && <div className="sl-err">{rowError}</div>}

          {addingEvent && canSeeFindings && (
            <div style={{ marginBottom: 14 }}>
              <EventEditor
                pid={propertyId}
                L={IDENTITY_COPY}
                onDone={async () => { setAddingEvent(false); await reloadEvents(); }}
                onCancel={() => setAddingEvent(false)}
              />
            </div>
          )}

          <FindingCards
            key={propertyId}
            lang={lang}
            propertyId={propertyId}
            focusId={focusId}
            // The brief in the tail already ends in the same sentence, built by
            // the same function over the same run row. Two copies drift the
            // moment a card is silenced, and a manager reading two nearly
            // identical lines with different numbers reads a bug.
            hideLiveness
            bottomHeadroom
            spine
            onReadState={onReadState}
            // "What Staxis noticed" is a manager's heading, and findings are
            // manager-only. A front-desk clerk sees this same list for their own
            // to-dos and nothing Staxis noticed, so the default heading described
            // a half of the screen they cannot be shown, over rows they typed
            // themselves.
            heading={canSeeFindings ? undefined : 'What needs doing'}
            emptyNote={emptyListNote({ canSeeFindings })}
            // Both belong to TODAY. The brief is this morning's record and a
            // finding is what Staxis believes right now; neither happened on
            // the Saturday somebody just clicked.
            showFindings={isToday}
            tail={isToday ? brief : null}
            composer={(
              <ComposerView
                open={composerOpen}
                state={composer}
                people={people}
                busy={composerBusy}
                error={composerError}
                onOpen={() => setComposerOpen(true)}
                onCancel={() => { setComposerOpen(false); setComposerError(null); }}
                onChange={setComposer}
                onSubmit={submitComposer}
              />
            )}
            interleave={{
              items: dayItems,
              // The log book and the AI's findings are both about NOW. On any
              // day but today the page is a dated list, and pinning today's
              // notes under Saturday would be filing them on the wrong day.
              logEntries: isToday ? logEntries : [],
              events: dayEvents,
              renderItem,
              renderLog: (entry) => <LogRowView entry={entry} onOpen={openLogbook} />,
              renderEvent: (event) => (
                <EventRowView
                  event={event}
                  meta={eventMeta(event)}
                  canManage={canSeeFindings}
                  onRemove={removeEvent}
                />
              ),
            }}
          />
        </div>

        {/* ── the rail: three panels with their content showing ── */}
        <div className="fx-rail">
          <KnowsRailButton factCount={factCount} onOpen={() => setKnowsOpen(true)} />

          <AssignedRailPanel
            notices={notices}
            entries={assignedData?.assigned ?? []}
            now={now}
            open={drawerOpen}
            loading={!assignedData && !assignedError}
            readFailed={!!assignedError}
            onOpen={openDrawer}
            onClose={() => setDrawerOpen(false)}
          />

          <LogbookRailPanel
            entries={railLog}
            mergeOn={logbookInList}
            mergeReady={!!prefsData}
            mergeBusy={mergeBusy}
            mergeError={mergeError}
            onToggleMerge={toggleMerge}
            onOpen={openLogbook}
          />
        </div>
      </div>

      <KnowsPanel
        open={knowsOpen}
        lang={lang}
        hotelName={hotelName}
        onClose={() => setKnowsOpen(false)}
        onStats={setFactCount}
      />

      <LogbookPopup
        open={logbookOpen}
        onClose={closeLogbook}
        propertyId={propertyId}
        meName={meName}
        merged={logbookInList}
        mergeReady={!!prefsData}
        onToggleMerge={toggleMerge}
        mergeBusy={mergeBusy}
        mergeError={mergeError}
      />
    </>
  );
}

/**
 * The mono line beside an event's title.
 *
 * Deliberately NOT a clock time. A `knowledge_events` row carries a DAY and an
 * optional end day, and nothing finer — inventing "2:00 PM" to match the design
 * reference would be the screen making something up, which is the one thing
 * this product does not do. It says the true thing: all day, or how far it runs.
 */
function eventMeta(event: KnowledgeEventDTO): string {
  return event.endDate && event.endDate !== event.eventDate
    ? `Through ${dayStamp(event.endDate)}`
    : 'All day';
}

/** The event editor takes the Communications copy helper, which is identity. */
const IDENTITY_COPY = (english: string) => english;

/** Today, in the browser's own timezone, as YYYY-MM-DD. */
function localIso(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}
