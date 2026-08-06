/**
 * THE "ADD A TO-DO" ROW: ITS STATE MACHINE, ITS COLOURS, AND ITS FALLBACK.
 *
 * The composer is one row that has to hold two ways of answering the same three
 * questions — writing them in a sentence, or tapping the word that says them —
 * without ever becoming a form. Almost everything that can go wrong with it is
 * invisible in a screenshot: the wrong row opens, a word goes the wrong colour,
 * an Add button creeps back, Escape closes the whole thing instead of the
 * buttons. So this drives the real component and reads what it produced.
 *
 * `ComposerView` is hook-free and fully controlled (list-rows.tsx's own rule),
 * which is exactly what makes this possible under `--conditions=react-server`,
 * where react-dom/server will not load: the element tree is walked, a handler
 * is invoked, and the state it handed back is the assertion.
 *
 * The second half covers the OPTIONAL model reading. Every test there is a test
 * that it stays optional: it is skipped when the code already understood, it is
 * dropped when it names somebody who does not work here, and every failure of
 * it leaves the row exactly as it was.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';

import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import Module from 'node:module';

import { emptyParse, parseTodo, type ComposerPerson, type ParseResult } from '@/lib/feed/parse-todo';
import {
  INTERPRET_MIN_WORDS,
  matchRoster,
  sanitizeInterpretation,
  shouldInterpret,
} from '@/lib/feed/interpret-todo';
import {
  COMPOSER_COPY,
  COMPOSER_OTHER,
  otherHint,
  promptExample,
  PROMPT_EXAMPLES,
} from '@/lib/feed/one-list-copy';

// Thursday 30 July 2026.
const NOW = new Date(2026, 6, 30, 9, 0, 0);
const MARCUS = 'staff-marcus';
const ROSTER: readonly ComposerPerson[] = [
  { staffId: MARCUS, name: 'Marcus Webb' },
  { staffId: 'staff-dana', name: 'Dana' },
];

// ── the React shim ──────────────────────────────────────────────────────────
// Same shim and the same reason as staxis-list-surface.test.ts: React 19's
// react-server build exports no createContext, and list-rows.tsx reaches the
// concourse icon module. Nothing here mounts a component that uses hooks.
const nodeRequire = Module.createRequire(`${process.cwd()}/package.json`);

type RowsModule = typeof import('@/components/concourse/list-rows');
type CssModule = typeof import('@/components/concourse/concourse-css');
let rows: RowsModule;
let css: string;

before(async () => {
  const react = nodeRequire('react') as Record<string, unknown>;
  if (typeof react.createContext !== 'function') {
    react.createContext = (defaultValue: unknown) => ({
      Provider: () => null, Consumer: () => null, _currentValue: defaultValue,
    });
  }
  rows = await import('@/components/concourse/list-rows');
  const cssModule: CssModule = await import('@/components/concourse/concourse-css');
  css = `${rows.LIST_CSS}\n${cssModule.FEED_CSS_FOR_TEST_ONLY()}`;
});

// ── walking what the component produced ─────────────────────────────────────

interface Node { type: unknown; props: Record<string, unknown> }

function findAll(node: unknown, match: (el: Node) => boolean, out: Node[] = []): Node[] {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const n of node) findAll(n, match, out); return out; }
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (el.props) {
    const candidate = { type: el.type, props: el.props };
    if (match(candidate)) out.push(candidate);
    findAll(el.props.children, match, out);
  }
  return out;
}

function textOf(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const n of node) textOf(n, out); return out; }
  const el = node as { props?: Record<string, unknown> };
  if (el.props) {
    for (const [key, value] of Object.entries(el.props)) {
      if (key === 'children') { textOf(value, out); continue; }
      if (/^(placeholder|aria-label)$/.test(key) && typeof value === 'string') out.push(value);
    }
  }
  return out;
}

function className(el: Node): string {
  return typeof el.props.className === 'string' ? el.props.className : '';
}

/** Every button whose visible label is exactly `label`. */
function buttons(tree: unknown, label: string): Node[] {
  return findAll(tree, (el) => el.type === 'button' && textOf(el.props.children).join('').trim() === label);
}

interface Driver {
  tree: unknown;
  /** The state the component handed back through onChange, if it did. */
  next: ComposerStateShape | null;
  submitted: boolean;
  cancelled: boolean;
}

