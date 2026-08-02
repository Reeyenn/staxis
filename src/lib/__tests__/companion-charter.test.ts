/**
 * THE COMPANION'S CHARTER, ENFORCED.
 *
 * src/lib/companion/charter.ts lists six promises the companion makes to the
 * person using it. A promise in a comment is a wish. Each clause below is the
 * matching test, named after the clause, so a change that breaks a promise
 * fails here rather than in front of a hotel.
 *
 *   1. never acts without a yes, and shows a receipt after
 *   2. never spends money
 *   3. honest about ability, and honest when it is asleep
 *   4. one voice: warm, brief, plain English, no em dashes
 *   5. English only
 *   6. never on a housekeeper screen
 *
 * ─── THE COPY WALK ─────────────────────────────────────────────────────────
 *
 * The dash and language rules use the producer-walking method from
 * findings-copy-rules.test.ts rather than a source grep, for the reason written
 * at the top of that file: the dash that actually shipped arrived through a
 * joiner in one file wrapping a fragment from another, and neither file read
 * wrong on its own. So `everyCompanionString()` CALLS the real producers across
 * every role, every candidate shape, every page and every failure reason, and
 * reads what comes back. The collector is deep and structure-agnostic, so a new
 * string field on any of these shapes is covered the day it appears without
 * anybody remembering to come back here.
 *
 * The vacuity guard at the bottom is load-bearing. A walk that silently returns
 * nothing passes forever.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ALL_ROLES, type AppRole } from '@/lib/roles';
import { COMPANION_VOICE } from '@/lib/companion/charter';
import { companionAllowedOnPath, companionMounts } from '@/lib/companion/mount';
import {
  COMPANION_PAGES,
  isCompanionPageKey,
  pageForPath,
  pagesFor,
  resolveDestination,
  tourFor,
  introFor,
  type CompanionPageKey,
} from '@/lib/companion/pages';
import {
  QUIET_TODAY,
  arrivalLine,
  cleanName,
  companionLabels,
  dailyHelloLine,
  greetingLine,
  looksSharedLogin,
  offerQuestion,
  offerSentence,
  ruleAttribution,
  ruleReadBack,
  ruleRemovedLine,
  ruleSavedLine,
  sleepLine,
  teachLine,
  todayFact,
  tourQuestion,
  welcomeGreeting,
  type SleepReason,
  type TeachFlow,
} from '@/lib/companion/copy';
import {
  EMPTY_COMPANION_MEMORY,
  decideCompanionSpeech,
  decideDailyHello,
  decideTeachMoment,
  type MannersInput,
} from '@/lib/companion/manners';

// ─── The walk ───────────────────────────────────────────────────────────────

const EM_DASH = '—';

/** Deep, recursive, structure-agnostic. Same collector as the findings guard. */
function collect(value: unknown, label: string, out: Array<[string, string]>): void {
  if (typeof value === 'string') {
    out.push([label, value]);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => collect(item, `${label}[${i}]`, out));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) collect(inner, `${label}.${key}`, out);
  }
}

const SLEEP_REASONS: readonly SleepReason[] = ['provider_down', 'cost_cap', 'section_off', 'unknown'];
const TEACH_FLOWS: readonly TeachFlow[] = ['create_task', 'log_book_entry', 'announcement'];
const PAGE_KEYS: readonly CompanionPageKey[] = COMPANION_PAGES.map((p) => p.key);

