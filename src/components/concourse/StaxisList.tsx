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
import { reportCompanionDeed, reportCompanionFlow } from '@/components/companion/companion-events';
import { readEnvelope } from '@/lib/api-envelope';
import type { LogEntryDTO } from '@/lib/comms/types';
import type { AssignedByMeItem, WorklistItem } from '@/lib/worklist/types';
import type { FeedPrefs } from '@/lib/feed/prefs';
import {
  COMPOSER_COPY,
  EVENT_COPY,
  emptyListNote,
  PROMPT_ROTATE_MS,
  ROW_MENU_COPY,
  type RowMenuAction,
  type RowMenuOption,
} from '@/lib/feed/one-list-copy';
import { isNewSince, rowIsMine } from '@/lib/feed/one-list';
import { emptyParse, parseTodo, type ParseResult } from '@/lib/feed/parse-todo';
import { INTERPRET_DEBOUNCE_MS, INTERPRET_TIMEOUT_MS, shouldInterpret } from '@/lib/feed/interpret-todo';
import { COMPOSER_TAUGHT_TODO_REPEAT, parseCompanionMemory } from '@/lib/companion/manners';

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
  MonthOverlay,
  WeekStrip,
  dayOf,
  dayStamp,
  dayTitle,
  draftRange,
  emptyEventDraft,
  isoDay,
  weekCells,
  weekRangeLabel,
  type EventDraft,
} from './list-calendar';
import { CxIcon } from './icons';
import { TraceFoundLine } from './TraceFoundLine';
import {
  AssignedPopupView,
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
  readCadenceDraft,
  withParse,
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
  // just in this dropdown. See COMPOSER_ROLES in lib/feed/one-list-copy.ts.
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

  // ── the per-row situation menu ───────────────────────────────────────────
  // Three pieces of state and they are deliberately SINGULAR: one row's menu is
  // open at a time, one option is collecting its answer at a time, one draft.
  // Keeping them per-row would let two rows sit half-answered behind each other
  // on a list somebody is scrolling, which is a state nobody can see and nobody
  // asked for.
  const [menuRow, setMenuRow] = React.useState<string | null>(null);
  const [menuAsking, setMenuAsking] = React.useState<RowMenuAction | null>(null);
  const [menuDraft, setMenuDraft] = React.useState('');

  const [composerOpen, setComposerOpen] = React.useState(false);
  const [composer, setComposer] = React.useState<ComposerState>(() => composerDefaults(todayIso, now.getDay()));
  const [composerBusy, setComposerBusy] = React.useState(false);
  const [composerError, setComposerError] = React.useState<string | null>(null);
  // What the last sentence said. Held rather than re-derived, because lifting a
  // phrase REMOVES it from the field: by the next keystroke the words that
  // produced the question are already gone. See withParse.
  const [parsed, setParsed] = React.useState<ParseResult>(() => emptyParse());
  const [recording, setRecording] = React.useState(false);
  const [micAvailable, setMicAvailable] = React.useState(false);
  const [teachLine, setTeachLine] = React.useState<string | null>(null);
  // Which rotating example the idle prompt is showing. See PROMPT_EXAMPLES.
  const [promptTick, setPromptTick] = React.useState(0);
  // The composer's own box, for the click-outside close. A ref, not a hook, as
  // far as list-rows.tsx is concerned: it takes it as a prop.
  const composerBox = React.useRef<HTMLDivElement | null>(null);

  // ── everything, or just mine ─────────────────────────────────────────────
  // Per DEVICE, deliberately. It is view state, not something about the person:
  // somebody who narrows their list on the phone they carry round the building
  // has not asked for the office screen to be narrowed too. Read once, on
  // mount, because localStorage is not available while the server renders.
  const [mineOnly, setMineOnly] = React.useState(false);
  React.useEffect(() => { setMineOnly(readMineOnly()); }, []);
  const chooseScope = React.useCallback((next: boolean) => {
    setMineOnly(next);
    writeMineOnly(next);
  }, []);

  // ── what was new when this person arrived ────────────────────────────────
  // FROZEN at the first read, and that is the whole trick. The markers are
  // measured against the cursor as it was when the page opened; the stamp below
  // then moves the cursor to now, so the NEXT visit measures from this one. Read
  // live, the stamp would erase every marker a fraction of a second after
  // painting it, and the feature would look like it had never shipped.
  const [listSeenAt, setListSeenAt] = React.useState<string | null | undefined>(undefined);
  const seenStamped = React.useRef(false);
  React.useEffect(() => {
    if (!prefsData || seenStamped.current) return;
    seenStamped.current = true;
    setListSeenAt(prefsData.prefs.listSeenAt);
    void (async () => {
      try {
        await fetchWithAuth('/api/feed/prefs', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pid: propertyId, markListSeen: true }),
          timeoutMs: INTERACTIVE_ACTION_TIMEOUT_MS,
        });
      } catch {
        // Fire and forget. A lost stamp costs one repeated set of markers on
        // the next visit, which is a smaller harm than an error over a list.
      }
    })();
  }, [prefsData, propertyId]);

  // ── which day the timeline is showing ────────────────────────────────────
  // The `List` / `Calendar` toggle is gone (2026-08-01). The week strip in the
  // day header is the ambient calendar and is always on screen; the MONTH grid
  // opens over it. Clicking a day in either re-anchors this list.
  const [anchorIso, setAnchorIso] = React.useState<string>(() => isoDay(now));
  const [monthOpen, setMonthOpen] = React.useState(false);
  const [month, setMonth] = React.useState<{ year: number; monthIndex: number }>(
    () => ({ year: now.getFullYear(), monthIndex: now.getMonth() }),
  );
  // ── adding something to the month ────────────────────────────────────────
  // Non-null while the side panel is open. The MONTH is the date control, so
  // the draft holds the two days the grid is showing and nothing re-types them.
  const [eventDraft, setEventDraft] = React.useState<EventDraft | null>(null);
  const [eventBusy, setEventBusy] = React.useState(false);
  const [eventError, setEventError] = React.useState<string | null>(null);
  // True between pointer-down on a day and pointer-up anywhere. Held in a ref
  // as well as in state: the window listener that ends a drag reads it during
  // an event, where a stale closure over state would be a stuck drag.
  const draggingRef = React.useRef(false);
  const [dragging, setDragging] = React.useState(false);

  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [logbookOpen, setLogbookOpen] = React.useState(false);
  // Knows is an overlay, not a route and not a tab. The page stays mounted
  // behind it, so it is never somewhere you have to navigate back from.
  const [knowsOpen, setKnowsOpen] = React.useState(false);

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

  // Read on every load now, not only when the drawer was open. The rail panel
  // carries the three most recent on its face (2026-08-05), so "what have I
  // handed out" is a question this page always has to have answered: it used to
  // say "nothing has come back since you last looked" over eleven live
  // assignments, which is true about the last hour and useless about the work.
  const { data: assignedData, error: assignedError, reload: reloadAssigned } =
    useApiResource<{ assigned: AssignedByMeItem[] }>(
      `/api/worklist?pid=${propertyId}&view=assigned-by-me`,
      { enabled: !!propertyId, keepDataOnError: true },
    );
  const assigned = React.useMemo(() => assignedData?.assigned ?? [], [assignedData]);

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
  /** Every ending /api/worklist/complete accepts. The route's own enum. */
  type SettleOutcome = 'done' | 'cant' | 'done_on_due' | 'skip' | 'called' | 'waiting' | 'not_an_issue';

  const closeMenu = React.useCallback(() => {
    setMenuRow(null);
    setMenuAsking(null);
    setMenuDraft('');
  }, []);

  const settle = React.useCallback(
    (item: WorklistItem, outcome: SettleOutcome, reason?: string) => {
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
          const envelope = await readEnvelope<{ recorded: boolean }>(res);
          if (envelope.error !== undefined) {
            // Never drop a row we did not actually settle. The person would
            // believe the work was recorded when it was not. The menu stays
            // OPEN on a failure, for the same reason: closing it would look
            // exactly like the tap having worked.
            setRowError(ROW_MENU_COPY.failed);
            return;
          }
          setReasonFor(null);
          setReasonDraft('');
          closeMenu();
          await reloadWorklist();
          if (drawerOpen) await reloadAssigned();
        } catch (e) {
          if (e instanceof SessionEndedError) throw e;
          setRowError(ROW_MENU_COPY.failed);
        } finally {
          setBusyRow(null);
        }
      })();
    },
    [propertyId, reloadWorklist, reloadAssigned, drawerOpen, closeMenu],
  );

  /**
   * Change something ABOUT a row without settling it: a schedule's cadence, or
   * who is holding a work order. The other half of the pair, and the same
   * discipline — nothing closes optimistically, and a failure says so.
   */
  const changeRow = React.useCallback(
    (item: WorklistItem, patch: { frequencyDays?: number; assigneeStaffId?: string | null }) => {
      void (async () => {
        setBusyRow(item.id);
        setRowError(null);
        try {
          const res = await fetchWithAuth('/api/worklist/assign', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              pid: propertyId,
              sourceType: item.sourceType,
              sourceId: item.sourceId,
              ...patch,
            }),
            timeoutMs: INTERACTIVE_ACTION_TIMEOUT_MS,
          });
          const envelope = await readEnvelope<{ assigned: boolean }>(res);
          if (envelope.error !== undefined) {
            setRowError(envelope.error || ROW_MENU_COPY.failed);
            return;
          }
          closeMenu();
          await reloadWorklist();
        } catch (e) {
          if (e instanceof SessionEndedError) throw e;
          setRowError(ROW_MENU_COPY.failed);
        } finally {
          setBusyRow(null);
        }
      })();
    },
    [propertyId, reloadWorklist, closeMenu],
  );

  /**
   * An option was tapped.
   *
   * The ones that need nothing fire straight away — a confirmation step on
   * "Somebody's been called" would be a second tap for a thing that is not
   * destructive and is trivially re-answerable. The ones that need an answer
   * open ONE field on the row, seeded with what is already true: the cadence
   * box starts on the cadence it is changing.
   */
  const pickMenuOption = React.useCallback((item: WorklistItem, option: RowMenuOption) => {
    setRowError(null);
    if (option.input === 'none') {
      settle(item, option.action === 'called' ? 'called'
        : option.action === 'skip' ? 'skip'
          : 'not_an_issue');
      return;
    }
    setMenuRow(item.id);
    setMenuAsking(option.action);
    setMenuDraft(option.action === 'reschedule' && item.cadenceDays ? String(item.cadenceDays) : '');
  }, [settle]);

  /** Send whatever the open field is holding. */
  const submitMenuAnswer = React.useCallback((item: WorklistItem) => {
    if (menuAsking === 'waiting') {
      const said = menuDraft.trim();
      if (!said) return;
      settle(item, 'waiting', said);
      return;
    }
    if (menuAsking === 'reschedule') {
      const days = readCadenceDraft(menuDraft);
      if (days === null) return;
      changeRow(item, { frequencyDays: days });
    }
  }, [menuAsking, menuDraft, settle, changeRow]);

  // ── the composer ─────────────────────────────────────────────────────────
  //
  // The parser is PURE CODE and is the only thing on the typing path: it runs
  // synchronously on every keystroke against a string under 200 characters, and
  // it cannot fail. Everything below it is optional and cancellable.

  /**
   * The optional second reading, and its two cancels.
   *
   * `timer` is the debounce; `abort` is the request. Both are torn down by
   * `cancelInterpret`, which runs on the next keystroke, on submit, and on
   * unmount. An answer that outlives the sentence it was asked about is dropped
   * on arrival as well, against the title the composer actually holds.
   */
  const interpretRef = React.useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    abort: AbortController | null;
  }>({ timer: null, abort: null });

  const cancelInterpret = React.useCallback(() => {
    const live = interpretRef.current;
    if (live.timer) { clearTimeout(live.timer); live.timer = null; }
    if (live.abort) { live.abort.abort(); live.abort = null; }
  }, []);

  React.useEffect(() => cancelInterpret, [cancelInterpret]);

  /** Whether this person has already been shown the repeat tip, ever. */
  const taught = React.useMemo(
    () => parseCompanionMemory(prefsData?.prefs.companionMemory ?? null).taught,
    [prefsData],
  );

  /** Spend the tip. Fire and forget: a lost stamp costs one repeated line. */
  const markTaught = React.useCallback(() => {
    void (async () => {
      try {
        await fetchWithAuth('/api/companion', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pid: propertyId, event: 'taught', flow: COMPOSER_TAUGHT_TODO_REPEAT }),
          timeoutMs: INTERACTIVE_ACTION_TIMEOUT_MS,
        });
        await reloadPrefs();
      } catch { /* the line is already on the screen; the stamp can wait */ }
    })();
  }, [propertyId, reloadPrefs]);

  const changeComposer = React.useCallback((next: ComposerState) => {
    // A tap, not typing: the buttons already produced the state they wanted.
    if (next.title === composer.title) { setComposer(next); return; }
    // Anything typed invalidates a reading that was already in flight, and
    // clears a tip that was about the to-do before this one.
    cancelInterpret();
    setTeachLine(null);
    // Emptying the row is the one thing that resets the answers. Without it a
    // day lifted from a sentence would outlive the sentence itself.
    if (!next.title.trim()) {
      setComposer({ ...composerDefaults(todayIso, now.getDay()), openRow: next.openRow });
      setParsed(emptyParse());
      return;
    }
    const result = parseTodo(next.title, people, now);
    setParsed(result);
    // The parse's tidied title (trimmed, capitalized) is for the chips and for
    // filing, never for the box: replacing the box's value with it eats the
    // trailing space on every keystroke, which reads as "spacebar is broken".
    // The box always shows exactly what was typed.
    setComposer({ ...withParse(next, result, now.getDay()), title: next.title });
  }, [composer.title, people, now, todayIso, cancelInterpret]);

  // A question is only live while nobody has answered it with their thumb.
  const composerQuestion = composer.source.when === 'chosen' || composer.source.repeat === 'chosen'
    ? null
    : parsed.question;

  // ── the optional second reading ──────────────────────────────────────────
  //
  // Fires only when the code above lifted NOTHING out of a sentence long enough
  // to have something in it. Debounced, deadlined, cancelled by the next
  // keystroke and by submit, and silent on every failure. It cannot block
  // Enter, it never shows a spinner, and it has no error state: if it returns
  // nothing, is slow, errors, is switched off in the Control Center, or the
  // browser is offline, this composer behaves exactly as it does without it.
  React.useEffect(() => {
    cancelInterpret();
    const text = composer.title.trim();
    if (!shouldInterpret(text, parsed)) return undefined;
    const live = interpretRef.current;
    live.timer = setTimeout(() => {
      const controller = new AbortController();
      live.abort = controller;
      void (async () => {
        try {
          const res = await fetchWithAuth('/api/feed/interpret-todo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pid: propertyId, text }),
            timeoutMs: INTERPRET_TIMEOUT_MS,
            signal: controller.signal,
          });
          const envelope = await readEnvelope<{ read: ParseResult | null }>(res);
          const read = envelope.error === undefined ? envelope.data?.read ?? null : null;
          if (!read || controller.signal.aborted) return;
          setComposer((prev) => {
            // The sentence moved on while this was in the air. An answer to a
            // question nobody is asking any more is dropped, not applied.
            if (prev.title.trim() !== text) return prev;
            // It arrives as a parse and is applied as one: caramel, never sage,
            // including the name. A person the code found is somebody who was
            // written down; a person a model proposes is a reading.
            // Same rule as the keystroke path: the reading updates the chips,
            // never the typed sentence. The guard above matched on trimmed
            // text, so an in-flight trailing space must survive the landing.
            return { ...withParse(prev, read, now.getDay(), { whoAs: 'parsed' }), title: prev.title };
          });
        } catch {
          // Deliberately total. There is no failure of this call that a person
          // is allowed to see.
        }
      })();
    }, INTERPRET_DEBOUNCE_MS);
    return cancelInterpret;
  }, [composer.title, parsed, propertyId, now, cancelInterpret]);

  const submitComposer = React.useCallback(() => {
    const payload = composerPayload(composer, meStaffId);
    if (!payload) return;
    cancelInterpret();
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
        // Nothing was tapped and nothing repeated: this person types plain
        // sentences and has not been told the rest is writable too. One line,
        // once ever, and only after the add already worked.
        const plain = composer.openRow === null
          && composer.source.when !== 'chosen'
          && composer.source.repeat !== 'chosen'
          && composer.repeat === 'once';
        const owed = plain && taught[COMPOSER_TAUGHT_TODO_REPEAT] !== true;

        setComposer(composerDefaults(todayIso, now.getDay()));
        setParsed(emptyParse());
        setComposerOpen(false);
        setTeachLine(owed ? COMPOSER_COPY.repeatTeach : null);
        if (owed) markTaught();
        // Somebody just wrote a task by hand that they could have asked for in
        // a sentence. Fired AFTER the composer closes and only on success, so
        // the tip never lands as an obstacle and never follows a failed save.
        // The companion decides whether to say anything; it will say it at most
        // once, ever. See decideTeachMoment.
        reportCompanionFlow('create_task');
        // The same moment, said to the tour instead of to the tip. A `try`
        // stop standing on this screen waits for exactly this and nothing
        // else, so it is fired AFTER the envelope came back clean: a to-do
        // that failed to save must never advance a tour that then tells
        // somebody it is on the list.
        reportCompanionDeed('todo_created');
        await reloadWorklist();
      } catch (e) {
        if (e instanceof SessionEndedError) throw e;
        setComposerError('That did not save. Try again in a moment.');
      } finally {
        setComposerBusy(false);
      }
    })();
  }, [composer, propertyId, reloadWorklist, meStaffId, todayIso, now, taught, markTaught, cancelInterpret]);

  /** Give up the row outright: the words, the answers, the open buttons. */
  const cancelComposer = React.useCallback(() => {
    setComposerOpen(false);
    setComposerError(null);
    setComposer(composerDefaults(todayIso, now.getDay()));
    setParsed(emptyParse());
    cancelInterpret();
  }, [todayIso, now, cancelInterpret]);

  /**
   * Shut the row without eating what is in it.
   *
   * A click somewhere else on the page is "I am done with this control", not "I
   * did not mean any of that": somebody who has typed half a sentence and
   * glanced at a row above has not asked for their words to be deleted. So an
   * empty row resets outright and a row with words in it just closes its
   * buttons and lets go of focus. Escape keeps its own harder second stage,
   * which is the deliberate act.
   */
  const collapseComposer = React.useCallback(() => {
    if (!composer.title.trim()) { cancelComposer(); return; }
    setComposerOpen(false);
    setComposer((prev) => (prev.openRow === null && !prev.otherHint
      ? prev
      : { ...prev, openRow: null, otherHint: false }));
  }, [composer.title, cancelComposer]);

  // ── closing the composer from outside it ─────────────────────────────────
  //
  // Two ways out that the row itself cannot see: a click anywhere else, and
  // Escape pressed while focus is on one of the chips rather than in the field.
  // Both live here because this is the only component on the screen with hooks;
  // list-rows.tsx is hook-free on purpose.
  //
  // Bound only while the row is actually engaged, and never while something
  // else is open over the top of it: the log book popup and the Knows panel
  // both close on Escape, and two things closing on one keypress is a page
  // that feels like it is fighting you.
  const composerEngaged = composerOpen || composer.openRow !== null || composer.title.trim().length > 0;
  // A row menu counts as something over the page for exactly one reason: the
  // composer's Escape handler must not also fire while a menu is answering.
  // Two things closing on one keypress is a page that feels like it is fighting
  // you, and that rule already governs the log book and Knows.
  const overlayOpen = knowsOpen || logbookOpen || monthOpen || drawerOpen || menuRow !== null;
  React.useEffect(() => {
    if (!composerEngaged || overlayOpen) return undefined;

    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      const box = composerBox.current;
      const target = e.target;
      if (!box || !(target instanceof Node)) return;
      if (box.contains(target)) return;
      collapseComposer();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // The field owns its own Escape, and it has a two-stage answer this must
      // not double up on. Anything else with focus (a chip, the mic, the page)
      // comes through here.
      const target = e.target as HTMLElement | null;
      if (target instanceof HTMLInputElement && target.classList.contains('fx-comptitle')) return;
      if (composer.openRow !== null || composer.otherHint) {
        setComposer((prev) => ({ ...prev, openRow: null, otherHint: false }));
        return;
      }
      cancelComposer();
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [composerEngaged, overlayOpen, composer.openRow, composer.otherHint, collapseComposer, cancelComposer]);

  // ── closing a row menu from outside it ───────────────────────────────────
  //
  // The menu brings its own click-anywhere-else exit (the transparent scrim in
  // WorkRowView), but a scrim cannot catch a key, and the panel is gone the
  // moment an option opens a field — so the reason box and the cadence box
  // would have had no way out but the Never mind button. Escape closes whatever
  // stage the menu is at, and this is the only place on the screen allowed to
  // touch the document: list-rows.tsx is hook-free on purpose.
  //
  // A click elsewhere deliberately does NOT discard a half-typed reason, for
  // the same reason the composer keeps its words: glancing at the row above is
  // not asking for what you typed to be deleted.
  React.useEffect(() => {
    if (menuRow === null) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      closeMenu();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuRow, closeMenu]);

  // ── the rotating example ─────────────────────────────────────────────────
  //
  // Slow (see PROMPT_ROTATE_MS) and stopped dead the moment somebody is using
  // the row: a placeholder that changes under a person who is reading it is
  // worse than a static one. It is only ever visible on an empty field anyway,
  // so the timer is simply not running the rest of the time.
  React.useEffect(() => {
    if (composerEngaged) return undefined;
    const timer = setInterval(() => setPromptTick((n) => n + 1), PROMPT_ROTATE_MS);
    return () => clearInterval(timer);
  }, [composerEngaged]);

  // ── speaking instead of typing ───────────────────────────────────────────
  //
  // Speech is an INPUT METHOD, not a mode. The words land in the same field the
  // keyboard fills, the same parser runs over them, and there is nothing to
  // confirm afterwards. Hold the mic and talk; let go and it is typed.
  //
  // The recogniser only exists in some browsers, so the mic is not offered at
  // all where it does not: an affordance that does nothing is worse than none.
  const speechRef = React.useRef<{ rec: SpeechRecognitionLike | null; pressedAt: number }>(
    { rec: null, pressedAt: 0 },
  );

  React.useEffect(() => {
    setMicAvailable(speechConstructor() !== null);
    const live = speechRef.current;
    // The recogniser holds the microphone. Leaving one running past unmount
    // leaves the browser's recording indicator on over a page that is gone.
    return () => { try { live.rec?.stop(); } catch { /* already gone */ } };
  }, []);

  const stopSpeech = React.useCallback(() => {
    const live = speechRef.current;
    try { live.rec?.stop(); } catch { /* already gone */ }
    live.rec = null;
    setRecording(false);
  }, []);

  const startSpeech = React.useCallback(() => {
    const Ctor = speechConstructor();
    if (!Ctor) return;
    const base = composer.title.trim() ? `${composer.title.trim()} ` : '';
    try {
      const rec = new Ctor();
      rec.lang = 'en-US';
      rec.interimResults = true;
      rec.continuous = true;
      rec.onresult = (e) => {
        let said = '';
        for (let i = e.resultIndex; i < e.results.length; i += 1) said += e.results[i][0]?.transcript ?? '';
        // Straight into the field, through the same change path a keystroke
        // takes, so the parser reads speech exactly as it reads typing.
        changeComposer({ ...composer, title: (base + said).replace(/\s+/g, ' ').trimStart() });
      };
      rec.onend = () => { speechRef.current.rec = null; setRecording(false); };
      rec.onerror = () => { speechRef.current.rec = null; setRecording(false); };
      speechRef.current.rec = rec;
      rec.start();
      setRecording(true);
    } catch {
      speechRef.current.rec = null;
      setRecording(false);
    }
  }, [composer, changeComposer]);

  /** Press to start. A HOLD stops on release; a TAP latches until tapped again. */
  const micPress = React.useCallback(() => {
    if (speechRef.current.rec) { stopSpeech(); return; }
    speechRef.current.pressedAt = Date.now();
    startSpeech();
  }, [startSpeech, stopSpeech]);

  const micRelease = React.useCallback(() => {
    if (!speechRef.current.rec) return;
    if (Date.now() - speechRef.current.pressedAt < 300) return;  // a tap, not a hold
    stopSpeech();
  }, [stopSpeech]);

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

  // ── picking days ON the month ────────────────────────────────────────────
  //
  // Pointer-down starts a range, moving across days extends it, letting go ends
  // it. A plain click is the degenerate case of that, which is why there is one
  // code path and not two: a tap on a phone and a drag on a desktop cannot
  // disagree about what got picked if neither has its own handler.
  const pickDown = React.useCallback((iso: string) => {
    draggingRef.current = true;
    setDragging(true);
    setEventDraft((prev) => (prev ? { ...prev, start: iso, end: iso } : prev));
  }, []);

  const pickMove = React.useCallback((iso: string) => {
    if (!draggingRef.current) return;
    setEventDraft((prev) => (prev ? { ...prev, end: iso } : prev));
  }, []);

  const pickUp = React.useCallback(() => {
    draggingRef.current = false;
    setDragging(false);
  }, []);

  // Letting go ANYWHERE ends the drag, including off the grid and outside the
  // window. Without this, dragging past the last row and releasing leaves the
  // range following the pointer around, which reads as the page being stuck.
  React.useEffect(() => {
    if (!dragging) return undefined;
    const end = () => { draggingRef.current = false; setDragging(false); };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, [dragging]);

  const startAddEvent = React.useCallback(() => {
    setEventError(null);
    // Pre-picked with the day the page is already anchored on. Somebody who
    // opened the month on a Saturday to add a Saturday thing has nothing left
    // to do but type, and anybody else drags.
    setEventDraft({ ...emptyEventDraft(), start: anchorIso, end: null });
  }, [anchorIso]);

  const cancelAddEvent = React.useCallback(() => {
    setEventDraft(null);
    setEventError(null);
    draggingRef.current = false;
    setDragging(false);
  }, []);

  const saveEvent = React.useCallback(() => {
    const draft = eventDraft;
    if (!draft) return;
    const range = draftRange(draft);
    const title = draft.title.trim();
    if (!range || !title) return;
    void (async () => {
      setEventBusy(true);
      setEventError(null);
      try {
        const res = await fetchWithAuth('/api/knowledge/events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pid: propertyId,
            title,
            eventDate: range.eventDate,
            endDate: range.endDate,
            notes: draft.notes.trim() || null,
          }),
          timeoutMs: INTERACTIVE_ACTION_TIMEOUT_MS,
        });
        const envelope = await readEnvelope<{ id?: string }>(res);
        if (envelope.error !== undefined) {
          setEventError(envelope.error || EVENT_COPY.failed);
          return;
        }
        setEventDraft(null);
        await reloadEvents();
      } catch (e) {
        if (e instanceof SessionEndedError) throw e;
        setEventError(EVENT_COPY.failed);
      } finally {
        setEventBusy(false);
      }
    })();
  }, [eventDraft, propertyId, reloadEvents]);

  const closeMonth = React.useCallback(() => {
    setMonthOpen(false);
    cancelAddEvent();
  }, [cancelAddEvent]);

  // ── Escape closes what is over the page ──────────────────────────────────
  //
  // The month and the assigned-by-me list are both plain overlays rather than
  // dialog elements, so nothing gives them this for free. The log book popup
  // and Knows bring their own, and are deliberately not handled here: two
  // things closing on one keypress reads as the page fighting you.
  //
  // The month goes first when both are somehow open, because it is the one
  // holding an unsaved draft.
  React.useEffect(() => {
    if (!monthOpen && !drawerOpen) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (monthOpen) closeMonth();
      else setDrawerOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [monthOpen, drawerOpen, closeMonth]);

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
      isNew={listSeenAt !== undefined && isNewSince(item, listSeenAt, now)}
      onDone={(i) => settle(i, 'done')}
      onDoneOnDay={(i) => settle(i, 'done_on_due')}
      onNotNeeded={(i) => settle(i, 'skip')}
      onAskReason={(i) => { setReasonFor(i.id); setReasonDraft(''); closeMenu(); }}
      onReasonChange={setReasonDraft}
      onCantSubmit={(i) => settle(i, 'cant', reasonDraft.trim())}
      onCancelReason={() => { setReasonFor(null); setReasonDraft(''); }}
      menuOpen={menuRow === item.id && menuAsking === null}
      menuAsking={menuRow === item.id ? menuAsking : null}
      menuDraft={menuRow === item.id ? menuDraft : ''}
      // The same roster the composer hands to-dos to. Housekeepers are already
      // absent from it, server-side, and the assign route refuses one anyway.
      menuPeople={people}
      onToggleMenu={(i, open) => {
        setRowError(null);
        if (open) { setMenuRow(i.id); setMenuAsking(null); setMenuDraft(''); }
        else closeMenu();
      }}
      onMenuPick={pickMenuOption}
      onMenuDraftChange={setMenuDraft}
      onMenuSubmit={submitMenuAnswer}
      onMenuPickPerson={(i, staffId) => changeRow(i, { assigneeStaffId: staffId })}
      onMenuCancel={closeMenu}
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

  /** Open the month on whatever day the page is currently showing. */
  const openMonth = React.useCallback(() => {
    const d = new Date(`${anchorIso}T12:00:00`);
    if (!Number.isNaN(d.getTime())) setMonth({ year: d.getFullYear(), monthIndex: d.getMonth() });
    setEventDraft(null);
    setEventError(null);
    setMonthOpen(true);
  }, [anchorIso]);

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
    () => {
      const onDay = isToday ? items : items.filter((it) => dayOf(it) === anchorIso);
      // Narrowed, never reordered. See the "one narrowing" note in one-list.ts:
      // this removes rows and touches nothing else, so the thing at the top of
      // "just mine" is the same thing that was highest among their own rows.
      if (!mineOnly || !meStaffId) return onDay;
      return onDay.filter((it) => rowIsMine({ kind: 'item', key: it.id, item: it }, meStaffId));
    },
    [isToday, items, anchorIso, mineOnly, meStaffId],
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
            {/* Two words, one capsule, sitting with the day controls because it
                is about which rows are shown rather than about any of them.
                Offered only once we know who "mine" would be: a toggle that
                could only ever empty the list is worse than no toggle. */}
            {meStaffId && (
              <>
                <div className="fx-seg" role="group" aria-label="Which work to show">
                  <button
                    type="button"
                    className="fx-segb"
                    aria-pressed={!mineOnly}
                    onClick={() => chooseScope(false)}
                  >
                    Everything
                  </button>
                  <button
                    type="button"
                    className="fx-segb"
                    aria-pressed={mineOnly}
                    onClick={() => chooseScope(true)}
                  >
                    Just mine
                  </button>
                </div>
                <span className="fx-vrule" aria-hidden />
              </>
            )}
            <button
              type="button"
              className="fx-month"
              aria-expanded={monthOpen}
              onClick={() => (monthOpen ? closeMonth() : openMonth())}
            >
              <CxIcon name="calendar" size={13} />
              Month
            </button>
          </div>

          <WeekStrip cells={cells} selectedIso={anchorIso} onSelectDay={anchorOn} />
        </div>
      </div>

      {/* ── the two lanes ── */}
      <div className="fx-body">
        <div>
          {rowError && <div className="sl-err">{rowError}</div>}

          {/* Found somewhere else. ONE PLAIN LINE and the same ask the peek
              carries, because this screen is a list of everything and a
              diagram over the top of it would be a second design. Saying yes
              walks over and the reveal is already drawn on arrival. The
              companion decides whether this appears at all; this renders it. */}
          <TraceFoundLine />

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
                now={now}
                question={composerQuestion}
                busy={composerBusy}
                error={composerError}
                recording={recording}
                micAvailable={micAvailable}
                teachLine={teachLine}
                promptTick={promptTick}
                boxRef={composerBox}
                onOpen={() => setComposerOpen(true)}
                onCancel={cancelComposer}
                onChange={changeComposer}
                onSubmit={submitComposer}
                onMicPress={micPress}
                onMicRelease={micRelease}
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
          <KnowsRailButton onOpen={() => setKnowsOpen(true)} />

          <AssignedRailPanel
            notices={notices}
            entries={assigned}
            now={now}
            loading={!assignedData && !assignedError}
            readFailed={!!assignedError}
            onOpen={openDrawer}
          />

          <LogbookRailPanel entries={railLog} onOpen={openLogbook} />
        </div>
      </div>

      <AssignedPopupView
        open={drawerOpen}
        entries={assigned}
        now={now}
        loading={!assignedData && !assignedError}
        readFailed={!!assignedError}
        onClose={() => setDrawerOpen(false)}
      />

      <MonthOverlay
        open={monthOpen}
        year={month.year}
        monthIndex={month.monthIndex}
        todayIso={todayIso}
        selectedIso={anchorIso}
        items={items}
        events={events}
        canManageEvents={canSeeFindings}
        draft={eventDraft}
        busy={eventBusy}
        error={eventError}
        onClose={closeMonth}
        onSelectDay={anchorOn}
        onStepMonth={stepMonth}
        onStartAdd={startAddEvent}
        onCancelAdd={cancelAddEvent}
        onDraftChange={setEventDraft}
        onSaveEvent={saveEvent}
        onPickDown={pickDown}
        onPickMove={pickMove}
        onPickUp={pickUp}
      />

      <KnowsPanel
        open={knowsOpen}
        lang={lang}
        hotelName={hotelName}
        onClose={() => setKnowsOpen(false)}
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

// The slice of the Web Speech API this touches. It is not in the standard DOM
// lib types and is `webkit`-prefixed in Chrome and Safari. Same shape the ask
// bar's dictation uses (AskStaxisBar.tsx).
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

function speechConstructor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

// ── the mine toggle's memory ─────────────────────────────────────────────
//
// One boolean, per device, per browser. Never sent anywhere. Wrapped in
// try/catch on BOTH sides because private-mode Safari throws on both, and a
// view preference must never be able to take the list down with it.

/** localStorage key. Dotted, matching the newer keys (staxis.companion.dock). */
export const MINE_ONLY_KEY = 'staxis.feed.mine';

function readMineOnly(): boolean {
  try {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(MINE_ONLY_KEY) === '1';
  } catch {
    return false;
  }
}

function writeMineOnly(on: boolean): void {
  try {
    if (typeof window === 'undefined') return;
    if (on) window.localStorage.setItem(MINE_ONLY_KEY, '1');
    else window.localStorage.removeItem(MINE_ONLY_KEY);
  } catch {
    // The toggle already moved on the screen. Losing the memory of it costs
    // one re-tap next time, which is not worth an error message.
  }
}

/** Today, in the browser's own timezone, as YYYY-MM-DD. */
function localIso(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}
