/**
 * NOTICES — the assignment loop, said once.
 *
 * The feature is small and the ways it can go wrong are all silent, which is
 * why each of them is named below:
 *
 *   1. it says one thing per task instead of one thing per batch, and the
 *      companion becomes the notification spam this product does not have
 *   2. it repeats the same batch on every page load, because "already told
 *      them" is the only thing standing between an exempt-from-the-caps class
 *      of speech and an infinite one
 *   3. it is silenced by a cap it was explicitly exempted from, and the person
 *      never learns their colleague handed them three jobs
 *   4. the popup covers the conversation it was opened from
 *   5. the read cursor goes backwards, and yesterday is unread again
 *   6. a housekeeper gets one
 *
 * Everything here exercises the real functions. There is no component, on
 * purpose: the suite runs under --conditions=react-server where a hook cannot
 * be mounted, which is exactly why every rule with a consequence lives in a
 * plain module.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  NOTICES_EMPTY_LINE,
  NOTICES_TITLE,
  announcementLine,
  dayLabelFor,
  decideNoticeAnnouncement,
  groupNoticesByDay,
  newestNoticeAt,
  noticeIsUnread,
  noticePerson,
  noticeReason,
  noticeSentence,
  noticeTitle,
  noticesCountLabel,
  sortNotices,
  unannounced,
  unreadNotices,
  type AssignmentNotice,
  type NoticeKind,
} from '@/lib/companion/notices';
import {
  EMPTY_COMPANION_MEMORY,
  parseCompanionMemory,
  rememberNoticesAnnounced,
  rememberNoticesSeen,
} from '@/lib/companion/manners';
import {
  EDGE_MARGIN,
  noticesFits,
  noticesRect,
  placeNoticesPopup,
  placePanel,
  panelWidthFor,
  NOTICES_ENTER_MS,
  NOTICES_EASING,
  noticesEnterMs,
  REDUCED_MOTION_MS,
  type Rect,
  type Viewport,
} from '@/lib/companion/dock';
import { companionMounts } from '@/lib/companion/mount';
import { chatIsMountedForRole } from '@/lib/agent/lenses';
import { companionLabels } from '@/lib/companion/copy';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const TODAY = '2026-08-05';

function notice(over: Partial<AssignmentNotice> & { kind?: NoticeKind } = {}): AssignmentNotice {
  const kind = over.kind ?? 'assigned';
  const personName = over.personName !== undefined ? over.personName : 'Sarah';
  const title = over.title ?? 'Check the pool pump';
  const reason = over.reason !== undefined ? over.reason : null;
  const taskId = over.taskId ?? 'task-1';
  return {
    id: over.id ?? `${kind}:${taskId}`,
    kind,
    taskId,
    at: over.at ?? `${TODAY}T14:00:00.000Z`,
    personName,
    title,
    reason,
    sentence: over.sentence ?? noticeSentence({ kind, personName, title, reason }),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. ONE BATCHED UTTERANCE, NEVER ONE PER TASK
// ═══════════════════════════════════════════════════════════════════════════

describe('the announcement is batched', () => {
  test('three jobs from one person are ONE sentence, not three', () => {
    const line = announcementLine([
      notice({ taskId: 'a' }),
      notice({ taskId: 'b' }),
      notice({ taskId: 'c' }),
    ], TODAY);
    assert.ok(line);
    // One sentence, and it names the count rather than listing the jobs. The
    // failure this guards is the obvious implementation: join the three row
    // sentences together and call it a batch.
    assert.equal(line, 'Sarah gave you 3 things today.');
    assert.equal(line!.split('.').filter((s) => s.trim()).length, 1);
  });

  test('a single notice speaks as itself rather than as a count', () => {
    // "You were given 1 thing" is a machine describing a message instead of
    // delivering it. With one, the row sentence IS the announcement.
    const one = notice({ taskId: 'solo' });
    assert.equal(announcementLine([one], TODAY), one.sentence);
  });

  test('the three kinds fold into at most three clauses, in one utterance', () => {
    const line = announcementLine([
      notice({ kind: 'assigned', taskId: 'a', personName: 'Sarah' }),
      notice({ kind: 'assigned', taskId: 'b', personName: 'Sarah' }),
      notice({ kind: 'done', taskId: 'c', personName: 'Marcus', title: 'Boiler check' }),
      notice({ kind: 'refused', taskId: 'd', personName: 'Luis', title: '214 deep clean', reason: 'needs a part' }),
    ], TODAY);
    assert.ok(line);
    assert.match(line!, /Sarah gave you 2 things today\./);
    assert.match(line!, /Marcus finished 1 thing today\./);
    assert.match(line!, /Luis could not do 1 thing today\./);
  });

  test('more than one person in a group is not attributed to either of them', () => {
    const line = announcementLine([
      notice({ taskId: 'a', personName: 'Sarah' }),
      notice({ taskId: 'b', personName: 'Marcus' }),
    ], TODAY);
    assert.equal(line, 'You were given 2 things today.');
  });

  test('it only says "today" when every item really is from today', () => {
    // The small lie that teaches somebody to stop believing counts. A batch
    // spanning last night and this morning makes no claim about a day.
    const line = announcementLine([
      notice({ taskId: 'a', at: `${TODAY}T09:00:00.000Z` }),
      notice({ taskId: 'b', at: '2026-08-04T22:00:00.000Z' }),
    ], TODAY);
    assert.equal(line, 'Sarah gave you 2 things.');
    assert.equal(
      announcementLine([notice({ taskId: 'a' }), notice({ taskId: 'b' })], null),
      'Sarah gave you 2 things.',
      'with no hotel day to compare against, it claims no day at all',
    );
  });

  test('nothing to say produces nothing, not an empty sentence', () => {
    assert.equal(announcementLine([], TODAY), null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. ONCE PER BATCH, AND EXEMPT FROM THE CAPS
// ═══════════════════════════════════════════════════════════════════════════

function announceInput(over: Partial<Parameters<typeof decideNoticeAnnouncement>[0]> = {}) {
  return {
    notices: [notice()],
    announcedThrough: null,
    today: TODAY,
    userIsBusy: false,
    quietThisSession: false,
    aiAwake: true,
    ...over,
  };
}

describe('the fourth mouth opens once per batch', () => {
  test('it speaks when there is something nobody has been told about', () => {
    const decision = decideNoticeAnnouncement(announceInput());
    assert.equal(decision.announce, true);
    if (!decision.announce) return;
    assert.equal(decision.count, 1);
    assert.equal(decision.through, `${TODAY}T14:00:00.000Z`);
  });

  test('the SAME batch never comes back', () => {
    const first = decideNoticeAnnouncement(announceInput());
    assert.equal(first.announce, true);
    if (!first.announce) return;
    const second = decideNoticeAnnouncement(announceInput({ announcedThrough: first.through }));
    assert.equal(second.announce, false);
    if (second.announce) return;
    // "already_announced", not "nothing_new". The list still has a row in it
    // and the mark still carries its count; what is spent is the speech.
    assert.equal(second.refusal, 'already_announced');
  });

  test('a NEWER notice after a stamped batch does speak again', () => {
    const stamped = `${TODAY}T14:00:00.000Z`;
    const decision = decideNoticeAnnouncement(announceInput({
      announcedThrough: stamped,
      notices: [
        notice({ taskId: 'old', at: stamped }),
        notice({ taskId: 'new', at: `${TODAY}T16:00:00.000Z` }),
      ],
    }));
    assert.equal(decision.announce, true);
    if (!decision.announce) return;
    // Only the unannounced one is counted. Re-counting the old row would make
    // the second utterance claim more happened than did.
    assert.equal(decision.count, 1);
    assert.equal(decision.through, `${TODAY}T16:00:00.000Z`);
  });

  test('the caps it is exempt from are not consulted at all', () => {
    // The whole founder ruling, held as a shape rather than as a comment: the
    // decision's input carries NO speech count, NO last-spoke time and NO
    // greeted-day, so there is nothing in it a cap could be applied to. A
    // future edit that threads one in has to change this signature.
    const keys = Object.keys(announceInput()).sort();
    assert.deepEqual(keys, [
      'aiAwake', 'announcedThrough', 'notices', 'quietThisSession', 'today', 'userIsBusy',
    ]);
    // And a memory that has already spent every budget still gets its line.
    const spent = {
      ...EMPTY_COMPANION_MEMORY,
      welcomedAt: '2026-07-01T00:00:00.000Z',
      greetedDay: TODAY,
      spokenDay: TODAY,
      spokenCount: 99,
      lastSpokeAt: `${TODAY}T13:59:00.000Z`,
    };
    const decision = decideNoticeAnnouncement(announceInput({
      announcedThrough: spent.noticesAnnouncedThrough,
    }));
    assert.equal(decision.announce, true);
  });

  test('every floor it is NOT exempt from still holds', () => {
    for (const [over, refusal] of [
      [{ aiAwake: false }, 'ai_asleep'],
      [{ quietThisSession: true }, 'quiet_this_session'],
      [{ userIsBusy: true }, 'user_is_busy'],
      [{ notices: [] }, 'nothing_new'],
    ] as const) {
      const decision = decideNoticeAnnouncement(announceInput(over));
      assert.equal(decision.announce, false, `${refusal} let a line through`);
      if (decision.announce) continue;
      assert.equal(decision.refusal, refusal);
    }
  });

  test('asleep is checked before anything else, so a broken provider cannot speak', () => {
    const decision = decideNoticeAnnouncement(announceInput({
      aiAwake: false, quietThisSession: true, userIsBusy: true, notices: [],
    }));
    assert.equal(decision.announce, false);
    if (decision.announce) return;
    assert.equal(decision.refusal, 'ai_asleep');
  });

  test('unannounced degrades to "tell them" on a stamp it cannot read', () => {
    // The safe direction for a stamp whose only job is silencing speech. A
    // forged or corrupt value costs one repeated line; the other way round it
    // costs somebody the message a colleague sent.
    assert.equal(unannounced([notice()], 'not-a-date').length, 1);
    assert.equal(unannounced([notice()], null).length, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. THE READ CURSOR
// ═══════════════════════════════════════════════════════════════════════════

describe('the read cursor', () => {
  test('everything is unread until the list has been opened once', () => {
    const rows = [notice({ taskId: 'a' }), notice({ taskId: 'b' })];
    assert.equal(unreadNotices(rows, null).length, 2);
  });

  test('opening the list advances it, and the count clears', () => {
    const rows = [
      notice({ taskId: 'a', at: `${TODAY}T09:00:00.000Z` }),
      notice({ taskId: 'b', at: `${TODAY}T14:00:00.000Z` }),
    ];
    const newest = newestNoticeAt(rows);
    assert.equal(newest, `${TODAY}T14:00:00.000Z`);
    const seen = rememberNoticesSeen(EMPTY_COMPANION_MEMORY, newest!);
    assert.equal(seen.noticesSeenAt, newest);
    assert.equal(unreadNotices(rows, seen.noticesSeenAt).length, 0);
  });

  test('something that lands AFTER the last look is unread again', () => {
    const seen = `${TODAY}T14:00:00.000Z`;
    const later = notice({ taskId: 'c', at: `${TODAY}T15:00:00.000Z` });
    assert.equal(noticeIsUnread(later, seen), true);
    assert.equal(noticeIsUnread(notice({ at: seen }), seen), false);
  });

  test('both stamps only ever move FORWARD', () => {
    // A second tab, or a replayed request, must not drag either cursor back
    // and make read work unread or make the companion repeat itself.
    const late = rememberNoticesSeen(EMPTY_COMPANION_MEMORY, `${TODAY}T18:00:00.000Z`);
    const backwards = rememberNoticesSeen(late, `${TODAY}T09:00:00.000Z`);
    assert.equal(backwards.noticesSeenAt, `${TODAY}T18:00:00.000Z`);

    const told = rememberNoticesAnnounced(EMPTY_COMPANION_MEMORY, `${TODAY}T18:00:00.000Z`);
    const rewound = rememberNoticesAnnounced(told, `${TODAY}T09:00:00.000Z`);
    assert.equal(rewound.noticesAnnouncedThrough, `${TODAY}T18:00:00.000Z`);
  });

  test('an unreadable instant writes nothing rather than corrupting the stamp', () => {
    assert.equal(rememberNoticesSeen(EMPTY_COMPANION_MEMORY, 'soon').noticesSeenAt, null);
    assert.equal(
      rememberNoticesAnnounced(EMPTY_COMPANION_MEMORY, '').noticesAnnouncedThrough,
      null,
    );
  });

  test('the two stamps are independent: being told is not having looked', () => {
    const told = rememberNoticesAnnounced(EMPTY_COMPANION_MEMORY, `${TODAY}T14:00:00.000Z`);
    assert.equal(told.noticesSeenAt, null,
      'announcing a batch must not silently mark it read; the count is still owed');
    const looked = rememberNoticesSeen(EMPTY_COMPANION_MEMORY, `${TODAY}T14:00:00.000Z`);
    assert.equal(looked.noticesAnnouncedThrough, null);
  });

  test('the parser reads both stamps back, and refuses junk in either', () => {
    const parsed = parseCompanionMemory({
      noticesAnnouncedThrough: `${TODAY}T14:00:00.000Z`,
      noticesSeenAt: `${TODAY}T15:00:00.000Z`,
    });
    assert.equal(parsed.noticesAnnouncedThrough, `${TODAY}T14:00:00.000Z`);
    assert.equal(parsed.noticesSeenAt, `${TODAY}T15:00:00.000Z`);

    const junk = parseCompanionMemory({ noticesAnnouncedThrough: 42, noticesSeenAt: { a: 1 } });
    assert.equal(junk.noticesAnnouncedThrough, null);
    assert.equal(junk.noticesSeenAt, null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. THE POPUP NEVER COVERS THE CONVERSATION
// ═══════════════════════════════════════════════════════════════════════════

function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.left + b.width
    && a.left + a.width > b.left
    && a.top < b.top + b.height
    && a.top + a.height > b.top;
}

/** The panel's rect, derived exactly the way the component derives it. */
function panelRectAt(mark: { x: number; y: number }, viewport: Viewport): Rect {
  const panel = placePanel(mark, viewport);
  const width = panelWidthFor(viewport);
  return {
    left: panel.left,
    width,
    height: panel.maxHeight,
    top: panel.top !== null ? panel.top : viewport.height - (panel.bottom ?? 0) - panel.maxHeight,
  };
}

