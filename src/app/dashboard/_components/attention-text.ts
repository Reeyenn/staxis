// Pure text builder for the dashboard "Needs attention" lines.
//
// Extracted from page.tsx so singular/plural + EN/ES parity is testable
// (src/lib/__tests__/dashboard-attention-text.test.ts). Before this, several
// lines pluralized on only one side ('3 anomaly flagged', '1 quejas
// atrasadas'), 'órdenes' lost its accent, and the '· Maintenance' pointer on
// the anomaly line existed only in English.

export type AttentionKind =
  | 'urgentOrders'
  | 'complianceOverdue'
  | 'anomalies'
  | 'complaintsOverdue'
  | 'callbacksDue'
  | 'roomsToClean';

export function attentionText(kind: AttentionKind, n: number, es: boolean): string {
  const one = n === 1;
  switch (kind) {
    case 'urgentOrders':
      return es
        ? (one ? 'orden de trabajo urgente' : 'órdenes de trabajo urgentes')
        : (one ? 'urgent work order' : 'urgent work orders');
    case 'complianceOverdue':
      return es
        ? (one ? 'revisión de cumplimiento vencida' : 'revisiones de cumplimiento vencidas')
        : (one ? 'compliance check overdue' : 'compliance checks overdue');
    case 'anomalies':
      return es
        ? (one ? 'anomalía marcada · Mantenimiento' : 'anomalías marcadas · Mantenimiento')
        : (one ? 'anomaly flagged · Maintenance' : 'anomalies flagged · Maintenance');
    case 'complaintsOverdue':
      return es
        ? (one ? 'queja atrasada' : 'quejas atrasadas')
        : (one ? 'complaint overdue' : 'complaints overdue');
    case 'callbacksDue':
      return es
        ? (one ? 'llamada de seguimiento hoy' : 'llamadas de seguimiento hoy')
        : (one ? 'guest callback due' : 'guest callbacks due');
    case 'roomsToClean':
      return es
        ? (one ? 'habitación por limpiar' : 'habitaciones por limpiar')
        : (one ? 'room to clean' : 'rooms to clean');
  }
}
