process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder-test-key-min-20-chars';

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { companyKnowledgeBlock } from '@/app/api/agent/portfolio/route';
import { getConfirmedCompanyFacts, listCompanyFacts } from '@/lib/company/rulebook';
import { loadConfirmedCompanyKnowledge } from '@/lib/agent/portfolio-intelligence/knowledge';
import { supabaseAdmin } from '@/lib/supabase-admin';

const ORGANIZATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROPERTY_ID = '11111111-1111-4111-8111-111111111111';
const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);

function installCompanyKnowledgeFailure(): void {
  // @ts-expect-error focused service-client failure seam
  supabaseAdmin.from = () => {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: () => chain,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({
        data: null,
        error: { code: 'XX000', message: 'simulated company knowledge outage' },
      }).then(resolve),
    };
    return chain;
  };
}

afterEach(() => {
  supabaseAdmin.from = originalFrom;
});

test('a company knowledge store failure is never reported as a verified empty rulebook', async () => {
  installCompanyKnowledgeFailure();
  const isExpectedStoreError = (error: unknown) => (
    Boolean(error)
    && typeof error === 'object'
    && (error as { message?: unknown }).message === 'simulated company knowledge outage'
  );
  await assert.rejects(() => getConfirmedCompanyFacts(ORGANIZATION_ID), isExpectedStoreError);
  await assert.rejects(() => listCompanyFacts(ORGANIZATION_ID), isExpectedStoreError);
});

test('portfolio knowledge marks the real company loader unavailable instead of included-empty', async () => {
  installCompanyKnowledgeFailure();
  const result = await companyKnowledgeBlock({
    organizationId: ORGANIZATION_ID,
    propertyIds: [PROPERTY_ID],
    now: new Date('2026-07-29T18:00:00.000Z'),
    requestId: 'company-knowledge-outage-test',
    deadlineAt: Date.now() + 5_000,
    signal: new AbortController().signal,
  }, {
    loadCompanyFacts: loadConfirmedCompanyKnowledge,
    loadPropertyFacts: async () => [],
  });

  assert.equal(result.versions.status, 'unavailable');
  assert.equal(result.overlay, null);
  assert.equal(result.block, '');
});