function everyCompanionString(): Array<[string, string]> {
  const out: Array<[string, string]> = [];

  // Fixed labels.
  collect(companionLabels(), 'labels', out);

  // Per role: the greeting, both shared and personal, and the tour question.
  for (const role of ALL_ROLES) {
    for (const sharedLogin of [false, true]) {
      collect(
        welcomeGreeting({ firstName: 'Maria', role, sharedLogin }),
        `welcome(${role},shared=${sharedLogin})`,
        out,
      );
    }
    collect(tourQuestion(role), `tour(${role})`, out);
  }

  // Per page: the intro, which is also the arrival line and the tour script.
  for (const key of PAGE_KEYS) {
    collect(introFor(key), `intro(${key})`, out);
    collect(arrivalLine(key), `arrival(${key})`, out);
  }
  collect(COMPANION_PAGES.map((p) => p.label), 'pageLabels', out);

  // The offer sentence, in both the single-hotel and named-hotel shapes, over a
  // range of source wordings including one that starts with an acronym.
  for (const text of [
    '3 rooms have no clean bath towels.',
    'PTAC units in 201 to 240 are overdue for a filter change.',
    'The pool pump has failed twice this month.',
  ]) {
    for (const multiHotel of [false, true]) {
      collect(
        offerSentence({ text, hotelName: 'Comfort Suites Beaumont', multiHotel }),
        `offer(${multiHotel})`,
        out,
      );
    }
  }
  collect(offerQuestion(null), 'offerQuestion(none)', out);
  for (const page of COMPANION_PAGES) collect(offerQuestion(page), `offerQuestion(${page.key})`, out);

  // Saying hello: the panel's opening line and the once-a-day greeting, over
  // every hour bucket, both name shapes, and with and without a true fact.
  for (const hour of [null, 0, 7, 12, 14, 18, 21, 23]) {
    for (const sharedLogin of [false, true]) {
      for (const waiting of [0, 1, 4]) {
        const shape = { firstName: 'Maria', sharedLogin, hour, fact: todayFact({ waiting }) };
        collect(greetingLine(shape), `greeting(${hour},${sharedLogin},${waiting})`, out);
        collect(dailyHelloLine(shape), `hello(${hour},${sharedLogin},${waiting})`, out);
      }
    }
  }
  collect(QUIET_TODAY, 'quietToday', out);
  for (const waiting of [1, 2, 40]) collect(todayFact({ waiting }) ?? '', `todayFact(${waiting})`, out);
  for (const hour of [null, 9, 20]) {
    collect(
      decideDailyHello({
        today: '2026-08-01',
        person: { firstName: 'Maria', sharedLogin: false },
        memory: { ...EMPTY_COMPANION_MEMORY, welcomedAt: '2026-07-01T12:00:00.000Z' },
        hour,
        waiting: 2,
        userIsBusy: false,
        quietThisSession: false,
        aiAwake: true,
      }),
      `helloDecision(${hour})`,
      out,
    );
  }

  // Sleep, in every reason it can have.
  for (const reason of SLEEP_REASONS) collect(sleepLine(reason), `sleep(${reason})`, out);

  // Teach, in every flow.
  for (const flow of TEACH_FLOWS) collect(teachLine(flow), `teach(${flow})`, out);

  // Standing rules: read-back, both receipts, and the attribution line.
  for (const rule of [
    'always tell me before any order over $200',
    'never promise a late checkout without asking me',
  ]) {
    collect(ruleReadBack(rule), 'ruleReadBack', out);
    collect(ruleSavedLine(rule), 'ruleSaved', out);
    collect(ruleRemovedLine(rule), 'ruleRemoved', out);
  }
  collect(
    ruleAttribution({ authorName: 'Maria', authorRole: 'general_manager', createdAt: '2026-07-30T12:00:00Z' }),
    'ruleAttribution',
    out,
  );
  collect(
    ruleAttribution({ authorName: null, authorRole: null, createdAt: 'not-a-date' }),
    'ruleAttribution(unknown)',
    out,
  );

  // And the engine's own rendered output, which is where a joiner would live.
  for (const role of ['owner', 'general_manager', 'front_desk', 'maintenance'] as const) {
    for (const multiHotel of [false, true]) {
      const speech = decideCompanionSpeech(mannersFixture({ role, multiHotel }));
      collect(speech, `speech(${role},${multiHotel})`, out);
    }
    const welcome = decideCompanionSpeech(mannersFixture({
      role, memory: { ...EMPTY_COMPANION_MEMORY }, wizardAlreadyRan: false,
    }));
    collect(welcome, `welcomeSpeech(${role})`, out);
    for (const flow of TEACH_FLOWS) {
      collect(
        decideTeachMoment({
          flow,
          memory: { ...EMPTY_COMPANION_MEMORY },
          role,
          userIsBusy: false,
          quietThisSession: false,
          aiAwake: true,
        }),
        `teachDecision(${role},${flow})`,
        out,
      );
    }
  }

  // Silence reasons are machine words, not sentences, and are excluded on
  // purpose: they never reach a person. Everything above does.
  return out.filter(([label]) => !/\.reason$/.test(label) && !/\.refusal$/.test(label));
}

