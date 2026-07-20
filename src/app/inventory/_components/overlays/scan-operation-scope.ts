export interface InvoiceOperationCursor {
  open: boolean;
  propertyId: string | null;
  sequence: number;
}

export interface InvoiceOperationScope {
  propertyId: string;
  sequence: number;
}

export interface DuplicateInvoiceRequestScope extends InvoiceOperationScope {
  reference: string;
  vendor: string;
}

export function createInvoiceOperationCursor(
  open: boolean,
  propertyId: string | null,
): InvoiceOperationCursor {
  return { open, propertyId, sequence: 0 };
}

/**
 * Invalidates every continuation captured under the previous sheet/property
 * lifecycle. Returning the same object when nothing changed lets the caller
 * detect a lifecycle boundary without a second comparison.
 */
export function syncInvoiceOperationLifecycle(
  cursor: InvoiceOperationCursor,
  open: boolean,
  propertyId: string | null,
): InvoiceOperationCursor {
  if (cursor.open === open && cursor.propertyId === propertyId) return cursor;
  return { open, propertyId, sequence: cursor.sequence + 1 };
}

export function invalidateInvoiceOperations(
  cursor: InvoiceOperationCursor,
): InvoiceOperationCursor {
  return { ...cursor, sequence: cursor.sequence + 1 };
}

export function beginInvoiceOperation(
  cursor: InvoiceOperationCursor,
  propertyId: string,
): { cursor: InvoiceOperationCursor; scope: InvoiceOperationScope } {
  const next = invalidateInvoiceOperations(cursor);
  return {
    cursor: next,
    scope: { propertyId, sequence: next.sequence },
  };
}

export function invoiceOperationIsCurrent(
  scope: InvoiceOperationScope,
  cursor: InvoiceOperationCursor,
): boolean {
  return cursor.open
    && cursor.propertyId === scope.propertyId
    && cursor.sequence === scope.sequence;
}

export function normalizeDuplicateVendorIdentity(vendor: string): string {
  return vendor.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Sequence is the primary race guard; identity checks also invalidate a
 * request immediately when the manager edits either field before a new blur
 * request has started.
 */
export function duplicateInvoiceRequestIsCurrent(
  scope: DuplicateInvoiceRequestScope,
  cursor: InvoiceOperationCursor,
  current: { reference: string; vendor: string },
): boolean {
  return invoiceOperationIsCurrent(scope, cursor)
    && scope.reference === current.reference
    && scope.vendor === normalizeDuplicateVendorIdentity(current.vendor);
}
