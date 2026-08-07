/**
 * Adversarial tests for the admin account switcher.
 *
 * The feature hands a platform admin a real session as somebody else, and a
 * signed cookie that puts their own session back. Two things have to be true
 * forever, and each case below is one of them being attacked:
 *
 *   • ONLY DEMO PEOPLE ARE REACHABLE. The set is recomputed server-side on
 *     every call, so a hand-rolled request naming a real customer's account id
 *     gets the identical predicate the menu was built from. Every "cannot
 *     prove it" path refuses.
 *
 *   • THE WAY BACK IS NOT A WAY UP. The return token is unforgeable without a
 *     server-only key, expires in hours, redeems once, and re-verifies against
 *     the live database that the admin it names is still an admin.
 *
 * Everything here exercises the real functions from
 * src/lib/admin-account-switch.ts with injected dependencies, so a plausible
 * bug (dropping the is_test check, trusting an expired token, forgetting to
 * burn a jti) fails a named case rather than sliding through.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  buildRoleLine,
  deriveReturnTokenKey,
  listSwitchableDemoAccounts,
  mintReturnToken,
  performAccountSwitch,
  performAdminReturn,
  resolveSwitchableDemoAccount,
  returnClaimKey,
  RETURN_TOKEN_TTL_MS,
  RETURN_TOKEN_VERSION,
  ROBOT_ACCOUNT_USERNAME,
  verifyReturnToken,
  type PerformReturnDeps,
  type PerformSwitchDeps,
  type ReturnTokenPayload,
  type SwitchableListDeps,
  type SwitchCandidateAccount,
} from '@/lib/admin-account-switch';
import type { AuthoritativePropertyAccess } from '@/lib/authorization/server';

// ─── Fixture world ──────────────────────────────────────────────────────────

const DEMO_HOTEL = '11111111-1111-4111-8111-000000000001';
const DEMO_HOTEL_2 = '11111111-1111-4111-8111-000000000002';
const REAL_HOTEL = '22222222-2222-4222-8222-000000000001';

const ADMIN_ACCOUNT = '00000000-0000-4000-8000-0000000000a1';
const ADMIN_AUTH = '00000000-0000-4000-8000-0000000000a2';
const DEMO_ACCOUNT = 'aaaa0000-0000-4000-8000-000000000001';
const DEMO_AUTH = 'aaaa0000-0000-4000-8000-0000000000f1';
const CUSTOMER_ACCOUNT = 'bbbb0000-0000-4000-8000-000000000001';
const ROBOT_ACCOUNT = 'cccc0000-0000-4000-8000-000000000001';
const INACTIVE_ACCOUNT = 'dddd0000-0000-4000-8000-000000000001';
const MIXED_ACCOUNT = 'eeee0000-0000-4000-8000-000000000001';

function account(overrides: Partial<SwitchCandidateAccount> = {}): SwitchCandidateAccount {
  return {
    id: DEMO_ACCOUNT,
    username: 'qa.maria',
    displayName: 'Maria Delgado',
    role: 'general_manager',
    active: true,
    authUserId: DEMO_AUTH,
    skip2fa: true,
    ...overrides,
  };
}

const ACCOUNTS: Record<string, SwitchCandidateAccount> = {
  [ADMIN_ACCOUNT]: account({
    id: ADMIN_ACCOUNT,
    username: 'reeyen',
    displayName: 'Reeyen Patel',
    role: 'admin',
    authUserId: ADMIN_AUTH,
    skip2fa: false,
  }),
  [DEMO_ACCOUNT]: account(),
  [CUSTOMER_ACCOUNT]: account({
    id: CUSTOMER_ACCOUNT,
    username: 'comfort.gm',
    displayName: 'Comfort Suites GM',
    authUserId: 'bbbb0000-0000-4000-8000-0000000000f1',
    skip2fa: false,
  }),
  [ROBOT_ACCOUNT]: account({
    id: ROBOT_ACCOUNT,
    username: ROBOT_ACCOUNT_USERNAME,
    displayName: 'Robot Manager',
    authUserId: 'cccc0000-0000-4000-8000-0000000000f1',
  }),
  [INACTIVE_ACCOUNT]: account({
    id: INACTIVE_ACCOUNT,
    username: 'qa.gone',
    displayName: 'Retired Demo Person',
    active: false,
    authUserId: 'dddd0000-0000-4000-8000-0000000000f1',
  }),
  [MIXED_ACCOUNT]: account({
    id: MIXED_ACCOUNT,
    username: 'qa.owner',
    displayName: 'Oona Ortega',
    role: 'owner',
    authUserId: 'eeee0000-0000-4000-8000-0000000000f1',
  }),
};

function access(propertyIds: string[], all = false): AuthoritativePropertyAccess {
  return {
    all,
    authorityMode: 'normalized',
    authorityVersion: 1,
    effectiveAccessHash: 'f'.repeat(64),
    propertyIds: all ? [] : propertyIds,
    legacyPropertyIds: [],
    membershipPropertyIds: all ? [] : propertyIds,
    propertyStandings: (all ? [] : propertyIds).map((propertyId) => ({
      propertyId,
      operationalRole: 'general_manager' as const,
      seesFinancials: false,
      hotelMutationAllowed: true,
      portfolioIntelligenceRead: false,
      entitlements: [
        { kind: 'membership_hat' as const, source: 'test', propertyId },
      ] as unknown as AuthoritativePropertyAccess['propertyStandings'][number]['entitlements'],
    })),
  };
}

const ACCESS: Record<string, AuthoritativePropertyAccess | null> = {
  [ADMIN_ACCOUNT]: access([], true),
  [DEMO_ACCOUNT]: access([DEMO_HOTEL]),
  [CUSTOMER_ACCOUNT]: access([REAL_HOTEL]),
  [ROBOT_ACCOUNT]: access([DEMO_HOTEL]),
  [INACTIVE_ACCOUNT]: access([DEMO_HOTEL]),
  // Reaches a demo hotel AND a real one. This is the person the "every hotel
  // must be a demo hotel" rule exists for.
  [MIXED_ACCOUNT]: access([DEMO_HOTEL, REAL_HOTEL]),
};

function policyDeps(overrides: Partial<SwitchableListDeps> = {}): SwitchableListDeps {
  return {
    listTestPropertyIds: async () => [DEMO_HOTEL, DEMO_HOTEL_2],
    loadAccount: async (id) => ACCOUNTS[id] ?? null,
    authoritativeAccess: async (id) => ACCESS[id] ?? null,
    listCandidateAccountIds: async () => Object.keys(ACCOUNTS),
    loadPropertyNames: async () =>
      new Map([
        [DEMO_HOTEL, 'Testing Hotel'],
        [DEMO_HOTEL_2, 'Port Arthur Inn'],
      ]),
    loadJobTitle: async () => null,
    ...overrides,
  };
}

// ─── Who is switchable ──────────────────────────────────────────────────────

describe('resolveSwitchableDemoAccount — only demo people, decided here', () => {
  test('accepts a demo person whose every hotel is a demo hotel', async () => {
    const result = await resolveSwitchableDemoAccount(DEMO_ACCOUNT, policyDeps());
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.account.displayName, 'Maria Delgado');
  });

  test('refuses a real customer account named by a forged request', async () => {
    const result = await resolveSwitchableDemoAccount(CUSTOMER_ACCOUNT, policyDeps());
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'reaches_real_hotel');
  });

  test('refuses a demo person who ALSO reaches one real hotel', async () => {
    const result = await resolveSwitchableDemoAccount(MIXED_ACCOUNT, policyDeps());
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'reaches_real_hotel');
  });

  test('refuses the robot walker even though it lives on a demo hotel', async () => {
    const result = await resolveSwitchableDemoAccount(ROBOT_ACCOUNT, policyDeps());
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'is_robot');
  });

  test('refuses another platform admin', async () => {
    const result = await resolveSwitchableDemoAccount(ADMIN_ACCOUNT, policyDeps());
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'is_admin');
  });

  test('refuses a deactivated account', async () => {
    const result = await resolveSwitchableDemoAccount(INACTIVE_ACCOUNT, policyDeps());
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'inactive');
  });

  test('refuses an account that does not exist', async () => {
    const result = await resolveSwitchableDemoAccount(
      '99999999-9999-4999-8999-999999999999',
      policyDeps(),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'not_found');
  });

  test('refuses when the authority snapshot cannot be read (fails closed)', async () => {
    const result = await resolveSwitchableDemoAccount(
      DEMO_ACCOUNT,
      policyDeps({ authoritativeAccess: async () => null }),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'authority_unavailable');
  });

  test('refuses when the demo-hotel list cannot be read (fails closed)', async () => {
    const result = await resolveSwitchableDemoAccount(
      DEMO_ACCOUNT,
      policyDeps({ listTestPropertyIds: async () => null }),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'authority_unavailable');
  });

  test('refuses the platform-admin wildcard rather than reading it as "no hotels"', async () => {
    // all=true arrives with empty arrays, so a naive "every hotel is a demo
    // hotel" check would pass it vacuously. This is that trap.
    const result = await resolveSwitchableDemoAccount(
      DEMO_ACCOUNT,
      policyDeps({ authoritativeAccess: async () => access([], true) }),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'wildcard_access');
  });

  test('refuses an account that reaches no hotel at all', async () => {
    const result = await resolveSwitchableDemoAccount(
      DEMO_ACCOUNT,
      policyDeps({ authoritativeAccess: async () => access([]) }),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'no_hotels');
  });
});

describe('listSwitchableDemoAccounts — the menu', () => {
  test('lists the demo person and nobody else, from a candidate set containing everyone', async () => {
    const listed = await listSwitchableDemoAccounts(policyDeps());
    assert.ok(listed);
    assert.deepEqual(
      listed.map((row) => row.accountId),
      [DEMO_ACCOUNT],
    );
    assert.equal(listed[0].roleLine, 'General manager, Testing Hotel');
  });

  test('prefers a real job title over the role word when the person has one', async () => {
    const listed = await listSwitchableDemoAccounts(
      policyDeps({ loadJobTitle: async () => 'VP of Operations' }),
    );
    assert.ok(listed);
    assert.equal(listed[0].roleLine, 'VP of Operations, Testing Hotel');
  });

  test('returns null rather than an empty menu when the hotels cannot be read', async () => {
    const listed = await listSwitchableDemoAccounts(
      policyDeps({ listTestPropertyIds: async () => null }),
    );
    assert.equal(listed, null);
  });

  test('returns null when the candidate query fails', async () => {
    const listed = await listSwitchableDemoAccounts(
      policyDeps({ listCandidateAccountIds: async () => null }),
    );
    assert.equal(listed, null);
  });

  test('role line never leaks a role slug', () => {
    assert.equal(buildRoleLine('front_desk', null, ['Testing Hotel']), 'Front desk, Testing Hotel');
    assert.equal(buildRoleLine('owner', null, []), 'Owner');
    assert.equal(
      buildRoleLine('general_manager', null, ['A', 'B']),
      'General manager, 2 demo hotels',
    );
  });
});

// ─── The return token ───────────────────────────────────────────────────────

const KEY = deriveReturnTokenKey('service-role-key-for-tests-only-0000');
const OTHER_KEY = deriveReturnTokenKey('a-different-service-role-key-000000');
const NOW = 1_770_000_000_000;

function payload(overrides: Partial<ReturnTokenPayload> = {}): ReturnTokenPayload {
  return {
    v: RETURN_TOKEN_VERSION,
    adminAuthUserId: ADMIN_AUTH,
    adminAccountId: ADMIN_ACCOUNT,
    targetAccountId: DEMO_ACCOUNT,
    adminTokenHash: 'admin-one-time-token-hash',
    jti: 'abc123',
    iat: NOW,
    exp: NOW + RETURN_TOKEN_TTL_MS,
    ...overrides,
  };
}

describe('return token — unforgeable, short-lived, bound to one admin', () => {
  test('round trips under the key that minted it', () => {
    const verified = verifyReturnToken(mintReturnToken(payload(), KEY), KEY, NOW + 1000);
    assert.equal(verified.ok, true);
    if (verified.ok) assert.equal(verified.payload.adminAccountId, ADMIN_ACCOUNT);
  });

  test('a token minted under a different secret is refused', () => {
    const verified = verifyReturnToken(mintReturnToken(payload(), OTHER_KEY), KEY, NOW);
    assert.equal(verified.ok, false);
    if (!verified.ok) assert.equal(verified.reason, 'bad_signature');
  });

  test('a tampered payload is refused even when the signature is left alone', () => {
    // Swap the admin binding for a different account and keep the old MAC.
    const token = mintReturnToken(payload(), KEY);
    const [, signature] = token.split('.');
    const forgedBody = Buffer.from(
      JSON.stringify(payload({ adminAccountId: DEMO_ACCOUNT })),
      'utf8',
    )
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const verified = verifyReturnToken(`${forgedBody}.${signature}`, KEY, NOW);
    assert.equal(verified.ok, false);
    if (!verified.ok) assert.equal(verified.reason, 'bad_signature');
  });

  test('an expired token is refused', () => {
    const token = mintReturnToken(payload(), KEY);
    const verified = verifyReturnToken(token, KEY, NOW + RETURN_TOKEN_TTL_MS + 1);
    assert.equal(verified.ok, false);
    if (!verified.ok) assert.equal(verified.reason, 'expired');
  });

  test('a token dated in the future is refused', () => {
    const token = mintReturnToken(payload({ iat: NOW + 600_000, exp: NOW + 900_000 }), KEY);
    const verified = verifyReturnToken(token, KEY, NOW);
    assert.equal(verified.ok, false);
    if (!verified.ok) assert.equal(verified.reason, 'not_yet_valid');
  });

  test('a token from a previous format version is refused', () => {
    const token = mintReturnToken(payload({ v: RETURN_TOKEN_VERSION - 1 }), KEY);
    const verified = verifyReturnToken(token, KEY, NOW);
    assert.equal(verified.ok, false);
    if (!verified.ok) assert.equal(verified.reason, 'version_mismatch');
  });

  test('garbage never throws and never verifies', () => {
    for (const raw of ['', '.', 'abc', 'a.b.c', 'nope.nope', '%%%.%%%']) {
      const verified = verifyReturnToken(raw, KEY, NOW);
      assert.equal(verified.ok, false);
    }
  });

  test('the signing key is derived, not the service-role key itself', () => {
    const secret = 'service-role-key-for-tests-only-0000';
    assert.notEqual(deriveReturnTokenKey(secret).toString('hex'), Buffer.from(secret).toString('hex'));
    // Deterministic, so a redeploy does not invalidate outstanding tokens.
    assert.equal(
      deriveReturnTokenKey(secret).toString('hex'),
      deriveReturnTokenKey(secret).toString('hex'),
    );
  });

  test('the single-use key is namespaced and storable', () => {
    assert.match(returnClaimKey('deadbeef'), /^[A-Za-z0-9_-]{1,256}$/);
    assert.notEqual(returnClaimKey('a'), returnClaimKey('b'));
  });
});

// ─── Switching ──────────────────────────────────────────────────────────────

interface SwitchWorld {
  deps: PerformSwitchDeps;
  minted: string[];
  trusted: Array<{ accountId: string; tokenHash: string }>;
}

function switchWorld(overrides: Partial<PerformSwitchDeps> = {}): SwitchWorld {
  const minted: string[] = [];
  const trusted: Array<{ accountId: string; tokenHash: string }> = [];
  const base = policyDeps();
  const deps: PerformSwitchDeps = {
    listTestPropertyIds: base.listTestPropertyIds,
    loadAccount: base.loadAccount,
    authoritativeAccess: base.authoritativeAccess,
    authEmail: async (authUserId) => `${authUserId}@staxis.local`,
    mintMagicLinkTokenHash: async (email) => {
      minted.push(email);
      return `hash-for-${email}`;
    },
    twoFactorEnabled: async () => false,
    skip2faAllowlisted: () => false,
    grantDeviceTrust: async (accountId, tokenHash) => {
      trusted.push({ accountId, tokenHash });
      return true;
    },
    signingKey: KEY,
    newJti: () => 'jti-fixed',
    newDeviceToken: () => 'fresh-device-token',
    hashDeviceToken: (token) => `sha-${token}`,
    ...overrides,
  };
  return { deps, minted, trusted };
}

function switchInput(overrides: Partial<Parameters<typeof performAccountSwitch>[0]> = {}) {
  return {
    callerAccountId: ADMIN_ACCOUNT,
    callerAuthUserId: ADMIN_AUTH,
    targetAccountId: DEMO_ACCOUNT,
    deviceCookieValue: null,
    nowMs: NOW,
    ...overrides,
  };
}

describe('performAccountSwitch — the switch endpoint gate, again', () => {
  test('a non-admin caller is refused, even with a perfectly valid target', async () => {
    const world = switchWorld();
    const result = await performAccountSwitch(
      switchInput({ callerAccountId: DEMO_ACCOUNT, callerAuthUserId: DEMO_AUTH }),
      world.deps,
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 403);
      assert.equal(result.reason, 'not_platform_admin');
    }
    assert.deepEqual(world.minted, [], 'no session may be minted for a non-admin caller');
  });

  test('a deactivated admin is refused', async () => {
    const world = switchWorld({
      loadAccount: async (id) =>
        id === ADMIN_ACCOUNT
          ? { ...ACCOUNTS[ADMIN_ACCOUNT], active: false }
          : ACCOUNTS[id] ?? null,
    });
    const result = await performAccountSwitch(switchInput(), world.deps);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'not_platform_admin');
    assert.deepEqual(world.minted, []);
  });

  test('a caller whose auth identity does not match their account row is refused', async () => {
    const world = switchWorld();
    const result = await performAccountSwitch(
      switchInput({ callerAuthUserId: 'ffff0000-0000-4000-8000-000000000001' }),
      world.deps,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'identity_mismatch');
    assert.deepEqual(world.minted, []);
  });

  test('a forged target outside the demo set is refused and mints nothing', async () => {
    const world = switchWorld();
    const result = await performAccountSwitch(
      switchInput({ targetAccountId: CUSTOMER_ACCOUNT }),
      world.deps,
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 403);
      assert.equal(result.reason, 'not_switchable:reaches_real_hotel');
    }
    assert.deepEqual(
      world.minted,
      [],
      'a refused target must not produce a login token for anybody, including the admin',
    );
  });

  test('the robot account is refused through the switch path too', async () => {
    const world = switchWorld();
    const result = await performAccountSwitch(
      switchInput({ targetAccountId: ROBOT_ACCOUNT }),
      world.deps,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'not_switchable:is_robot');
  });

  test('switching into yourself is refused', async () => {
    const world = switchWorld();
    const result = await performAccountSwitch(
      switchInput({ targetAccountId: ADMIN_ACCOUNT }),
      world.deps,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'already_this_account');
  });

  test('happy path mints both sessions and a return token that verifies', async () => {
    const world = switchWorld();
    const result = await performAccountSwitch(switchInput(), world.deps);
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(result.targetTokenHash, `hash-for-${DEMO_AUTH}@staxis.local`);
    assert.equal(result.targetDisplayName, 'Maria Delgado');
    assert.equal(result.adminDisplayName, 'Reeyen Patel');

    const verified = verifyReturnToken(result.returnToken, KEY, NOW + 1000);
    assert.equal(verified.ok, true);
    if (verified.ok) {
      assert.equal(verified.payload.adminAccountId, ADMIN_ACCOUNT);
      assert.equal(verified.payload.adminAuthUserId, ADMIN_AUTH);
      assert.equal(verified.payload.targetAccountId, DEMO_ACCOUNT);
      assert.equal(verified.payload.adminTokenHash, `hash-for-${ADMIN_AUTH}@staxis.local`);
      assert.equal(verified.payload.exp - verified.payload.iat, RETURN_TOKEN_TTL_MS);
    }
  });

  test('the admin way back is built BEFORE the target session, so a half-failure never strands the admin', async () => {
    // The admin's link mints fine; the target's fails. The admin session in
    // the browser is untouched because nothing was handed back.
    let call = 0;
    const world = switchWorld({
      mintMagicLinkTokenHash: async () => {
        call += 1;
        return call === 1 ? 'admin-hash' : null;
      },
    });
    const result = await performAccountSwitch(switchInput(), world.deps);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'target_mint_failed');
  });

  test('a target with no auth email is refused rather than silently created', async () => {
    const world = switchWorld({ authEmail: async () => null });
    const result = await performAccountSwitch(switchInput(), world.deps);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'target_has_no_auth_email');
    assert.deepEqual(world.minted, []);
  });
});

describe('performAccountSwitch — 2FA is touched only when it would otherwise block', () => {
  test('grants nothing while the global 2FA switch is off', async () => {
    const world = switchWorld({ twoFactorEnabled: async () => false });
    const result = await performAccountSwitch(switchInput(), world.deps);
    assert.equal(result.ok, true);
    assert.deepEqual(world.trusted, []);
  });

  test('grants nothing when the demo account is already on the skip-2FA allowlist', async () => {
    const world = switchWorld({
      twoFactorEnabled: async () => true,
      skip2faAllowlisted: (authUserId) => authUserId === DEMO_AUTH,
    });
    const result = await performAccountSwitch(switchInput(), world.deps);
    assert.equal(result.ok, true);
    assert.deepEqual(world.trusted, []);
  });

  test('reuses this browser device token and grants trust to the demo account only', async () => {
    const world = switchWorld({ twoFactorEnabled: async () => true });
    const result = await performAccountSwitch(
      switchInput({ deviceCookieValue: 'existing-device-token' }),
      world.deps,
    );
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.deviceTrust.newDeviceToken, null);
    assert.deepEqual(world.trusted, [
      { accountId: DEMO_ACCOUNT, tokenHash: 'sha-existing-device-token' },
    ]);
  });

  test('a browser with no device token gets one, and the admin keeps a matching row so the way back works', async () => {
    const world = switchWorld({ twoFactorEnabled: async () => true });
    const result = await performAccountSwitch(switchInput(), world.deps);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.deviceTrust.newDeviceToken, 'fresh-device-token');
    assert.deepEqual(world.trusted, [
      { accountId: DEMO_ACCOUNT, tokenHash: 'sha-fresh-device-token' },
      { accountId: ADMIN_ACCOUNT, tokenHash: 'sha-fresh-device-token' },
    ]);
  });

  test('a failed trust grant refuses the switch rather than handing back a dead session', async () => {
    const world = switchWorld({
      twoFactorEnabled: async () => true,
      grantDeviceTrust: async () => false,
    });
    const result = await performAccountSwitch(switchInput(), world.deps);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'device_trust_failed');
  });
});

// ─── Returning ──────────────────────────────────────────────────────────────

function returnDeps(overrides: Partial<PerformReturnDeps> = {}): PerformReturnDeps {
  const claimed = new Set<string>();
  return {
    signingKey: KEY,
    loadAccount: async (id) => ACCOUNTS[id] ?? null,
    claimSingleUse: async (jti) => {
      if (claimed.has(jti)) return false;
      claimed.add(jti);
      return true;
    },
    ...overrides,
  };
}

describe('performAdminReturn — the way back is not a way up', () => {
  test('refuses when the browser has no return cookie', async () => {
    const result = await performAdminReturn({ rawToken: null, nowMs: NOW }, returnDeps());
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 401);
      assert.equal(result.reason, 'no_return_token');
    }
  });

  test('a demo user cannot forge one: a token signed without the server key is refused', async () => {
    const forged = mintReturnToken(payload(), OTHER_KEY);
    const result = await performAdminReturn({ rawToken: forged, nowMs: NOW }, returnDeps());
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'token_bad_signature');
  });

  test('a demo user cannot name themselves the admin: the account must actually be an admin', async () => {
    // Even a correctly SIGNED token is useless if the account it names is not
    // an active platform admin — which is the check that stops a token minted
    // before a demotion from restoring it.
    const token = mintReturnToken(payload({ adminAccountId: DEMO_ACCOUNT, adminAuthUserId: DEMO_AUTH }), KEY);
    const result = await performAdminReturn({ rawToken: token, nowMs: NOW }, returnDeps());
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 403);
      assert.equal(result.reason, 'admin_no_longer_authorized');
    }
  });

  test('a demoted or deactivated admin cannot be restored', async () => {
    const token = mintReturnToken(payload(), KEY);
    const result = await performAdminReturn(
      { rawToken: token, nowMs: NOW },
      returnDeps({
        loadAccount: async () => ({ ...ACCOUNTS[ADMIN_ACCOUNT], active: false }),
      }),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'admin_no_longer_authorized');
  });

  test('an admin whose auth identity was rebuilt cannot be restored by the old token', async () => {
    const token = mintReturnToken(payload(), KEY);
    const result = await performAdminReturn(
      { rawToken: token, nowMs: NOW },
      returnDeps({
        loadAccount: async () => ({
          ...ACCOUNTS[ADMIN_ACCOUNT],
          authUserId: 'ffff0000-0000-4000-8000-000000000009',
        }),
      }),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'admin_identity_changed');
  });

  test('an expired token is refused', async () => {
    const token = mintReturnToken(payload(), KEY);
    const result = await performAdminReturn(
      { rawToken: token, nowMs: NOW + RETURN_TOKEN_TTL_MS + 1 },
      returnDeps(),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'token_expired');
  });

  test('a reused token is refused the second time', async () => {
    const token = mintReturnToken(payload(), KEY);
    const deps = returnDeps();
    const first = await performAdminReturn({ rawToken: token, nowMs: NOW }, deps);
    assert.equal(first.ok, true);
    const second = await performAdminReturn({ rawToken: token, nowMs: NOW + 1000 }, deps);
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.equal(second.status, 401);
      assert.equal(second.reason, 'token_already_used');
    }
  });

  test('the jti is burned BEFORE the admin credential is handed back', async () => {
    // If the claim happened after the lookup, two racing redeems could both
    // read "still an admin" and both be served.
    const order: string[] = [];
    const token = mintReturnToken(payload(), KEY);
    await performAdminReturn(
      { rawToken: token, nowMs: NOW },
      returnDeps({
        claimSingleUse: async () => { order.push('claim'); return true; },
        loadAccount: async (id) => { order.push('load'); return ACCOUNTS[id] ?? null; },
      }),
    );
    assert.deepEqual(order, ['claim', 'load']);
  });

  test('a claim store that cannot prove uniqueness refuses the return (fails closed)', async () => {
    const token = mintReturnToken(payload(), KEY);
    const result = await performAdminReturn(
      { rawToken: token, nowMs: NOW },
      returnDeps({ claimSingleUse: async () => false }),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'token_already_used');
  });

  test('happy path hands back the admin one-time token and the admin name', async () => {
    const token = mintReturnToken(payload(), KEY);
    const result = await performAdminReturn({ rawToken: token, nowMs: NOW }, returnDeps());
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.adminTokenHash, 'admin-one-time-token-hash');
      assert.equal(result.adminDisplayName, 'Reeyen Patel');
      assert.equal(result.adminAccountId, ADMIN_ACCOUNT);
    }
  });
});