/**
 * The hotel's own words, subtracted before any style rule is applied.
 *
 * Straight from findings-copy-rules.test.ts, which learned this the hard way: a
 * shipped fixture is genuinely named "PTAC units — rooms 201-240", and a guard
 * that called that a Staxis em dash would be pressure to start editing customer
 * data to please a style rule.
 *
 * The companion has the sharpest version of this problem, because a standing
 * rule is quoted back VERBATIM by design. "never promise a late checkout" is a
 * house rule somebody typed; the word "checkout" in it is not Staxis offering
 * to buy anything. So the quoted rule, the hotel name and the finding sentences
 * are removed, and what is left is the words Staxis chose.
 */
const HOTEL_SUPPLIED: readonly string[] = [
  'always tell me before any order over $200',
  'never promise a late checkout without asking me',
  'never say "we are full" to a walk in',
  'Comfort Suites Beaumont',
  '3 rooms have no clean bath towels.',
  'PTAC units in 201 to 240 are overdue for a filter change.',
  'The pool pump has failed twice this month.',
  'Maria',
];

function staxisWordsOnly(value: string): string {
  let out = value;
  for (const supplied of HOTEL_SUPPLIED) out = out.split(supplied).join(' ');
  return out;
}

/** The walk, with every hotel-supplied fragment subtracted. */
function staxisStrings(): Array<[string, string]> {
  return everyCompanionString().map(([k, v]) => [k, staxisWordsOnly(v)] as [string, string]);
}

function mannersFixture(over: Partial<MannersInput> & { role?: AppRole } = {}): MannersInput {
  const { role, ...rest } = over;
  return {
    now: new Date('2026-08-01T17:00:00.000Z'),
    today: '2026-08-01',
    person: { firstName: 'Maria', role: role ?? 'general_manager', sharedLogin: false },
    memory: {
      ...EMPTY_COMPANION_MEMORY,
      welcomedAt: '2026-07-01T00:00:00.000Z',
      tourDeclined: true,
    },
    candidates: [{
      topic: 'finding:linen',
      text: '3 rooms have no clean bath towels.',
      sensitivity: 'operational',
      covers: ['finding:1'],
      destination: 'inventory',
    }],
    onScreen: [],
    userIsBusy: false,
    quietThisSession: false,
    aiAwake: true,
    wizardAlreadyRan: true,
    multiHotel: false,
    hotelName: 'Comfort Suites Beaumont',
    ...rest,
  };
}

// ─── Clause 4: one voice ────────────────────────────────────────────────────

