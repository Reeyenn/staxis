import type {
  CompanyAccessData,
  CompanyAccessHistoryEntry,
  CompanyAccessRecordStatus,
  CompanyAccessRequest,
  CompanyAccessSource,
  CompanyAccessViewerContext,
  CompanyManagedGrant,
  CompanyMembership,
  CompanyOrganization,
  CompanyProperty,
  AccessScopeType,
} from './dto';

export type AccessContextState = 'ready' | 'missing' | 'ambiguous';

export interface CompanyAccessContext {
  state: AccessContextState;
  selectedPropertyId: string | null;
  selectedPropertyName: string | null;
  organizationId: string | null;
  organizationName: string | null;
  companyPropertyIds: string[];
  companyProperties: CompanyProperty[];
  organization: CompanyOrganization | null;
}

export interface AccessPersonRecord {
  id: string;
  sourceIds: string[];
  accessProfile: string;
  roleLabel: string;
  scopeType: AccessScopeType;
  scopeLabel: string;
  propertyIds: string[];
  source: CompanyAccessSource;
  sourceLabel: string;
  status: CompanyAccessRecordStatus;
  startsAt: string | null;
  expiresAt: string | null;
  grantedBy: string | null;
  reason: string | null;
  isMembershipAccess: boolean;
  isPendingRequest: boolean;
}

export interface AccessPerson {
  accountId: string | null;
  displayName: string;
  jobTitle: string | null;
  isCurrentUser: boolean;
  membershipIds: string[];
  membership: CompanyMembership | null;
  records: AccessPersonRecord[];
  history: AccessPersonRecord[];
  currentRecords: AccessPersonRecord[];
  pendingRecords: AccessPersonRecord[];
  hasCurrentAccess: boolean;
}

export interface AccessPeopleResult {
  people: AccessPerson[];
  effectivePeople: AccessPerson[];
  pendingPeople: AccessPerson[];
  peopleWithoutHotelAccess: AccessPerson[];
  historyPeople: AccessPerson[];
}

const PROFILE_LABELS: Record<string, string> = {
  organization_owner: 'Owner',
  organization_admin: 'Administrator',
  portfolio_manager: 'Portfolio Manager',
  property_manager: 'Hotel Manager',
  department_lead: 'Department Lead',
  contributor: 'Contributor',
  viewer: 'Viewer',
  external_collaborator: 'External collaborator',
  owner: 'Owner',
  regional_manager: 'Regional Manager',
  controller: 'Contributor',
  general_manager: 'Hotel Manager',
  front_desk: 'Viewer',
  housekeeping: 'Viewer',
  maintenance: 'Viewer',
  staff: 'Viewer',
};

export function accessProfileLabel(value: string | null | undefined): string {
  if (!value) return 'Team member';
  return PROFILE_LABELS[value] ?? 'Team member';
}

export function accessSourceLabel(source: CompanyAccessSource): string {
  return source === 'direct' ? 'Given directly' : 'Inherited through company';
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort();
}

function activeProperties(data: CompanyAccessData, organizationId: string | null): CompanyProperty[] {
  const seen = new Set<string>();
  return data.properties
    .filter((property) => (
      property.status === 'active'
      && property.organizationId === organizationId
    ))
    .filter((property) => {
      if (seen.has(property.nodeId)) return false;
      seen.add(property.nodeId);
      return true;
    })
    .sort((left, right) => (
      left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
    ));
}

function exactPropertyCandidates(
  data: CompanyAccessData,
  selectedPropertyId: string,
): CompanyProperty[] {
  return data.properties.filter((property) => (
    property.id === selectedPropertyId && property.status === 'active'
  ));
}

