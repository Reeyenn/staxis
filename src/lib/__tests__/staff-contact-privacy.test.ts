import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { STAFF_COLS } from '@/lib/db/staff';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('staff phone privacy', () => {
  test('generic property roster never includes phone data', () => {
    const cols = STAFF_COLS.split(',').map(c => c.trim());
    assert.ok(!cols.includes('phone'), `STAFF_COLS exposed phone: ${STAFF_COLS}`);
    assert.ok(!cols.includes('phone_lookup'), `STAFF_COLS exposed phone_lookup: ${STAFF_COLS}`);
  });

  test('generic browser writes strip phone as well as wage', () => {
    const db = source('src/lib/db/staff.ts');
    assert.match(db, /delete row\.phone;/);
    assert.match(db, /delete row\.hourly_wage;/);
    assert.match(db, /addStaffMember[\s\S]*stripPrivateWrites\(toStaffRow\(data\)\)/);
    assert.match(db, /updateStaffMember[\s\S]*stripPrivateWrites\(toStaffRow\(data\)\)/);
  });

  test('contacts API requires manage_team and scopes reads and writes to the property', () => {
    const route = source('src/app/api/staff/contacts/route.ts');
    assert.match(route, /verifyTeamManager\(req, \{ capability: 'manage_team' \}\)/g);
    assert.match(route, /callerCapabilityDecision\(caller, 'manage_team', propertyId\)/g);
    assert.match(route, /capabilityDecision === 'unavailable'[\s\S]*capabilityUnavailableResponse/g);
    assert.match(route, /\.select\('id, phone'\)[\s\S]*\.eq\('property_id', propertyId\)/);
    assert.match(route, /\.update\(\{ phone, phone_lookup: phoneLookup \}\)[\s\S]*\.eq\('id', staffCheck\.value!\)[\s\S]*\.eq\('property_id', propertyId\)/);
    assert.match(route, /phone\.replace\(\/\\D\/g, ''\)\.slice\(-10\)/);
    assert.match(route, /if \(!updated\)[\s\S]*Staff member not found for this property/);
    assert.match(route, /validateUuid\(body\.staffId, 'staffId'\)/);
    assert.match(route, /validatePhone\(body\.phone, 'phone'\)/);
  });

  test('My Hotel → People hydrates and writes contacts through the gated API', () => {
    // The merged People panel took over the Directory's phone handling on
    // 2026-07-27 (Staff → Directory, which held the only other copy of this
    // logic, was deleted the same day). Same discipline: the number never rides
    // the browser roster projection, and an untouched blank field never
    // overwrites a stored one.
    const panel = source('src/app/company/_components/HotelTeamPanel.tsx');
    const form = source('src/app/company/_components/PersonEmploymentForm.tsx');
    assert.match(panel, /\/api\/staff\/contacts\?propertyId=\$\{encodeURIComponent\(hotelId\)\}/);
    assert.match(form, /fetchWithAuth\('\/api\/staff\/contacts', \{/);
    assert.match(form, /phoneTouched/);
    assert.match(form, /if \(!existingId \|\| phoneTouched\) \{/);
    assert.doesNotMatch(form, /phone:\s*staff\.phone/);
    assert.doesNotMatch(panel, /member\.phone|staff\.phone/);
    assert.match(panel, /contacts=\{contacts\}/);
    assert.match(panel, /contactsReady=\{contactsReady\}/);
    assert.match(panel, /contactsUnavailable=\{contactsError\}/);
    assert.doesNotMatch(panel, /Phone unavailable/);
  });

  test('same-property operational surfaces expose phone presence, never the raw number', () => {
    const board = source('src/app/api/housekeeping/board/route.ts');
    assert.match(board, /has_phone:\s*typeof s\.phone/);
    assert.doesNotMatch(board, /\n\s*phone:\s*s\.phone/);

    const boardType = source('src/app/housekeeping/_components/ScheduleBoard.tsx');
    const boardHk = boardType.match(/export interface BoardHk \{([\s\S]*?)\n\}/)?.[1] ?? '';
    assert.match(boardHk, /has_phone:\s*boolean/);
    assert.doesNotMatch(boardHk, /\bphone\??:/);

    const agentHelper = source('src/lib/agent/tools/_helpers.ts');
    assert.doesNotMatch(agentHelper, /\.select\('[^']*\bphone\b[^']*'\)/);
    const staffRow = agentHelper.match(/export interface StaffRow \{([\s\S]*?)\n\}/)?.[1] ?? '';
    assert.doesNotMatch(staffRow, /\bphone\??:/);

    const adminHealth = source('src/app/api/admin/property-health/route.ts');
    assert.doesNotMatch(adminHealth, /\.from\('staff'\)[\s\S]{0,120}\.select\('[^']*\bphone\b/);

    const autoFill = source('src/app/api/cron/schedule-auto-fill/route.ts');
    assert.doesNotMatch(autoFill, /\.from\('staff'\)\s*\.select\('\*'\)/);
    assert.doesNotMatch(autoFill, /\.from\('staff'\)[\s\S]{0,350}\b(?:phone|hourly_wage)\b/);
  });

  test('a failed new-staff contact initialization retries by id, not by inserting again', () => {
    // Saving a brand-new person is several writes: the staff row, then the
    // phone, then the wage, then the auto-assign rank. If any later one fails,
    // pressing Save again must REUSE the row the first attempt created —
    // otherwise the hotel ends up with two of the same housekeeper.
    const ui = source('src/app/company/_components/PersonEmploymentForm.tsx');
    assert.match(ui, /const existingId = staffId \?\? createdIdRef\.current/);
    assert.match(ui, /createdIdRef\.current = newId/);
    assert.match(ui, /existingId\s*\?\s*updateStaffMember[\s\S]*?:\s*addStaffMember/);
    assert.match(ui, /if \(!existingId \|\| phoneTouched\) \{/);

    // The retry id may only be forgotten once every write has landed.
    const contactWrite = ui.indexOf("fetchWithAuth('/api/staff/contacts'");
    const wageWrite = ui.indexOf("fetchWithAuth('/api/staff/wages'");
    const priorityWrite = ui.indexOf("fetchWithAuth('/api/housekeeping/staff-priority'");
    const clearRetryId = ui.indexOf('createdIdRef.current = null;');
    const catchBlock = ui.indexOf('} catch (saveError) {', clearRetryId);
    assert.ok(contactWrite > 0 && wageWrite > contactWrite && priorityWrite > wageWrite,
      'the follow-up writes must run after the staff row is created');
    assert.ok(clearRetryId > priorityWrite && catchBlock > clearRetryId,
      'the retry id must only be cleared after every follow-up write succeeded');
    assert.doesNotMatch(
      ui.slice(catchBlock),
      /createdIdRef\.current = null/,
      'a failed save must keep the created row id so the retry updates it',
    );
  });

  test('migration 0332 restricts authenticated reads to the roster projection', () => {
    const migration = source('supabase/migrations/0332_staff_sensitive_column_privileges.sql');
    const match = migration.match(
      /grant\s+select\s*\(([\s\S]*?)\)\s+on\s+public\.staff\s+to\s+authenticated;/i,
    );
    assert.ok(match, 'migration must define an authenticated column allowlist');

    const granted = match[1]
      .split(',')
      .map(column => column.trim())
      .filter(Boolean)
      .sort();
    const expected = ['property_id', ...STAFF_COLS.split(',').map(column => column.trim())].sort();
    assert.deepEqual(granted, expected);

    assert.match(migration, /revoke\s+select\s+on\s+public\.staff\s+from\s+public,\s*anon,\s*authenticated/i);
    assert.match(migration, /grant\s+select\s+on\s+public\.staff\s+to\s+service_role/i);
    for (const sensitive of ['phone', 'phone_lookup', 'hourly_wage']) {
      assert.ok(!granted.includes(sensitive), `${sensitive} must not be browser-readable`);
    }
    assert.doesNotMatch(
      migration,
      /revoke\s+(?:insert|update|delete)|revoke\s+[^;]*(?:insert|update|delete)[^;]*on\s+public\.staff/i,
      'column privacy migration must preserve the manage_team-gated write grants',
    );
  });
});