describe('charter: one voice', () => {
  test('no user-facing companion string contains an em dash', () => {
    const offenders = staxisStrings()
      .filter(([, value]) => value.includes(EM_DASH))
      .map(([key, value]) => `${key}: ${value}`);
    assert.deepEqual(
      offenders,
      [],
      'Em dashes are not used in Staxis copy. Use a full stop, a comma or a colon.\n'
      + offenders.join('\n'),
    );
  });

  test('no companion string shouts, sells or decorates', () => {
    // Exclamation marks, emoji and marketing words. The companion is a
    // colleague; a colleague does not say "powerful" or put a rocket in a
    // sentence about towels.
    const BANNED = /(!|seamless|powerful|effortless|revolutionary|unlock|supercharge|amazing|delight|magic)/i;
    const EMOJI = /\p{Extended_Pictographic}/u;
    const offenders = staxisStrings()
      .filter(([, v]) => BANNED.test(v) || EMOJI.test(v))
      .map(([k, v]) => `${k}: ${v}`);
    assert.deepEqual(offenders, [], offenders.join('\n'));
  });

  test('every sentence is short enough to read in a glance', () => {
    // The bubble is a corner of somebody's screen while they are working. A
    // paragraph in it is a paragraph nobody reads.
    const offenders = everyCompanionString()
      .filter(([, v]) => v.length > 220)
      .map(([k, v]) => `${k} (${v.length} chars): ${v.slice(0, 60)}…`);
    assert.deepEqual(offenders, [], offenders.join('\n'));
  });

  test('the walk actually walks something', () => {
    // A guard whose walk silently returns nothing passes forever.
    const corpus = everyCompanionString();
    assert.ok(corpus.length > 120, `only ${corpus.length} strings walked`);
    // And the hotel-data subtraction must not have eaten the corpus: a
    // staxisWordsOnly that returned '' would make every style rule above pass
    // forever. Most strings must still carry real Staxis words after it.
    const withWords = staxisStrings().filter(([, v]) => v.trim().length > 12);
    assert.ok(withWords.length > 100, `only ${withWords.length} strings survived the subtraction`);
    const labels = corpus.map(([k]) => k);
    for (const required of ['labels.', 'welcome(', 'intro(', 'sleep(', 'teach(', 'ruleSaved', 'speech(']) {
      assert.ok(labels.some((l) => l.startsWith(required)), `walk is missing ${required}`);
    }
    // And it reaches every page and every sleep reason, not just the first.
    for (const key of PAGE_KEYS) assert.ok(labels.includes(`intro(${key})`), `intro(${key}) not walked`);
    for (const reason of SLEEP_REASONS) assert.ok(labels.includes(`sleep(${reason})`), `sleep(${reason}) not walked`);
  });
});

// ─── Clause 5: English only ─────────────────────────────────────────────────

describe('charter: English only', () => {
  test('no companion string is Spanish, and none carries an es sibling', () => {
    // Founder ruling 2026-07-29. The plausible bug is somebody helpfully
    // backfilling an `es:` next to copy they touched, which is exactly what the
    // ruling forbids. Two signals: Spanish-only characters, and the giveaway
    // words that only appear in the translations this product no longer has.
    const SPANISH = /[¿¡]|\b(está|habitación|limpieza|mañana|día|más|sí|cómo|gracias|hotel de)\b/i;
    const offenders = staxisStrings()
      .filter(([, v]) => SPANISH.test(v))
      .map(([k, v]) => `${k}: ${v}`);
    assert.deepEqual(offenders, [], offenders.join('\n'));
  });
});

// ─── Clause 6: never on a housekeeper screen ────────────────────────────────

