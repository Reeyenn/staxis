/**
 * staxis_point_at — the chat half of the pointer, and the three walls that
 * make pointing at nothing impossible.
 *
 * The interesting failure this file exists to catch is not "the tool errors".
 * It is the tool succeeding on a control the person cannot see: a key from the
 * stockroom answered while they are standing on the one-list, which would draw
 * an arrow at empty space or, worse, at whatever happened to carry that
 * attribute on the wrong screen. So every test below is about the SCOPE of a
 * success, not the shape of it.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import '@/lib/agent/tools';
import '@/lib/agent/tools/index';
import { getTool, getToolsForRole, type ToolContext } from '@/lib/agent/tools';
import { COMPANION_ANCHORS } from '@/lib/companion/anchors';
import { pageForPath } from '@/lib/companion/pages';
import { ALL_ROLES, type AppRole } from '@/lib/roles';

const TOOL = 'staxis_point_at';

interface Who {
  role?: AppRole;
  hotelMutationAllowed?: boolean;
  /** The route-bound per-hotel money capability, as the real route supplies it. */
  seesMoney?: boolean;
}

function context(page: ToolContext['companionPage'], who: Who = {}): ToolContext {
  return {
    user: {
      uid: 'u',
      accountId: '00000000-0000-0000-0000-000000000001',
      username: 'u',
      displayName: 'U',
      role: who.role ?? ('general_manager' as AppRole),
      propertyAccess: [],
      ...(who.hotelMutationAllowed === undefined ? {} : { hotelMutationAllowed: who.hotelMutationAllowed }),
      ...(who.seesMoney === undefined ? {} : { capabilitySnapshot: { view_financials: who.seesMoney } }),
    },
    propertyId: '11111111-1111-4111-8111-111111111111',
    staffId: null,
    requestId: 'r',
    surface: 'chat',
    companionPage: page,
  };
}

async function point(anchor: unknown, page: ToolContext['companionPage'], who: Who = {}) {
  const tool = getTool(TOOL);
  assert.ok(tool, 'the tool must be registered');
  return tool.handler({ anchor } as never, { ...context(page, who), db: {} } as never);
}

describe('staxis_point_at is offered exactly where the companion is', () => {
  const names = (role: AppRole, surface: 'chat' | 'portfolio' | 'walkthrough' = 'chat') =>
    getToolsForRole(role, surface).map((t) => t.name);

  test('the hats the companion serves have it', () => {
    for (const role of ['admin', 'owner', 'general_manager', 'maintenance', 'staff'] as AppRole[]) {
      assert.ok(names(role).includes(TOOL), `${role} should have it`);
    }
  });

  test('a housekeeper never sees it, because they have no companion at all', () => {
    assert.deepEqual(names('housekeeping'), []);
  });

  test('the front desk does not get it, like every other staxis tool', () => {
    assert.equal(names('front_desk').includes(TOOL), false);
  });

  test('it never reaches the cross-hotel surface', () => {
    // An arrow is drawn on ONE screen in ONE browser. There is no such thing as
    // a control on a portfolio of twelve hotels.
    for (const role of ALL_ROLES) {
      assert.equal(names(role, 'portfolio').includes(TOOL), false);
      assert.equal(names(role, 'walkthrough').includes(TOOL), false);
    }
  });

  test('it changes nothing, so it needs no approval card', () => {
    const tool = getTool(TOOL);
    assert.ok(tool);
    // Load-bearing, not incidental: a mutating tool never emits
    // tool_call_started inline, and that event is the only way the browser
    // hears about this at all. A mutation here would be a silent dead button.
    assert.notEqual(tool.mutates, true);
    assert.equal(tool.approval, undefined);
  });
});

