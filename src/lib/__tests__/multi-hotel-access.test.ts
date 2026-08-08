import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  buildMultiHotelRowsPayload,
  isSharedPropertyMemory,
  MAX_MULTI_HOTEL_RESPONSE_ROWS,
} from '@/lib/staxis/multi-hotel';
import {
  authorizationReceiptMatches,
  chooseExistingStaffIdentity,
} from '@/lib/staxis/multi-hotel-scope';
import {
  canClaimMultiHotelEmpty,
  filterMultiHotelRows,
  formatMultiHotelDate,
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
    replyCountComplete: true,
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
      surface: 'logbook',
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
      surface: 'logbook',
      entries: [logEntry(PROPERTY_A, 'available', '2026-08-08T10:00:00Z'), logEntry(PROPERTY_B, 'unavailable', '2026-08-08T11:00:00Z')],
    });
    assert.deepEqual(partial.entries.map((entry) => entry.id), ['available']);
    assert.equal(partial.coverage.complete, false);
  });

  test('missing local identity is unavailable, while duplicate exact identities are also unavailable', () => {
    const absent = chooseExistingStaffIdentity({
      propertyId: PROPERTY_A,
      authUserId: AUTH_USER,
      linkedCandidates: [],
      authCandidates: [],
      legacyCandidate: null,
      deterministicCandidate: null,
    });
    assert.deepEqual(absent, { kind: 'absent' });
    const unresolved = hotel(PROPERTY_A, 'Alpha');
    const unresolvedScope = {
      accountId: ACCOUNT,
      organizationId: null,
      hotels: [unresolved],
      authorizedPropertyIds: [PROPERTY_A],
      authorityHash: 'a'.repeat(64),
      authorityAll: false,
      authorizationReceipt: null,
    };
    const unresolvedPayload = buildMultiHotelRowsPayload({
      scope: unresolvedScope,
      attemptedHotels: [unresolved],
      unavailable: [{ propertyId: PROPERTY_A, hotelName: 'Alpha', reason: 'identity_unavailable' }],
      surface: 'assigned-by-me',
    });
    assert.equal(unresolvedPayload.coverage.complete, false);
    assert.equal(unresolvedPayload.coverage.unavailable[0]?.reason, 'identity_unavailable');
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
    assert.deepEqual(
      chooseExistingStaffIdentity({
        propertyId: PROPERTY_A,
        authUserId: AUTH_USER,
        linkedCandidates: [],
        authCandidates: [{ ...row('5'.repeat(36)), is_active: null }],
        legacyCandidate: null,
        deterministicCandidate: null,
      }),
      { kind: 'identity', staffId: '5'.repeat(36), department: 'front_desk' },
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
      rowBudget: 5_000,
      rowsReturned: 1,
      rowsOmitted: 0,
      responseByteBudget: 3_000_000,
      responseBytesEstimated: 100,
      truncated: false,
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

  test('aggregate row window is deterministic and explicit instead of silently claiming complete history', () => {
    const alpha = hotel(PROPERTY_A, 'Alpha');
    const scope = {
      accountId: ACCOUNT,
      organizationId: null,
      hotels: [alpha],
      authorizedPropertyIds: [PROPERTY_A],
      authorityHash: 'a'.repeat(64),
      authorityAll: false,
      authorizationReceipt: null,
    };
    const payload = buildMultiHotelRowsPayload({
      scope,
      attemptedHotels: [alpha],
      unavailable: [],
      surface: 'logbook',
      entries: Array.from({ length: MAX_MULTI_HOTEL_RESPONSE_ROWS + 37 }, (_, index) => (
        logEntry(PROPERTY_A, `row-${index}`, `2026-08-08T${String(index % 24).padStart(2, '0')}:00:00Z`)
      )),
    });
    assert.equal(payload.entries.length, MAX_MULTI_HOTEL_RESPONSE_ROWS);
    assert.equal(payload.coverage.rowsOmitted, 37);
    assert.equal(payload.coverage.truncated, true);
    assert.equal(payload.coverage.complete, false);

    const sourceWindowed = buildMultiHotelRowsPayload({
      scope,
      attemptedHotels: [alpha],
      unavailable: [],
      surface: 'logbook',
      entries: [logEntry(PROPERTY_A, 'only-visible-row', '2026-08-08T10:00:00Z')],
      sourceTruncated: true,
    });
    assert.equal(sourceWindowed.coverage.truncated, true);
    assert.equal(sourceWindowed.coverage.complete, false);
    assert.equal(sourceWindowed.coverage.rowsOmitted, 1);
  });

  test('response byte budget counts UTF-8 bytes and formats dates in the hotel timezone', () => {
    const alpha = hotel(PROPERTY_A, 'Alpha');
    const scope = {
      accountId: ACCOUNT,
      organizationId: null,
      hotels: [alpha],
      authorizedPropertyIds: [PROPERTY_A],
      authorityHash: 'a'.repeat(64),
      authorityAll: false,
      authorizationReceipt: null,
    };
    const unicodeRow = { ...logEntry(PROPERTY_A, 'unicode', '2026-08-08T10:00:00Z'), body: '💡'.repeat(800_000) };
    const payload = buildMultiHotelRowsPayload({
      scope,
      attemptedHotels: [alpha],
      unavailable: [],
      surface: 'logbook',
      entries: [unicodeRow],
    });
    assert.equal(payload.entries.length, 0);
    assert.equal(payload.coverage.truncated, true);
    assert.equal(formatMultiHotelDate('2026-08-08T01:00:00Z', 'America/Chicago', 'en-US'), 'Aug 7');
    assert.equal(
      formatMultiHotelDate('2026-08-08T01:00:00Z', 'not/a-timezone', 'en-US'),
      new Date('2026-08-08T01:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    );
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
    assert.match(scope, /is_active\.eq\.true,is_active\.is\.null/);
    assert.doesNotMatch(scope, /display_name/);
    assert.doesNotMatch(scope, /\.insert\(/);
    assert.doesNotMatch(scope, /\.update\(/);
  });

  test('Assigned by me remains author-scoped and distinguishes absent from ambiguous identity', () => {
    const read = source('src', 'lib', 'staxis', 'multi-hotel.ts');
    assert.match(read, /gatherAssignedByMeWithMeta\(/);
    assert.match(read, /!hotel\.staffId/);
    assert.match(read, /reason: 'identity_unavailable'/);
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
    assert.match(route, /hashToRateLimitKey\(`\$\{account\.accountId\}:\$\{session\.userId\}`\)/);
    assert.doesNotMatch(route, /hashToRateLimitKey\(`\$\{account\.accountId\}:\$\{organizationId/);
    assert.match(route, /replies\.reason === 'not_found'[\s\S]*status: 404/);
    assert.match(route, /This log book entry was removed or is no longer available/);
    assert.match(route, /repliesComplete: replies\.truncated !== true/);
    assert.match(route, /ready: payload\.coverage\.complete/);
  });

  test('partial aggregate data stays visible with explicit coverage, while single-hotel UI keeps its existing popup', () => {
    const panel = source('src', 'components', 'concourse', 'MultiHotelOpsPanel.tsx');
    const list = source('src', 'components', 'concourse', 'StaxisList.tsx');
    assert.match(panel, /!payload\.coverage\.complete/);
    assert.match(panel, /payload && surface === 'logbook'/);
    assert.match(panel, /hotels\.length > 1/);
    assert.match(panel, /aria-pressed/);
    assert.match(panel, /Showing the first 500 replies/);
    assert.doesNotMatch(panel, /onOpenLogbook|Open \{entry\.hotelName\}/);
    assert.match(list, /propertyId=\{propertyId\}/);
  });
});