describe('charter: never on a housekeeper screen', () => {
  test('refuses on every housekeeper and laundry path, whoever is looking', () => {
    // The bubble mounts inside AppLayout, and those pages do not import
    // AppLayout today. That is a fact about a file layout, and file layouts
    // move. This is the gate that does not depend on it.
    const offLimits = [
      '/housekeeper',
      '/housekeeper/',
      '/housekeeper/abc-123',
      '/housekeeper/abc-123?pid=x&staffId=y',
      '/laundry',
      '/laundry/abc-123',
    ];
    for (const path of offLimits) {
      assert.equal(companionAllowedOnPath(path), false, `${path} allowed the companion`);
      // Including for an owner who opened a housekeeper's own link.
      const decision = companionMounts({ pathname: path, role: 'owner' });
      assert.equal(decision.mounts, false, `${path} mounted for an owner`);
      assert.ok(!decision.mounts);
      assert.equal(decision.refusal, 'off_limits_screen');
    }
  });

  test('the manager housekeeping board keeps its companion', () => {
    // /housekeeping is the manager screen and shares a prefix with /housekeeper.
    // A sloppy startsWith would take the bubble off a screen it belongs on.
    assert.equal(companionAllowedOnPath('/housekeeping'), true);
    assert.equal(companionMounts({ pathname: '/housekeeping', role: 'general_manager' }).mounts, true);
  });

  test('a housekeeping hat gets no companion anywhere, on any screen', () => {
    for (const path of ['/dashboard', '/feed', '/inventory', '/housekeeping']) {
      const decision = companionMounts({ pathname: path, role: 'housekeeping' });
      assert.equal(decision.mounts, false, `${path} mounted for a housekeeper`);
      assert.ok(!decision.mounts);
      assert.equal(decision.refusal, 'role_has_no_chat');
    }
  });

  test('every other operational hat does get one', () => {
    for (const role of ['admin', 'owner', 'general_manager', 'front_desk', 'maintenance', 'staff'] as const) {
      assert.equal(companionMounts({ pathname: '/dashboard', role }).mounts, true, role);
    }
  });

  test('signed-out and setup surfaces are off limits too', () => {
    for (const path of ['/signin', '/signup', '/onboard', '/onboard/step-2', '/join', '/invite/abc', '/privacy']) {
      assert.equal(companionAllowedOnPath(path), false, path);
    }
  });

  test('a missing or malformed path refuses rather than defaulting to allowed', () => {
    for (const path of [null, undefined, '', 'housekeeper', 'https://evil.example/housekeeper']) {
      assert.equal(companionAllowedOnPath(path as string | null | undefined), false, String(path));
    }
  });

  test('no role means no companion', () => {
    const decision = companionMounts({ pathname: '/dashboard', role: null });
    assert.equal(decision.mounts, false);
    assert.ok(!decision.mounts);
    assert.equal(decision.refusal, 'no_role');
  });
});

// ─── Navigation is an allowlist ─────────────────────────────────────────────

