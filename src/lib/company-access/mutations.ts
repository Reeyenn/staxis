import { isValidEmail, isUuid } from '@/lib/api-validate';
import {
  isAccessProfile,
  isAccessScopeType,
  isJobCategory,
  type AccessProfile,
  type AccessScopeType,
  type JobCategory,
} from '@/lib/organization-access/domain';

interface MutationScope {
  organizationId: string;
  scopeType: AccessScopeType;
  portfolioId: string | null;
  propertyId: string | null;
}

export interface ValidInvitationMutation extends MutationScope {
  email: string;
  jobCategory: JobCategory;
  jobTitle: string | null;
  accessProfile: AccessProfile;
  grantExpiresAt: string | null;
}

export interface ValidAccessRequestMutation extends MutationScope {
  requestedProfile: AccessProfile;
  reason: string;
}

export interface ValidGrantRevocationMutation {
  grantId: string;
  reason: string;
}

export interface ValidInvitationCancellationMutation {
  invitationId: string;
  reason: string;
}

export interface ValidMembershipLifecycleMutation {
  membershipId: string;
  action: 'suspend' | 'resume' | 'remove';
  reason: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function optionalTrimmed(value: unknown, field: string, max: number): ValidationResult<string | null> {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, error: `${field} must be text` };
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: null };
  if (trimmed.length > max) return { ok: false, error: `${field} is too long` };
  return { ok: true, value: trimmed };
}

function requiredLifecycleReason(value: unknown): ValidationResult<string> {
  if (typeof value !== 'string') return { ok: false, error: 'Reason is required' };
  const reason = value.trim();
  if (reason.length < 8 || reason.length > 500) {
    return { ok: false, error: 'Reason must be between 8 and 500 characters' };
  }
  return { ok: true, value: reason };
}

function validateScope(body: Record<string, unknown>): ValidationResult<MutationScope> {
  if (!isUuid(body.organizationId)) return { ok: false, error: 'organizationId must be a valid UUID' };
  if (!isAccessScopeType(body.scopeType)) return { ok: false, error: 'Invalid access scope' };
  const portfolioId = body.portfolioId == null || body.portfolioId === '' ? null : body.portfolioId;
  const propertyId = body.propertyId == null || body.propertyId === '' ? null : body.propertyId;
  if (portfolioId !== null && !isUuid(portfolioId)) return { ok: false, error: 'portfolioId must be a valid UUID' };
  if (propertyId !== null && !isUuid(propertyId)) return { ok: false, error: 'propertyId must be a valid UUID' };
  if (body.scopeType === 'organization' && (portfolioId || propertyId)) {
    return { ok: false, error: 'Organization scope cannot include a portfolio or hotel' };
  }
  if (body.scopeType === 'portfolio' && (!portfolioId || propertyId)) {
    return { ok: false, error: 'Portfolio scope requires exactly one portfolio' };
  }
  if (body.scopeType === 'property' && (!propertyId || portfolioId)) {
    return { ok: false, error: 'Hotel scope requires exactly one hotel' };
  }
  return {
    ok: true,
    value: {
      organizationId: body.organizationId,
      scopeType: body.scopeType,
      portfolioId: portfolioId as string | null,
      propertyId: propertyId as string | null,
    },
  };
}

function profileMatchesScope(profile: AccessProfile, scopeType: AccessScopeType): boolean {
  if (profile === 'organization_owner' || profile === 'organization_admin') return scopeType === 'organization';
  if (profile === 'portfolio_manager') return scopeType === 'portfolio';
  if (profile === 'property_manager') return scopeType === 'property';
  return true;
}

