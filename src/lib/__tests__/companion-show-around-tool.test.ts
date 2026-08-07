/**
 * staxis_show_around — the door back to the tour for the person who said no.
 *
 * The tour is offered ONCE, on somebody's first sign-in, and a No there is a
 * No forever. That is the right social contract and it leaves one hole: the
 * person who said no in their first thirty seconds and wants it in week two.
 * This tool is that hole filled, and the failure it must not have is the one
 * every companion browser-side tool shares: succeeding for somebody whose
 * screen cannot show what it promises.
 *
 * So the tests below are about the SCOPE of a success. A hat with no tour, a
 * turn with no screen behind it, and the standing rule that housekeeping is
 * never involved in any of this.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import '@/lib/agent/tools';
import '@/lib/agent/tools/index';
import { getTool, getToolsForRole, type ToolContext } from '@/lib/agent/tools';
import { chatIsMountedForRole } from '@/lib/agent/lenses';
import { ALL_ROLES, type AppRole } from '@/lib/roles';
import type { EnabledSections } from '@/lib/sections/registry';

const TOOL = 'staxis_show_around';

interface Who {
  role?: AppRole;
  hotelMutationAllowed?: boolean;
  seesMoney?: boolean;
  enabledSections?: EnabledSections;
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
    ...(who.enabledSections === undefined ? {} : { enabledSections: who.enabledSections }),
  };
}

async function showAround(page: ToolContext['companionPage'], who: Who = {}) {
  const tool = getTool(TOOL);
  assert.ok(tool, 'the tool must be registered');
  return tool.handler({} as never, { ...context(page, who), db: {} } as never);
}

describe('who is offered the tour at all', () => {
  const names = (role: AppRole) => getToolsForRole(role, 'chat').map((t) => t.name);

  test('housekeeping is never offered it, by three separate refusals', () => {
    // The standing rule. mount.ts refuses the hat, the lens mounts no chat for
    // it, and `allowedRoles` leaves it off. This asserts the third, and the
    // second by implication: a hat with no chat has no catalog to be in.
    assert.equal(chatIsMountedForRole('housekeeping'), false);
    assert.ok(!names('housekeeping').includes(TOOL));
  });

  test('every hat the companion actually serves is offered it', () => {
    // Including the front desk, which carries no other staxis_* tool. The desk
    // is where turnover is highest and where the person is most often brand
    // new, so the introduction is the one thing that lens must not withhold.
    for (const role of ['general_manager', 'owner', 'admin', 'front_desk', 'maintenance'] as AppRole[]) {
      assert.ok(names(role).includes(TOOL), `${role} cannot ask to be shown around`);
    }
  });

  test('no hat outside the companion gets it', () => {
    for (const role of ALL_ROLES) {
      if (chatIsMountedForRole(role)) continue;
      assert.ok(!names(role).includes(TOOL), `${role} has no companion but was offered the tour`);
    }
  });
});

describe('it refuses a turn with no screen behind it', () => {
  test('no page proof is a refusal, not a guess', async () => {
    // The portfolio route, the approval-resolve route and the eval harness all
    // build a context with no companion page. A tour has to start from a
    // screen somebody is standing on.
    const r = await showAround(null);
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /no screen/i);
  });

  test('an undefined page is refused the same way', async () => {
    const r = await showAround(undefined);
    assert.equal(r.ok, false);
  });
});

describe('it refuses a person whose tour would be empty', () => {
  const ALL_OFF: EnabledSections = {
    staxis: false, dashboard: false, maintenance: false, inventory: false,
    communications: false, housekeeping: false, staff: false, financials: false,
  };

  test('a line role at a hotel with every section off has nothing to be walked through', async () => {
    // The only shape that genuinely empties a tour. Switching ONE section off
    // shortens it (proven in companion-tour.test.ts); switching them all off
    // is the hotel that has no product yet, and the honest answer there is no
    // tour rather than a tour of the leftovers.
    //
    // A MANAGER is deliberately not empty even here, and that is correct: My
    // Hotel and Settings sit outside the eight-section registry, so a manager
    // at a hotel with nothing switched on can still be shown where the hotel
    // itself gets set up. That is the one useful thing left to show them.
    const r = await showAround('staxis', { role: 'front_desk', enabledSections: ALL_OFF });
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /no tour/i);
    // And the refusal is one the model can turn into a sentence rather than a
    // stack trace, which is the whole contract for a tool that fails.
    assert.match(r.error ?? '', /answer questions/i);
  });

  test('a manager at that same empty hotel is still shown where setup lives', async () => {
    const r = await showAround('staxis', { hotelMutationAllowed: true, enabledSections: ALL_OFF });
    assert.equal(r.ok, true);
    assert.deepEqual((r.data as { covers: string[] }).covers, ['people', 'settings']);
  });

  test('a manager at an ordinary hotel gets a real tour', async () => {
    const r = await showAround('staxis', { hotelMutationAllowed: true, seesMoney: true });
    assert.equal(r.ok, true);
    const data = r.data as { touring: boolean; stops: number; covers: string[] };
    assert.equal(data.touring, true);
    assert.ok(data.stops >= 6, `only ${data.stops} stops`);
  });
});

describe('what it hands back is narrowed to this person', () => {
  test('a front desk hire is told about a shorter tour than a manager', async () => {
    const desk = await showAround('staxis', { role: 'front_desk', hotelMutationAllowed: false });
    const gm = await showAround('staxis', { hotelMutationAllowed: true, seesMoney: true });
    assert.equal(desk.ok, true);
    assert.equal(gm.ok, true);
    const deskStops = (desk.data as { stops: number }).stops;
    const gmStops = (gm.data as { stops: number }).stops;
    assert.ok(deskStops < gmStops, `desk ${deskStops} vs gm ${gmStops}`);
  });

  test('a front desk hire is never told the tour covers Settings or People', async () => {
    // The adversarial one. `covers` is what the model uses to say how big the
    // tour is; naming a manager screen there would let the reply promise a
    // walk through a door this person cannot open.
    const r = await showAround('staxis', { role: 'front_desk', hotelMutationAllowed: false });
    const covers = (r.data as { covers: string[] }).covers;
    assert.ok(!covers.includes('settings'), covers.join(', '));
    assert.ok(!covers.includes('people'), covers.join(', '));
  });

  test('a manager whose hotel switched Inventory off is not promised an Inventory stop', async () => {
    const r = await showAround('staxis', {
      hotelMutationAllowed: true, seesMoney: true, enabledSections: { inventory: false },
    });
    assert.equal(r.ok, true);
    const covers = (r.data as { covers: string[] }).covers;
    assert.ok(!covers.includes('inventory'), covers.join(', '));
  });

  test('it fails closed on the entitlements it was not told about', async () => {
    // No `hotelMutationAllowed` and no capability snapshot is a legacy or eval
    // context. The safe direction on an ENTITLEMENT is the shorter tour, so
    // the teach stop (whose control renders only under `manage`) is dropped.
    //
    // The page-level manager stops are deliberately NOT dropped, and that is
    // not an oversight. People and Settings are gated by ROLE, through the
    // same `resolveDestination` the "take me there" button uses, and a manager
    // without write standing can still open and read both. Dropping them here
    // would make the tour stricter than the app, which is its own kind of lie.
    const r = await showAround('staxis');
    assert.equal(r.ok, true);
    const covers = (r.data as { covers: string[] }).covers;
    assert.ok(!covers.includes('knows'), `the teach stop needs manage: ${covers.join(', ')}`);
    assert.ok(covers.includes('settings'), 'a manager can still read Settings');
  });
});

describe('the tool itself changes nothing', () => {
  test('it takes no arguments, so there is nothing to point it at', () => {
    // The whole safety of an acknowledgement. `staxis_point_at` at least takes
    // a key; this takes nothing at all, so there is no input that could make
    // it do something other than start this person's own tour.
    const tool = getTool(TOOL)!;
    assert.deepEqual(tool.inputSchema.properties, {});
    assert.deepEqual(tool.inputSchema.required ?? [], []);
  });

  test('its description tells the model the tour acts on nothing', () => {
    // Model-facing text, so the em-dash rule does not apply. What it MUST do
    // is stop the model claiming the tour set something up, which is the one
    // sentence charter clause 1 cannot survive.
    const description = getTool(TOOL)!.description;
    assert.match(description, /NEVER does anything/i);
    assert.match(description, /points and it waits/i);
  });

  test('it is chat-only, like every other companion tool', () => {
    const tool = getTool(TOOL)!;
    assert.ok(tool.surfaces === undefined || tool.surfaces.includes('chat'));
  });
});