function contextForOrganization(
  data: CompanyAccessData,
  selectedPropertyId: string,
  organization: CompanyOrganization,
): CompanyAccessContext {
  const candidates = exactPropertyCandidates(data, selectedPropertyId)
    .filter((property) => property.organizationId === organization.id);
  if (candidates.length !== 1) {
    return {
      state: candidates.length > 1 ? 'ambiguous' : 'missing',
      selectedPropertyId,
      selectedPropertyName: candidates[0]?.name ?? null,
      organizationId: organization.id,
      organizationName: organization.name,
      companyPropertyIds: [],
      companyProperties: [],
      organization,
    };
  }
  const companyProperties = activeProperties(data, organization.id);
  if (companyProperties.length === 0 || !companyProperties.some((property) => property.id === selectedPropertyId)) {
    return {
      state: 'missing',
      selectedPropertyId,
      selectedPropertyName: candidates[0].name,
      organizationId: organization.id,
      organizationName: organization.name,
      companyPropertyIds: [],
      companyProperties: [],
      organization,
    };
  }
  return {
    state: 'ready',
    selectedPropertyId,
    selectedPropertyName: candidates[0].name,
    organizationId: organization.id,
    organizationName: organization.name,
    companyPropertyIds: uniqueSorted(companyProperties.map((property) => property.id)),
    companyProperties,
    organization,
  };
}

/** Resolve the one hotel/company key that the Access tab is allowed to show.
 * Multiple rows for the same hotel are an ambiguity, never a reason to merge
 * organizations or display an empty success state. */
export function resolveCompanyAccessContext(
  data: CompanyAccessData,
  selectedPropertyId: string | null,
  viewerContext?: CompanyAccessViewerContext,
): CompanyAccessContext {
  const empty = (state: AccessContextState): CompanyAccessContext => ({
    state,
    selectedPropertyId,
    selectedPropertyName: null,
    organizationId: null,
    organizationName: null,
    companyPropertyIds: [],
    companyProperties: [],
    organization: null,
  });
  if (!selectedPropertyId) return empty('missing');

  if (viewerContext?.scope === 'organization') {
    if (viewerContext.requestedPropertyId !== selectedPropertyId) return empty('missing');
    const organizations = data.organizations.filter((organization) => (
      organization.id === viewerContext.targetId
      && organization.status === 'active'
    ));
    if (organizations.length !== 1) return empty(organizations.length > 1 ? 'ambiguous' : 'missing');
    return contextForOrganization(data, selectedPropertyId, organizations[0]);
  }

  const candidates = exactPropertyCandidates(data, selectedPropertyId);
  if (candidates.length === 0) return empty('missing');
  if (candidates.length > 1) return empty('ambiguous');

  const selected = candidates[0];
  if (viewerContext?.scope === 'property'
      && viewerContext.requestedPropertyId !== selectedPropertyId) return empty('missing');
  if (!selected.organizationId) {
    return {
      state: 'ready',
      selectedPropertyId,
      selectedPropertyName: selected.name,
      organizationId: null,
      organizationName: null,
      companyPropertyIds: [selected.id],
      companyProperties: [selected],
      organization: null,
    };
  }
  const organization = data.organizations.find((candidate) => (
    candidate.id === selected.organizationId && candidate.status === 'active'
  ));
  return organization ? contextForOrganization(data, selectedPropertyId, organization) : empty('missing');
}

function humanScopeLabel(
  record: Pick<AccessPersonRecord, 'scopeType' | 'propertyIds'>,
  context: CompanyAccessContext,
): string {
  const propertyIds = uniqueSorted(record.propertyIds);
  if (record.scopeType === 'organization'
      && context.companyPropertyIds.length > 0
      && context.companyPropertyIds.every((propertyId) => propertyIds.includes(propertyId))) {
    return 'All company hotels';
  }
  if (propertyIds.length === 1 && propertyIds[0] === context.selectedPropertyId) return 'This hotel';
  if (propertyIds.length > 0) return `${propertyIds.length} selected hotels`;
  return 'Current hotel scope unavailable';
}

