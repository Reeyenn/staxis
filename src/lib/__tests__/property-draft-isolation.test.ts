import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

function section(contents: string, start: string, end: string): string {
  const startIndex = contents.indexOf(start);
  const endIndex = contents.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `missing section start: ${start}`);
  assert.ok(endIndex > startIndex, `missing section end: ${end}`);
  return contents.slice(startIndex, endIndex);
}

const knows = source('src', 'components', 'concourse', 'KnowsView.tsx');
const notifications = source(
  'src', 'app', 'settings', 'notifications', '_components', 'NotificationsPanel.tsx',
);
const myShifts = source('src', 'app', 'staff', '_components', 'MyShifts.tsx');
const staffPage = source('src', 'app', '(hotel)', 'staff', 'page.tsx');
const queue = source('src', 'components', 'concourse', 'QueueView.tsx');
const dripQuestion = source('src', 'components', 'concourse', 'DripQuestionCard.tsx');
const staxisList = source('src', 'components', 'concourse', 'StaxisList.tsx');
const financialsPage = source('src', 'app', '(hotel)', 'financials', 'page.tsx');
const checkbook = source('src', 'app', 'financials', '_components', 'CheckbookTab.tsx');
const budget = source('src', 'app', 'financials', '_components', 'BudgetTab.tsx');
const capex = source('src', 'app', 'financials', '_components', 'CapexTab.tsx');
const capexRequest = source('src', 'app', 'financials', '_components', 'CapexRequestModal.tsx');
const capexDetail = source('src', 'app', 'financials', '_components', 'CapexDetailModal.tsx');
const financialUi = source('src', 'app', 'financials', '_components', 'fin-ui.tsx');

