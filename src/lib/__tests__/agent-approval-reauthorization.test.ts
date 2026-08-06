import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const route = readFileSync(
  join(process.cwd(), 'src/app/api/agent/command/resolve-action/route.ts'),
  'utf8',
);

describe('delayed approval authorization lifecycle', () => {
  test('re-resolves current authority inside the add-on loop before every add-on write', () => {
    const loop = route.indexOf('for (const addonId of body.addons)');
    const recheck = route.indexOf('await reauthorizeAgentScope({', loop);
    const run = route.indexOf('await addon.run({', loop);
    assert.ok(loop >= 0 && recheck > loop && run > recheck);

    const fence = route.slice(recheck, run);
    assert.match(fence, /authUserId: auth\.userId/);
    assert.match(fence, /propertyId: body\.pid/);
    assert.match(fence, /mutationToolName: pending\.toolName/);
    assert.match(fence, /if \(!addonAuthority\)[\s\S]*?continue/);
  });

  test('re-resolves after the resume claim and before any hotel or model context read', () => {
    const claim = route.indexOf('await claimTurnResume(');
    const recheck = route.indexOf('await reauthorizeAgentScope({', claim);
    const history = route.indexOf('await loadConversation(', claim);
    const snapshot = route.indexOf('buildHotelSnapshot(', claim);
    const memory = route.indexOf('retrieveMemoryForTurn(', claim);
    const provider = route.indexOf('streamAgent({', claim);

    assert.ok(claim >= 0 && recheck > claim);
    for (const boundary of [history, snapshot, memory, provider]) {
      assert.ok(boundary > recheck, 'context/provider work must follow the fresh authority fence');
    }
    const refusal = route.slice(recheck, history);
    assert.match(refusal, /authorization_changed/);
    assert.match(refusal, /releaseTurnResume\(/);
    assert.match(refusal, /return;/);
  });

  test('never falls back to pre-authorization conversation history on a fresh-read failure', () => {
    assert.match(route, /if \(!freshConvo \|\| freshConvo\.propertyId !== body\.pid\)/);
    assert.match(route, /const history: AgentMessage\[\] = freshConvo\.messages/);
    assert.doesNotMatch(route, /freshConvo\?\.messages \?\? convo\.messages/);
  });

  test('the shared fresh fence includes active account, exact property, lens, mutation and section checks', () => {
    const start = route.indexOf('async function reauthorizeAgentScope');
    const end = route.indexOf('\nexport async function POST', start);
    const fence = route.slice(start, end);
    assert.match(fence, /loadAgentUserCtx\(input\.authUserId, input\.propertyId\)/);
    assert.match(fence, /fresh\.userCtx\.accountId !== input\.expectedAccountId/);
    // Every one of these is asked about the SURFACE the card was minted on
    // (2026-08-06): a card raised by "@Staxis" in a staff thread must not be
    // judged against whether that hat has a chat bar, and its section gate is
    // Messages rather than the Staxis tab. `approvalSurfaceForTool` picks the
    // surface, 'chat' first, so every card minted before that change resolves
    // through exactly the path it always did.
    assert.match(fence, /surfaceIsMountedForRole\(fresh\.userCtx\.role, input\.surface\)/);
    assert.match(fence, /getEnabledSectionsFresh\(input\.propertyId\)/);
    assert.match(fence, /isSectionEnabled\(freshSections, surfaceSection\)/);
    assert.match(fence, /fresh\.userCtx\.hotelMutationAllowed !== true/);
    assert.match(
      fence,
      /getToolsForRole\([\s\S]*?fresh\.userCtx\.role,[\s\S]*?input\.surface,[\s\S]*?fresh\.userCtx,[\s\S]*?\)/,
    );
    // And both call sites must pass one, or the fence would silently judge a
    // thread card against the chat bar.
    const addon = route.indexOf('const addonAuthority = await reauthorizeAgentScope({');
    const resume = route.indexOf('const resumeAuthority = await reauthorizeAgentScope({');
    assert.ok(addon > 0 && resume > 0);
    for (const at of [addon, resume]) {
      assert.match(route.slice(at, at + 260), /surface: approvalSurface/);
    }
  });
});
