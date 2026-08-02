import assert from 'node:assert/strict';
import { test } from 'node:test';

import { portfolioTurnRequestSchema } from '@/lib/agent/portfolio-intelligence/route-contract';

const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';

test('a fresh portfolio request omits conversationId instead of sending null', () => {
  const freshBody = {
    organizationId: ORGANIZATION_ID,
    message: 'How are my hotels doing?',
  };
  assert.equal(portfolioTurnRequestSchema.safeParse(freshBody).success, true);
  assert.equal(
    portfolioTurnRequestSchema.safeParse({ ...freshBody, conversationId: null }).success,
    false,
  );
});
