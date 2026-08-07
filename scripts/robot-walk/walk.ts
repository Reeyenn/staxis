/**
 * The nightly robot walkthrough.
 *
 * A real Chromium signs into the REAL live site as a manager at the seeded
 * Robot Hotel and does what a person does, step by step, then hands the results
 * to /api/admin/robot-walk/report. See src/lib/automation/robot-walk.ts for what
 * happens to those results and why they land where they do.
 *
 * ─── RUN IT ────────────────────────────────────────────────────────────────
 *
 *   ROBOT_WALK_PASSWORD=... ROBOT_WALK_PROPERTY_ID=... CRON_SECRET=... \
 *     npx tsx --conditions=react-server scripts/robot-walk/walk.ts
 *
 * ─── THE SAFETY RAIL ───────────────────────────────────────────────────────
 *
 * This script deletes things, in production. Two rules make that safe, and
 * neither is a comment: they are code, and they run before anything is touched.
 *
 *   1. It refuses to do ANYTHING mutating unless the hotel it is signed into is
 *      exactly ROBOT_WALK_PROPERTY_ID. Wrong hotel, or a hotel it cannot
 *      identify, and the walk aborts having only read.
 *   2. It only ever deletes text that starts with ROBOT_WALK_MARKER, checked by
 *      isRobotWalkArtifact(). Anything it is not certain it created, it leaves.
 *
 * It also never opens invites, email, money, ordering or settings.
 *
 * ─── EXIT CODE ─────────────────────────────────────────────────────────────
 *
 * Zero when the report was delivered, even if steps failed: a failed step is
 * news for the founder's "Recent errors" box, not for a GitHub email. Non-zero
 * only when the report could NOT be delivered, because that is the one failure
 * nothing else in the system can see.
 */

import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import {
  anchorCensusDetail,
  anchorCensusPages,
  anchorsExpectedAt,
  composerNamesAssignee,
  isRobotWalkArtifact,
  runRobotWalk,
  summarizeRobotWalk,
  robotWalkStepLabel,
  ROBOT_WALK_MARKER,
  type RobotWalkStep,
  type RobotWalkStepResult,
} from '../../src/lib/automation/robot-walk';

// ─── Configuration ───────────────────────────────────────────────────────────

const BASE_URL = (process.env.ROBOT_WALK_BASE_URL || 'https://getstaxis.com').replace(/\/$/, '');
const USERNAME = process.env.ROBOT_WALK_USER || 'robot.manager';
const PASSWORD = process.env.ROBOT_WALK_PASSWORD || '';
const PROPERTY_ID = process.env.ROBOT_WALK_PROPERTY_ID || '';
const CRON_SECRET = process.env.CRON_SECRET || '';
/** The second person on the roster. The robot proves the picker offers them. */
const COLLEAGUE = process.env.ROBOT_WALK_COLLEAGUE || 'Robot Colleague';
/**
 * Who the robot actually hands the to-do to: itself, by name, out of the same
 * list of people the colleague is in.
 *
 * WHY NOT THE COLLEAGUE. A to-do handed to somebody else leaves the author's own
 * list by design, and the product gives the author no way to take it back — the
 * "assigned by me" drawer is a read. A robot that handed one over every night
 * would pile up a row a night on a list it can never clear, forever. Assigning
 * by name to its own roster identity walks the identical control and the
 * identical write, and leaves the to-do somewhere the robot can tidy it away.
 */
const ASSIGNEE = process.env.ROBOT_WALK_ASSIGNEE || 'Robot Manager';

/** Every artifact the robot makes, so cleanup can find them by name. */
const TODO_TITLE = `${ROBOT_WALK_MARKER} nightly walkthrough`;
const ASSIGNED_TODO_TITLE = `${ROBOT_WALK_MARKER} hand this to somebody`;
const FACT_TEXT = `${ROBOT_WALK_MARKER} the supply closet is on floor 2.`;
const ITEM_NAME = `${ROBOT_WALK_MARKER} spare bulbs`;

