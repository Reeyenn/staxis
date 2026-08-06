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

function context(page: ToolContext['companionPage']): ToolContext {
  return {
    user: {
      uid: 'u',
      accountId: '00000000-0000-0000-0000-000000000001',
      username: 'u',
      displayName: 'U',
      role: 'general_manager' as AppRole,
      propertyAccess: [],
    },
    propertyId: '11111111-1111-4111-8111-111111111111',
    staffId: null,
    requestId: 'r',
    surface: 'chat',
    companionPage: page,
  };
}

async function point(anchor: unknown, page: ToolContext['companionPage']) {
  const tool = getTool(TOOL);
  assert.ok(tool, 'the tool must be registered');
  return tool.handler({ anchor } as never, { ...context(page), db: {} } as never);
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

  test('every anchor is refused on every screen except its own', async () => {
    const pages = ['inventory', 'staxis', 'dashboard', 'maintenance', 'people', 'settings'] as const;
    for (const anchor of COMPANION_ANCHORS) {
      for (const page of pages) {
        const result = await point(anchor.key, page);
        assert.equal(
          result.ok,
          page === anchor.page,
          `${anchor.key} on ${page} should be ${page === anchor.page ? 'allowed' : 'refused'}`,
        );
      }
    }
  });

  test('a turn with no screen behind it is refused rather than guessed at', async () => {
    // The portfolio route, the approval-resolve route and the eval harness all
    // build a context with no page. Failing closed is the only safe direction:
    // there is no browser waiting to draw anything.
    for (const anchor of COMPANION_ANCHORS) {
      assert.equal((await point(anchor.key, null)).ok, false);
      assert.equal((await point(anchor.key, undefined)).ok, false);
    }
  });
});

describe('what a success actually hands back', () => {
  test('it acknowledges, and says nothing about having done anything', async () => {
    const result = await point('inventory-import', 'inventory');
    assert.equal(result.ok, true);
    const data = result.data as Record<string, unknown>;
    assert.equal(data.pointing, true);
    assert.equal(data.anchor, 'inventory-import');
    assert.equal(data.page, 'inventory');
    assert.equal(typeof data.does, 'string');
    assert.ok((data.does as string).length > 20);
  });

  test('surrounding whitespace on a key is forgiven, a different key is not', async () => {
    assert.equal((await point('  add-delivery  ', 'inventory')).ok, true);
    assert.equal((await point('add delivery', 'inventory')).ok, false);
  });

  test('it names the other controls on that screen, so a wrong guess gets the real list', async () => {
    const result = await point('inventory-import', 'inventory');
    assert.deepEqual((result.data as Record<string, unknown>).alsoOnThisScreen, ['add-delivery']);
  });

  test('the pages it answers for are pages a person can actually be on', async () => {
    // A registry entry pointing at a page the router does not serve would be a
    // control the model is told about and can never successfully draw.
    for (const anchor of COMPANION_ANCHORS) {
      const paths = ['/inventory', '/feed', '/dashboard', '/maintenance', '/communications', '/settings'];
      const reachable = paths.some((p) => pageForPath(p)?.key === anchor.page);
      assert.ok(reachable, `${anchor.key} lives on a page nothing routes to`);
    }
  });
});