describe('navigation', () => {
  test('every destination is an in-app path, never an external URL', () => {
    for (const page of COMPANION_PAGES) {
      assert.match(page.href, /^\/[A-Za-z0-9\-_/]*(\?[A-Za-z0-9=&_-]*)?$/, page.key);
      assert.equal(page.href.startsWith('//'), false, `${page.key} is protocol-relative`);
      assert.match(page.path, /^\/[A-Za-z0-9\-_/]*$/, page.key);
    }
  });

  test('a key that is not on the list resolves to nothing', () => {
    const ctx = { role: 'owner' as AppRole, enabledSections: null };
    for (const key of [
      'https://evil.example',
      '/etc/passwd',
      'javascript:alert(1)',
      '../admin',
      '',
      null,
      undefined,
      42,
      { href: '/admin' },
    ]) {
      assert.equal(resolveDestination(key, ctx), null, String(key));
      assert.equal(isCompanionPageKey(key), false, String(key));
    }
  });

  test('a manager-only screen is never offered to a line role', () => {
    const line = { role: 'front_desk' as AppRole, enabledSections: null };
    for (const page of COMPANION_PAGES.filter((p) => p.managerOnly)) {
      assert.equal(resolveDestination(page.key, line), null, page.key);
    }
    const manager = { role: 'general_manager' as AppRole, enabledSections: null };
    for (const page of COMPANION_PAGES.filter((p) => p.managerOnly)) {
      assert.ok(resolveDestination(page.key, manager), page.key);
    }
  });

  test('a screen this hotel switched off is not offered', () => {
    // Walking somebody into a locked door is worse than staying quiet.
    const ctx = { role: 'owner' as AppRole, enabledSections: { inventory: false } };
    assert.equal(resolveDestination('inventory', ctx), null);
    assert.ok(resolveDestination('dashboard', ctx));
    assert.equal(pagesFor(ctx).some((p) => p.key === 'inventory'), false);
  });

  test('a hotel with no stored section map gets every screen, not none', () => {
    // The whole default-ON contract. `flags[x] === true` here would hide every
    // destination at every hotel that has never touched the switches.
    const ctx = { role: 'owner' as AppRole, enabledSections: null };
    assert.equal(pagesFor(ctx).length, COMPANION_PAGES.length);
  });

  test('the tour is role-sized and never contains a screen the person cannot open', () => {
    for (const role of ['owner', 'general_manager', 'front_desk', 'maintenance'] as const) {
      const ctx = { role, enabledSections: null };
      const tour = tourFor(ctx);
      assert.ok(tour.length > 0, role);
      const allowed = new Set(pagesFor(ctx).map((p) => p.key));
      for (const page of tour) assert.ok(allowed.has(page.key), `${role} tour includes ${page.key}`);
      // No screen twice.
      assert.equal(new Set(tour.map((p) => p.key)).size, tour.length, role);
    }
    const ownerTour = tourFor({ role: 'owner', enabledSections: null }).map((p) => p.key);
    const deskTour = tourFor({ role: 'front_desk', enabledSections: null }).map((p) => p.key);
    assert.notDeepEqual(ownerTour, deskTour);
    assert.equal(deskTour.includes('settings'), false);
    assert.equal(deskTour.includes('people'), false);
  });

  test('every page has an intro, and it is one or two plain sentences', () => {
    for (const page of COMPANION_PAGES) {
      const intro = introFor(page.key);
      assert.ok(intro.length > 40, `${page.key} intro is a stub`);
      const sentences = intro.split('. ').length;
      assert.ok(sentences <= 3, `${page.key} intro runs to ${sentences} sentences`);
    }
  });

  test('pageForPath ignores query and trailing slash', () => {
    assert.equal(pageForPath('/feed')?.key, 'staxis');
    assert.equal(pageForPath('/feed?tab=knows')?.key, 'staxis');
    assert.equal(pageForPath('/feed/')?.key, 'staxis');
    assert.equal(pageForPath('/nowhere'), null);
    assert.equal(pageForPath(null), null);
  });
});

// ─── Clause 3: honest ───────────────────────────────────────────────────────

describe('charter: honest about ability', () => {
  test('every sleep reason has its own plain sentence, and none promises a time', () => {
    const seen = new Set<string>();
    for (const reason of SLEEP_REASONS) {
      const line = sleepLine(reason);
      assert.ok(line.length > 20, reason);
      assert.equal(seen.has(line), false, `${reason} reuses another reason's sentence`);
      seen.add(line);
      // No invented deadline. "Try again in five minutes" is a lie told
      // precisely; the cost cap's "in the morning" is a real boundary.
      assert.equal(/\b(\d+)\s*(second|minute|hour)s?\b/i.test(line), false, reason);
    }
  });

  test('the sleep copy says what still works, so nobody thinks Staxis is down', () => {
    for (const reason of ['provider_down', 'cost_cap', 'unknown'] as const) {
      assert.match(sleepLine(reason), /still works/i, reason);
    }
  });

  test('a teach line only ever names a flow that has a real tool behind it', () => {
    // Charter clause 3. "Next time just tell me" about something the companion
    // cannot do is the exact dishonesty this clause exists for, and it is why
    // adding a person is not on the list: there is no invite tool in the agent
    // catalog. If somebody adds a flow here, they must add its tool too.
    const REAL_TOOLS: Record<TeachFlow, string> = {
      create_task: 'create_todo',
      log_book_entry: 'add_logbook_entry',
      announcement: 'post_announcement',
    };
    assert.deepEqual(Object.keys(REAL_TOOLS).sort(), [...TEACH_FLOWS].sort());
    for (const flow of TEACH_FLOWS) {
      assert.ok(teachLine(flow).example.length > 10, flow);
    }
  });
});

