import 'server-only';

import { isUuid } from '@/lib/api-validate';
import { supabaseAdmin } from '@/lib/supabase-admin';
import type { AppRole } from '@/lib/roles';

const LEGACY_JOIN_CODE_RX = /^[A-Z0-9][A-Z0-9-]{4,126}[A-Z0-9]$/;
const CODE_KINDS = new Set([
  'staff_signup',
  'onboarding_resume',
  'privileged_onboarding',
  'legacy_revoked',
]);
const CODE_ROLES = new Set([
  'owner',
  'general_manager',
  'front_desk',
  'housekeeping',
  'maintenance',
]);
const RECEIPT_STATUSES = new Set(['active', 'revoked', 'expired', 'used_up']);
const RESUME_RECEIPT_STATUSES = new Set(['used_up', 'revoked', 'expired']);

export interface JoinCodeCapabilityReceipt {
  schemaVersion: 'join-code-capability-v1';
  status: 'active' | 'revoked' | 'expired' | 'used_up';
  codeId: string;
  hotelId: string;
  codeKind: 'staff_signup' | 'onboarding_resume' | 'privileged_onboarding' | 'legacy_revoked';
  role: 'owner' | 'general_manager' | 'front_desk' | 'housekeeping' | 'maintenance' | null;
  expiresAt: string;
  maxUses: number;
  usedCount: number;
}

export type JoinCodeCapabilityResolution =
  | { outcome: 'resolved'; receipt: JoinCodeCapabilityReceipt }
  | { outcome: 'not_found' }
  | { outcome: 'unavailable'; databaseCode: string | null };

const FINALIZATION_STATUSES = new Set([
  'invalid',
  'not_found',
  'revoked',
  'expired',
  'used_up',
  'conflict',
  'denied',
  'auth_user_missing',
  'account_exists',
  'username_conflict',
]);

export interface JoinCodeSignupFinalizationReceipt {
  schemaVersion: 'join-code-signup-finalization-v1';
  status: 'finalized' | 'existing';
  codeId: string;
  hotelId: string;
  accountId: string;
  finalRole: Exclude<AppRole, 'admin' | 'staff'>;
  username: string;
  pendingApproval: boolean;
  usedCount: number;
}

export interface FinalizeJoinCodeSignupInput {
  codeId: string;
  code: string;
  hotelId: string;
  expectedUsedCount: number;
  authUserId: string;
  username: string;
  displayName: string;
  requestedRole: Exclude<AppRole, 'admin' | 'staff'>;
  expectedPendingApproval: boolean;
  phone: string | null;
  language: 'en' | 'es';
  requestId: string;
}

export type JoinCodeSignupFinalization =
  | { outcome: 'finalized'; receipt: JoinCodeSignupFinalizationReceipt }
  | {
      outcome: 'denied';
      status:
        | 'invalid'
        | 'not_found'
        | 'revoked'
        | 'expired'
        | 'used_up'
        | 'conflict'
        | 'denied'
        | 'auth_user_missing'
        | 'account_exists'
        | 'username_conflict';
    }
  | { outcome: 'unavailable'; databaseCode: string | null };

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function finiteTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function parseReceipt(value: unknown): JoinCodeCapabilityResolution | null {
  const record = recordOf(value);
  if (!record) return null;
  if (record.ok === false
      && record.status === 'not_found'
      && exactKeys(record, ['ok', 'status'])) {
    return { outcome: 'not_found' };
  }
  if (record.ok !== true
      || record.schemaVersion !== 'join-code-capability-v1'
      || !exactKeys(record, [
        'ok', 'schemaVersion', 'status', 'codeId', 'hotelId', 'codeKind',
        'role', 'expiresAt', 'maxUses', 'usedCount',
      ])
      || !RECEIPT_STATUSES.has(String(record.status))
      || !isUuid(record.codeId)
      || !isUuid(record.hotelId)
      || !CODE_KINDS.has(String(record.codeKind))
      || !(record.role === null || CODE_ROLES.has(String(record.role)))
      || !finiteTimestamp(record.expiresAt)
      || !Number.isInteger(record.maxUses)
      || (record.maxUses as number) < 1
      || !Number.isInteger(record.usedCount)
      || (record.usedCount as number) < 0) {
    return null;
  }

  const status = record.status as JoinCodeCapabilityReceipt['status'];
  const maxUses = record.maxUses as number;
  const usedCount = record.usedCount as number;
  const codeKind = record.codeKind as JoinCodeCapabilityReceipt['codeKind'];
  const role = record.role as JoinCodeCapabilityReceipt['role'];
  const expired = Date.parse(record.expiresAt) <= Date.now();
  if ((status === 'active' && (expired || usedCount >= maxUses))
      || (status === 'expired' && !expired)
      || (status === 'used_up' && (expired || usedCount < maxUses))) {
    return null;
  }
  const staffRole = role === null
    || role === 'front_desk'
    || role === 'housekeeping'
    || role === 'maintenance';
  const privilegedRole = role === 'owner' || role === 'general_manager';
  if ((codeKind === 'staff_signup' && !staffRole)
      || (codeKind === 'onboarding_resume'
        && (role !== null
          || maxUses !== 1
          || usedCount !== 1
          || !RESUME_RECEIPT_STATUSES.has(status)))
      || (codeKind === 'privileged_onboarding'
        && (!privilegedRole || maxUses !== 1 || usedCount > 1))
      || (codeKind === 'legacy_revoked' && (!privilegedRole || status !== 'revoked'))) {
    return null;
  }

  return {
    outcome: 'resolved',
    receipt: {
      schemaVersion: 'join-code-capability-v1',
      status,
      codeId: record.codeId,
      hotelId: record.hotelId,
      codeKind,
      role,
      expiresAt: record.expiresAt,
      maxUses,
      usedCount,
    },
  };
}

