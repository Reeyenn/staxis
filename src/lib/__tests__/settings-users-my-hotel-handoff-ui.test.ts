import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const page = readFileSync(
  join(process.cwd(), 'src', 'app', 'settings', 'users', 'page.tsx'),
  'utf8',
);

describe('legacy Settings users handoff', () => {
  test('keeps the bookmark useful and links to the active hotel People workspace', () => {
    assert.match(page, /href="\/company\?tab=people"/);
    assert.match(page, /Open People for \$\{activeProperty\?\.name \?\? 'this hotel'\}/);
    assert.match(page, /This bookmark still shows accounts and ownership transfer/);
    assert.match(page, /Open People in My Hotel/);
    assert.match(page, /Abrir Personas en Mi hotel/);
    assert.doesNotMatch(page, /router\.replace\(['"]\/company\?tab=people/);
  });

  test('does not expose legacy role or login-lifecycle mutations', () => {
    assert.doesNotMatch(page, /ASSIGNABLE_ROLES/);
    assert.doesNotMatch(page, /UserX|UserCheck/);
    assert.doesNotMatch(page, /action:\s*['"](?:change_role|deactivate|reactivate)['"]/);
    assert.doesNotMatch(page, /confirm\(msg\)/);
    assert.doesNotMatch(page, /value=\{u\.role\}[\s\S]*<option/);
    assert.doesNotMatch(page, /opacity: u\.active/);
  });

  test('preserves ownership transfer as the only account mutation', () => {
    assert.match(page, /const transferOwnership = async \(accountId: string, reason: string\)/);
    assert.match(page, /action: 'transfer_ownership'/);
    assert.match(page, /newOwnerAccountId: accountId/);
    assert.match(page, /<TransferOwnershipModal/);
    assert.match(page, /Make owner/);
    assert.match(page, /await transferOwnership\(transferTarget\.accountId, reason\)/);
  });

  test('persists one client operation UUID across ambiguous response and reload retries', () => {
    assert.match(page, /getOrCreateOwnershipTransferAttempt/);
    assert.match(page, /window\.localStorage/);
    assert.match(page, /operationId,/);
    assert.match(page, /const definitive = \(res\.ok && body\.ok === true\)/);
    assert.match(page, /clearOwnershipTransferAttempt\([\s\S]*requestedPropertyId,[\s\S]*accountId,[\s\S]*operationId/);
    assert.doesNotMatch(page, /finally[\s\S]{0,160}clearOwnershipTransferAttempt/);
  });

  test('keeps navigation and ownership targets touch sized', () => {
    assert.match(page, /className="btn btn-primary"[\s\S]*style=\{\{ height: 44/);
    assert.match(page, /function ghostBtnStyle[\s\S]*height: 44/);
  });
});