type ComposerStateShape = ReturnType<RowsModule['composerDefaults']>;

function base(over: Partial<ComposerStateShape> = {}): ComposerStateShape {
  return { ...rows.composerDefaults('2026-07-30', 4), ...over };
}

function render(state: ComposerStateShape, props: Record<string, unknown> = {}): Driver {
  const driver: Driver = { tree: null, next: null, submitted: false, cancelled: false };
  driver.tree = rows.ComposerView({
    open: true,
    state,
    people: ROSTER,
    now: NOW,
    onOpen: () => {},
    onCancel: () => { driver.cancelled = true; },
    onChange: (n: ComposerStateShape) => { driver.next = n; },
    onSubmit: () => { driver.submitted = true; },
    ...props,
  } as Parameters<RowsModule['ComposerView']>[0]);
  return driver;
}

/** Tap the word that says `text` and return the state it produced. */
function tapWord(state: ComposerStateShape, text: string): ComposerStateShape {
  const driver = render(state);
  const word = findAll(driver.tree, (el) => el.type === 'button' && className(el).startsWith('fx-compword')
    && textOf(el.props.children).join('').trim() === text);
  assert.equal(word.length, 1, `expected exactly one word reading "${text}"`);
  (word[0].props.onClick as () => void)();
  assert.ok(driver.next, 'tapping a word produced no new state');
  return driver.next;
}

/** Tap the option button labelled `label` and return the state it produced. */
function tapButton(state: ComposerStateShape, label: string): ComposerStateShape {
  const driver = render(state);
  const found = buttons(driver.tree, label).filter((el) => className(el).startsWith('fx-compb'));
  assert.equal(found.length, 1, `expected exactly one button labelled "${label}"`);
  (found[0].props.onClick as (e?: unknown) => void)();
  assert.ok(driver.next, 'tapping a button produced no new state');
  return driver.next;
}

/** The SENTENCE field, by its own class: the repeat line has a number in it. */
function sentenceField(tree: unknown): Node {
  const input = findAll(tree, (el) => el.type === 'input' && className(el).startsWith('fx-comptitle'));
  assert.equal(input.length, 1, 'the row must have exactly one sentence field');
  return input[0];
}

