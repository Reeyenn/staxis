import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  clearStaleChunkRecoveryIncident,
  reloadOnceWithSessionGuard,
  STALE_CHUNK_RECOVERY_GUARD_KEY,
  STALE_CHUNK_RECOVERY_PARAM,
  staleChunkRecoveryKey,
} from '@/lib/stale-chunk-recovery';

function memoryStorage(values = new Map<string, string>()) {
  return {
    values,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    },
  };
}

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

describe('stale chunk incident recovery', () => {
  test('fingerprint includes error name, digest, asset, and current build identity', () => {
    const error = {
      name: 'ChunkLoadError',
      message: 'Loading chunk 781 failed',
      digest: 'digest-a',
      stack: 'at https://getstaxis.com/_next/static/chunks/781-a1.js:1:1',
    };
    const baseline = staleChunkRecoveryKey('/inventory', error, 'next-build:build-a');

    assert.notEqual(
      baseline,
      staleChunkRecoveryKey('/inventory', { ...error, name: 'TypeError' }, 'next-build:build-a'),
    );
    assert.notEqual(
      baseline,
      staleChunkRecoveryKey('/inventory', { ...error, digest: 'digest-b' }, 'next-build:build-a'),
    );
    assert.notEqual(
      baseline,
      staleChunkRecoveryKey(
        '/inventory',
        { ...error, stack: 'at https://getstaxis.com/_next/static/chunks/781-b2.js:1:1' },
        'next-build:build-a',
      ),
    );
    assert.notEqual(
      baseline,
      staleChunkRecoveryKey('/inventory', error, 'next-build:build-b'),
    );
  });

  test('one active incident blocks every automatic retry until stable cleanup', () => {
    const { values, storage } = memoryStorage();
    let reloads = 0;
    const location = {
      href: 'https://getstaxis.com/inventory',
      reload: () => { reloads += 1; },
      replace: () => { throw new Error('URL fallback should not be used'); },
    };
    const first = {
      key: 'staxis-chunk-recovery:/inventory:first-build',
      guardKey: STALE_CHUNK_RECOVERY_GUARD_KEY,
      fallbackParam: STALE_CHUNK_RECOVERY_PARAM,
      getSessionStorage: () => storage,
      location,
    };

    assert.equal(reloadOnceWithSessionGuard(first), true);
    assert.equal(values.get(STALE_CHUNK_RECOVERY_GUARD_KEY), first.key);
    assert.equal(reloadOnceWithSessionGuard({ ...first, key: 'different-after-reload' }), false);
    assert.equal(reloads, 1);

    clearStaleChunkRecoveryIncident({
      getSessionStorage: () => storage,
      location,
      replaceHistoryUrl: () => { throw new Error('no recovery URL exists'); },
    });

    assert.equal(values.has(STALE_CHUNK_RECOVERY_GUARD_KEY), false);
    assert.equal(reloadOnceWithSessionGuard(first), true);
    assert.equal(reloads, 2, 'a later incident receives a fresh one-shot reload');
  });

  test('blocked storage uses one URL marker for the incident and stable cleanup retires it', () => {
    const blockedStorage = () => { throw new DOMException('blocked', 'SecurityError'); };
    let replacedUrl = '';
    let historyUrl = '';
    const location = {
      href: 'https://getstaxis.com/staff?view=week#today',
      reload: () => { throw new Error('blocked storage must use URL fallback'); },
      replace: (url: string) => { replacedUrl = url; },
    };
    const first = {
      key: 'staxis-chunk-recovery:/staff:first-build',
      guardKey: STALE_CHUNK_RECOVERY_GUARD_KEY,
      fallbackParam: STALE_CHUNK_RECOVERY_PARAM,
      getSessionStorage: blockedStorage,
      location,
    };

    assert.equal(reloadOnceWithSessionGuard(first), true);
    assert.equal(new URL(replacedUrl).searchParams.get(STALE_CHUNK_RECOVERY_PARAM), first.key);

    location.href = replacedUrl;
    replacedUrl = '';
    assert.equal(reloadOnceWithSessionGuard({ ...first, key: 'different-after-reload' }), false);
    assert.equal(replacedUrl, '', 'changed error metadata must not create a reload loop');

    clearStaleChunkRecoveryIncident({
      getSessionStorage: blockedStorage,
      location,
      replaceHistoryUrl: (url) => { historyUrl = url; },
    });
    const cleaned = new URL(historyUrl);
    assert.equal(cleaned.searchParams.has(STALE_CHUNK_RECOVERY_PARAM), false);
    assert.equal(cleaned.searchParams.get('view'), 'week');
    assert.equal(cleaned.hash, '#today');

    location.href = historyUrl;
    assert.equal(reloadOnceWithSessionGuard(first), true);
    assert.ok(replacedUrl, 'the same fingerprint can recover during a later incident');
  });

  test('route boundaries share the incident guard and the rendered shell performs safe cleanup', () => {
    for (const boundary of [
      source('src', 'app', 'error.tsx'),
      source('src', 'app', 'global-error.tsx'),
    ]) {
      assert.match(boundary, /markStaleChunkFailureThisBoot\(\)/);
      assert.match(
        boundary,
        /reloadOnceWithSessionGuard\(\{[\s\S]*?guardKey: STALE_CHUNK_RECOVERY_GUARD_KEY[\s\S]*?fallbackParam: STALE_CHUNK_RECOVERY_PARAM/,
      );
    }

    const appLayout = source('src', 'components', 'layout', 'AppLayout.tsx');
    assert.match(
      appLayout,
      /window\.setTimeout\(\(\) => \{[\s\S]*?staleChunkFailureSeenThisBoot\(\)[\s\S]*?clearStaleChunkRecoveryIncident\([\s\S]*?STALE_CHUNK_STABLE_BOOT_MS/,
    );
    assert.match(appLayout, /window\.history\.replaceState\(window\.history\.state, '', url\)/);
  });
});
