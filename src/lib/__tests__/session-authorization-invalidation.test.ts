import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { subscribeToSessionAuthorizationInvalidations } from '@/lib/auth/session-authorization-invalidation';

const authContext = readFileSync(join(process.cwd(), 'src/contexts/AuthContext.tsx'), 'utf8');
const authorizationRoute = readFileSync(
  join(process.cwd(), 'src/app/api/auth/session-authorization/route.ts'),
  'utf8',
);

test('session refresh carries an opaque full-provenance projection fingerprint', () => {
  assert.match(authorizationRoute, /authorizationFingerprint = authority\.effectiveAccessHash/);
  assert.match(authContext, /setAuthorizationFingerprint\(snapshot\.authorizationFingerprint\)/);
  assert.match(authContext, /active && authorizationFingerprint === null/);
  assert.match(authContext, /!active && authorizationFingerprint !== null/);
});

test('an open session receives its own authorization invalidation and rechecks instead of trusting the payload', async () => {
  const uid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let callback: (() => void) | null = null;
  let subscriptionStatus: ((status: string) => void) | null = null;
  let filter: Record<string, string> | null = null;
  let removed: unknown = null;
  const fakeChannel = {
    on: (_event: string, receivedFilter: Record<string, string>, receivedCallback: () => void) => {
      filter = receivedFilter;
      callback = receivedCallback;
      return fakeChannel;
    },
    subscribe: (statusCallback: (status: string) => void) => {
      subscriptionStatus = statusCallback;
      return fakeChannel;
    },
  };
  const client = {
    channel: (name: string) => {
      assert.equal(name, `session-authorization:${uid}`);
      return fakeChannel;
    },
    removeChannel: async (channel: unknown) => {
      removed = channel;
      return 'ok' as const;
    },
  };
  let rechecks = 0;
  const unsubscribe = subscribeToSessionAuthorizationInvalidations({
    client: client as never,
    authUid: uid,
    onInvalidate: () => { rechecks += 1; },
  });

  assert.deepEqual(filter, {
    event: '*',
    schema: 'public',
    table: 'account_authorization_notifications',
    filter: `data_user_id=eq.${uid}`,
  });
  assert.ok(callback);
  assert.ok(subscriptionStatus);
  (subscriptionStatus as (status: string) => void)('SUBSCRIBED');
  assert.equal(rechecks, 1, 'subscription readiness closes a demotion-before-listener race');
  (callback as () => void)();
  assert.equal(rechecks, 2, 'a live update must immediately request a fresh server verdict');
  unsubscribe();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(removed, fakeChannel);
});

test('the self-only invalidation row is still protected by the repository MFA boundary', () => {
  const migration = readFileSync(join(
    process.cwd(),
    'supabase/migrations/0385_account_authorization_notifications.sql',
  ), 'utf8');
  assert.match(
    migration,
    /create policy account_authorization_notifications_self_select[\s\S]*?data_user_id = auth\.uid\(\)[\s\S]*?mfa_verified_or_grace\(\)/,
  );
});

test('realtime teardown failures are contained during account switches', async () => {
  const fakeChannel = {
    on: () => fakeChannel,
    subscribe: () => fakeChannel,
  };
  const client = {
    channel: () => fakeChannel,
    removeChannel: async () => {
      throw new TypeError('socket already closed');
    },
  };
  const unsubscribe = subscribeToSessionAuthorizationInvalidations({
    client: client as never,
    authUid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    onInvalidate: () => undefined,
  });

  unsubscribe();
  await new Promise((resolve) => setImmediate(resolve));
});