describe('property-owned draft and action isolation', () => {
  test('Knows remounts drafts for the exact viewer and hotel and drops late completions', () => {
    assert.match(knows, /const scopeKey = `\$\{user\?\.uid \?\? 'signed-out'\}:\$\{activePropertyId \?\? 'no-property'\}`/);
    assert.match(knows, /<KnowsPropertyView[\s\S]*?key=\{scopeKey\}[\s\S]*?propertyId=\{activePropertyId\}[\s\S]*?scopeKey=\{scopeKey\}/);

    const scoped = section(knows, 'export function KnowsPropertyView(', '// Returns readEnvelope');
    assert.match(scoped, /activeScopeRef = useRef<string \| null>\(scopeKey\)/);
    assert.match(scoped, /activeScopeRef\.current === scopeKey[\s\S]*?activeScopeRef\.current = null/);
    assert.match(scoped, /const ownsScope = useCallback/);

    // The 2026-08-05 rebuild replaced the open box and the per-row trio with
    // one box in three costumes, so there are two write paths here instead of
    // four. Both still refuse to touch state they no longer own.
    const actions = section(knows, 'const submitBox = useCallback', 'const groups = useMemo');
    assert.match(actions, /propertyId, action: 'teach', text/);
    assert.match(actions, /action: box\.kind === 'wrong' \? 'wrong' : 'adjust'/);
    assert.match(actions, /propertyId, action: 'remove', kind: item\.kind, id: item\.id/);
    assert.ok((actions.match(/if \(!ownsScope\(\)\) return;/g) ?? []).length >= 3);
    assert.ok((actions.match(/if \(ownsScope\(\)\) set(?:Busy|RowBusy)/g) ?? []).length >= 2);
  });

  test('notification CC drafts and save ownership reset on viewer or hotel changes', () => {
    const scopeReset = section(
      notifications,
      '// Invalidate any response and draft for the previous viewer+hotel',
      'const load = useCallback',
    );
    assert.match(scopeReset, /saveRequestRef\.current \+= 1/);
    assert.match(scopeReset, /setNewCc\(''\)/);
    assert.match(scopeReset, /setSaving\(false\)/);
    assert.match(scopeReset, /\[capabilityViewerKey, propertyId\]/);

    const save = section(
      notifications,
      'const save = async',
      'const handleAddCc = async',
    );
    assert.match(save, /const requestedPropertyId = propertyId/);
    assert.match(save, /const requestId = \+\+saveRequestRef\.current/);
    assert.match(save, /requestId === saveRequestRef\.current[\s\S]*?activeScopeRef\.current === requestedPropertyId/);
    assert.match(save, /body: JSON\.stringify\(\{ propertyId: requestedPropertyId, \.\.\.next \}\)/);
    assert.ok((save.match(/if \(!ownsSave\(\)\) return false;/g) ?? []).length >= 3);
    assert.match(save, /finally \{[\s\S]*?if \(ownsSave\(\)\) setSaving\(false\)/);
  });

  test('My Shifts remounts an open time-off draft and stamps its completion', () => {
    assert.match(myShifts, /const scopeKey = `\$\{user\?\.uid \?\? 'signed-out'\}:\$\{activePropertyId \?\? 'no-property'\}`/);
    assert.match(myShifts, /<MyShiftsPropertyView[\s\S]*?key=\{scopeKey\}[\s\S]*?scopeKey=\{scopeKey\}/);
    assert.match(myShifts, /<RequestTimeOffModal[\s\S]*?hotelId=\{activePropertyId \?\? ''\}[\s\S]*?scopeKey=\{scopeKey\}/);

    const modal = section(
      myShifts,
      'function RequestTimeOffModal(',
      '// ── Not-linked empty state',
    );
    assert.match(modal, /actionScopeRef = React\.useRef<string \| null>\(scopeKey\)/);
    assert.match(modal, /actionScopeRef\.current === scopeKey[\s\S]*?actionScopeRef\.current = null/);
    assert.match(modal, /const requestedHotelId = hotelId/);
    assert.match(modal, /actionScopeRef\.current === scopeKey[\s\S]*?actionAttemptRef\.current === attempt/);
    assert.match(modal, /body: JSON\.stringify\(\{ hotelId: requestedHotelId, requestDate, reason:/);
    assert.match(modal, /timeoutMs: INTERACTIVE_ACTION_TIMEOUT_MS/);
    assert.ok((modal.match(/if \(!ownsAttempt\(\)\) return;/g) ?? []).length >= 2);
    assert.match(modal, /finally \{[\s\S]*?if \(ownsAttempt\(\)\) setBusy\(false\)/);
    assert.match(staffPage, /<DemoSwitchableView key=\{capabilityViewerKey\}/);
    assert.match(staffPage, /<ManagerView key=\{capabilityViewerKey\}/);
  });

  test('My Shifts bounds pickup writes and reconciles lost responses in the initiating scope', () => {
    assert.match(myShifts, /<OpenShiftsCard[\s\S]*?scopeKey=\{scopeKey\}[\s\S]*?onReconcile=\{retryShifts\}/);

    const pickup = section(
      myShifts,
      'function OpenShiftsCard(',
      'const MONTH_SHORT',
    );
    assert.match(pickup, /actionScopeRef = React\.useRef<string \| null>\(scopeKey\)/);
    assert.match(pickup, /actionScopeRef\.current === scopeKey[\s\S]*?actionScopeRef\.current = null/);
    assert.match(pickup, /if \(actionInFlightRef\.current\) return/);
    assert.match(pickup, /const requestedHotelId = hotelId/);
    assert.match(pickup, /const requestedShiftId = shiftId/);
    assert.match(pickup, /body: JSON\.stringify\(\{ hotelId: requestedHotelId, shiftId: requestedShiftId \}\)/);
    assert.match(pickup, /timeoutMs: INTERACTIVE_ACTION_TIMEOUT_MS/);
    assert.match(pickup, /let responseReceived = false/);
    assert.match(pickup, /responseReceived = true/);
    assert.match(pickup, /if \(!responseReceived\) \{[\s\S]*?onReconcile\(\)/);
    assert.ok(
      (pickup.match(/onReconcile\(\)/g) ?? []).length >= 2,
      'both successful and transport-ambiguous pickups must refresh the schedule snapshot',
    );
    assert.match(pickup, /finally \{[\s\S]*?if \(ownsAttempt\(\)\)[\s\S]*?setBusyId\(null\)/);
  });

  test('Feed cards and questions remount for the exact hotel and post to the captured scope', () => {
    assert.match(queue, /<HotelQueue[\s\S]*?propertyId=\{activePropertyId \?\? undefined\}/);
    // The cards are inside StaxisList now (2026-07-30). The invariant is
    // unchanged and so is the reason for it: everything on this screen must
    // remount for the exact hotel, so a stale row from the previous hotel can
    // never be acted on against the new one.
    //
    // 2026-07-30 (the DOM-leak outage): the two siblings' keys are now
    // NAMESPACED via hotelQueueChildKeys — still derived from the hotel, so
    // the remount-per-hotel invariant holds, but never equal to each other.
    // Two siblings sharing one bare propertyId key was the leak.
    // The behavior-level pin lives in staxis-list-remount.client.test.tsx;
    // these assertions pin that the keys stay derived from the hotel.
    assert.match(queue, /const childKeys = hotelQueueChildKeys\(propertyId\)/);
    assert.match(queue, /<StaxisList[\s\S]*?key=\{childKeys\.list\}[\s\S]*?propertyId=\{propertyId\}/);
    assert.match(staxisList, /<FindingCards[\s\S]*?key=\{propertyId\}[\s\S]*?propertyId=\{propertyId\}/);
    // Every write on the list carries the hotel it was captured against.
    assert.match(staxisList, /body: JSON\.stringify\(\{\s*\n?\s*pid: propertyId/);
    assert.match(queue, /<DripQuestionCard key=\{childKeys\.drip\}[\s\S]*?propertyId=\{propertyId\}/);
    assert.match(dripQuestion, /const resolvedPropertyId = propertyId \?\? activePropertyId/);
    assert.match(dripQuestion, /const pid = resolvedPropertyId[\s\S]*?body: JSON\.stringify\(\{ propertyId: pid/);
    assert.doesNotMatch(dripQuestion, /const pid = activePropertyId/);
  });

  test('Financial editors remount for the exact viewer and hotel', () => {
    assert.match(financialsPage, /const financialScopeKey = `\$\{user\.uid\}:\$\{activePropertyId\}`/);
    for (const component of ['CheckbookTab', 'BudgetTab', 'CapexTab']) {
      assert.match(
        financialsPage,
        new RegExp(`<${component} key=\\{financialScopeKey\\} scopeKey=\\{financialScopeKey\\}`),
      );
    }

    for (const contents of [checkbook, budget, capex]) {
      assert.match(contents, /activeScopeRef = useRef<string \| null>\(scopeKey\)/);
      assert.match(contents, /activeScopeRef\.current === scopeKey/);
      assert.match(contents, /activeScopeRef\.current = null/);
    }
  });

  test('Checkbook and Budget stamp writes with an immutable hotel and drop late results', () => {
    const checkbookActions = section(checkbook, 'const saveAction = useApiAction', 'const deptOptions = useMemo');
    assert.match(checkbookActions, /pid: input\.propertyId/);
    assert.ok((checkbookActions.match(/const requestedPropertyId = pid/g) ?? []).length >= 2);
    assert.ok((checkbookActions.match(/if \(!ownsAttempt\(\)\) return;/g) ?? []).length >= 2);

    const budgetActions = section(budget, 'const saveAction = useApiAction', 'const trending =');
    assert.match(budgetActions, /pid: input\.propertyId/);
    assert.match(budgetActions, /const requestedPropertyId = pid/);
    assert.match(budgetActions, /const requestedMonth = month/);
    assert.match(budgetActions, /if \(!ownsAttempt\(\)\) return;/);

    assert.match(financialUi, /timeoutMs: INTERACTIVE_ACTION_TIMEOUT_MS/);
  });

  test('CapEx stamps nested mutations and prevents stale dialogs from completing', () => {
    assert.match(capex, /<DetailModal[\s\S]*?key=\{`\$\{scopeKey\}:\$\{openId\}`\}[\s\S]*?scopeKey=\{`\$\{scopeKey\}:\$\{openId\}`\}/);
    assert.match(capex, /<RequestModal scopeKey=\{scopeKey\} pid=\{pid\}/);
    assert.match(capex, /<DecisionModal[\s\S]*?scopeKey=\{`\$\{scopeKey\}:\$\{decision\.project\.id\}:\$\{decision\.action\}`\}/);
    assert.match(capex, /const afterChange = \(focusId\?: string\) => \{[\s\S]*?if \(!ownsScope\(\)\) return;/);

    assert.match(capexRequest, /pid: input\.propertyId/);
    assert.match(capexRequest, /const requestedPropertyId = pid/);
    assert.ok((capexRequest.match(/if \(!ownsScope\(\)\)/g) ?? []).length >= 2);
    assert.match(capexRequest, /if \(!ownsAttempt\(\)\) return;/);
    assert.match(capexRequest, /timeoutMs: null/);

    assert.ok((capexDetail.match(/pid: input\.propertyId/g) ?? []).length >= 3);
    assert.ok((capexDetail.match(/const requestedPropertyId = pid/g) ?? []).length >= 4);
    assert.ok((capexDetail.match(/if \(!ownsScope\(\)\)/g) ?? []).length >= 5);
    assert.ok((capexDetail.match(/if \(!ownsAttempt\(\)\) return;/g) ?? []).length >= 3);
  });

});
