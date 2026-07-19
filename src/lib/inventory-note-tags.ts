// Shared note-string tags stamped on inventory ledger rows by each workflow.
//
// The History feed (src/app/inventory/_components/history-events.ts) CLASSIFIES
// events by these exact strings — they are a cross-module contract, not
// display copy. If a writer rewords its note without going through these
// constants, its rows silently reclassify as a generic delivery/count in
// History (no error anywhere). Import from here in BOTH the writer and any
// reader. Rows already in the database keep their old strings, so never
// change an existing value here — add a new constant and match both.

/** Invoice-scan deliveries: `Invoice scan` or `Invoice scan · inv#<n>@<vendor>`
 *  (built in src/lib/inventory-invoice-commit.ts). */
export const INVOICE_SCAN_NOTE_PREFIX = 'Invoice scan';

/** Count rows written by the AI assistant's update-item-count tool. */
export const ASSISTANT_COUNT_NOTE = 'Counted via Staxis assistant';

/** Legacy delivery-ledger rows previously written by the AI assistant.
 * Retained unchanged so existing History entries still classify correctly.
 * Current `markOrdered` only stamps `inventory.last_ordered_at`. */
export const ASSISTANT_ORDER_NOTE = 'Marked ordered via assistant';
