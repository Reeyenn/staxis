import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { StaffMember } from '@/types';
import { dayInfo, type BoardShift } from '@/lib/schedule-board';
import { DayBoard } from '@/app/staff/_components/schedule/DayBoard';
import { WeekRoster } from '@/app/staff/_components/schedule/WeekRoster';
import type { OpenShift } from '@/app/staff/_components/schedule/useScheduleData';

const DOM_GLOBALS = [
  'window',
  'document',
  'navigator',
  'Element',
  'HTMLElement',
  'Node',
  'Event',
  'EventTarget',
  'MouseEvent',
  'MutationObserver',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'getComputedStyle',
] as const;

type Browser = { restore(): void };

function installBrowser(): Browser {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/staff',
  });
  const originals = new Map<string, PropertyDescriptor | undefined>();

  for (const key of DOM_GLOBALS) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const candidate = dom.window[key as keyof typeof dom.window];
    const value = typeof candidate === 'function' && (
      key === 'requestAnimationFrame'
      || key === 'cancelAnimationFrame'
      || key === 'getComputedStyle'
    )
      ? candidate.bind(dom.window)
      : candidate;
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }

  Object.defineProperty(dom.window, 'matchMedia', {
    configurable: true,
    value: (media: string) => ({
      matches: false,
      media,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });

  const actFlag = 'IS_REACT_ACT_ENVIRONMENT';
  originals.set(actFlag, Object.getOwnPropertyDescriptor(globalThis, actFlag));
  Object.defineProperty(globalThis, actFlag, {
    configurable: true,
    writable: true,
    value: true,
  });

  return {
    restore() {
      dom.window.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

async function flushMicrotasks(rounds = 4): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

async function render(root: Root, element: React.ReactElement): Promise<void> {
  await act(async () => {
    root.render(element);
    await flushMicrotasks();
  });
}

function mount(context: TestContext, browser: Browser): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  context.after(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    context.mock.timers.reset();
    browser.restore();
  });
  return { container, root };
}

function staff(id: string, name: string): StaffMember {
  return {
    id,
    name,
    language: 'en',
    isSenior: false,
    department: 'housekeeping',
    scheduledToday: false,
    weeklyHours: 0,
    maxWeeklyHours: 40,
    isActive: true,
  };
}

const WEEK_DATES = [
  '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05',
  '2026-08-06', '2026-08-07', '2026-08-08',
] as const;
const WEEK_DAYS = WEEK_DATES.map(date => dayInfo(date, WEEK_DATES[0], 'en'));

function shift(id: string, staffId: string, dayIndex: number, hours: number): BoardShift {
  const startMin = 8 * 60;
  return {
    id,
    staffId,
    dept: 'housekeeping',
    startMin,
    endMin: startMin + hours * 60,
    nonce: dayIndex,
  };
}

function exactText(container: HTMLElement, value: string): HTMLElement | undefined {
  return Array.from(container.querySelectorAll<HTMLElement>('span'))
    .find(element => element.textContent === value);
}

describe('staff operational information component rendering', { concurrency: false }, () => {
  test('WeekRoster renders schedule hours, exact-cap near status, and over-cap status', async (context) => {
    const browser = installBrowser();
    const { container, root } = mount(context, browser);
    const near = staff('near', 'Near Limit');
    const exact = staff('exact', 'Exact Cap');
    const over = staff('over', 'Over Cap');
    const shiftsByDate = new Map<string, BoardShift[]>();
    const add = (next: BoardShift) => {
      const list = shiftsByDate.get(WEEK_DATES[next.nonce ?? 0]) ?? [];
      list.push(next);
      shiftsByDate.set(WEEK_DATES[next.nonce ?? 0], list);
    };

    [9, 9, 9, 9].forEach((hours, index) => add(shift(`near-${index}`, near.id, index, hours)));
    [8, 8, 8, 8, 8].forEach((hours, index) => add(shift(`exact-${index}`, exact.id, index, hours)));
    [8, 8, 8, 8, 9].forEach((hours, index) => add(shift(`over-${index}`, over.id, index, hours)));

    await render(root, (
      <WeekRoster
        days={WEEK_DAYS}
        getDay={date => shiftsByDate.get(date) ?? []}
        staff={[near, exact, over]}
        lang="en"
        reducedMotion
      />
    ));

    const text = container.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    assert.match(text, /Scheduled 36\/40h · Near limit/);
    assert.match(text, /Scheduled 40\/40h · Near limit/);
    assert.match(text, /Scheduled 41\/40h · Over limit/);
    assert.doesNotMatch(text, /worked hours|attendance|clocked in|on shift/i);
  });

  test('DayBoard places Scheduled now beside a short shift time at its inclusive start and exclusive end', async (context) => {
    const browser = installBrowser();
    context.mock.timers.enable({
      apis: ['Date', 'setInterval'],
      now: new Date('2026-05-15T01:00:00Z'),
    });
    const { container, root } = mount(context, browser);
    const shortShift: BoardShift = {
      id: 'short',
      staffId: 'ava',
      dept: 'housekeeping',
      startMin: 20 * 60,
      endMin: 21 * 60 + 30,
    };

    await render(root, (
      <DayBoard
        shifts={[shortShift]}
        presets={[]}
        isToday
        timezone="America/Chicago"
        lang="en"
        nameOf={() => 'Ava Chen'}
        otTitles={new Map()}
        readOnlyStaffIds={new Set()}
        openShifts={[]}
        onUpdate={() => {}}
        onGestureStart={() => {}}
        onGestureEnd={() => {}}
        onRemove={() => {}}
        onTapShift={() => {}}
        onTapOpenShift={() => {}}
      />
    ));

    const badge = exactText(container, 'Scheduled now');
    const time = exactText(container, '8p–9:30p');
    assert.ok(badge, 'the property-local start time is inside the shift');
    assert.ok(time, 'the existing short-shift time remains visible');
    assert.equal(badge.parentElement, time.parentElement, 'badge and time share the existing inline treatment');
    const block = badge.closest('div[title]');
    assert.ok(block);
    assert.ok(block.contains(time));

    await act(async () => {
      context.mock.timers.tick(90 * 60_000);
      await flushMicrotasks();
    });
    assert.equal(exactText(container, 'Scheduled now'), undefined, 'the shift end is exclusive');
    assert.doesNotMatch(container.textContent ?? '', /worked hours|attendance|clocked in|on shift/i);
  });

  test('DayBoard respects the existing overnight shift convention', async (context) => {
    const browser = installBrowser();
    context.mock.timers.enable({
      apis: ['Date', 'setInterval'],
      now: new Date('2026-05-15T04:30:00Z'),
    });
    const { container, root } = mount(context, browser);
    const overnight: BoardShift = {
      id: 'overnight',
      staffId: 'night-auditor',
      dept: 'front_desk',
      startMin: 23 * 60,
      endMin: 31 * 60,
    };

    await render(root, (
      <DayBoard
        shifts={[overnight]}
        presets={[]}
        isToday
        timezone="America/Chicago"
        lang="en"
        nameOf={() => 'Night Auditor'}
        otTitles={new Map()}
        openShifts={[]}
        onUpdate={() => {}}
        onGestureStart={() => {}}
        onGestureEnd={() => {}}
        onRemove={() => {}}
        onTapShift={() => {}}
        onTapOpenShift={() => {}}
      />
    ));

    assert.ok(exactText(container, 'Scheduled now'));
    assert.ok(exactText(container, '11p–7a'));

    await act(async () => {
      context.mock.timers.tick(2 * 60 * 60_000);
      await flushMicrotasks();
    });
    assert.equal(exactText(container, 'Scheduled now'), undefined, 'the overnight row belongs to its start date');
  });

  test('DayBoard shows an open shift as an unstaffed slot that opens the editor', async (context) => {
    const browser = installBrowser();
    const { container, root } = mount(context, browser);
    const tapped: string[] = [];
    const openSlot: OpenShift = {
      id: 'open-1',
      date: '2026-08-04',
      dept: 'housekeeping',
      startMin: 10 * 60,
      endMin: 18 * 60,
      note: null,
      reason: 'Coverage reopened when a staff profile was archived',
      visibleToStaff: true,
    };

    await render(root, (
      <DayBoard
        shifts={[]}
        openShifts={[openSlot]}
        presets={[]}
        isToday={false}
        timezone="America/Chicago"
        lang="en"
        nameOf={() => 'Nobody'}
        otTitles={new Map()}
        onUpdate={() => {}}
        onGestureStart={() => {}}
        onGestureEnd={() => {}}
        onRemove={() => {}}
        onTapShift={() => {}}
        onTapOpenShift={(id) => { tapped.push(id); }}
      />
    ));

    const text = container.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    assert.match(text, /Open shift/, 'the uncovered slot is named on the board');
    assert.match(text, /1 OPEN/, 'the department lane counts its uncovered slots');

    const hkLane = container.querySelector<HTMLElement>('[data-lane="housekeeping"]');
    assert.ok(hkLane, 'the slot lands in its own department lane');
    assert.doesNotMatch(
      hkLane.textContent ?? '',
      /No one on .* yet\. Use ＋ Add staff above\./,
      'a lane holding an open slot is not also reported as untouched',
    );
    const fdLane = container.querySelector<HTMLElement>('[data-lane="front_desk"]');
    assert.match(
      fdLane?.textContent ?? '',
      /No one on .* yet\. Use ＋ Add staff above\./,
      'a genuinely empty lane keeps its existing prompt',
    );

    const chip = Array.from(container.querySelectorAll('button'))
      .find(button => (button.textContent ?? '').includes('Open shift'));
    assert.ok(chip, 'the open slot is a real button, not a decorated div');
    assert.match(
      chip.style.border,
      /dashed/,
      'an uncovered slot must not read as a filled shift at a glance',
    );

    await act(async () => {
      chip.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flushMicrotasks();
    });
    assert.deepEqual(tapped, ['open-1'], 'tapping an open slot opens its editor');
  });

  test('WeekRoster marks the days that still have uncovered slots', async (context) => {
    const browser = installBrowser();
    const { container, root } = mount(context, browser);
    const person = staff('ava', 'Ava Chen');

    await render(root, (
      <WeekRoster
        days={WEEK_DAYS}
        getDay={() => []}
        staff={[person]}
        lang="en"
        reducedMotion
        openCountByDate={{ '2026-08-04': 2 }}
      />
    ));

    const text = container.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    assert.match(text, /2 OPEN/, 'the day column carries the uncovered count');
    assert.equal(
      (text.match(/OPEN/g) ?? []).length,
      1,
      'only the day that actually has uncovered slots is marked',
    );
  });

  test('preserves the approved wording boundary and existing print labels', () => {
    const scheduleSource = readFileSync(join(process.cwd(), 'src/app/staff/_components/schedule/index.tsx'), 'utf8');
    assert.match(scheduleSource, /<th>\$\{'HOURS'\}<\/th>/);
    assert.match(scheduleSource, /<td class="name">\$\{'ON SHIFT'\}<\/td>/);
    assert.doesNotMatch(scheduleSource, /Scheduled today/);
    assert.doesNotMatch(scheduleSource, /<th>\$\{'SCHEDULED'\}<\/th>/);
  });
});
