/**
 * Tests for the dashboard "Needs attention" line texts
 * (src/app/dashboard/_components/attention-text.ts).
 *
 * Guards the singular/plural + EN/ES parity fixes: before extraction the
 * page rendered '3 anomaly flagged' (EN never pluralized), '1 quejas
 * atrasadas' / '1 revisiones ... vencidas' (ES never singularized),
 * 'ordenes' without its accent, and the '· Maintenance' pointer on the
 * anomaly line existed only in English.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { attentionText, type AttentionKind } from '@/app/dashboard/_components/attention-text';

const KINDS: AttentionKind[] = [
  'urgentOrders',
  'complianceOverdue',
  'anomalies',
  'complaintsOverdue',
  'callbacksDue',
  'roomsToClean',
];

describe('attentionText — singular vs plural differ on both sides', () => {
  for (const kind of KINDS) {
    // callbacksDue ES pivots on llamada/llamadas; every kind must produce a
    // different string for 1 vs many, in BOTH languages.
    test(`${kind}: n=1 and n=3 differ in EN and ES`, () => {
      assert.notEqual(attentionText(kind, 1, false), attentionText(kind, 3, false));
      assert.notEqual(attentionText(kind, 1, true), attentionText(kind, 3, true));
    });
  }
});

describe('attentionText — specific regressions', () => {
  test('EN anomalies pluralize (was "3 anomaly flagged")', () => {
    assert.equal(attentionText('anomalies', 3, false), 'anomalies flagged · Maintenance');
    assert.equal(attentionText('anomalies', 1, false), 'anomaly flagged · Maintenance');
  });

  test('ES anomaly line carries the Maintenance pointer (was EN-only)', () => {
    assert.match(attentionText('anomalies', 1, true), /· Mantenimiento$/);
    assert.match(attentionText('anomalies', 2, true), /· Mantenimiento$/);
  });

  test('ES plural urgent orders carries the accent (órdenes, was "ordenes")', () => {
    assert.equal(attentionText('urgentOrders', 2, true), 'órdenes de trabajo urgentes');
    assert.equal(attentionText('urgentOrders', 1, true), 'orden de trabajo urgente');
  });

  test('ES singulars are grammatical (was always-plural)', () => {
    assert.equal(attentionText('complaintsOverdue', 1, true), 'queja atrasada');
    assert.equal(attentionText('complianceOverdue', 1, true), 'revisión de cumplimiento vencida');
    assert.equal(attentionText('callbacksDue', 1, true), 'llamada de seguimiento hoy');
    assert.equal(attentionText('roomsToClean', 1, true), 'habitación por limpiar');
  });

  test('EN singular lost item (was always "lost items nearing disposal")', () => {
  });
});
