import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  buildMultiHotelRowsPayload,
  isSharedPropertyMemory,
} from '@/lib/staxis/multi-hotel';
import {
  authorizationReceiptMatches,
  chooseExistingStaffIdentity,
} from '@/lib/staxis/multi-hotel-scope';
import {
  canClaimMultiHotelEmpty,
  filterMultiHotelRows,
  type MultiHotelCoverage,
} from '@/lib/staxis/multi-hotel-types';
import { keepForAssigner } from '@/lib/worklist/core';

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

const PROPERTY_A = '11111111-1111-4111-8111-111111111111';
const PROPERTY_B = '22222222-2222-4222-8222-222222222222';
const PROPERTY_C = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AUTH_USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function hotel(propertyId: string, hotelName: string) {
  return {
    propertyId,
    hotelName,
    timezone: 'America/Chicago',
    standing: null,
    staffId: null,
    department: null,
    identityAmbiguous: false,
  };
}

function logEntry(propertyId: string, id: string, createdAt: string) {
  return {
    id,
    propertyId,
    hotelName: propertyId === PROPERTY_A ? 'Alpha' : propertyId === PROPERTY_B ? 'Bravo' : 'Foreign',
    timezone: 'America/Chicago',
    title: id,
    body: '',
    category: null,
    authorStaffId: null,
    authorName: null,
    replyCount: 0,
    createdAt,
    updatedAt: createdAt,
  };
}