/** Per-action patience. The live site is a real deploy on a cold serverless. */
const ACTION_MS = 20_000;
/** The one model call gets its own, longer, budget. */
const MODEL_MS = 90_000;

const workflowRunUrl = process.env.GITHUB_RUN_ID && process.env.GITHUB_REPOSITORY
  ? `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : null;

// ─── Small helpers ───────────────────────────────────────────────────────────

function say(line: string): void {
  console.log(line);
}

async function goto(page: Page, path: string): Promise<void> {
  await page.goto(`${BASE_URL}${path}`, { waitUntil: 'domcontentloaded', timeout: ACTION_MS });
}

/** The composer's sentence field, scoped so the page's other inputs cannot win. */
function composerInput(page: Page): Locator {
  return page.getByTestId('composer').getByRole('textbox', { name: 'What needs doing' });
}

/** Every work row currently on the list whose title the robot wrote. */
async function robotRowTitles(page: Page): Promise<string[]> {
  const titles = await page.locator('.fx-row .fx-rowt').allTextContents();
  return titles.filter(isRobotWalkArtifact);
}

async function openFeed(page: Page): Promise<void> {
  await goto(page, '/feed');
  await page.locator('[data-feed-state="ready"]').first().waitFor({ timeout: ACTION_MS });
}

async function openKnows(page: Page): Promise<Locator> {
  await goto(page, '/feed?tab=knows');
  const panel = page.locator('[role="dialog"][aria-label="What Staxis knows"]');
  await panel.waitFor({ timeout: ACTION_MS });
  return panel;
}

// ─── The safety rail ─────────────────────────────────────────────────────────

/**
 * Which hotel are we actually standing in?
 *
 * Read from the browser's own record of the active hotel rather than from
 * anything this script decided, because the question being asked is "what will
 * the next click write to", and that is answered by the app, not by us.
 */
async function activeHotelId(page: Page): Promise<string | null> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const id = await page.evaluate(() => {
      try { return window.localStorage.getItem('hotelops-active-property'); } catch { return null; }
    });
    if (id) return id;
    await page.waitForTimeout(500);
  }
  return null;
}

async function assertStandingInTheRobotHotel(page: Page): Promise<void> {
  const active = await activeHotelId(page);
  if (!active) {
    throw new Error('Refusing to continue: could not tell which hotel this account is signed into.');
  }
  if (active !== PROPERTY_ID) {
    throw new Error(
      `Refusing to continue: signed in at hotel ${active}, expected the robot hotel ${PROPERTY_ID}. `
      + 'Nothing was changed.',
    );
  }
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

/**
 * Clear away anything the robot left behind, its own work included.
 *
 * Runs BEFORE the walk as well as after it, which is what makes a crashed
 * previous night harmless: last night's half-finished to-do would otherwise sit
 * on the list forever, and tonight's "is my new to-do there" check would pass on
 * a row it did not create.
 *
 * Every failure here is swallowed. Cleanup is housekeeping, and a walk that
 * reported "sign in is broken" because it could not tidy up is a walk that
 * reported the wrong thing.
 */
async function cleanUp(page: Page, label: string): Promise<void> {
  say(`  tidying up (${label})`);

  // 1. To-dos — finished, which is the product's own way of clearing one.
  try {
    await openFeed(page);
    for (let guard = 0; guard < 10; guard += 1) {
      const titles = await robotRowTitles(page);
      if (titles.length === 0) break;
      const row = page.locator('.fx-row').filter({ hasText: titles[0] }).first();
      const done = row.getByRole('button', { name: 'Done', exact: true });
      if (await done.count() === 0) break;
      await done.click({ timeout: ACTION_MS });
      await page.waitForTimeout(1_200);
    }
  } catch (err) {
    say(`  could not clear the robot's to-dos: ${String(err)}`);
  }

  // 2. Facts.
  try {
    const panel = await openKnows(page);
    for (let guard = 0; guard < 10; guard += 1) {
      const row = panel.locator('.kn-row').filter({ hasText: ROBOT_WALK_MARKER }).first();
      if (await row.count() === 0) break;
      const remove = row.getByRole('button', { name: 'Remove', exact: true });
      if (await remove.count() === 0) break;
      await remove.click({ timeout: ACTION_MS });
      await page.waitForTimeout(1_200);
    }
  } catch (err) {
    say(`  could not clear the robot's facts: ${String(err)}`);
  }

  // 3. Inventory items.
  try {
    await goto(page, '/inventory');
    for (let guard = 0; guard < 10; guard += 1) {
      const row = page.locator('.inv-ledger-row').filter({ hasText: ROBOT_WALK_MARKER }).first();
      if (await row.count() === 0) break;
      await row.click({ timeout: ACTION_MS });
      const sheet = page.locator('[role="dialog"]').first();
      await sheet.waitFor({ timeout: ACTION_MS });
      const del = sheet.getByRole('button', { name: 'Delete item', exact: true });
      if (await del.count() === 0) break;
      await del.click({ timeout: ACTION_MS });
      await page.waitForTimeout(1_500);
    }
  } catch (err) {
    say(`  could not clear the robot's inventory items: ${String(err)}`);
  }
}

