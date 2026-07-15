import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { summarizeHomeInventory } from '@/lib/home-inventory-summary';

describe('summarizeHomeInventory', () => {
  test('an empty catalog stays neutral', () => {
    assert.deepEqual(summarizeHomeInventory([]), {
      en: 'Open inventory', es: 'Abrir inventario', tone: 'muted',
    });
  });

  test('never-counted zeroes invite the first count instead of showing critical', () => {
    assert.deepEqual(summarizeHomeInventory([
      { current_stock: 0, par_level: 20, last_counted_at: null },
      { current_stock: 0, par_level: 10, last_counted_at: null },
    ]), {
      en: 'Start first count', es: 'Empieza el primer conteo', tone: 'muted',
    });
  });

  test('ignores uncounted rows when evaluating counted stock', () => {
    assert.deepEqual(summarizeHomeInventory([
      { current_stock: 0, par_level: 20, last_counted_at: null },
      { current_stock: 2, par_level: 10, last_counted_at: '2026-07-15T12:00:00Z' },
    ]), {
      en: '1 item critical', es: '1 artículo crítico', tone: 'bad',
    });
  });

  test('reports low and healthy counted stock', () => {
    assert.equal(summarizeHomeInventory([
      { current_stock: 5, par_level: 10, last_counted_at: '2026-07-15T12:00:00Z' },
    ]).tone, 'warn');
    assert.equal(summarizeHomeInventory([
      { current_stock: 10, par_level: 10, last_counted_at: '2026-07-15T12:00:00Z' },
    ]).tone, 'ok');
  });

  test('matches Inventory boundaries at half-par and par', () => {
    assert.equal(summarizeHomeInventory([
      { current_stock: 49, par_level: 100, last_counted_at: '2026-07-15T12:00:00Z' },
    ]).tone, 'bad');
    assert.equal(summarizeHomeInventory([
      { current_stock: 50, par_level: 100, last_counted_at: '2026-07-15T12:00:00Z' },
    ]).tone, 'warn');
    assert.equal(summarizeHomeInventory([
      { current_stock: 100, par_level: 100, last_counted_at: '2026-07-15T12:00:00Z' },
    ]).tone, 'ok');
  });

  test('does not call stock healthy when no counted item has a usable par', () => {
    assert.deepEqual(summarizeHomeInventory([
      { current_stock: 4, par_level: 0, last_counted_at: '2026-07-15T12:00:00Z' },
    ]), {
      en: 'Set par levels', es: 'Configura niveles par', tone: 'muted',
    });
  });
});
