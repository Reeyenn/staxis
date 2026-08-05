import type { CompanyManagedGrant, CompanyMembership } from '@/lib/company-access/dto';

export interface AccessPersonGroup {
  accountId: string;
  displayName: string;
  isCurrentUser: boolean;
  memberships: CompanyMembership[];
}

const HISTORY_STATUSES = new Set([
  'revoked',
  'expired',
  'inactive',
  'cancelled',
  'denied',
  'approved',
]);

/** Group access records by the server-provided account identity. */
export function groupAccessMemberships(
  memberships: readonly CompanyMembership[],
): AccessPersonGroup[] {
  const groups = new Map<string, AccessPersonGroup>();
  for (const membership of memberships) {
    const existing = groups.get(membership.accountId);
    if (existing) {
      existing.memberships.push(membership);
      existing.isCurrentUser = existing.isCurrentUser || Boolean(membership.isCurrentUser);
      continue;
    }
    groups.set(membership.accountId, {
      accountId: membership.accountId,
      displayName: membership.displayName,
      isCurrentUser: Boolean(membership.isCurrentUser),
      memberships: [membership],
    });
  }
  return [...groups.values()];
}

/** Historical records stay out of the default access view. */
export function isAccessHistoryStatus(status: string): boolean {
  return HISTORY_STATUSES.has(status);
}

export function splitAccessMemberships(memberships: readonly CompanyMembership[]): {
  current: CompanyMembership[];
  history: CompanyMembership[];
} {
  return memberships.reduce<{ current: CompanyMembership[]; history: CompanyMembership[] }>(
    (result, membership) => {
      if (isAccessHistoryStatus(membership.status)) result.history.push(membership);
      else result.current.push(membership);
      return result;
    },
    { current: [], history: [] },
  );
}

/** Property-scoped customer grants are the direct hotel-access records. */
export function isDirectAccessGrant(grant: Pick<CompanyManagedGrant, 'scopeType'>): boolean {
  return grant.scopeType === 'property';
}

export function shouldRenderAccessEmptyState(input: {
  adminPreview: boolean;
  renderedPeopleCount: number;
  currentRequestCount: number;
  showHistory: boolean;
  historyRequestCount: number;
}): boolean {
  const hasVisibleHistoryRequest = input.showHistory && input.historyRequestCount > 0;
  return !input.adminPreview
    && input.renderedPeopleCount === 0
    && input.currentRequestCount === 0
    && !hasVisibleHistoryRequest;
}