function sourceForGrant(grant: CompanyManagedGrant): CompanyAccessSource {
  return grant.source ?? (grant.scopeType === 'property' ? 'direct' : 'company');
}

function recordFromGrant(
  grant: CompanyManagedGrant,
  context: CompanyAccessContext,
  options: {
    id?: string;
    pending?: boolean;
    membershipStatus?: CompanyAccessRecordStatus;
    includeOutsideSelected?: boolean;
  } = {},
): AccessPersonRecord | null {
  const allowedPropertyIds = new Set(context.companyPropertyIds);
  const propertyIds = uniqueSorted(grant.propertyIds.filter((propertyId) => allowedPropertyIds.has(propertyId)));
  if (!context.selectedPropertyId || (!options.includeOutsideSelected && !propertyIds.includes(context.selectedPropertyId))) return null;
  const source = sourceForGrant(grant);
  const status = options.membershipStatus ?? grant.status ?? (options.pending ? 'pending' : 'active');
  return {
    id: options.id ?? grant.id,
    sourceIds: [grant.id],
    accessProfile: grant.accessProfile,
    roleLabel: accessProfileLabel(grant.accessProfile),
    scopeType: grant.scopeType,
    scopeLabel: humanScopeLabel({ scopeType: grant.scopeType, propertyIds }, context),
    propertyIds,
    source,
    sourceLabel: accessSourceLabel(source),
    status,
    startsAt: grant.startsAt ?? null,
    expiresAt: grant.expiresAt ?? null,
    grantedBy: grant.grantedBy ?? null,
    reason: grant.reason ?? null,
    isMembershipAccess: grant.isMembershipAccess === true,
    isPendingRequest: options.pending === true,
  };
}

function recordFromRequest(
  request: CompanyAccessRequest,
  context: CompanyAccessContext,
): AccessPersonRecord | null {
  const scopeType = request.scopeType ?? (request.propertyIds.length === 1 ? 'property' : 'organization');
  const source: CompanyAccessSource = scopeType === 'property' ? 'direct' : 'company';
  return recordFromGrant({
    id: `request:${request.id}`,
    accessProfile: request.requestedProfile,
    scopeType,
    scopeLabel: request.scopeLabel,
    propertyIds: request.propertyIds,
    canRevoke: false,
    source,
    status: request.status,
    startsAt: request.createdAt,
    expiresAt: null,
    reason: request.reason ?? 'Waiting for an authorized manager to review this request.',
  }, context, { id: `request:${request.id}`, pending: request.status === 'pending' });
}

function mergeRecords(records: AccessPersonRecord[], context: CompanyAccessContext): AccessPersonRecord[] {
  const merged = new Map<string, AccessPersonRecord>();
  for (const record of records) {
    const key = [
      record.accessProfile,
      record.source,
      record.status,
      record.expiresAt ?? '',
      record.isPendingRequest ? 'request' : 'access',
    ].join(':');
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...record, propertyIds: [...record.propertyIds] });
      continue;
    }
    existing.sourceIds = uniqueSorted([...existing.sourceIds, ...record.sourceIds]);
    existing.propertyIds = uniqueSorted([...existing.propertyIds, ...record.propertyIds]);
    existing.scopeLabel = humanScopeLabel(existing, context);
    existing.reason = [...new Set([existing.reason, record.reason].filter((value): value is string => Boolean(value)))].join(' / ') || null;
    existing.grantedBy = existing.grantedBy ?? record.grantedBy;
    existing.isMembershipAccess ||= record.isMembershipAccess;
    existing.startsAt = existing.startsAt && record.startsAt
      ? (Date.parse(existing.startsAt) <= Date.parse(record.startsAt) ? existing.startsAt : record.startsAt)
      : existing.startsAt ?? record.startsAt;
  }
  return [...merged.values()].sort((left, right) => (
    left.roleLabel.localeCompare(right.roleLabel)
      || left.sourceLabel.localeCompare(right.sourceLabel)
      || left.scopeLabel.localeCompare(right.scopeLabel)
  ));
}

