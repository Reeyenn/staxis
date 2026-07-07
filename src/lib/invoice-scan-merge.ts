// ═══════════════════════════════════════════════════════════════════════════
// Invoice scan merge — fold the per-page vision extractions of a multi-page
// invoice back into a single invoice.
//
// Pure + dependency-free (mirrors src/lib/photo-count-merge.ts). The scan route
// fans out one vision call per photo page (or one call for a whole PDF, which
// the model reads as multiple pages) and hands the ordered ExtractedInvoice[]
// here. Items are concatenated in page order; the header fields (vendor / date /
// number) usually live on page 1 only, so we take the first non-null value in
// page order — a continuation page returns null header fields and simply
// contributes its line items.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * One invoice's worth of extracted data. Shared shape between the scan-invoice
 * route (which normalizes the merged items) and this merge helper — kept here
 * so both sides agree on the contract.
 */
export interface ExtractedInvoice {
  vendor_name: string | null;
  invoice_date: string | null;
  invoice_number: string | null;
  items: Array<{
    item_name: string;
    quantity: number;          // resolved units (cases × pack_size when applicable)
    quantity_cases: number | null;
    pack_size: number | null;  // hint for the user when they wire a new item
    unit_cost: number | null;
    total_cost: number | null;
  }>;
}

/**
 * Merge the per-page extractions of one invoice into a single invoice.
 *
 *   - items: concatenated in page order (page 1's items, then page 2's, …).
 *   - vendor_name / invoice_date / invoice_number: the FIRST non-null value in
 *     page order. This lets a header-less continuation page (null vendor/date/
 *     number) fall through to whichever page actually carried the header.
 *
 * An empty `pages` array yields an empty invoice (null header fields, no items).
 */
export function mergeInvoicePages(pages: ExtractedInvoice[]): ExtractedInvoice {
  const firstNonNull = (pick: (p: ExtractedInvoice) => string | null): string | null => {
    for (const p of pages) {
      const v = pick(p);
      if (v != null) return v;
    }
    return null;
  };

  const items: ExtractedInvoice['items'] = [];
  for (const p of pages) {
    if (Array.isArray(p.items)) items.push(...p.items);
  }

  return {
    vendor_name: firstNonNull(p => p.vendor_name),
    invoice_date: firstNonNull(p => p.invoice_date),
    invoice_number: firstNonNull(p => p.invoice_number),
    items,
  };
}