describe('multi-hotel Staxis access contract', () => {
  test('merges authorized A/B in global order, labels hotels, and drops foreign C', () => {
    const alpha = hotel(PROPERTY_A, 'Alpha');
    const bravo = hotel(PROPERTY_B, 'Bravo');
    const scope = {
      accountId: ACCOUNT,
      organizationId: null,
      hotels: [alpha, bravo],
      authorizedPropertyIds: [PROPERTY_A, PROPERTY_B],
      authorityHash: 'a'.repeat(64),
      authorityAll: false,
      authorizationReceipt: null,
    };
    const payload = buildMultiHotelRowsPayload({
      scope,
      attemptedHotels: [alpha, bravo],
      unavailable: [],
      entries: [
        logEntry(PROPERTY_A, 'older', '2026-08-07T10:00:00Z'),
        logEntry(PROPERTY_C, 'foreign', '2026-08-09T10:00:00Z'),
        logEntry(PROPERTY_B, 'newer', '2026-08-08T10:00:00Z'),
      ],
    });
    assert.deepEqual(payload.entries.map((entry) => entry.id), ['newer', 'older']);
    assert.deepEqual(payload.hotels.map((entry) => entry.propertyId), [PROPERTY_A, PROPERTY_B]);
    assert.equal(payload.coverage.complete, true);
    assert.equal(payload.coverage.omittedHotelCount, 0);
    const partial = buildMultiHotelRowsPayload({
      scope,
      attemptedHotels: [alpha, bravo],
      unavailable: [{ propertyId: PROPERTY_B, hotelName: 'Bravo', reason: 'read_failed' }],
      entries: [logEntry(PROPERTY_A, 'available', '2026-08-08T10:00:00Z'), logEntry(PROPERTY_B, 'unavailable', '2026-08-08T11:00:00Z')],
    });
    assert.deepEqual(partial.entries.map((entry) => entry.id), ['available']);
    assert.equal(partial.coverage.complete, false);
  });

  test('missing local identity is absent, while duplicate exact identities are unavailable', () => {
    const absent = chooseExistingStaffIdentity({
      propertyId: PROPERTY_A,
      authUserId: AUTH_USER,
      linkedCandidates: [],
      authCandidates: [],
      legacyCandidate: null,
      deterministicCandidate: null,
    });
    assert.deepEqual(absent, { kind: 'absent' });
    const row = (id: string) => ({
      id,
      property_id: PROPERTY_A,
      auth_user_id: AUTH_USER,
      department: 'front_desk',
      is_active: true,
    });
    assert.deepEqual(
      chooseExistingStaffIdentity({
        propertyId: PROPERTY_A,
        authUserId: AUTH_USER,
        linkedCandidates: [],
        authCandidates: [row('1'.repeat(36)), row('2'.repeat(36))],
        legacyCandidate: null,
        deterministicCandidate: null,
      }),
      { kind: 'ambiguous' },
    );
    assert.deepEqual(
      chooseExistingStaffIdentity({
        propertyId: PROPERTY_A,
        authUserId: AUTH_USER,
        linkedCandidates: [],
        authCandidates: [],
        legacyCandidate: null,
        deterministicCandidate: { ...row('3'.repeat(36)), auth_user_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
      }),
      { kind: 'absent' },
    );
    assert.deepEqual(
      chooseExistingStaffIdentity({
        propertyId: PROPERTY_A,
        authUserId: AUTH_USER,
        linkedCandidates: [{ ...row('4'.repeat(36)), auth_user_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }],
        authCandidates: [],
        legacyCandidate: null,
        deterministicCandidate: null,
      }),
      { kind: 'ambiguous' },
    );
  });

  test('Assigned by me uses the exact local author and keeps self-assigned work out', () => {
    const read = source('src', 'lib', 'worklist', 'core.ts');
    assert.match(read, /\.eq\('created_by_staff_id', staffId\)/);
    const base = {
      taskId: 'task',
      title: 'Task',
      assigneeStaffId: 'other-staff',
      assigneeName: 'Other',
      assignedDepartment: null,
      state: 'waiting' as const,
      dueDate: null,
      createdAt: null,
      settledByName: null,
      settledByStaffId: null,
      settledAt: null,
      reason: null,
      completedForDate: null,
      ageDays: 0,
    };
    assert.equal(keepForAssigner(base, 'current-local-staff'), true);
    assert.equal(keepForAssigner({ ...base, assigneeStaffId: 'current-local-staff' }, 'current-local-staff'), false);
    assert.equal(keepForAssigner({ ...base, assigneeStaffId: 'gm-staff' }, 'current-local-staff'), true);
  });

  test('partial coverage renders available rows but cannot claim an empty whole scope', () => {
    const coverage = {
      authorizedHotelCount: 2,
      attemptedHotelCount: 2,
      processedHotelCount: 1,
      omittedHotelCount: 0,
      unavailableHotelCount: 1,
      unavailable: [],
      complete: false,
    } satisfies MultiHotelCoverage;
    assert.equal(canClaimMultiHotelEmpty(coverage), false);
    const rows = [
      { propertyId: PROPERTY_A, hotelName: 'Alpha', timezone: null, value: 'row A' },
      { propertyId: PROPERTY_B, hotelName: 'Bravo', timezone: null, value: 'row B' },
    ];
    assert.deepEqual(filterMultiHotelRows(rows, PROPERTY_B).map((row) => row.value), ['row B']);
    assert.deepEqual(filterMultiHotelRows(rows, 'all').map((row) => row.value), ['row A', 'row B']);
  });

  test('property memory excludes both current-user and other-user subjects', () => {
    assert.equal(isSharedPropertyMemory({ scope: 'property', subject_account_id: null, is_active: true }), true);
    assert.equal(isSharedPropertyMemory({ scope: 'property', subject_account_id: ACCOUNT, is_active: true }), false);
    assert.equal(isSharedPropertyMemory({ scope: 'user', subject_account_id: null, is_active: true }), false);
    assert.equal(isSharedPropertyMemory({ scope: 'property', subject_account_id: null, is_active: false }), false);
  });

  test('receipt reassertion fails closed after revocation or hotel-set change', () => {
    const receipt = {
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      organizationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      scopeHash: 'f'.repeat(64),
      authorizationHash: '0'.repeat(64),
      propertyIds: [PROPERTY_A, PROPERTY_B],
    } as const;
    const scope = {
      organizationId: receipt.organizationId,
      authorizedPropertyIds: [PROPERTY_A, PROPERTY_B],
      authorizationReceipt: receipt,
    };
    assert.equal(authorizationReceiptMatches(scope, receipt), true);
    assert.equal(authorizationReceiptMatches(scope, { ...receipt, authorizationHash: '1'.repeat(64) }), false);
    assert.equal(authorizationReceiptMatches(scope, { ...receipt, propertyIds: [PROPERTY_A] }), false);
  });

  test('resolves existing property-local identities without display-name matching or writes', () => {
    const scope = source('src', 'lib', 'staxis', 'multi-hotel-scope.ts');
    assert.match(scope, /account_property_staff_links/);
    assert.match(scope, /auth_user_id/);
    assert.match(scope, /commsStaffIdentityId\(propertyId, input\.accountId\)/);
    assert.match(scope, /identityAmbiguous/);
    assert.doesNotMatch(scope, /display_name/);
    assert.doesNotMatch(scope, /\.insert\(/);
    assert.doesNotMatch(scope, /\.update\(/);
  });

  test('Assigned by me remains author-scoped and distinguishes absent from ambiguous identity', () => {
    const read = source('src', 'lib', 'staxis', 'multi-hotel.ts');
    assert.match(read, /gatherAssignedByMe\(/);
    assert.match(read, /!hotel\.staffId/);
    assert.match(read, /ok: true, value: \[\]/);
    assert.match(read, /hotel\.identityAmbiguous/);
    assert.match(read, /scope.*property/);
  });

  test('Knows aggregate is property-only and excludes subject memory', () => {
    const read = source('src', 'lib', 'staxis', 'multi-hotel.ts');
    assert.match(read, /\.eq\('scope', 'property'\)/);
    assert.match(read, /\.is\('subject_account_id', null\)/);
    assert.match(read, /docVisibilityScope/);
    assert.match(read, /canReadDocVisibility/);
  });

  test('aggregate API reasserts exact company/hotel scope before egress and detail uses exact pid + entry', () => {
    const route = source('src', 'app', 'api', 'staxis', 'multi-hotel', 'route.ts');
    assert.match(route, /organizationId/);
    assert.match(route, /propertyId/);
    assert.match(route, /entryId/);
    assert.match(route, /readLogRepliesForHotel\(hotel, entryId\.value\)/);
    assert.match(route, /multiHotelScopeStillCurrent\(resolved\.scope\)/);
    assert.match(route, /checkAndIncrementRateLimit\(\s*'comms-read'/);
    assert.match(route, /ready: payload\.coverage\.complete/);
  });

  test('partial aggregate data stays visible with explicit coverage, while single-hotel UI keeps its existing popup', () => {
    const panel = source('src', 'components', 'concourse', 'MultiHotelOpsPanel.tsx');
    const list = source('src', 'components', 'concourse', 'StaxisList.tsx');
    assert.match(panel, /!payload\.coverage\.complete/);
    assert.match(panel, /payload && surface === 'logbook'/);
    assert.match(panel, /hotels\.length > 1/);
    assert.doesNotMatch(panel, /onOpenLogbook|Open \{entry\.hotelName\}/);
    assert.match(list, /propertyId=\{propertyId\}/);
  });
});