// ─── The walk ────────────────────────────────────────────────────────────────

function buildSteps(page: Page): RobotWalkStep[] {
  return [
    {
      id: 'sign-in',
      run: async () => {
        await goto(page, '/signin');
        await page.locator('#signin-email').fill(USERNAME);
        await page.locator('#signin-password').fill(PASSWORD);
        await page.locator('form button[type="submit"]').first().click();
        // A one-time-code page here means the bypass is not configured, and
        // saying so is far more useful than a timeout on a missing element.
        await page.waitForURL((url) => !url.pathname.startsWith('/signin'), { timeout: ACTION_MS })
          .catch(async () => {
            if (page.url().includes('/signin/verify')) {
              throw new Error('Sign-in stopped for a one-time code. The robot account is not on SKIP_2FA_USER_IDS.');
            }
            throw new Error(`Sign-in did not get past ${page.url()}`);
          });
      },
    },
    {
      id: 'staxis-list',
      run: async () => {
        await openFeed(page);
        await page.locator('.fx-lane').first().waitFor({ timeout: ACTION_MS });
      },
    },
    {
      id: 'add-todo',
      run: async () => {
        await composerInput(page).fill(TODO_TITLE);
        await page.keyboard.press('Enter');
        await page.locator('.fx-row').filter({ hasText: TODO_TITLE }).first()
          .waitFor({ timeout: ACTION_MS });
      },
    },
    {
      id: 'assign-todo',
      run: async () => {
        // Assignment happens while the to-do is being written, not afterwards:
        // a finished row has no reassign control, by design.
        await composerInput(page).fill(ASSIGNED_TODO_TITLE);
        const who = page.getByTestId('composer').getByRole('button', { name: /^Who: / });
        await who.click({ timeout: ACTION_MS });

        // The roster is what fills this list. A hotel whose people stopped
        // loading offers "You" and the departments and looks perfectly normal,
        // so the colleague's presence is checked even though the to-do does not
        // go to them.
        if (await page.getByRole('radio', { name: COLLEAGUE, exact: true }).count() === 0) {
          throw new Error(`${COLLEAGUE} is not offered as somebody to hand work to.`);
        }

        await page.getByRole('radio', { name: ASSIGNEE, exact: true }).click({ timeout: ACTION_MS });
        const label = await who.getAttribute('aria-label');
        // The button says the person's FIRST name, by design. Asserting the
        // full name here is what made this step fail every night for a reason
        // that had nothing to do with the app. See composerNamesAssignee.
        if (!composerNamesAssignee(label, ASSIGNEE)) {
          throw new Error(`Picked ${ASSIGNEE} but the composer still says "${label ?? 'nothing'}".`);
        }

        await composerInput(page).press('Enter');
        await page.locator('.fx-row').filter({ hasText: ASSIGNED_TODO_TITLE }).first()
          .waitFor({ timeout: ACTION_MS });
      },
    },
    {
      id: 'complete-todo',
      run: async () => {
        const row = page.locator('.fx-row').filter({ hasText: TODO_TITLE }).first();
        await row.getByRole('button', { name: 'Done', exact: true }).click({ timeout: ACTION_MS });
        await page.locator('.fx-row').filter({ hasText: TODO_TITLE })
          .first().waitFor({ state: 'detached', timeout: ACTION_MS });
      },
    },
    {
      id: 'log-book',
      run: async () => {
        await goto(page, '/feed?view=logbook');
        // Lazy-loaded chunk on first open, so this is the one place a slow
        // network shows up as a missing element rather than a slow one.
        await page.locator('.fx-lbt').first().waitFor({ timeout: ACTION_MS });
      },
    },
    {
      id: 'teach-fact',
      run: async () => {
        const panel = await openKnows(page);
        await panel.getByRole('button', { name: 'Teach it something', exact: true })
          .click({ timeout: ACTION_MS });
        await page.getByRole('textbox', { name: 'Teach it something' })
          .fill(FACT_TEXT, { timeout: ACTION_MS });
        await page.getByRole('button', { name: 'Save', exact: true }).click({ timeout: ACTION_MS });
        await panel.locator('.kn-row').filter({ hasText: FACT_TEXT }).first()
          .waitFor({ timeout: ACTION_MS });
      },
    },
    {
      id: 'forget-fact',
      run: async () => {
        const panel = page.locator('[role="dialog"][aria-label="What Staxis knows"]');
        const row = panel.locator('.kn-row').filter({ hasText: FACT_TEXT }).first();
        await row.getByRole('button', { name: 'Remove', exact: true }).click({ timeout: ACTION_MS });
        await panel.locator('.kn-row').filter({ hasText: FACT_TEXT }).first()
          .waitFor({ state: 'detached', timeout: ACTION_MS });
      },
    },
    {
      id: 'ask-companion',
      run: async () => {
        await openFeed(page);
        await page.getByRole('button', { name: 'Ask Staxis' }).first().click({ timeout: ACTION_MS });
        const panel = page.locator('#staxis-panel');
        await panel.waitFor({ timeout: ACTION_MS });
        await panel.getByRole('textbox', { name: 'Ask Staxis' })
          .fill('What did I just add?', { timeout: ACTION_MS });
        await page.keyboard.press('Enter');

        // `data-asx-turn` and not the class: the class is shared with the
        // opening line and with the "AI is switched off" notice, so counting it
        // would pass on a companion that never answered.
        await panel.locator('[data-asx-turn="assistant"]').first().waitFor({ timeout: MODEL_MS });
        const failed = await panel.locator('.asx-err').allTextContents();
        if (failed.length > 0) throw new Error(`The companion answered with an error: ${failed.join(' ')}`);
      },
    },
    {
      id: 'add-item',
      run: async () => {
        await goto(page, '/inventory?action=add');
        const sheet = page.locator('[role="dialog"]').first();
        await sheet.waitFor({ timeout: ACTION_MS });
        await sheet.getByRole('textbox', { name: 'Name', exact: true })
          .fill(ITEM_NAME, { timeout: ACTION_MS });
        // Explicitly nothing on the shelf. Deleting an item with stock on it is
        // refused, by design, and the robot has to be able to take back what it
        // put in.
        await sheet.getByRole('spinbutton', { name: 'On hand', exact: true })
          .fill('0', { timeout: ACTION_MS });
        await sheet.getByRole('button', { name: 'Add item', exact: true }).click({ timeout: ACTION_MS });
        await page.locator('.inv-ledger-row').filter({ hasText: ITEM_NAME }).first()
          .waitFor({ timeout: ACTION_MS });
      },
    },
    {
      id: 'delete-item',
      run: async () => {
        await page.locator('.inv-ledger-row').filter({ hasText: ITEM_NAME }).first()
          .click({ timeout: ACTION_MS });
        const sheet = page.locator('[role="dialog"]').first();
        await sheet.waitFor({ timeout: ACTION_MS });
        await sheet.getByRole('button', { name: 'Delete item', exact: true })
          .click({ timeout: ACTION_MS });
        await page.locator('.inv-ledger-row').filter({ hasText: ITEM_NAME }).first()
          .waitFor({ state: 'detached', timeout: ACTION_MS });
      },
    },
    {
      id: 'people-roster',
      run: async () => {
        await goto(page, '/company?tab=people');
        const roster = page.locator('[role="list"][aria-label="People at this hotel"]');
        await roster.waitFor({ timeout: ACTION_MS });
        const people = await roster.getByRole('listitem').count();
        // An empty roster on a hotel that was seeded with two people is the
        // silent-empty-state failure this whole exercise exists to catch.
        if (people === 0) throw new Error('The staff list rendered with nobody on it.');
      },
    },
    {
      // ─── The anchor census ────────────────────────────────────────────────
      //
      // Every control the companion is allowed to point at, checked for real,
      // in a real browser, on the real deploy. See ANCHOR_CENSUS_LOCATIONS for
      // why this is the only honest place to check it and why the location map
      // is separate from the anchor registry's own `page`.
      //
      // It asserts three things per anchor, in order, because each catches a
      // different way of breaking it: the attribute is in the DOM (somebody
      // kept the button and dropped the handle), exactly one node carries it
      // (a copy-paste that would make the arrow pick whichever came first),
      // and it measures as something (the control is inside a branch that is
      // rendered but hidden, which is what the pointer itself refuses to draw
      // at). It never clicks anything.
      id: 'anchor-census',
      run: async () => {
        const missing: string[] = [];
        for (const url of anchorCensusPages()) {
          await goto(page, url);
          // One anchor of any kind proves the shell has painted. Without this
          // the census races the first render and reports every key missing,
          // which is the false alarm that would get it switched off.
          await page.locator('[data-staxis-anchor]').first().waitFor({ timeout: ACTION_MS });
          for (const key of anchorsExpectedAt(url)) {
            const found = page.locator(`[data-staxis-anchor="${key}"]`);
            try {
              await found.first().waitFor({ state: 'visible', timeout: 4_000 });
            } catch {
              missing.push(key);
              continue;
            }
            const count = await found.count();
            if (count !== 1) { missing.push(`${key} (${count} of them)`); continue; }
            const box = await found.first().boundingBox();
            if (!box || box.width <= 0 || box.height <= 0) missing.push(`${key} (measures as nothing)`);
          }
        }
        if (missing.length > 0) throw new Error(anchorCensusDetail(missing));
      },
    },
    {
      id: 'sign-out',
      run: async () => {
        await openFeed(page);
        await page.getByRole('button', { name: 'User menu' }).click({ timeout: ACTION_MS });
        await page.getByRole('button', { name: 'Sign Out', exact: true }).click({ timeout: ACTION_MS });
        await page.waitForURL((url) => url.pathname.startsWith('/signin'), { timeout: ACTION_MS });
      },
    },
  ];
}

