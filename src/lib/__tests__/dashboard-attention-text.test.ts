import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { attentionText, type AttentionKind } from '@/app/dashboard/_components/attention-text';

const KINDS: AttentionKind[] = [
  'urgentOrders',
  'complaintsOverdue',
  'callbacksDue',
  'roomsToClean',
];

describe('attentionText English singular and plural labels', () => {
  for (const kind of KINDS) {
    test(`${kind}: n=1 and n=3 differ`, () => {
      assert.notEqual(attentionText(kind, 1), attentionText(kind, 3));
    });
  }
});