interface PersonBuilder {
  accountId: string | null;
  displayName: string;
  jobTitle: string | null;
  isCurrentUser: boolean;
  membershipIds: Set<string>;
  memberships: CompanyMembership[];
  records: AccessPersonRecord[];
  history: AccessPersonRecord[];
}

function builderKey(accountId: string | null | undefined, displayName: string): string {
  return accountId ? `account:${accountId}` : `name:${displayName.trim().toLocaleLowerCase()}`;
}

function addBuilder(
  builders: Map<string, PersonBuilder>,
  input: { accountId?: string | null; displayName: string; jobTitle?: string | null; membership?: CompanyMembership | null; currentUser?: boolean },
): PersonBuilder {
  const key = builderKey(input.accountId, input.displayName);
  const existing = builders.get(key);
  if (existing) {
    if (input.membership) {
      existing.membershipIds.add(input.membership.id);
      existing.memberships.push(input.membership);
    }
    existing.isCurrentUser ||= input.currentUser === true;
    existing.jobTitle ||= input.jobTitle ?? input.membership?.jobTitle ?? null;
    return existing;
  }
  const created: PersonBuilder = {
    accountId: input.accountId ?? null,
    displayName: input.displayName || 'Unnamed person',
    jobTitle: input.jobTitle ?? input.membership?.jobTitle ?? null,
    isCurrentUser: input.currentUser === true,
    membershipIds: new Set(input.membership ? [input.membership.id] : []),
    memberships: input.membership ? [input.membership] : [],
    records: [],
    history: [],
  };
  builders.set(key, created);
  return created;
}

function addMembership(
  builders: Map<string, PersonBuilder>,
  membership: CompanyMembership,
  context: CompanyAccessContext,
  currentAccountId: string,
): void {
  const builder = addBuilder(builders, {
    accountId: membership.accountId,
    displayName: membership.displayName,
    jobTitle: membership.jobTitle,
    membership,
    currentUser: membership.accountId === currentAccountId || membership.isCurrentUser === true,
  });
  const current: AccessPersonRecord[] = [];
  for (const grant of membership.grants ?? []) {
    const record = recordFromGrant(grant, context, {
      membershipStatus: membership.status === 'active' ? undefined : membership.status,
      includeOutsideSelected: true,
    });
    if (record) current.push(record);
  }
  if (current.length === 0 && membership.accessProfile && membership.propertyIds.length > 0) {
    const fallback = recordFromGrant({
      id: `membership:${membership.id}`,
      accessProfile: membership.accessProfile,
      scopeType: membership.accessScopeType
        ?? (membership.propertyIds.length === context.companyPropertyIds.length ? 'organization' : 'property'),
      scopeLabel: '',
      propertyIds: membership.propertyIds,
      canRevoke: false,
      source: membership.accessSource ?? 'direct',
      status: membership.status,
      isMembershipAccess: true,
    }, context);
    if (fallback) current.push(fallback);
  }
  builder.records.push(...current.filter((record) => (
    record.status === 'active'
      || record.status === 'expiring'
      || record.status === 'pending'
  )));
}

function addHistory(
  builders: Map<string, PersonBuilder>,
  entry: CompanyAccessHistoryEntry,
  context: CompanyAccessContext,
  currentAccountId: string,
): void {
  const record = recordFromGrant(entry.record, context);
  if (!record || record.status === 'active' || record.status === 'expiring') return;
  const builder = addBuilder(builders, {
    accountId: entry.accountId,
    displayName: entry.displayName,
    jobTitle: entry.jobTitle,
    currentUser: entry.accountId === currentAccountId,
  });
  if (record.status === 'pending') builder.records.push(record);
  else builder.history.push(record);
}

/** Build the single Access answer for one selected hotel. Membership hats,
 * normalized rows, and pending requests are grouped by account and merged
 * only when their effective role, source, status, and scope agree. */
