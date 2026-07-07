/**
 * Tests for the invoice scan merge helper (src/lib/invoice-scan-merge.ts).
 * Pure logic. Pins page-order item concatenation and first-non-null header
 * resolution across multi-page invoices.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeInvoicePages, type ExtractedInvoice } from '../invoice-scan-merge';

const item = (name: string): ExtractedInvoice['items'][number] => ({
  item_name: name,
  quantity: 1,
  quantity_cases: null,
  pack_size: null,
  unit_cost: null,
  total_cost: null,
});

describe('mergeInvoicePages', () => {
  it('passes a single page through unchanged', () => {
    const page: ExtractedInvoice = {
      vendor_name: 'Acme Supply',
      invoice_date: '2026-07-01',
      invoice_number: 'INV-1',
      items: [item('Towels'), item('Soap')],
    };
    const merged = mergeInvoicePages([page]);
    assert.deepEqual(merged, page);
  });

  it('takes header metadata from page 1 when present on both', () => {
    const p1: ExtractedInvoice = {
      vendor_name: 'Acme Supply',
      invoice_date: '2026-07-01',
      invoice_number: 'INV-1',
      items: [item('Towels')],
    };
    const p2: ExtractedInvoice = {
      vendor_name: 'Different Vendor',
      invoice_date: '2026-07-02',
      invoice_number: 'INV-2',
      items: [item('Soap')],
    };
    const merged = mergeInvoicePages([p1, p2]);
    assert.equal(merged.vendor_name, 'Acme Supply');
    assert.equal(merged.invoice_date, '2026-07-01');
    assert.equal(merged.invoice_number, 'INV-1');
  });

  it('falls back to page 2 metadata when page 1 fields are null', () => {
    const p1: ExtractedInvoice = {
      vendor_name: null,
      invoice_date: null,
      invoice_number: null,
      items: [item('Towels')],
    };
    const p2: ExtractedInvoice = {
      vendor_name: 'Acme Supply',
      invoice_date: '2026-07-02',
      invoice_number: 'INV-2',
      items: [item('Soap')],
    };
    const merged = mergeInvoicePages([p1, p2]);
    assert.equal(merged.vendor_name, 'Acme Supply');
    assert.equal(merged.invoice_date, '2026-07-02');
    assert.equal(merged.invoice_number, 'INV-2');
  });

  it('concatenates items in page order (page 1 then page 2)', () => {
    const p1: ExtractedInvoice = {
      vendor_name: 'Acme',
      invoice_date: null,
      invoice_number: null,
      items: [item('A1'), item('A2')],
    };
    const p2: ExtractedInvoice = {
      vendor_name: null,
      invoice_date: null,
      invoice_number: null,
      items: [item('B1'), item('B2')],
    };
    const merged = mergeInvoicePages([p1, p2]);
    assert.deepEqual(merged.items.map(i => i.item_name), ['A1', 'A2', 'B1', 'B2']);
  });

  it('returns an empty invoice (null header, no items) for an empty pages array', () => {
    const merged = mergeInvoicePages([]);
    assert.deepEqual(merged, {
      vendor_name: null,
      invoice_date: null,
      invoice_number: null,
      items: [],
    });
  });
});