describe('the notices popup', () => {
  const VIEWPORTS: Viewport[] = [
    { width: 1440, height: 900 },
    { width: 1280, height: 800 },
    { width: 1024, height: 640 },
    { width: 900, height: 1200 },
    { width: 420, height: 780 },
  ];

  test('it never overlaps the panel, wherever the mark has been dragged', () => {
    for (const viewport of VIEWPORTS) {
      for (const x of [0, 40, Math.round(viewport.width / 2), viewport.width - 40, viewport.width]) {
        for (const y of [0, 40, Math.round(viewport.height / 2), viewport.height - 40, viewport.height]) {
          const panel = panelRectAt({ x, y }, viewport);
          const placement = placeNoticesPopup(panel, viewport);
          if (!noticesFits(placement)) continue;
          const popup = noticesRect(placement, viewport);
          assert.equal(
            overlaps(popup, panel), false,
            `the list covered the thread at ${viewport.width}x${viewport.height}, mark ${x},${y}`,
          );
        }
      }
    }
  });

  test('at the resting corner it opens UPWARD, above the panel', () => {
    const viewport = { width: 1440, height: 900 };
    const panel = panelRectAt({ x: 1440 - 26 - 86, y: 900 - 26 - 86 }, viewport);
    const placement = placeNoticesPopup(panel, viewport);
    assert.equal(placement.side, 'above');
    const popup = noticesRect(placement, viewport);
    assert.ok(
      popup.top + popup.height <= panel.top,
      'the popup must end at or above the panel it belongs to',
    );
  });

  test('a mark at the TOP of the screen flips the list below instead', () => {
    // The panel itself flips below when there is no room above it; the list has
    // to make the same decision off the panel's new position rather than
    // insisting on "up" and running off the top of the window.
    const viewport = { width: 1440, height: 900 };
    const panel = panelRectAt({ x: 1200, y: 12 }, viewport);
    const placement = placeNoticesPopup(panel, viewport);
    assert.equal(placement.side, 'below');
    const popup = noticesRect(placement, viewport);
    assert.ok(popup.top >= panel.top + panel.height);
  });

  test('it always stays inside the window', () => {
    for (const viewport of VIEWPORTS) {
      for (const x of [0, viewport.width]) {
        const panel = panelRectAt({ x, y: viewport.height - 112 }, viewport);
        const placement = placeNoticesPopup(panel, viewport);
        if (!noticesFits(placement)) continue;
        const popup = noticesRect(placement, viewport);
        assert.ok(popup.left >= 0, 'popup ran off the left edge');
        assert.ok(popup.left + popup.width <= viewport.width, 'popup ran off the right edge');
        assert.ok(popup.top >= -1, 'popup ran off the top');
        assert.ok(popup.top + popup.height <= viewport.height + 1, 'popup ran off the bottom');
      }
    }
  });

  test('a sliver of a list is not shown at all', () => {
    // A 40px window onto a list is decoration that covers the page. Below the
    // floor the control simply does nothing, which is honest.
    const viewport = { width: 1440, height: 260 };
    const panel = panelRectAt({ x: 1300, y: 130 }, viewport);
    const placement = placeNoticesPopup(panel, viewport);
    assert.equal(noticesFits(placement), placement.maxHeight >= 96);
  });

  test('the motion is the Obsidian language, and reduced motion is a plain fade', () => {
    assert.equal(NOTICES_ENTER_MS, 240);
    assert.equal(NOTICES_EASING, 'cubic-bezier(.22,1,.36,1)');
    assert.equal(noticesEnterMs(false), NOTICES_ENTER_MS);
    assert.equal(noticesEnterMs(true), REDUCED_MOTION_MS);
  });

  test('the popup is never wider than the window allows', () => {
    const viewport = { width: 320, height: 800 };
    const panel = panelRectAt({ x: 200, y: 600 }, viewport);
    const placement = placeNoticesPopup(panel, viewport);
    assert.ok(placement.width <= viewport.width - EDGE_MARGIN * 2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. THE LIST READS TOP TO BOTTOM
// ═══════════════════════════════════════════════════════════════════════════

describe('the list', () => {
  test('newest first, and stable when two land in the same millisecond', () => {
    const same = `${TODAY}T14:00:00.000Z`;
    const rows = sortNotices([
      notice({ taskId: 'b', at: same }),
      notice({ taskId: 'a', at: same }),
      notice({ taskId: 'c', at: `${TODAY}T16:00:00.000Z` }),
    ]);
    assert.deepEqual(rows.map((r) => r.taskId), ['c', 'a', 'b']);
    // Sorting the same list again must not reorder it: a list that shuffles
    // while somebody is reading it looks like a bug even when both orders are
    // equally true.
    assert.deepEqual(sortNotices(rows).map((r) => r.taskId), ['c', 'a', 'b']);
  });

  test('grouped by the HOTEL\'s day, newest day first', () => {
    const days = groupNoticesByDay([
      notice({ taskId: 'a', at: `${TODAY}T09:00:00.000Z` }),
      notice({ taskId: 'b', at: '2026-08-04T22:00:00.000Z' }),
      notice({ taskId: 'c', at: '2026-08-02T10:00:00.000Z' }),
      notice({ taskId: 'd', at: '2026-07-20T10:00:00.000Z' }),
    ], TODAY);
    assert.deepEqual(days.map((d) => d.label), ['Today', 'Yesterday', 'Sunday', 'Jul 20']);
    assert.equal(days[0].items.length, 1);
  });

  test('the day boundary follows the hotel, not the reader', () => {
    // 1am at the hotel on the 5th is still "Today" for a night auditor, and the
    // same instant is a different day by a browser clock in another zone. The
    // hotel's day is the one the whole product counts by.
    const at = `${TODAY}T01:00:00.000Z`;
    assert.equal(dayLabelFor(at, TODAY), 'Today');
    assert.equal(dayLabelFor(at, '2026-08-06'), 'Yesterday');
  });

  test('the count is a small number or an honest 99+, and nothing when clear', () => {
    assert.equal(noticesCountLabel(0), null);
    assert.equal(noticesCountLabel(1), '1');
    assert.equal(noticesCountLabel(99), '99');
    assert.equal(noticesCountLabel(240), '99+');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. THE SENTENCES
// ═══════════════════════════════════════════════════════════════════════════

describe('one plain sentence a row', () => {
  test('each kind reads as what happened', () => {
    assert.equal(
      noticeSentence({ kind: 'assigned', personName: 'Sarah', title: 'Check the pool pump', reason: null }),
      'Sarah gave you "Check the pool pump".',
    );
    assert.equal(
      noticeSentence({ kind: 'done', personName: 'Marcus', title: 'Boiler check', reason: null }),
      'Marcus finished "Boiler check".',
    );
    assert.equal(
      noticeSentence({ kind: 'refused', personName: 'Luis', title: '214 deep clean', reason: 'needs a part' }),
      'Luis could not do "214 deep clean": needs a part.',
    );
  });

  test('the refusal reason is quoted, never paraphrased or dropped', () => {
    const said = 'the guest never left the room and I could not get in';
    const line = noticeSentence({ kind: 'refused', personName: 'Luis', title: '214', reason: said });
    assert.ok(line.includes(said), 'the whole justification for the blocked state is the reason');
  });

  test('a refusal with no reason on it still says what happened', () => {
    assert.equal(
      noticeSentence({ kind: 'refused', personName: 'Luis', title: '214', reason: '   ' }),
      'Luis could not do "214".',
    );
  });

  test('nobody is invented and nothing is left blank', () => {
    assert.equal(noticePerson(null), 'Someone on your team');
    assert.equal(noticePerson('   '), 'Someone on your team');
    assert.equal(noticeTitle(''), 'a job with no name on it');
    assert.equal(noticeReason(null), null);
  });

  test('a title keeps its words and loses only its trailing punctuation', () => {
    assert.equal(noticeTitle('  Check   the pool  pump. '), 'Check the pool pump');
    assert.equal(noticeTitle('Fix A/C in 214!!'), 'Fix A/C in 214');
  });

  test('nothing user-facing here carries an em dash', () => {
    // The producer walk, narrowed to this module. Hotel-supplied words (the
    // title, the reason, the person) are the fixtures' own and are chosen
    // without dashes, so anything found is a joiner Staxis wrote.
    const strings: string[] = [
      NOTICES_EMPTY_LINE,
      NOTICES_TITLE,
      noticesCountLabel(3) ?? '',
      announcementLine([notice({ taskId: 'a' }), notice({ taskId: 'b' })], TODAY) ?? '',
      announcementLine([
        notice({ kind: 'done', taskId: 'c', personName: 'Marcus', title: 'Boiler check' }),
        notice({ kind: 'refused', taskId: 'd', personName: 'Luis', title: '214', reason: 'needs a part' }),
      ], null) ?? '',
      dayLabelFor('2026-08-02T10:00:00.000Z', TODAY),
      noticePerson(null),
      noticeTitle(''),
    ];
    for (const kind of ['assigned', 'done', 'refused'] as const) {
      strings.push(noticeSentence({
        kind, personName: 'Luis', title: '214 deep clean', reason: 'needs a part',
      }));
      strings.push(noticeSentence({ kind, personName: null, title: '', reason: null }));
    }
    assert.ok(strings.length >= 12, 'the walk went vacuous');
    for (const value of strings) {
      assert.equal(value.includes('—'), false, `em dash in: ${value}`);
    }
  });

  test('the word "notifications" appears nowhere, and neither does "AI"', () => {
    // Founder ruling. "Notices" is something a colleague put in front of you; a
    // notification is something an app decided you should look at, and the word
    // carries every habit this product is trying not to have.
    const labels = companionLabels();
    const surface = [
      NOTICES_EMPTY_LINE, NOTICES_TITLE,
      labels.notices, labels.showNotices, labels.openNotices, labels.closeNotices,
    ];
    for (const value of surface) {
      assert.ok(value, 'a notices label is missing');
      assert.equal(/notification/i.test(value), false, `"${value}" says notification`);
      assert.equal(/\bAI\b/.test(value), false, `"${value}" says AI`);
    }
    assert.equal(labels.notices, 'Notices');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. NEVER A HOUSEKEEPER
// ═══════════════════════════════════════════════════════════════════════════

describe('housekeeping gets no notices, by two independent gates', () => {
  test('the hat has no chat, which is what the route ships notices behind', () => {
    // The bootstrap route computes `awake` from chatIsMountedForRole and ships
    // an EMPTY notices array when it is false. This is that predicate, held
    // here so a change to it fails in a test named after the consequence.
    assert.equal(chatIsMountedForRole('housekeeping'), false);
    for (const role of ['admin', 'owner', 'general_manager', 'front_desk', 'maintenance', 'staff'] as const) {
      assert.equal(chatIsMountedForRole(role), true, `${role} lost its chat`);
    }
  });

  test('the companion does not mount on a housekeeper screen for anybody', () => {
    // The second, independent refusal. A general manager opening a
    // housekeeper's SMS link gets no bubble, so no notices either.
    assert.equal(
      companionMounts({ pathname: '/housekeeper/abc', role: 'general_manager' }).mounts,
      false,
    );
    assert.equal(companionMounts({ pathname: '/feed', role: 'housekeeping' }).mounts, false);
    assert.equal(companionMounts({ pathname: '/feed', role: 'general_manager' }).mounts, true);
  });
});
