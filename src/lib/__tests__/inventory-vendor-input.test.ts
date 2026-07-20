import assert from 'node:assert/strict';
import test from 'node:test';
import { parseInventoryVendorFields } from '@/lib/inventory-vendor-input';

test('vendor input accepts only strings/null for optional text and strict booleans', () => {
  for (const [field, value] of [
    ['phone', { bad: true }],
    ['phone', 123],
    ['accountNumber', ['A-1']],
    ['notes', { toString: () => 'hidden' }],
  ] as const) {
    const parsed = parseInventoryVendorFields({ name: 'Vendor', [field]: value }, true);
    assert.match(parsed.error ?? '', /string or null/i);
  }
  assert.match(
    parseInventoryVendorFields({ name: 'Vendor', isActive: 'false' }, true).error ?? '',
    /boolean/i,
  );
});

test('vendor input preserves explicit false/null and enforces length instead of truncating', () => {
  const parsed = parseInventoryVendorFields({
    name: 'Vendor', email: null, phone: null, accountNumber: ' A-1 ', notes: ' note ', isActive: false,
  }, true);
  assert.deepEqual(parsed, { input: {
    name: 'Vendor', email: null, phone: null, accountNumber: 'A-1', notes: 'note', isActive: false,
  } });
  assert.match(
    parseInventoryVendorFields({ name: 'Vendor', phone: 'x'.repeat(41) }, true).error ?? '',
    /too long/i,
  );
});

test('vendor input trims names and rejects whitespace-only names before the database call', () => {
  assert.deepEqual(parseInventoryVendorFields({ name: '  Linen Co  ' }, true), {
    input: { name: 'Linen Co' },
  });
  assert.match(parseInventoryVendorFields({ name: '   ' }, true).error ?? '', /name/i);
});
