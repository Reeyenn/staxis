process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CompanyFinding } from '@/lib/company/company-findings';
import {
  PORTFOLIO_DATA_SECTIONS,
  portfolioFindingPolicyDecision,
  type PortfolioQueuePolicy,
} from '@/lib/company/portfolio-data-policy';
import { portfolioRunMayPersist } from '@/lib/company/portfolio-runner';

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';

test('any unavailable hotel source makes the legacy company run mutation-free and retryable', () => {
  assert.equal(portfolioRunMayPersist(0), true);
  assert.equal(portfolioRunMayPersist(1), false);
  assert.equal(portfolioRunMayPersist(50), false);
});

test('legacy activity-stopped cards authorize from their canonical affected-hotel scope', () => {
  const sections = Object.fromEntries(PORTFOLIO_DATA_SECTIONS.map((section) => [
    section,
    new Map([[P1, 'enabled'], [P2, 'enabled']]),
  ])) as unknown as PortfolioQueuePolicy['sections'];
  const policy: PortfolioQueuePolicy = {
    propertyIds: [P1, P2],
    sections,
    financials: new Map([[P1, 'allowed'], [P2, 'allowed']]),
    fingerprint: 'test',
  };
  const finding = {
    detectorId: 'portfolio_activity_stopped',
    affectedPropertyIds: [P1, P2],
    evidence: { params: { stream: 'work_order_flow' } },
  } as unknown as CompanyFinding;

  assert.equal(portfolioFindingPolicyDecision(finding, policy), 'allowed');
});