export function buildAccessPeople(
  data: CompanyAccessData,
  context: CompanyAccessContext,
  currentAccountId: string,
): AccessPeopleResult {
  if (context.state !== 'ready' || !context.selectedPropertyId) {
    return { people: [], effectivePeople: [], pendingPeople: [], peopleWithoutHotelAccess: [], historyPeople: [] };
  }
  const selectedPropertyId = context.selectedPropertyId;
  const builders = new Map<string, PersonBuilder>();
  for (const membership of data.memberships) {
    if (!context.organizationId || membership.organizationId !== context.organizationId) continue;
    addMembership(builders, membership, context, currentAccountId);
  }
  for (const entry of data.accessHistory ?? []) {
    if (!context.organizationId || entry.organizationId !== context.organizationId) continue;
    addHistory(builders, entry, context, currentAccountId);
  }
  for (const receipt of data.effectiveAccess) {
    if (context.organizationId
        ? receipt.organizationId !== context.organizationId
        : receipt.organizationId !== null && receipt.organizationId !== undefined) continue;
    const record = recordFromGrant({
      id: receipt.id,
      accessProfile: receipt.accessProfile,
      scopeType: receipt.scopeType,
      scopeLabel: receipt.scopeLabel,
      propertyIds: receipt.propertyIds,
      canRevoke: false,
      source: receipt.scopeType === 'property' ? 'direct' : 'company',
      status: receipt.status,
      startsAt: null,
      expiresAt: receipt.expiresAt,
      grantedBy: receipt.grantedBy,
      reason: receipt.reason,
    }, context);
    if (!record) continue;
    const builder = addBuilder(builders, {
      accountId: currentAccountId,
      displayName: data.memberships.find((membership) => membership.accountId === currentAccountId)?.displayName ?? 'You',
      jobTitle: receipt.jobTitle,
      currentUser: true,
    });
    if (record.status === 'active' || record.status === 'expiring') builder.records.push(record);
    else builder.history.push(record);
  }
  for (const request of data.requests) {
    if (!context.organizationId || request.organizationId !== context.organizationId) continue;
    const record = recordFromRequest(request, context);
    if (!record) continue;
    const builder = addBuilder(builders, {
      accountId: request.requesterAccountId,
      displayName: request.requesterName,
      currentUser: request.requesterAccountId === currentAccountId,
    });
    if (record.status === 'pending') builder.records.push(record);
    else builder.history.push(record);
  }

  const people = [...builders.values()].map((builder): AccessPerson => {
    const allRecords = mergeRecords(builder.records, context).filter((record) => (
      record.propertyIds.includes(selectedPropertyId)
    ));
    const history = mergeRecords(builder.history, context);
    const pendingRecords = allRecords.filter((record) => record.status === 'pending');
    const records = allRecords.filter((record) => record.status !== 'pending');
    const currentRecords = records.filter((record) => (
      record.status === 'active' || record.status === 'expiring'
    ));
    return {
      accountId: builder.accountId,
      displayName: builder.displayName,
      jobTitle: builder.jobTitle,
      isCurrentUser: builder.isCurrentUser,
      membershipIds: [...builder.membershipIds].sort(),
      membership: builder.memberships[0] ?? null,
      records,
      history,
      currentRecords,
      pendingRecords,
      hasCurrentAccess: currentRecords.length > 0,
    };
  }).sort((left, right) => left.displayName.localeCompare(right.displayName));

  return {
    people,
    effectivePeople: people.filter((person) => person.hasCurrentAccess),
    pendingPeople: people.filter((person) => person.pendingRecords.length > 0),
    peopleWithoutHotelAccess: people.filter((person) => (
      !person.hasCurrentAccess
      && person.pendingRecords.length === 0
      && person.membership !== null
      && person.history.length === 0
    )),
    historyPeople: people.filter((person) => person.history.length > 0),
  };
}
