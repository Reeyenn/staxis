import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { signOutAndNavigateToSignin } from '@/lib/auth/sign-out-navigation';

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

describe('deliberate sign-out navigation', { concurrency: false }, () => {
  test('awaits sign-out before replacing the document with /signin', async () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const events: string[] = [];
    let releaseSignOut!: () => void;
    const signOut = async () => {
      events.push('sign-out-started');
      await new Promise<void>((resolve) => { releaseSignOut = resolve; });
      events.push('sign-out-finished');
    };
    const requested: string[] = [];
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        location: {
          replace(url: string) {
            events.push(`navigate:${url}`);
            requested.push(url);
          },
        },
      },
    });

    try {
      const pending = signOutAndNavigateToSignin(signOut);

      await Promise.resolve();
      assert.deepEqual(events, ['sign-out-started']);
      assert.deepEqual(requested, []);

      releaseSignOut();
      await pending;

      assert.deepEqual(events, ['sign-out-started', 'sign-out-finished', 'navigate:/signin']);
      assert.deepEqual(requested, ['/signin']);
    } finally {
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });

  test('does not navigate when sign-out rejects', async () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const requested: string[] = [];
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: { location: { replace: (url: string) => { requested.push(url); } } },
    });

    try {
      await assert.rejects(
        signOutAndNavigateToSignin(async () => {
          throw new Error('sign-out failed');
        }),
        /sign-out failed/,
      );
      assert.deepEqual(requested, []);
    } finally {
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });

  test('all deliberate sign-out surfaces use the awaited navigation helper', () => {
    const propertySelector = source('src', 'app', '(hotel)', 'property-selector', 'page.tsx');
    const concourse = source('src', 'components', 'concourse', 'ConcourseBar.tsx');
    assert.match(
      propertySelector,
      /await signOutAndNavigateToSignin\(signOut\)/,
      'property-selector picker and join-status variants must share the deliberate sign-out path',
    );
    assert.match(
      concourse,
      /signOutAndNavigateToSignin\(signOut\)/,
      'desktop and mobile concourse sign-out controls must share the deliberate sign-out path',
    );
  });

  test('passive session expiry keeps its existing recovery panel and redirect semantics', () => {
    const boundary = source(
      'src', 'components', 'layout', 'AuthenticatedRuntimeBoundary.tsx',
    );
    assert.doesNotMatch(boundary, /signOutAndNavigateToSignin/);
    assert.match(boundary, /title="Sign in to continue"/);
    assert.match(boundary, /reason: 'session-ended'/);
    assert.match(boundary, /window\.location\.assign\(`\/signin\?\$\{params\.toString\(\)\}`\)/);
  });
});
