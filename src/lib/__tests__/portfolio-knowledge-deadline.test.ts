process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder-test-key-min-20-chars';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  companyKnowledgeBlock,
  PORTFOLIO_KNOWLEDGE_BUDGET_MS,
} from '@/app/api/agent/portfolio/route';

const ORGANIZATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROPERTY_ID = '11111111-1111-4111-8111-111111111111';

test('optional knowledge has a narrow budget that leaves time for evidence synthesis', () => {
  assert.ok(PORTFOLIO_KNOWLEDGE_BUDGET_MS > 0);
  assert.ok(PORTFOLIO_KNOWLEDGE_BUDGET_MS <= 2_000);
});

test('a hung company-fact read degrades promptly to evidence-only at the portfolio deadline', async () => {
  const startedAt = Date.now();
  const controller = new AbortController();
  const result = await companyKnowledgeBlock({
    organizationId: ORGANIZATION_ID,
    propertyIds: [PROPERTY_ID],
    now: new Date('2026-07-27T18:00:00.000Z'),
    requestId: 'knowledge-deadline-test',
    deadlineAt: startedAt + 30,
    signal: controller.signal,
  }, {
    loadCompanyFacts: async () => new Promise<never>(() => {}),
    loadPropertyFacts: async () => [],
  });

  assert.equal(result.block, '');
  assert.equal(result.versions.status, 'timed_out');
  assert.ok(Date.now() - startedAt < 500, 'a hung optional store must not own the request budget');
});

test('request cancellation degrades the optional overlay without waiting for either store', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await companyKnowledgeBlock({
    organizationId: ORGANIZATION_ID,
    propertyIds: [PROPERTY_ID],
    now: new Date('2026-07-27T18:00:00.000Z'),
    requestId: 'knowledge-cancel-test',
    deadlineAt: Date.now() + 10_000,
    signal: controller.signal,
  }, {
    loadCompanyFacts: async () => new Promise<never>(() => {}),
    loadPropertyFacts: async () => new Promise<never>(() => {}),
  });

  assert.equal(result.block, '');
  assert.equal(result.versions.status, 'cancelled');
});
