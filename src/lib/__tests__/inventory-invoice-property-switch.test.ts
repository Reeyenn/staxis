import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import {
  invoiceReviewHasUnsavedWork,
} from '../../app/inventory/_components/overlays/scan-review';
import {
  beginInvoiceOperation,
  createInvoiceOperationCursor,
  duplicateInvoiceRequestIsCurrent,
  invalidateInvoiceOperations,
  invoiceOperationIsCurrent,
  normalizeDuplicateVendorIdentity,
  syncInvoiceOperationLifecycle,
  type DuplicateInvoiceRequestScope,
} from '../../app/inventory/_components/overlays/scan-operation-scope';
import {
  BEFORE_PROPERTY_CHANGE_EVENT,
  propertyChangeAllowed,
  type PropertyChangeDetail,
} from '../property-change-guard';

type GuardState = Parameters<typeof invoiceReviewHasUnsavedWork>[0] & {
  retryLocked?: boolean;
  saveBoundaryInFlight?: boolean;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function withWindowTarget<T>(run: (target: EventTarget) => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const target = new EventTarget();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: target,
    writable: true,
  });
  try {
    return run(target);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
    else delete (globalThis as { window?: unknown }).window;
  }
}

function attemptCrossTabSwitch(
  state: GuardState,
  confirmDiscard: () => boolean,
  onConfirmedDiscard: () => void = () => {},
) {
  return withWindowTarget((target) => {
    let activePropertyId = 'hotel-a';
    const beforePropertyChange = (rawEvent: Event) => {
      const event = rawEvent as CustomEvent<PropertyChangeDetail>;
      const hasUnsavedChanges = Boolean(state.retryLocked)
        || invoiceReviewHasUnsavedWork(state);
      if (!hasUnsavedChanges) return;
      if (
        state.saveBoundaryInFlight
        || state.phase === 'verifying'
        || state.phase === 'committing'
        || state.retryLocked
      ) {
        event.preventDefault();
        return;
      }
      if (!confirmDiscard()) {
        event.preventDefault();
        return;
      }
      onConfirmedDiscard();
    };
    target.addEventListener(BEFORE_PROPERTY_CHANGE_EVENT, beforePropertyChange);

    const allowed = propertyChangeAllowed({
      fromPropertyId: activePropertyId,
      toPropertyId: 'hotel-b',
      source: 'cross-tab',
    });
    if (allowed) activePropertyId = 'hotel-b';

    target.removeEventListener(BEFORE_PROPERTY_CHANGE_EVENT, beforePropertyChange);
    return { activePropertyId, allowed };
  });
}