export function validateInvitationMutation(bodyValue: unknown, now = new Date()): ValidationResult<ValidInvitationMutation> {
  const body = recordOf(bodyValue);
  if (!body) return { ok: false, error: 'Request body must be an object' };
  const scope = validateScope(body);
  if (!scope.ok) return scope;
  const normalizedEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!isValidEmail(normalizedEmail)) return { ok: false, error: 'Enter a valid email address' };
  const jobCategory = body.jobCategory ?? 'other';
  if (!isJobCategory(jobCategory)) return { ok: false, error: 'Invalid job category' };
  const jobTitle = optionalTrimmed(body.jobTitle, 'Job title', 120);
  if (!jobTitle.ok) return jobTitle;
  if (!isAccessProfile(body.accessProfile)) return { ok: false, error: 'Invalid access profile' };
  if (!profileMatchesScope(body.accessProfile, scope.value.scopeType)) {
    return { ok: false, error: 'That access profile cannot use the selected scope' };
  }
  let grantExpiresAt: string | null = null;
  if (body.expiresAt !== undefined && body.expiresAt !== null && body.expiresAt !== '') {
    if (typeof body.expiresAt !== 'string') return { ok: false, error: 'Expiration must be a date' };
    const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(body.expiresAt)
      ? `${body.expiresAt}T23:59:59.999Z`
      : body.expiresAt);
    if (!Number.isFinite(parsed.getTime()) || parsed.getTime() <= now.getTime() + INVITATION_TTL_MS) {
      return { ok: false, error: 'Access expiration must be after the seven-day invitation window' };
    }
    grantExpiresAt = parsed.toISOString();
  }
  if (body.accessProfile === 'organization_owner' && grantExpiresAt) {
    return { ok: false, error: 'Organization owner access cannot expire' };
  }
  if (body.accessProfile === 'external_collaborator' && !grantExpiresAt) {
    return { ok: false, error: 'External collaborator access requires an expiration' };
  }

  return {
    ok: true,
    value: {
      ...scope.value,
      email: normalizedEmail,
      jobCategory,
      jobTitle: jobTitle.value,
      accessProfile: body.accessProfile,
      grantExpiresAt,
    },
  };
}

export function validateAccessRequestMutation(bodyValue: unknown): ValidationResult<ValidAccessRequestMutation> {
  const body = recordOf(bodyValue);
  if (!body) return { ok: false, error: 'Request body must be an object' };
  const scope = validateScope(body);
  if (!scope.ok) return scope;
  if (!isAccessProfile(body.requestedProfile)) return { ok: false, error: 'Invalid requested profile' };
  if (!profileMatchesScope(body.requestedProfile, scope.value.scopeType)) {
    return { ok: false, error: 'That access profile cannot use the selected scope' };
  }
  if (typeof body.reason !== 'string') return { ok: false, error: 'Reason is required' };
  const reason = body.reason.trim();
  if (reason.length < 8 || reason.length > 1000) {
    return { ok: false, error: 'Reason must be between 8 and 1000 characters' };
  }
  return { ok: true, value: { ...scope.value, requestedProfile: body.requestedProfile, reason } };
}

export function validateGrantRevocationMutation(bodyValue: unknown): ValidationResult<ValidGrantRevocationMutation> {
  const body = recordOf(bodyValue);
  if (!body) return { ok: false, error: 'Request body must be an object' };
  if (!isUuid(body.grantId)) return { ok: false, error: 'grantId must be a valid UUID' };
  const reason = requiredLifecycleReason(body.reason);
  if (!reason.ok) return reason;
  return { ok: true, value: { grantId: body.grantId, reason: reason.value } };
}

export function validateInvitationCancellationMutation(bodyValue: unknown): ValidationResult<ValidInvitationCancellationMutation> {
  const body = recordOf(bodyValue);
  if (!body) return { ok: false, error: 'Request body must be an object' };
  if (!isUuid(body.invitationId)) return { ok: false, error: 'invitationId must be a valid UUID' };
  const reason = requiredLifecycleReason(body.reason);
  if (!reason.ok) return reason;
  return { ok: true, value: { invitationId: body.invitationId, reason: reason.value } };
}

export function validateMembershipLifecycleMutation(bodyValue: unknown): ValidationResult<ValidMembershipLifecycleMutation> {
  const body = recordOf(bodyValue);
  if (!body) return { ok: false, error: 'Request body must be an object' };
  if (!isUuid(body.membershipId)) return { ok: false, error: 'membershipId must be a valid UUID' };
  if (body.action !== 'suspend' && body.action !== 'resume' && body.action !== 'remove') {
    return { ok: false, error: 'Action must be suspend, resume, or remove' };
  }
  const reason = requiredLifecycleReason(body.reason);
  if (!reason.ok) return reason;
  return {
    ok: true,
    value: { membershipId: body.membershipId, action: body.action, reason: reason.value },
  };
}
