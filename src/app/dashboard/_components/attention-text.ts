// Pure text builder for the dashboard "Needs attention" lines.
//
// Extracted from page.tsx so singular/plural behavior is testable.

export type AttentionKind =
  | 'urgentOrders'
  | 'complaintsOverdue'
  | 'callbacksDue'
  | 'roomsToClean';

export function attentionText(kind: AttentionKind, n: number): string {
  const one = n === 1;
  switch (kind) {
    case 'urgentOrders':
      return one ? 'urgent work order' : 'urgent work orders';
    case 'complaintsOverdue':
      return one ? 'complaint overdue' : 'complaints overdue';
    case 'callbacksDue':
      return one ? 'guest callback due' : 'guest callbacks due';
    case 'roomsToClean':
      return one ? 'room to clean' : 'rooms to clean';
  }
}