// ─── Clause 1 and 2: consent and money ──────────────────────────────────────

describe('charter: consent and money', () => {
  test('every unprompted thing the companion says is answerable yes or no', () => {
    const welcome = decideCompanionSpeech(mannersFixture({
      memory: { ...EMPTY_COMPANION_MEMORY }, wizardAlreadyRan: false,
    }));
    assert.ok(welcome.kind === 'welcome');
    assert.match(welcome.question, /\?$/);

    const offer = decideCompanionSpeech(mannersFixture());
    assert.ok(offer.kind === 'offer');
    // The offer's own question comes from offerQuestion, over every
    // destination it can carry plus the no-destination case.
    assert.match(offerQuestion(null), /\?$/);
    for (const page of COMPANION_PAGES) assert.match(offerQuestion(page), /\?$/);
  });

  test('the companion never offers to spend money', () => {
    // Clause 2. Ordering is out of its reach entirely, and no sentence it can
    // produce offers to buy, order or pay for anything.
    const SPEND = /\b(buy|purchase|order it|place the order|pay for|paying for|reorder for you|spend)\b/i;
    const offenders = staxisStrings()
      .filter(([, v]) => SPEND.test(v))
      .map(([k, v]) => `${k}: ${v}`);
    assert.deepEqual(offenders, [], offenders.join('\n'));
  });

  test('a standing rule is read back verbatim, and the receipt quotes what was stored', () => {
    // Clause 1. The read-back is what somebody agrees to, so a paraphrase would
    // mean approving one sentence and storing another.
    const rule = 'always tell me before any order over $200';
    assert.ok(ruleReadBack(rule).includes(rule));
    assert.ok(ruleSavedLine(rule).includes(rule));
    assert.ok(ruleRemovedLine(rule).includes(rule));
    // And the read-back asks. It does not announce.
    assert.match(ruleReadBack(rule), /\?$/);
    // While the receipt does not ask. It reports.
    assert.equal(/\?$/.test(ruleSavedLine(rule)), false);
  });

  test('a rule containing a quote cannot break out of the quoted read-back', () => {
    const rule = 'never say "we are full" to a walk in';
    const readBack = ruleReadBack(rule);
    // Exactly two straight quotes: the pair this sentence added.
    assert.equal((readBack.match(/"/g) ?? []).length, 2);
  });
});

// ─── The instruction layer ──────────────────────────────────────────────────

describe('the voice, as the model receives it', () => {
  test('the instruction layer states the rules it is meant to enforce', () => {
    // Model-facing text is exempt from the dash rule (same carve-out as tool
    // descriptions), which is why it is not in the walk. What it must do is
    // actually carry the instructions, so a future edit cannot quietly empty it.
    for (const required of [/em dash/i, /plain English/i, /brief|short/i, /emoji/i]) {
      assert.match(COMPANION_VOICE, required);
    }
    assert.ok(COMPANION_VOICE.length > 200);
  });
});

// ─── The naming predicates ──────────────────────────────────────────────────

describe('greeting somebody by name', () => {
  test('refuses an address, a blank, or anything that is not a name', () => {
    for (const raw of ['front@hotel.com', '', '   ', '123', '!!!', null, undefined, 'x'.repeat(40)]) {
      assert.equal(cleanName(raw as string | null), null, String(raw));
    }
  });

  test('takes the first word of a full name', () => {
    assert.equal(cleanName('Maria Gonzalez'), 'Maria');
    assert.equal(cleanName('  Jean-Luc  Picard '), 'Jean-Luc');
    assert.equal(cleanName("O'Brien"), "O'Brien");
  });

  test('a job title is treated as a shared login, not as somebody called Front', () => {
    for (const name of ['Front Desk', 'Reception', 'Manager', 'front@hotel.com', 'Demo']) {
      assert.equal(looksSharedLogin(name), true, name);
    }
    assert.equal(looksSharedLogin('Maria Gonzalez'), false);
  });
});

// ─── Labels ─────────────────────────────────────────────────────────────────

describe('the fixed labels', () => {
  test('a No is offered in words somebody would actually use', () => {
    const labels = companionLabels();
    assert.ok(labels.no.length > 0);
    assert.ok(labels.yes.length > 0);
    assert.notEqual(labels.yes, labels.no);
    // And there is always a way out that is not an answer.
    assert.ok(labels.quietForNow.length > 0);
  });

  test('the empty state for standing rules shows somebody how to make one', () => {
    // A rule can only be created by telling the companion, so an empty state
    // that just says "no rules yet" would be a dead end.
    assert.match(companionLabels().rulesEmpty, /tell/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The greeting says only what it was told
// ═══════════════════════════════════════════════════════════════════════════
//
// Staxis speaks first when somebody opens an empty panel, and again once a day
// unprompted. Both lines are templates over three values: the hour on the wall
// AT THE HOTEL, this person's first name, and a count the browser was already
// given. There is no model call on either path.
//
// The failure this guards against is the obvious one for a greeting: reaching
// for a plausible number because a sentence reads better with one in it. A
// wrong occupancy figure in the corner of the screen is worse than no greeting
// at all, because it is indistinguishable from a right one.

describe('charter: the greeting invents nothing', () => {
  const shapes = { firstName: 'Maria', sharedLogin: false };

  test('with nothing to report, the opening line carries no number', () => {
    for (const hour of [null, 0, 6, 11, 12, 17, 18, 23]) {
      const line = greetingLine({ ...shapes, hour, fact: todayFact({ waiting: 0 }) });
      assert.doesNotMatch(line, /\d/, `a count appeared from nowhere: ${line}`);
    }
  });

  test('the only number it may print is the one it was handed', () => {
    for (const waiting of [1, 2, 3, 7, 15]) {
      const line = greetingLine({ ...shapes, hour: 9, fact: todayFact({ waiting }) });
      const digits = line.match(/\d+/g) ?? [];
      assert.deepEqual(digits, [String(waiting)], `stray numbers in: ${line}`);
    }
  });

  test('an unknown hour produces no claim about the time of day', () => {
    const line = greetingLine({ ...shapes, hour: null, fact: null });
    assert.equal(line, 'Hello, Maria.');
    for (const word of ['morning', 'afternoon', 'evening', 'night']) {
      assert.doesNotMatch(line.toLowerCase(), new RegExp(word));
    }
  });

  test('the daily hello is honest about a quiet hotel rather than padding it', () => {
    const quiet = dailyHelloLine({ ...shapes, hour: 9, fact: todayFact({ waiting: 0 }) });
    assert.ok(quiet.endsWith(QUIET_TODAY), quiet);
    assert.doesNotMatch(quiet, /\d/);
  });

  test('a name is only ever said when there is a real one to say', () => {
    for (const [firstName, sharedLogin] of [['Front', true], [null, false], ['front@hotel.com', false]] as const) {
      const line = greetingLine({ firstName, sharedLogin, hour: 9, fact: null });
      assert.ok(/^(Hello|Good (morning|afternoon|evening))\.$/.test(line), line);
    }
  });

  test('every greeting is one glanceable line, in the companion voice', () => {
    for (const hour of [null, 9, 14, 20]) {
      for (const waiting of [0, 1, 5]) {
        const shape = { ...shapes, hour, fact: todayFact({ waiting }) };
        for (const line of [greetingLine(shape), dailyHelloLine(shape)]) {
          assert.ok(line.length <= 90, `too long to glance at: ${line}`);
          assert.ok(!line.includes(EM_DASH), line);
          assert.ok(!line.includes('\n'), line);
        }
      }
    }
  });
});