describe('scanned-invoice property-switch guard', () => {
  test('a rejected cross-tab switch preserves upload, reading, and review work', () => {
    const work: GuardState[] = [
      { phase: 'upload', hasStagedFile: true, rowCount: 0 },
      { phase: 'reading', hasStagedFile: false, rowCount: 0 },
      { phase: 'review', hasStagedFile: false, rowCount: 2 },
    ];

    for (const state of work) {
      let confirms = 0;
      const result = attemptCrossTabSwitch(state, () => {
        confirms += 1;
        return false;
      });
      assert.deepEqual(result, { activePropertyId: 'hotel-a', allowed: false }, state.phase);
      assert.equal(confirms, 1, state.phase);
    }
  });

  test('an explicit confirmation clears the old draft and allows the hotel switch', () => {
    let oldHotelDraftPresent = true;
    const result = attemptCrossTabSwitch(
      { phase: 'review', hasStagedFile: false, rowCount: 1 },
      () => true,
      () => { oldHotelDraftPresent = false; },
    );
    assert.deepEqual(result, { activePropertyId: 'hotel-b', allowed: true });
    assert.equal(oldHotelDraftPresent, false);
  });

  test('save-boundary, committing, and durable-retry states never switch hotels', () => {
    let confirms = 0;
    const confirm = () => {
      confirms += 1;
      return true;
    };
    assert.deepEqual(
      attemptCrossTabSwitch(
        { phase: 'verifying', hasStagedFile: false, rowCount: 1 },
        confirm,
      ),
      { activePropertyId: 'hotel-a', allowed: false },
    );
    assert.deepEqual(
      attemptCrossTabSwitch(
        { phase: 'review', hasStagedFile: false, rowCount: 1, saveBoundaryInFlight: true },
        confirm,
      ),
      { activePropertyId: 'hotel-a', allowed: false },
    );
    assert.deepEqual(
      attemptCrossTabSwitch(
        { phase: 'committing', hasStagedFile: false, rowCount: 1 },
        confirm,
      ),
      { activePropertyId: 'hotel-a', allowed: false },
    );
    assert.deepEqual(
      attemptCrossTabSwitch(
        { phase: 'review', hasStagedFile: false, rowCount: 0, retryLocked: true },
        confirm,
      ),
      { activePropertyId: 'hotel-a', allowed: false },
    );
    assert.equal(confirms, 0);
  });

  test('a late OCR response cannot repopulate the newly selected hotel', async () => {
    let cursor = createInvoiceOperationCursor(true, 'hotel-a');
    const started = beginInvoiceOperation(cursor, 'hotel-a');
    cursor = started.cursor;
    const response = deferred<string>();
    let visibleRows = ['hotel-b existing item'];
    const settle = (async () => {
      const oldHotelLine = await response.promise;
      if (invoiceOperationIsCurrent(started.scope, cursor)) visibleRows = [oldHotelLine];
    })();

    cursor = syncInvoiceOperationLifecycle(cursor, true, 'hotel-b');
    response.resolve('hotel-a OCR line');
    await settle;

    assert.deepEqual(visibleRows, ['hotel-b existing item']);
  });

  test('a property lifecycle change at duplicate verification cannot cross the commit boundary', async () => {
    let cursor = createInvoiceOperationCursor(true, 'hotel-a');
    const started = beginInvoiceOperation(cursor, 'hotel-a');
    cursor = started.cursor;
    const duplicateBoundary = deferred<'clear'>();
    let commits = 0;
    const save = (async () => {
      await duplicateBoundary.promise;
      if (!invoiceOperationIsCurrent(started.scope, cursor)) return;
      commits += 1;
    })();

    cursor = syncInvoiceOperationLifecycle(cursor, true, 'hotel-b');
    duplicateBoundary.resolve('clear');
    await save;

    assert.equal(commits, 0);
  });

  test('only a committed lifecycle change invalidates active work, and layout cleanup invalidates unmount', () => {
    let committedCursor = createInvoiceOperationCursor(true, 'hotel-a');
    const started = beginInvoiceOperation(committedCursor, 'hotel-a');
    committedCursor = started.cursor;

    // A concurrent render can calculate a possible next lifecycle, but an
    // abandoned render never publishes it to the committed ref.
    const abandonedProposal = syncInvoiceOperationLifecycle(committedCursor, true, 'hotel-b');
    assert.equal(invoiceOperationIsCurrent(started.scope, committedCursor), true);
    assert.equal(invoiceOperationIsCurrent(started.scope, abandonedProposal), false);

    // The layout-effect cleanup used on unmount/property commit publishes an
    // invalidated cursor synchronously.
    committedCursor = invalidateInvoiceOperations(committedCursor);
    assert.equal(invoiceOperationIsCurrent(started.scope, committedCursor), false);
  });

  test('an older duplicate lookup cannot overwrite a newer invoice identity', async () => {
    let cursor = createInvoiceOperationCursor(true, 'hotel-a');
    const first = beginInvoiceOperation(cursor, 'hotel-a');
    cursor = first.cursor;
    const firstScope: DuplicateInvoiceRequestScope = {
      ...first.scope,
      reference: 'INV-A',
      vendor: normalizeDuplicateVendorIdentity('Vendor A'),
    };
    const oldLookup = deferred<boolean>();
    let visibleDuplicate: boolean | null = null;
    let currentIdentity = { reference: 'INV-A', vendor: 'Vendor A' };
    const settleOld = (async () => {
      const duplicate = await oldLookup.promise;
      if (duplicateInvoiceRequestIsCurrent(firstScope, cursor, currentIdentity)) {
        visibleDuplicate = duplicate;
      }
    })();

    currentIdentity = { reference: 'INV-B', vendor: 'Vendor B' };
    const second = beginInvoiceOperation(cursor, 'hotel-a');
    cursor = second.cursor;
    const secondScope: DuplicateInvoiceRequestScope = {
      ...second.scope,
      reference: 'INV-B',
      vendor: normalizeDuplicateVendorIdentity('Vendor B'),
    };
    assert.equal(duplicateInvoiceRequestIsCurrent(secondScope, cursor, currentIdentity), true);
    visibleDuplicate = false;

    oldLookup.resolve(true);
    await settleOld;
    assert.equal(visibleDuplicate, false);
  });

  test('the live wiring gates cross-tab state changes and freezes delivery writes to the attempt hotel', () => {
    const propertyContext = readFileSync(fileURLToPath(new URL(
      '../../contexts/PropertyContext.tsx', import.meta.url,
    )), 'utf8');
    const scanSheet = readFileSync(fileURLToPath(new URL(
      '../../app/inventory/_components/overlays/ScanInvoiceSheet.tsx', import.meta.url,
    )), 'utf8');
    const commit = readFileSync(fileURLToPath(new URL(
      '../../app/inventory/_components/overlays/scan-commit.ts', import.meta.url,
    )), 'utf8');

    assert.match(
      propertyContext,
      /source:\s*'cross-tab',[\s\S]*?\}\)\) return;[\s\S]*?setActivePropertyIdState\(next\)/,
    );
    assert.match(
      scanSheet,
      /if \(!open \|\| !hasUnsavedChanges\) return;[\s\S]*?saveBoundaryScopeRef\.current[\s\S]*?phase === 'verifying'[\s\S]*?phase === 'committing'[\s\S]*?event\.preventDefault\(\)[\s\S]*?!window\.confirm\(ss\.propertySwitchConfirm\)[\s\S]*?invalidateOperations\(\)[\s\S]*?addEventListener\(BEFORE_PROPERTY_CHANGE_EVENT, beforePropertyChange\)/,
    );
    assert.match(
      scanSheet,
      /useLayoutEffect\(\(\) => \{[\s\S]*?const nextLifecycle = syncInvoiceOperationLifecycle\([\s\S]*?return \(\) => \{[\s\S]*?operationCursorRef\.current = invalidateInvoiceOperations\(operationCursorRef\.current\);[\s\S]*?saveBoundaryScopeRef\.current = null;[\s\S]*?\}, \[activePropertyId, open\]\);/,
    );
    assert.equal((scanSheet.match(/syncInvoiceOperationLifecycle\(/g) ?? []).length, 1);
    assert.match(
      scanSheet,
      /if \(reviewStorageInput\) clearInventoryOverlayDraft\(reviewStorageInput\);\s*invalidateOperations\(\);/,
    );
    assert.match(
      scanSheet,
      /const scanScope = beginOperation\(activePropertyId\)[\s\S]*?pid: scanScope\.propertyId[\s\S]*?if \(!operationCurrent\(scanScope\)\) return;[\s\S]*?verifyDuplicateInvoice\(num, scannedVendor, scanScope\)/,
    );
    assert.match(
      scanSheet,
      /saveBoundaryScopeRef\.current = commitScope;[\s\S]*?setPhase\('verifying'\);[\s\S]*?await verifyDuplicateInvoice\([^;]*commitScope\)[\s\S]*?if \(!operationCurrent\(commitScope\)\)[\s\S]*?setPhase\('committing'\)/,
    );
    assert.match(
      commit,
      /receiveInventoryDeliveryAtomic\(\s*ctx\.uid,[\s\S]*?attempt\.propertyId,/,
    );
  });
});
