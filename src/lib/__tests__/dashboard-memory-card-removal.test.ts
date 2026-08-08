import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

test('hotel dashboard does not mount the learning recap card', () => {
  const dashboard = source('src', 'app', '(hotel)', 'dashboard', 'page.tsx');

  assert.doesNotMatch(dashboard, /MemoryRecapCard/);
  assert.doesNotMatch(dashboard, /What Staxis learned/i);
  assert.match(dashboard, /<LogBookCard \/>/);
  assert.match(dashboard, /<CalendarCard \/>/);
});