describe('it cannot point at something that is not there', () => {
  test('an unknown key is refused, in words the model can use', async () => {
    for (const bad of ['', '   ', 'the import button', 'inventory_import', 'wages', 42, null, undefined]) {
      const result = await point(bad, 'inventory');
      assert.equal(result.ok, false, `${String(bad)} must be refused`);
      assert.ok((result.error ?? '').length > 20, 'a refusal must be a sentence, not a code');
    }
  });

  test('a key from another screen is refused, so it can never draw where it cannot see', async () => {
    // The whole point of the page gate. Both directions, because a one-way
    // check would pass this test and ship half a wall.
    const wrong = await point('todo-composer', 'inventory');
    assert.equal(wrong.ok, false);
    const alsoWrong = await point('inventory-import', 'staxis');
    assert.equal(alsoWrong.ok, false);
  });

  test('every PAGE anchor is refused on every screen except its own', async () => {
    // `any` anchors are the app chrome (the pill bar, the mark in the corner),
    // which is on every screen the companion is allowed to exist on, so
    // scoping them to one page would be a lie in seven places out of eight.
    // Everything else is still scoped to exactly one screen.
    const pages = ['inventory', 'staxis', 'dashboard', 'maintenance', 'people', 'settings'] as const;
    const boss: Who = { role: 'general_manager' as AppRole, hotelMutationAllowed: true, seesMoney: true };
    for (const anchor of COMPANION_ANCHORS) {
      if (anchor.page === 'any') continue;
      for (const page of pages) {
        const result = await point(anchor.key, page, boss);
        assert.equal(
          result.ok,
          page === anchor.page,
          `${anchor.key} on ${page} should be ${page === anchor.page ? 'allowed' : 'refused'}`,
        );
      }
    }
  });

  test('an `any` anchor is allowed on every screen and STILL refused with no screen', async () => {
    // The half of the page wall that `any` must not loosen. Chrome is
    // everywhere, and "everywhere" still does not include a turn that has no
    // browser behind it at all.
    const pages = ['inventory', 'staxis', 'dashboard', 'maintenance', 'people', 'settings'] as const;
    const boss: Who = { role: 'general_manager' as AppRole, hotelMutationAllowed: true, seesMoney: true };
    const chrome = COMPANION_ANCHORS.filter((a) => a.page === 'any');
    assert.ok(chrome.length > 0, 'no chrome anchors to test');
    for (const anchor of chrome) {
      for (const page of pages) {
        assert.equal((await point(anchor.key, page, boss)).ok, true, `${anchor.key} on ${page}`);
      }
      assert.equal((await point(anchor.key, null, boss)).ok, false, `${anchor.key} with no screen`);
    }
  });

  test('a control the asker\'s own screen never rendered is refused', async () => {
    // The bug this closes: a maintenance tech asks where the importer is, the
    // model is told the key, the tool says yes, and the browser finds nothing
    // because the button renders only under `canManage && canViewFinancials`.
    // The answer reads as the companion being certain and the app being broken.
    const wrench: Who = { role: 'maintenance' as AppRole, hotelMutationAllowed: true, seesMoney: false };
    for (const key of ['inventory-import', 'add-delivery']) {
      const result = await point(key, 'inventory', wrench);
      assert.equal(result.ok, false, `${key} must be refused for a hat that cannot see it`);
      assert.match(result.error ?? '', /access/i);
    }
    // And the one that needs nothing still works for them.
    assert.equal((await point('todo-composer', 'staxis', wrench)).ok, true);
  });

  test('money and management are separate gates, and both are needed for the importer', async () => {
    const role = 'general_manager' as AppRole;
    // A manager with no finance read gets the delivery scanner, not the importer.
    const noMoney: Who = { role, hotelMutationAllowed: true, seesMoney: false };
    assert.equal((await point('add-delivery', 'inventory', noMoney)).ok, true);

    // A manager whose hotel mutation standing was explicitly withdrawn (a
    // read-only company hat drilling in) gets neither.
    const readOnly: Who = { role, hotelMutationAllowed: false, seesMoney: true };
    assert.equal((await point('add-delivery', 'inventory', readOnly)).ok, false);
    assert.equal((await point('inventory-import', 'inventory', readOnly)).ok, false);
  });

  test('a refusal never hands back a key that would also refuse', async () => {
    // `alsoOnThisScreen` is the model's recovery path. Offering it a key its
    // own standing would reject just costs another round trip and another
    // confident wrong answer.
    //
    // Asserted as the PROMISE rather than as a frozen list: every key handed
    // back is called for real and must succeed. A pinned array would have to be
    // edited every time the chrome grows, and editing it is exactly how it
    // would come to contain a key that no longer works.
    const noMoney: Who = { role: 'general_manager' as AppRole, hotelMutationAllowed: true, seesMoney: false };
    const result = await point('inventory-import', 'inventory', noMoney);
    assert.equal(result.ok, false, 'the importer needs money, so this is the refusal path');
    const offered = (result.data as Record<string, unknown> | undefined)?.alsoOnThisScreen;
    for (const key of (offered ?? []) as string[]) {
      assert.equal(
        (await point(key, 'inventory', noMoney)).ok,
        true,
        `${key} was offered as a recovery and would itself refuse`,
      );
    }
  });

  test('a turn with no screen behind it is refused rather than guessed at', async () => {
    // The portfolio route, the approval-resolve route and the eval harness all
    // build a context with no page. Failing closed is the only safe direction:
    // there is no browser waiting to draw anything.
    const boss: Who = { role: 'general_manager' as AppRole, hotelMutationAllowed: true, seesMoney: true };
    for (const anchor of COMPANION_ANCHORS) {
      assert.equal((await point(anchor.key, null, boss)).ok, false);
      assert.equal((await point(anchor.key, undefined, boss)).ok, false);
    }
  });
});

