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

import { useAuth } from '@/contexts/AuthContext';
import { useApiResource } from '@/lib/hooks/use-api-resource';
import { fetchWithAuth, INTERACTIVE_ACTION_TIMEOUT_MS, SessionEndedError } from '@/lib/api-fetch';
import { readEnvelope } from '@/lib/api-envelope';
import type { LogEntryDTO } from '@/lib/comms/types';
import type { AssignedByMeItem, WorklistItem } from '@/lib/worklist/types';
import type { FeedPrefs } from '@/lib/feed/prefs';
import { emptyListNote } from '@/lib/feed/one-list-copy';

import type { KnowledgeEventDTO } from '@/lib/knowledge/types';

import { FindingCards, type QueueReadState } from './FindingCards';
import { LogbookPopup } from './LogbookPopup';
import { CalendarView, isoDay } from './list-calendar';
import { EventEditor } from '@/app/communications/_components/CalendarPane';
import {
  AssignedByMeView,
  ComposerView,
  LIST_CSS,
  LogRowView,
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
}

export function StaxisList({ propertyId, lang, focusId, onReadState, canSeeFindings }: StaxisListProps) {
  const { user } = useAuth();
  const now = React.useMemo(() => new Date(), []);
  const todayIso = React.useMemo(() => localIso(now), [now]);

  // ── the work ─────────────────────────────────────────────────────────────
  const { data: worklist, reload: reloadWorklist } = useApiResource<{ items: WorklistItem[] }>(
    `/api/worklist?pid=${propertyId}`,
    { enabled: !!propertyId, pollMs: 60_000, keepDataOnError: true },
  );
  const items = React.useMemo(() => worklist?.items ?? [], [worklist]);

  // ── this person's switches ───────────────────────────────────────────────
  const { data: prefsData, reload: reloadPrefs } = useApiResource<{ prefs: FeedPrefs }>(
    `/api/feed/prefs?pid=${propertyId}`,
    { enabled: !!propertyId, keepDataOnError: true },
  );
  const logbookInList = prefsData?.prefs.logbookInList === true;

  // Only fetched when the switch is on. A hotel that never turned it on never
  // pays for the read.
  const { data: logData } = useApiResource<{ entries: LogEntryDTO[] }>(
    `/api/comms/logbook?pid=${propertyId}`,
    { enabled: !!propertyId && logbookInList, pollMs: 120_000, keepDataOnError: true },
  );
  // Bounded on purpose: the log book is a place you go. Merging every note
  // ever written into the list would bury the work under the diary.
  const logEntries = React.useMemo(() => (logbookInList ? (logData?.entries ?? []).slice(0, 5) : []), [logbookInList, logData]);

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

  // List or Calendar. Both are the SAME rows; the calendar keeps the ones that
  // name a day and puts them on one. The switch moved here from the old
  // Communications To-do pane along with the list itself.
  const [view, setView] = React.useState<'list' | 'calendar'>('list');
  const [month, setMonth] = React.useState<{ year: number; monthIndex: number }>(
    () => ({ year: now.getFullYear(), monthIndex: now.getMonth() }),
  );
  const [selectedDay, setSelectedDay] = React.useState<string | null>(() => isoDay(now));
  const [addingEvent, setAddingEvent] = React.useState(false);

  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [logbookOpen, setLogbookOpen] = React.useState(false);
  const [mergeBusy, setMergeBusy] = React.useState(false);
  const [mergeError, setMergeError] = React.useState<string | null>(null);

  const { data: assignedData, error: assignedError, reload: reloadAssigned } =
    useApiResource<{ assigned: AssignedByMeItem[] }>(
      `/api/worklist?pid=${propertyId}&view=assigned-by-me`,
      { enabled: !!propertyId && drawerOpen, keepDataOnError: true },
    );

  // The hotel's own dated events share the calendar. Only fetched when the
  // calendar is actually on screen: the list view has no use for them.
  const { data: eventData, reload: reloadEvents } = useApiResource<{ events: KnowledgeEventDTO[] }>(
    `/api/knowledge/events?pid=${propertyId}`,
    { enabled: !!propertyId && view === 'calendar', keepDataOnError: true },
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
        await reloadWorklist();
      } catch (e) {
        if (e instanceof SessionEndedError) throw e;
        setComposerError('That did not save. Try again in a moment.');
      } finally {
        setComposerBusy(false);
      }
    })();
  }, [composer, propertyId, reloadWorklist, meStaffId, todayIso, now]);

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

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: LIST_CSS }} />

      {/* Right side, below the Queue/Knows row, down by profile and settings. */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <div role="group" aria-label="Choose a view" style={{ display: 'flex', gap: 6, marginRight: 'auto' }}>
          <button
            type="button"
            className={view === 'list' ? 'fd-act fd-yes' : 'fd-act'}
            aria-pressed={view === 'list'}
            onClick={() => setView('list')}
          >
            List
          </button>
          <button
            type="button"
            className={view === 'calendar' ? 'fd-act fd-yes' : 'fd-act'}
            aria-pressed={view === 'calendar'}
            onClick={() => setView('calendar')}
          >
            Calendar
          </button>
        </div>
        <button type="button" className="fd-act" onClick={() => setDrawerOpen((v) => !v)} aria-expanded={drawerOpen}>
          Assigned by me
        </button>
        <button type="button" className="fd-act" onClick={() => setLogbookOpen(true)}>
          Log book
        </button>
      </div>

      {drawerOpen && (
        <AssignedByMeView
          entries={assignedData?.assigned ?? []}
          now={now}
          loading={!assignedData && !assignedError}
          readFailed={!!assignedError}
        />
      )}

      {rowError && <div className="sl-err">{rowError}</div>}

      {view === 'list' ? (
        <FindingCards
          key={propertyId}
          lang={lang}
          propertyId={propertyId}
          focusId={focusId}
          hideLiveness
          bottomHeadroom
          onReadState={onReadState}
          emptyNote={emptyListNote({ canSeeFindings })}
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
            items,
            logEntries,
            renderItem,
            renderLog: (entry) => <LogRowView entry={entry} onOpen={() => setLogbookOpen(true)} />,
          }}
        />
      ) : (
        <>
        {canSeeFindings && (
          <div className="fd-acts">
            <button type="button" className="fd-act" onClick={() => setAddingEvent((v) => !v)}>
              {addingEvent ? 'Cancel' : 'Add event'}
            </button>
          </div>
        )}
        {addingEvent && canSeeFindings && (
          <EventEditor
            pid={propertyId}
            L={IDENTITY_COPY}
            onDone={async () => { setAddingEvent(false); await reloadEvents(); }}
            onCancel={() => setAddingEvent(false)}
          />
        )}
        <CalendarView
          year={month.year}
          monthIndex={month.monthIndex}
          todayIso={todayIso}
          selectedIso={selectedDay}
          items={items}
          events={events}
          onSelectDay={setSelectedDay}
          onStepMonth={stepMonth}
          renderItem={renderItem}
          canManageEvents={canSeeFindings}
          onDeleteEvent={removeEvent}
        />
        </>
      )}

      <LogbookPopup
        open={logbookOpen}
        onClose={() => setLogbookOpen(false)}
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

/** The event editor takes the Communications copy helper, which is identity. */
const IDENTITY_COPY = (english: string) => english;

/** Today, in the browser's own timezone, as YYYY-MM-DD. */
function localIso(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}
