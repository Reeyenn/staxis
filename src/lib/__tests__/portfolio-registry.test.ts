/**
 * Tests for src/lib/portfolio/registry.ts — adapter registry behavior.
 *
 * Covers:
 *   • registerAdapter is idempotent for same object
 *   • registerAdapter throws on duplicate-id collision (different object)
 *   • getAdapter / listAdapters reflect registrations
 *   • __resetRegistryForTests clears state cleanly
 *   • the housekeeping adapter auto-registers when index.ts is imported
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  registerAdapter,
  getAdapter,
  listAdapters,
  __resetRegistryForTests,
} from '@/lib/portfolio/registry';
import type {
  PortfolioModuleAverages,
  PortfolioTileAdapter,
  PortfolioTileData,
} from '@/lib/portfolio/types';

function mkAdapter(id: PortfolioTileAdapter['moduleId']): PortfolioTileAdapter {
  return {
    moduleId: id,
    moduleLabel: { en: id, es: id },
    fetchTileData: async (propertyId: string): Promise<PortfolioTileData> => ({
      module: 'housekeeping',
      propertyId,
      property: { id: propertyId, name: 'Mock', totalRooms: 0 },
      roomsTurned: 0, roomsRemaining: 0,
      inspectionPassRate: null, avgMinutesPerDeparture: null,
      laborCostTodayCents: null, laborBudgetTodayCents: null,
      staffActiveCount: 0, staffScheduledCount: 0,
      accuracyLabel: 'capacity_unavailable',
    }),
    anomalyFlag: (_d, _a: PortfolioModuleAverages) => null,
  };
}

describe('portfolio registry', () => {
  beforeEach(() => {
    __resetRegistryForTests();
  });

  test('registerAdapter then getAdapter returns the registered adapter', () => {
    const adapter = mkAdapter('housekeeping');
    registerAdapter(adapter);
    assert.equal(getAdapter('housekeeping'), adapter);
  });

  test('getAdapter returns undefined for an unregistered moduleId', () => {
    assert.equal(getAdapter('maintenance'), undefined);
  });

  test('registering the SAME adapter twice is idempotent', () => {
    const adapter = mkAdapter('housekeeping');
    registerAdapter(adapter);
    registerAdapter(adapter);   // must not throw
    assert.equal(listAdapters().length, 1);
  });

  test('registering a DIFFERENT adapter against the same id throws', () => {
    registerAdapter(mkAdapter('housekeeping'));
    const other = mkAdapter('housekeeping');
    assert.throws(() => registerAdapter(other), /two different adapters/i);
  });

  test('listAdapters returns registration order', () => {
    const hk = mkAdapter('housekeeping');
    const mx = mkAdapter('maintenance');
    registerAdapter(hk);
    registerAdapter(mx);
    const out = listAdapters();
    assert.equal(out.length, 2);
    assert.equal(out[0], hk);
    assert.equal(out[1], mx);
  });

  test('__resetRegistryForTests clears all registrations', () => {
    registerAdapter(mkAdapter('housekeeping'));
    __resetRegistryForTests();
    assert.deepEqual(listAdapters(), []);
  });
});

describe('housekeeping adapter — auto-registration via barrel import', () => {
  beforeEach(() => {
    __resetRegistryForTests();
  });

  test('importing src/lib/portfolio registers the housekeeping adapter', async () => {
    // Dynamic-import the barrel to trigger side-effecting registration.
    // The barrel transitively imports the housekeeping adapter, which
    // calls registerAdapter() at module load.
    await import('@/lib/portfolio');
    const hk = getAdapter('housekeeping');
    assert.ok(hk, 'housekeeping adapter must be registered after barrel import');
    assert.equal(hk!.moduleLabel.en, 'Housekeeping');
    assert.equal(hk!.moduleLabel.es, 'Limpieza');
  });
});