const BOSS = {
  role: 'general_manager' as AppRole,
  hotelMutationAllowed: true,
  seesMoney: true,
};

describe('what a success actually hands back', () => {
  test('it acknowledges, and says nothing about having done anything', async () => {
    const result = await point('inventory-import', 'inventory', BOSS);
    assert.equal(result.ok, true);
    const data = result.data as Record<string, unknown>;
    assert.equal(data.pointing, true);
    assert.equal(data.anchor, 'inventory-import');
    assert.equal(data.page, 'inventory');
    assert.equal(typeof data.does, 'string');
    assert.ok((data.does as string).length > 20);
  });

  test('surrounding whitespace on a key is forgiven, a different key is not', async () => {
    assert.equal((await point('  add-delivery  ', 'inventory', BOSS)).ok, true);
    assert.equal((await point('add delivery', 'inventory', BOSS)).ok, false);
  });

  test('it names the other controls on that screen, so a wrong guess gets the real list', async () => {
    const result = await point('inventory-import', 'inventory', BOSS);
    const also = (result.data as Record<string, unknown>).alsoOnThisScreen as string[];
    // The stockroom's other button, plus the chrome that is on every screen.
    assert.ok(also.includes('add-delivery'), also.join(', '));
    assert.ok(also.includes('staxis-mark'), also.join(', '));
    // Never itself, and never a control from another screen.
    assert.ok(!also.includes('inventory-import'), also.join(', '));
    assert.ok(!also.includes('todo-composer'), also.join(', '));
  });

  test('the pages it answers for are pages a person can actually be on', async () => {
    // A registry entry pointing at a page the router does not serve would be a
    // control the model is told about and can never successfully draw.
    for (const anchor of COMPANION_ANCHORS) {
      const paths = ['/inventory', '/feed', '/dashboard', '/maintenance', '/communications', '/settings'];
      const reachable = anchor.page === 'any'
        || paths.some((p) => pageForPath(p)?.key === anchor.page);
      assert.ok(reachable, `${anchor.key} lives on a page nothing routes to`);
    }
  });
});