// ─── Reporting ───────────────────────────────────────────────────────────────

async function deliverReport(
  startedAt: string,
  finishedAt: string,
  steps: RobotWalkStepResult[],
): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/admin/robot-walk/report`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${CRON_SECRET}`,
    },
    body: JSON.stringify({ startedAt, finishedAt, steps, workflowRunUrl }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`report rejected with HTTP ${res.status}: ${text.slice(0, 500)}`);
  say(`  report accepted: ${text.slice(0, 300)}`);
}

// ─── Entry ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  for (const [name, value] of [
    ['ROBOT_WALK_PASSWORD', PASSWORD],
    ['ROBOT_WALK_PROPERTY_ID', PROPERTY_ID],
    ['CRON_SECRET', CRON_SECRET],
  ] as const) {
    if (!value) {
      console.error(`::error::${name} is not set. The nightly walk cannot run without it.`);
      process.exit(1);
    }
  }

  const startedAt = new Date().toISOString();
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let steps: RobotWalkStepResult[] = [];
  /** The walk as planned, so an early abort can still account for every step. */
  let walked: RobotWalkStep[] = [];
  let abortReason: string | null = null;

  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    context.setDefaultTimeout(ACTION_MS);
    const page = await context.newPage();

    // Deleting an inventory item asks a native "are you sure". Nobody is here
    // to answer it, and an unanswered dialog blocks the page forever.
    page.on('dialog', (dialog) => { void dialog.accept(); });

    walked = buildSteps(page);

    // Sign in first, then prove where we are, and only then touch anything.
    const noticing = (id: string, err: unknown) => { say(`  ✗ ${robotWalkStepLabel(id)}: ${String(err)}`); };
    steps = steps.concat(await runRobotWalk(walked.slice(0, 1), { onFailure: noticing }));
    if (!steps[0]?.ok) throw new Error('sign-in failed, so nothing else can be attempted');

    await assertStandingInTheRobotHotel(page);
    await cleanUp(page, 'before');

    // Everything except sign-in, which is done, and sign-out, which has to be
    // last: tidying up needs a signed-in browser, so the walk cleans the hotel
    // and only then leaves it.
    steps = steps.concat(await runRobotWalk(walked.slice(1, -1), { onFailure: noticing }));

    await cleanUp(page, 'after');

    steps = steps.concat(await runRobotWalk(walked.slice(-1), { onFailure: noticing }));
  } catch (err) {
    abortReason = err instanceof Error ? err.message : String(err);
    say(`walk stopped early: ${abortReason}`);
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }

  // Account for every step that was planned but never reached — a browser that
  // died halfway, or the safety rail refusing the hotel. Without this the
  // report would carry only the handful of steps that ran, every one of them
  // green, and an aborted night would be indistinguishable from a clean one.
  //
  // The FIRST unreached step carries the reason as a real failure rather than
  // as a skip, because a skip is never reported to Recent errors. An abort that
  // produced only skips would leave the founder's box empty on the night the
  // robot could not run at all, which is the loudest thing it has to say.
  const reached = new Set(steps.map((s) => s.name));
  // ...unless a step already broke for real, in which case that step IS the
  // reason and blaming a second one would be the cascade this design avoids.
  let blamed = steps.some((s) => !s.ok && s.skipped !== true);
  for (const step of walked) {
    if (reached.has(step.id)) continue;
    if (!blamed) {
      blamed = true;
      steps.push({ name: step.id, ok: false, ms: 0, error: abortReason ?? 'The walk stopped here without saying why.' });
      continue;
    }
    steps.push({
      name: step.id,
      ok: false,
      ms: 0,
      skipped: true,
      error: 'Not attempted: the walk stopped before reaching this step.',
    });
  }

  if (steps.length === 0) {
    // The browser never opened, so no step was ever planned. An empty report is
    // read as a failure, but it names nothing; this gives the failure a name.
    steps.push({
      name: 'sign-in',
      ok: false,
      ms: 0,
      error: abortReason ?? 'The browser never opened.',
    });
  }

  const finishedAt = new Date().toISOString();
  const summary = summarizeRobotWalk(steps);

  say('');
  for (const step of steps) {
    const mark = step.ok ? '✓' : step.skipped ? '·' : '✗';
    say(`  ${mark} ${robotWalkStepLabel(step.name)}${step.error ? ` — ${step.error}` : ''}`);
  }
  say('');
  say(`${summary.passed} of ${summary.total} steps passed.`);
  for (const step of summary.failed) {
    console.log(`::error::Could not ${robotWalkStepLabel(step.name)}. ${step.error ?? ''}`);
  }

  try {
    await deliverReport(startedAt, finishedAt, steps);
  } catch (err) {
    // The one failure nothing else can see. Everything above is already on its
    // way to the founder's Recent errors box; this is not.
    console.error(`::error::The nightly robot could not file its report: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void main();