function press(driver: Driver, key: string): void {
  const input = [sentenceField(driver.tree)];
  (input[0].props.onKeyDown as (e: unknown) => void)({
    key, preventDefault: () => {},
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. the state machine
// ═══════════════════════════════════════════════════════════════════════════

describe('one word, one row of buttons', () => {
  test('tapping a word with text open opens ONLY that word\'s row', () => {
    const typed = base({ title: 'Check the boiler room', repeat: 'weekly', weekday: 5, source: { who: 'default', when: 'default', repeat: 'parsed' } });
    const opened = tapWord(typed, 'every Friday');
    assert.equal(opened.openRow, 'repeat');

    const after = render(opened);
    // The REPEAT row is there...
    assert.equal(buttons(after.tree, 'Every week').length, 1);
    // ...and the other two are not. This is the whole difference between this
    // design and the rejected one that opened three menus at once.
    assert.equal(buttons(after.tree, 'Tomorrow').length, 0, 'the WHEN row must stay shut');
    assert.equal(buttons(after.tree, 'You').length, 0, 'the WHO row must stay shut');
  });

  test('tapping the same word again closes it', () => {
    const opened = base({ title: 'x', openRow: 'repeat' });
    assert.equal(tapWord(opened, 'once').openRow, null);
  });

  test('tapping a word with NOTHING typed opens all three', () => {
    const opened = tapWord(base(), 'today');
    assert.equal(opened.openRow, 'all');
    const after = render(opened);
    assert.equal(buttons(after.tree, 'You').length, 1, 'the WHO row is missing');
    assert.equal(buttons(after.tree, 'Tomorrow').length, 1, 'the WHEN row is missing');
    assert.equal(buttons(after.tree, 'Every week').length, 1, 'the REPEAT row is missing');
  });

  test('with all three open and nothing typed, every word reads as chosen', () => {
    // The person is looking at their own answers, not at something understood.
    const driver = render(base({ openRow: 'all' }));
    const words = findAll(driver.tree, (el) => className(el).startsWith('fx-compword'));
    assert.equal(words.length, 3);
    for (const word of words) assert.match(className(word), /fx-pick/, 'a word did not read as chosen');
  });

  test('tapping a button sets the value, marks it chosen, and LEAVES THE ROW OPEN', () => {
    const open = base({ title: 'Check the boiler', openRow: 'repeat' });
    const picked = tapButton(open, 'Every week');
    assert.equal(picked.repeat, 'weekly');
    assert.equal(picked.source.repeat, 'chosen');
    assert.equal(picked.openRow, 'repeat', 'a row that closes on the first tap cannot be corrected');
  });

  test('the row a tap opened does not submit anything', () => {
    const driver = render(base({ title: 'x', openRow: 'repeat' }));
    const every = buttons(driver.tree, 'Every week')[0];
    (every.props.onClick as () => void)();
    assert.equal(driver.submitted, false, 'choosing is not sending');
  });

  test('a typed sentence cannot move a value somebody already tapped', () => {
    const chosen = base({ title: 'Check the boiler', repeat: 'monthly', source: { who: 'default', when: 'default', repeat: 'chosen' } });
    const typed = rows.withParse(chosen, parseTodo('check the boiler every Friday', ROSTER, NOW), 4);
    assert.equal(typed.repeat, 'monthly', 'typing overrode a thumb');
    assert.equal(typed.source.repeat, 'chosen');
  });
});

describe('the colours say where each answer came from', () => {
  test('a value lifted from the sentence is caramel', () => {
    const state = rows.withParse(base({ title: 'check the boiler every Friday' }), parseTodo('check the boiler every Friday', ROSTER, NOW), 4);
    const driver = render(state);
    const repeatWordEl = findAll(driver.tree, (el) => className(el).startsWith('fx-compword')
      && textOf(el.props.children).join('').includes('every Friday'));
    assert.equal(repeatWordEl.length, 1);
    assert.match(className(repeatWordEl[0]), /fx-lift/, 'a lifted cadence must read as understood');
  });

  test('a value somebody tapped is sage', () => {
    const picked = tapButton(base({ title: 'x', openRow: 'repeat' }), 'Every week');
    // "Every week" on a Thursday IS every Thursday, and the row says so: the
    // payload really does carry a weekday, and a word reading "every week" over
    // a template pinned to Thursday would be a lie of omission.
    assert.equal(picked.weekday, 4);
    const driver = render(picked);
    const word = findAll(driver.tree, (el) => className(el).startsWith('fx-compword')
      && textOf(el.props.children).join('').includes('every Thursday'));
    assert.equal(word.length, 1, 'the cadence word did not read back the day it was pinned to');
    assert.match(className(word[0]), /fx-pick/, 'a tapped cadence must read as chosen');
  });

  test('an untouched default is neither', () => {
    const driver = render(base());
    for (const word of findAll(driver.tree, (el) => className(el).startsWith('fx-compword'))) {
      assert.equal(className(word), 'fx-compword', 'a default must not wear an accent');
    }
  });

  // A name in a sentence is a decision the person made out loud, not something
  // that was worked out about them. The design calls it sage for that reason.
  test('a name written in the sentence reads as chosen, not as understood', () => {
    const state = rows.withParse(base(), parseTodo('have Marcus check the pool', ROSTER, NOW), 4);
    assert.equal(state.who, MARCUS);
    assert.equal(state.source.who, 'chosen');
  });
});

describe('there is no Add button, and Enter is the only commit', () => {
  test('nothing anywhere in the row is an Add or a Cancel button', () => {
    for (const state of [base(), base({ title: 'x' }), base({ title: 'x', openRow: 'all' }), base({ openRow: 'all' })]) {
      const driver = render(state);
      assert.equal(buttons(driver.tree, 'Add').length, 0, 'an Add button came back');
      assert.equal(buttons(driver.tree, 'Adding…').length, 0);
      assert.equal(buttons(driver.tree, 'Cancel').length, 0, 'a Cancel button came back');
    }
  });

  test('Enter sends once there are words', () => {
    const driver = render(base({ title: 'Fix the ice machine' }));
    press(driver, 'Enter');
    assert.equal(driver.submitted, true);
  });

  test('Enter on an empty row sends nothing', () => {
    const driver = render(base());
    press(driver, 'Enter');
    assert.equal(driver.submitted, false);
  });

  test('Enter while a save is already in flight sends nothing twice', () => {
    const driver = render(base({ title: 'Fix the ice machine' }), { busy: true });
    press(driver, 'Enter');
    assert.equal(driver.submitted, false);
  });

  test('Escape closes the buttons first, and only then gives up the row', () => {
    const open = render(base({ title: 'x', openRow: 'when' }));
    press(open, 'Escape');
    assert.equal(open.next?.openRow, null, 'the first Escape must close the buttons');
    assert.equal(open.cancelled, false, 'the first Escape must not throw the sentence away');

    const shut = render(base({ title: 'x', openRow: null }));
    press(shut, 'Escape');
    assert.equal(shut.cancelled, true, 'the second Escape gives up the row');
  });

  test('the mono hint says what Enter would do, and what is happening', () => {
    assert.match(textOf(render(base({ title: 'x' })).tree).join(' | '), /Enter/);
    assert.match(textOf(render(base({ title: 'x' }), { busy: true }).tree).join(' | '), /Adding/);
    assert.match(textOf(render(base({ openRow: 'all' })).tree).join(' | '), /Enter to add/);
  });
});

describe('the WHO row, and the line that used to sit under it', () => {
  test('the housekeeping line is gone from every state the row can reach', () => {
    // Deleted 2026-08-05. It explained who was MISSING, under a list of who is
    // there, over a row nobody had asked anything of yet.
    for (const openRow of [null, 'who', 'when', 'repeat', 'all'] as const) {
      const text = textOf(render(base({ title: 'x', openRow })).tree).join(' | ');
      assert.ok(
        !/housekeep/i.test(text),
        `a line about housekeeping came back with openRow=${openRow}`,
      );
    }
  });

  test('the WHO row offers you, the roster, the three roles, and Other', () => {
    const driver = render(base({ title: 'x', openRow: 'who' }));
    const labels = findAll(driver.tree, (el) => className(el).startsWith('fx-compb'))
      .map((el) => textOf(el.props.children).join('').trim());
    assert.deepEqual(labels, [
      'You', 'Marcus Webb', 'Dana', "Whoever's on front desk", 'Maintenance', 'Everyone', 'Other',
    ]);
  });

  test('Other is not one of the answers: it never carries a value and is never selected', () => {
    const driver = render(base({ title: 'x', openRow: 'who' }));
    const other = buttons(driver.tree, COMPOSER_COPY.other)
      .filter((el) => className(el).includes('fx-compother'));
    assert.equal(other.length, 1, 'the Other chip is missing');
    // Not a radio, so it cannot be the selected answer to "who".
    assert.equal(other[0].props.role, undefined);
    assert.equal(other[0].props['aria-checked'], undefined);
    assert.ok(!className(other[0]).includes('fx-sel'));
  });

  test('tapping Other shows the hint and CHANGES NOBODY', () => {
    const state = base({ title: 'x', openRow: 'who' });
    const driver = render(state);
    const other = buttons(driver.tree, COMPOSER_COPY.other)
      .filter((el) => className(el).includes('fx-compother'))[0];
    // The handler reaches for the field through the DOM, which does not exist
    // here. It must still produce the state change, so the DOM half is the
    // half that is allowed to fail.
    (other.props.onClick as (e: unknown) => void)({ currentTarget: null });
    assert.ok(driver.next, 'tapping Other produced no new state');
    assert.equal(driver.next.otherHint, true);
    assert.equal(driver.next.who, state.who, 'Other moved the assignee');
    assert.equal(driver.next.source.who, 'default', 'Other answered a question nobody asked');

    // ...and the hint then says the thing that makes typing a name findable.
    const after = render(driver.next);
    assert.ok(textOf(after.tree).join(' | ').includes(otherHint('Marcus Webb')));
  });

  test('picking a real person afterwards spends the hint', () => {
    // The hint says a name can be TYPED. Somebody who then tapped one off the
    // list did not need it, and a line that stays put reads as an instruction
    // they failed to follow.
    const hinted = base({ title: 'x', openRow: 'who', otherHint: true });
    assert.match(textOf(render(hinted).tree).join(' | '), /Type their name in the sentence/);
    const picked = tapButton(hinted, 'Marcus Webb');
    assert.equal(picked.otherHint, false);
    assert.ok(!/Type their name in the sentence/.test(textOf(render(picked).tree).join(' | ')));
  });

  test('a row still carrying Other is submittable, and goes to the person adding it', () => {
    const payload = rows.composerPayload(base({ title: 'x', who: COMPOSER_OTHER }), 'my-staff-id');
    assert.equal(payload?.assignedStaffId, 'my-staff-id');
    assert.equal(payload?.assignedDepartment, null);
  });
});

describe('the repeat line: one line, and a blank at the end of it', () => {
  test('it is one horizontally scrolling line, not a block that wraps', () => {
    const driver = render(base({ title: 'x', openRow: 'repeat' }));
    const group = findAll(driver.tree, (el) => className(el).includes('fx-compopts'));
    assert.equal(group.length, 1);
    assert.match(className(group[0]), /fx-compscroll/, 'the cadence row is allowed to reflow');
  });

  test('it offers the seven cadences in the founder\'s order', () => {
    const driver = render(base({ title: 'x', openRow: 'repeat' }));
    const labels = findAll(driver.tree, (el) => el.props.role === 'radio' && className(el).startsWith('fx-compb'))
      .map((el) => textOf(el.props.children).join('').trim());
    assert.deepEqual(labels, [
      'Once', 'Every day', 'Every 3 days', 'Every 4 days', 'Every week', 'Every 2 weeks', 'Every month',
    ]);
  });

  test('a fixed every-N-days chip selects itself and nothing else', () => {
    const picked = tapButton(base({ title: 'x', openRow: 'repeat' }), 'Every 3 days');
    assert.equal(picked.repeat, 'every_n_days');
    assert.equal(picked.intervalDays, '3');
    assert.equal(picked.source.repeat, 'chosen');

    const after = render(picked);
    const selected = findAll(after.tree, (el) => el.props['aria-checked'] === true
      && className(el).startsWith('fx-compb'))
      .map((el) => textOf(el.props.children).join('').trim());
    assert.deepEqual(selected, ['Every 3 days'], 'two cadences read as chosen at once');
  });

  test('typing a number into the blank IS choosing the cadence', () => {
    const driver = render(base({ title: 'x', openRow: 'repeat' }));
    const blank = findAll(driver.tree, (el) => className(el) === 'fx-compnum');
    assert.equal(blank.length, 1, 'the blank is missing from the repeat line');
    (blank[0].props.onChange as (e: unknown) => void)({ target: { value: '45' } });
    assert.equal(driver.next?.repeat, 'every_n_days');
    assert.equal(driver.next?.intervalDays, '45');
    assert.equal(rows.composerPayload({ ...driver.next!, title: 'x' }, 'me')?.intervalDays, 45);
  });

  test('the blank refuses letters, and emptying it goes back to a one-off', () => {
    const driver = render(base({ title: 'x', openRow: 'repeat', repeat: 'every_n_days', intervalDays: '45' }));
    const blank = findAll(driver.tree, (el) => className(el) === 'fx-compnum')[0];
    (blank.props.onChange as (e: unknown) => void)({ target: { value: '4a5' } });
    assert.equal(driver.next?.intervalDays, '45', 'a letter reached the number');

    (blank.props.onChange as (e: unknown) => void)({ target: { value: '' } });
    assert.equal(driver.next?.repeat, 'once', 'an empty blank left a repeat with no gap in it');
    assert.equal(driver.next?.intervalDays, '');
  });

  test('a gap the chips already cover lights the CHIP, not the blank', () => {
    // Otherwise "every 3 days" typed into the blank shows two things selected.
    const driver = render(base({ title: 'x', openRow: 'repeat', repeat: 'every_n_days', intervalDays: '3' }));
    const blankChip = findAll(driver.tree, (el) => className(el).startsWith('fx-compevery'))[0];
    assert.ok(!className(blankChip).includes('fx-sel'));
    const blank = findAll(driver.tree, (el) => className(el) === 'fx-compnum')[0];
    assert.equal(blank.props.value, '', 'the blank kept a number the chip is already showing');
  });

  test('the word above the row reads back the gap that was chosen', () => {
    const text = textOf(render(base({
      title: 'x', repeat: 'every_n_days', intervalDays: '45',
      source: { who: 'default', when: 'default', repeat: 'chosen' },
    })).tree).join(' | ');
    assert.match(text, /every 45 days/);
  });

  test('a number the cadence cannot carry says so, quietly, and never blocks Enter', () => {
    const driver = render(base({ title: 'x', openRow: 'repeat', repeat: 'every_n_days', intervalDays: '900' }));
    assert.match(textOf(driver.tree).join(' | '), /Pick a number between 2 and 365/);
    assert.equal(findAll(driver.tree, (el) => className(el).includes('sl-err')).length, 0);
    press(driver, 'Enter');
    assert.equal(driver.submitted, true, 'a hint that blocks the row is an error in disguise');
  });
});

describe('the prompt rotates real examples', () => {
  test('the idle field shows an example, and a different one on the next tick', () => {
    const first = sentenceField(render(base()).tree);
    const second = sentenceField(render(base(), { promptTick: 1 }).tree);
    assert.ok(PROMPT_EXAMPLES.length > 1, 'one example is not a rotation');
    assert.equal(first.props.placeholder, promptExample(0));
    assert.equal(second.props.placeholder, promptExample(1));
    assert.notEqual(first.props.placeholder, second.props.placeholder);
  });

  test('the accessible name never rotates with it', () => {
    // A control that renames itself every few seconds is unusable with a
    // screen reader, which is the whole risk this feature carries.
    for (const promptTick of [0, 1, 2, 97, -4]) {
      const field = sentenceField(render(base(), { promptTick }).tree);
      assert.equal(field.props['aria-label'], 'What needs doing');
      assert.ok(typeof field.props.placeholder === 'string' && field.props.placeholder.length > 0);
    }
  });

  test('the examples give way once somebody has opened the buttons with nothing typed', () => {
    const field = sentenceField(render(base({ openRow: 'all' })).tree);
    assert.equal(field.props.placeholder, COMPOSER_COPY.promptChoosing);
  });
});

describe('the question, which is never an error', () => {
  const asked = parseTodo('fix room 214 ac Friday', ROSTER, NOW);

  test('it renders its line, both answers, and what Enter would take', () => {
    const driver = render(base({ title: asked.title, when: asked.when! }), { question: asked.question });
    const text = textOf(driver.tree).join(' | ');
    assert.match(text, /Which Friday\?/);
    assert.match(text, /This Friday/);
    assert.match(text, /Every Friday/);
    assert.match(text, /Enter takes this Friday\./);
    // Not an error, and not a blocker.
    assert.equal(findAll(driver.tree, (el) => className(el).includes('sl-err')).length, 0);
  });

  test('it never blocks Enter', () => {
    const driver = render(base({ title: asked.title }), { question: asked.question });
    press(driver, 'Enter');
    assert.equal(driver.submitted, true, 'a question that blocks the row is an error in disguise');
  });

  test('answering it marks the answer chosen', () => {
    const driver = render(base({ title: asked.title }), { question: asked.question });
    const every = buttons(driver.tree, 'Every Friday')[0];
    (every.props.onClick as () => void)();
    assert.equal(driver.next?.repeat, 'weekly');
    assert.equal(driver.next?.source.repeat, 'chosen');
    assert.equal(driver.next?.weekday, 5);
  });
});

describe('speaking instead of typing', () => {
  test('the mic is offered when the browser has one, and not when it does not', () => {
    assert.equal(findAll(render(base()).tree, (el) => className(el).startsWith('fx-compmic')).length, 1);
    assert.equal(
      findAll(render(base(), { micAvailable: false }).tree, (el) => className(el).startsWith('fx-compmic')).length,
      0,
      'an affordance that does nothing is worse than none',
    );
  });

  test('while it is held the row shows a level and says how to stop', () => {
    const driver = render(base({ title: 'check the boiler' }), { recording: true });
    assert.equal(findAll(driver.tree, (el) => className(el) === 'fx-compmeter').length, 1);
    assert.match(textOf(driver.tree).join(' | '), /Let go when you are done/);
    assert.match(className(sentenceField(driver.tree)), /fx-live/, 'the words must read as speech while they are being said');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. every class the row names is a class that exists
// ═══════════════════════════════════════════════════════════════════════════

describe('the row is fully styled in every state it can reach', () => {
  test('nothing it names is undefined in the stylesheet', () => {
    // The regression this guards: the 2026-08-01 redesign moved geometry
    // between stylesheets and dropped `.sl-sw` while a component still asked
    // for it. The switch silently lost its layout. This is a no-runtime
    // invariant, so it is checked as one.
    const states: ComposerStateShape[] = [
      base(),
      base({ title: 'Fix the ice machine' }),
      base({ title: 'x', openRow: 'who' }),
      base({ title: 'x', openRow: 'when' }),
      base({ title: 'x', openRow: 'repeat', repeat: 'weekly', weekday: 5 }),
      // The states that draw the two quiet hint lines and the blank, which
      // nothing else in this matrix reaches.
      base({ title: 'x', openRow: 'who', otherHint: true }),
      base({ title: 'x', openRow: 'repeat', repeat: 'every_n_days', intervalDays: '45' }),
      base({ title: 'x', openRow: 'repeat', repeat: 'every_n_days', intervalDays: '900' }),
      base({ openRow: 'all' }),
      base({ title: 'x', who: MARCUS, source: { who: 'chosen', when: 'default', repeat: 'default' } }),
      base({ title: 'x', repeat: 'daily', source: { who: 'default', when: 'default', repeat: 'parsed' } }),
    ];
    const named = new Set<string>();
    for (const state of states) {
      for (const extra of [{}, { busy: true }, { recording: true }, { error: 'nope' }, { teachLine: 'tip' },
        { question: parseTodo('fix room 214 ac Friday', ROSTER, NOW).question }]) {
        const driver = render(state, extra);
        for (const el of findAll(driver.tree, (node) => typeof node.props.className === 'string')) {
          for (const token of className(el).split(/\s+/)) if (token) named.add(token);
        }
      }
    }
    assert.ok(named.size > 15, `expected the walk to reach the row, saw ${named.size} classes`);
    const missing = [...named].filter((token) => !css.includes(`.${token}`)).sort();
    assert.deepEqual(missing, [], `classes used but never defined: ${missing.join(', ')}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. the optional second reading
// ═══════════════════════════════════════════════════════════════════════════

describe('the second reading only happens when the code path found nothing', () => {
  const LONG = 'can somebody take a look at the boiler before the weekend';

  test('it is skipped entirely when the plain parser already lifted something', () => {
    for (const sentence of [
      'check the boiler room every Friday please and thank you',
      'have Marcus take a good look at the boiler room soon',
      'take a good long look at the boiler room tomorrow morning',
    ]) {
      const parsed = parseTodo(sentence, ROSTER, NOW);
      assert.equal(shouldInterpret(sentence, parsed), false, `${sentence} did not need a second reading`);
    }
  });

  test('it is skipped when the parser understood enough to ask a question', () => {
    const sentence = 'somebody go and look at the boiler room on the Friday';
    const parsed = parseTodo(sentence, ROSTER, NOW);
    assert.ok(parsed.when || parsed.question, 'fixture no longer exercises the branch');
    assert.equal(shouldInterpret(sentence, parsed), false);
  });

  test('it is skipped on a short sentence that plainly means what it says', () => {
    for (const sentence of ['fix the ice machine', 'reseat the breaker', 'call the plumber back']) {
      assert.ok(sentence.split(/\s+/).length < INTERPRET_MIN_WORDS);
      assert.equal(shouldInterpret(sentence, parseTodo(sentence, ROSTER, NOW)), false);
    }
  });

  test('it happens on a long sentence the code could not read at all', () => {
    const parsed = parseTodo(LONG, ROSTER, NOW);
    assert.equal(parsed.who, null);
    assert.equal(parsed.when, null);
    assert.equal(parsed.repeat, null);
    assert.equal(shouldInterpret(LONG, parsed), true);
  });

  test('an empty or oversized sentence is never sent', () => {
    assert.equal(shouldInterpret('', emptyParse()), false);
    assert.equal(shouldInterpret('a '.repeat(300), emptyParse()), false);
  });
});

describe('what a reading is allowed to come back with', () => {
  const RAW = 'can somebody take a look at the boiler before the weekend';

  test('a person who does not work here is dropped', () => {
    const read = sanitizeInterpretation(RAW, {
      who: 'Priya', when: null, repeat: null, weekday: null, dayOfMonth: null, phrases: [],
    }, ROSTER, NOW);
    assert.equal(read, null, 'a name off the roster is the whole of that reading, so it is nothing');
  });

  // Housekeepers are absent from the roster listAssignees returns, which is the
  // roster the SERVER passes here. So the check that keeps a stranger out is
  // the same check that keeps a housekeeper out.
  test('a housekeeper can never be matched, because they are not on the roster', () => {
    assert.equal(matchRoster('Rosa', ROSTER), null);
    assert.equal(matchRoster('marcus', ROSTER), MARCUS, 'a real first name still matches, case and all');
    assert.equal(matchRoster('MARCUS WEBB', ROSTER), MARCUS);
    assert.equal(matchRoster('', ROSTER), null);
    assert.equal(matchRoster('M', ROSTER), null, 'an initial is not a match');
  });

  test('a reading that claims nothing believable is nothing at all', () => {
    for (const reading of [
      null, 'text', 42, {},
      { who: null, when: 'not a date', repeat: 'sometimes', weekday: 99, dayOfMonth: 44, phrases: [] },
      { who: 'Priya', when: '2020-01-01', repeat: null, weekday: null, dayOfMonth: null, phrases: [] },
    ]) {
      assert.equal(sanitizeInterpretation(RAW, reading, ROSTER, NOW), null);
    }
  });

  test('a day already gone is refused rather than quietly back-dated', () => {
    const read = sanitizeInterpretation(RAW, {
      who: 'Marcus', when: '2020-01-01', repeat: null, weekday: null, dayOfMonth: null, phrases: [],
    }, ROSTER, NOW);
    assert.equal(read?.when, null, 'a to-do must never arrive already late');
    assert.equal(read?.who, MARCUS);
  });

  test('it cannot author the task: only phrases the person actually wrote are cut', () => {
    const read = sanitizeInterpretation(RAW, {
      who: null,
      when: '2026-07-31',
      repeat: null,
      weekday: null,
      dayOfMonth: null,
      // The first is real; the rest are invented, and must change nothing.
      phrases: ['before the weekend', 'URGENT', 'call the vendor immediately'],
    }, ROSTER, NOW);
    assert.equal(read?.title, 'Can somebody take a look at the boiler');
    assert.ok(!read!.title.includes('URGENT'));
    assert.ok(!read!.title.includes('vendor'));
  });

  test('it never asks a question of its own', () => {
    const read = sanitizeInterpretation(RAW, {
      who: 'Marcus', when: null, repeat: 'weekly', weekday: 5, dayOfMonth: null, phrases: [],
    }, ROSTER, NOW);
    assert.equal(read?.question, null, 'two uncertainties in a row is a form');
  });
});

describe('a reading changes nothing it is not allowed to change', () => {
  const RAW = 'can somebody take a look at the boiler before the weekend';

  test('a timeout, an error or a switched-off slot leaves the row exactly as it was', () => {
    // Every one of those paths reaches the composer as "no reading". This is
    // that state, applied.
    const before = rows.withParse(base({ title: RAW }), parseTodo(RAW, ROSTER, NOW), 4);
    const after = rows.withParse(before, emptyParse(before.title), 4, { whoAs: 'parsed' });
    assert.deepEqual(after, before, 'a failed reading moved something');
  });

  test('when it does land, it lands as caramel and never as sage', () => {
    const before = rows.withParse(base({ title: RAW }), parseTodo(RAW, ROSTER, NOW), 4);
    const read = sanitizeInterpretation(RAW, {
      who: 'Marcus', when: '2026-07-31', repeat: null, weekday: null, dayOfMonth: null, phrases: [],
    }, ROSTER, NOW) as ParseResult;
    const after = rows.withParse(before, read, 4, { whoAs: 'parsed' });
    assert.equal(after.who, MARCUS);
    assert.equal(after.source.who, 'parsed', 'a name a model proposed is a reading, not a decision');
    assert.equal(after.source.when, 'parsed');
    // ...and it still cannot touch anything a thumb already answered.
    const tapped = { ...before, source: { ...before.source, who: 'chosen' as const }, who: 'dept:maintenance' };
    assert.equal(rows.withParse(tapped, read, 4, { whoAs: 'parsed' }).who, 'dept:maintenance');
  });

  test('the payload it produces is still a calendar day, and still the same shape', () => {
    const read = sanitizeInterpretation(RAW, {
      who: 'Marcus', when: '2026-07-31', repeat: null, weekday: null, dayOfMonth: null, phrases: ['before the weekend'],
    }, ROSTER, NOW) as ParseResult;
    const state = rows.withParse(base({ title: RAW }), read, 4, { whoAs: 'parsed' });
    const payload = rows.composerPayload(state, 'me');
    assert.equal(payload?.assignedStaffId, MARCUS);
    assert.equal(payload?.dueDate, '2026-07-31', 'a day, never an instant');
    assert.equal(payload?.repeat, 'once');
  });
});
