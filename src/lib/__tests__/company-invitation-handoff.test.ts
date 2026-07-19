import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  clearCompanyInvitationHandoff,
  COMPANY_INVITATION_RESUME_PATH,
  COMPANY_INVITATION_SIGN_IN_HREF,
  companyInvitationTokenFromPath,
  type InvitationHandoffStorage,
  readCompanyInvitationHandoff,
  storeCompanyInvitationHandoff,
} from '@/lib/company-access/invitation-handoff';

class MemoryStorage implements InvitationHandoffStorage {
  readonly values = new Map<string, string>();

  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

describe('company invitation auth handoff', () => {
  test('keeps a validated raw token in session storage and returns only its internal path', () => {
    const storage = new MemoryStorage();
    const token = 'A'.repeat(64);

    assert.equal(storeCompanyInvitationHandoff(token, storage), true);
    assert.equal(readCompanyInvitationHandoff(storage), `/company-invite/${token.toLowerCase()}`);
    clearCompanyInvitationHandoff(storage);
    assert.equal(readCompanyInvitationHandoff(storage), null);
  });

  test('rejects malformed tokens and clears corrupted stored values', () => {
    const storage = new MemoryStorage();
    assert.equal(storeCompanyInvitationHandoff('../company', storage), false);
    storage.values.set('staxis.company-invitation', 'not-a-token');
    assert.equal(readCompanyInvitationHandoff(storage), null);
    assert.equal(storage.values.size, 0);
  });

  test('uses a token-free resume URL across sign-in', () => {
    const token = 'b'.repeat(64);
    assert.equal(COMPANY_INVITATION_RESUME_PATH, '/company-invite/resume');
    assert.equal(COMPANY_INVITATION_SIGN_IN_HREF, '/signin?redirect=%2Fcompany-invite%2Fresume');
    assert.equal(COMPANY_INVITATION_SIGN_IN_HREF.includes(token), false);
    assert.equal(companyInvitationTokenFromPath(`/company-invite/${token}`), token);
    assert.equal(companyInvitationTokenFromPath(COMPANY_INVITATION_RESUME_PATH), null);
    assert.equal(companyInvitationTokenFromPath(`/company-invite/${token}/extra`), null);
  });

  test('fails safely when browser storage is unavailable', () => {
    const blocked: InvitationHandoffStorage = {
      getItem() { throw new Error('blocked'); },
      setItem() { throw new Error('blocked'); },
      removeItem() { throw new Error('blocked'); },
    };
    assert.equal(storeCompanyInvitationHandoff('c'.repeat(64), blocked), false);
    assert.equal(readCompanyInvitationHandoff(blocked), null);
    assert.doesNotThrow(() => clearCompanyInvitationHandoff(blocked));
  });
});