function parseFinalization(value: unknown): JoinCodeSignupFinalization | null {
  const record = recordOf(value);
  if (!record) return null;
  if (record.ok === false
      && typeof record.status === 'string'
      && FINALIZATION_STATUSES.has(record.status)
      && exactKeys(record, ['ok', 'status'])) {
    return {
      outcome: 'denied',
      status: record.status as Extract<JoinCodeSignupFinalization, { outcome: 'denied' }>['status'],
    };
  }
  if (record.ok !== true
      || record.schemaVersion !== 'join-code-signup-finalization-v1'
      || (record.status !== 'finalized' && record.status !== 'existing')
      || !exactKeys(record, [
        'ok', 'schemaVersion', 'status', 'codeId', 'hotelId', 'accountId',
        'finalRole', 'username', 'pendingApproval', 'usedCount',
      ])
      || !isUuid(record.codeId)
      || !isUuid(record.hotelId)
      || !isUuid(record.accountId)
      || !CODE_ROLES.has(String(record.finalRole))
      || record.finalRole === 'owner' && record.pendingApproval !== false
      || record.finalRole === 'general_manager' && record.pendingApproval !== false
      || typeof record.username !== 'string'
      || record.username.length < 1
      || record.username.length > 40
      || typeof record.pendingApproval !== 'boolean'
      || !Number.isInteger(record.usedCount)
      || (record.usedCount as number) < 1) {
    return null;
  }

  return {
    outcome: 'finalized',
    receipt: {
      schemaVersion: 'join-code-signup-finalization-v1',
      status: record.status,
      codeId: record.codeId,
      hotelId: record.hotelId,
      accountId: record.accountId,
      finalRole: record.finalRole as JoinCodeSignupFinalizationReceipt['finalRole'],
      username: record.username,
      pendingApproval: record.pendingApproval,
      usedCount: record.usedCount as number,
    },
  };
}

/** Wizard/mapping bearer capabilities are intentionally disjoint from staff signup. */
export function isOnboardingJoinCodeCapability(
  receipt: JoinCodeCapabilityReceipt,
): boolean {
  return (
    receipt.codeKind === 'privileged_onboarding'
    && (receipt.status === 'active' || receipt.status === 'used_up')
  ) || (
    receipt.codeKind === 'onboarding_resume'
    && receipt.status === 'used_up'
  );
}

/**
 * Resolve an exact join-code bearer through the service-only database boundary.
 * The bearer is normalized only for case/outer whitespace, is never returned,
 * and is never included in an error object or log payload.
 */
export async function resolveJoinCodeCapability(
  candidate: unknown,
): Promise<JoinCodeCapabilityResolution> {
  if (typeof candidate !== 'string') return { outcome: 'not_found' };
  const normalized = candidate.trim().toUpperCase();
  if (Buffer.byteLength(normalized, 'utf8') < 6
      || Buffer.byteLength(normalized, 'utf8') > 128
      || !LEGACY_JOIN_CODE_RX.test(normalized)) {
    return { outcome: 'not_found' };
  }

  const { data, error } = await supabaseAdmin.rpc(
    'staxis_resolve_join_code_capability',
    { p_code: normalized },
  );
  if (error) {
    return { outcome: 'unavailable', databaseCode: error.code ?? null };
  }
  const parsed = parseReceipt(data);
  return parsed ?? { outcome: 'unavailable', databaseCode: 'PGRST_CONTRACT' };
}

/**
 * Atomically reassert and consume a bearer, then create every relational
 * signup row. Auth itself is external to Postgres, so callers create the Auth
 * identity first and delete it on a definitive refusal. The RPC is idempotent
 * for a previously committed (Auth user, code) pair so a lost response can be
 * recovered without consuming a second slot.
 */
export async function finalizeJoinCodeSignup(
  input: FinalizeJoinCodeSignupInput,
): Promise<JoinCodeSignupFinalization> {
  const { data, error } = await supabaseAdmin.rpc(
    'staxis_finalize_join_code_signup',
    {
      p_code_id: input.codeId,
      p_code: input.code.trim().toUpperCase(),
      p_hotel_id: input.hotelId,
      p_expected_used_count: input.expectedUsedCount,
      p_auth_user_id: input.authUserId,
      p_username: input.username,
      p_display_name: input.displayName,
      p_requested_role: input.requestedRole,
      p_phone: input.phone,
      p_language: input.language,
      p_request_id: input.requestId,
    },
  );
  if (error) {
    return { outcome: 'unavailable', databaseCode: error.code ?? null };
  }
  const parsed = parseFinalization(data);
  if (!parsed) {
    return { outcome: 'unavailable', databaseCode: 'PGRST_CONTRACT' };
  }
  if (parsed.outcome === 'finalized'
      && (parsed.receipt.codeId !== input.codeId
        || parsed.receipt.hotelId !== input.hotelId
        || parsed.receipt.finalRole !== input.requestedRole
        || parsed.receipt.pendingApproval !== input.expectedPendingApproval
        || parsed.receipt.username !== input.username
        || parsed.receipt.usedCount !== input.expectedUsedCount + 1)) {
    return { outcome: 'unavailable', databaseCode: 'PGRST_CONTRACT' };
  }
  return parsed;
}
