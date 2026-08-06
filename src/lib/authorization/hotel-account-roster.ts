import 'server-only';

import { isUuid } from '@/lib/api-validate';
import { isValidRole, type AppRole } from '@/lib/roles';
import { supabaseAdmin } from '@/lib/supabase-admin';

export const AUTHORITATIVE_HOTEL_ROSTER_SCHEMA_VERSION = 'authoritative-hotel-roster-v1' as const;

export type HotelRosterAuthorityMode = 'legacy' | 'shadow' | 'normalized';
export type HotelRosterManagementSurface = 'legacy_hotel' | 'company_access';

export interface AuthoritativeHotelAccount {
  accountId: string;
  username: string;
  displayName: string;
  role: AppRole;
  active: boolean;
  dataUserId: string;
  staffId: string | null;
  createdAt: string;
  updatedAt: string;
  authorityMode: HotelRosterAuthorityMode;
  authorityVersion: number;
  propertyIds: string[];
  managementSurface: HotelRosterManagementSurface;
}

export interface AuthoritativeHotelRoster {
  schemaVersion: typeof AUTHORITATIVE_HOTEL_ROSTER_SCHEMA_VERSION;
  propertyId: string;
  generatedAt: string;
  accounts: AuthoritativeHotelAccount[];
}

export class AuthoritativeHotelRosterError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'AuthoritativeHotelRosterError';
    this.code = code;
  }
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sortedUniqueUuidArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 5000 || !value.every(isUuid)) return null;
  const normalized = [...new Set(value as string[])].sort();
  if (normalized.length !== value.length) return null;
  return normalized.every((id, index) => id === value[index]) ? normalized : null;
}

/** Fail closed if the SECURITY DEFINER response drifts from its closed DTO. */
export function parseAuthoritativeHotelRoster(value: unknown): AuthoritativeHotelRoster | null {
  const root = recordOf(value);
  if (!root
      || root.ok !== true
      || root.schemaVersion !== AUTHORITATIVE_HOTEL_ROSTER_SCHEMA_VERSION
      || !isUuid(root.propertyId)
      || typeof root.generatedAt !== 'string'
      || !Array.isArray(root.accounts)
      || root.accounts.length > 5000) return null;

  const accounts: AuthoritativeHotelAccount[] = [];
  const seen = new Set<string>();
  for (const valueAccount of root.accounts) {
    const account = recordOf(valueAccount);
    const propertyIds = sortedUniqueUuidArray(account?.propertyIds);
    if (!account
        || !isUuid(account.accountId)
        || seen.has(account.accountId)
        || typeof account.username !== 'string'
        || typeof account.displayName !== 'string'
        || !isValidRole(account.role)
        || typeof account.active !== 'boolean'
        || !isUuid(account.dataUserId)
        || (account.staffId !== null && !isUuid(account.staffId))
        || typeof account.createdAt !== 'string'
        || typeof account.updatedAt !== 'string'
        || !['legacy', 'shadow', 'normalized'].includes(String(account.authorityMode))
        || !Number.isSafeInteger(account.authorityVersion)
        || Number(account.authorityVersion) <= 0
        || !propertyIds
        || !['legacy_hotel', 'company_access'].includes(String(account.managementSurface))) {
      return null;
    }
    // Post-cutover (0426) every account carries normalized authority, so
    // authorityMode no longer tells you which surface manages the person.
    // 0424's roster RPC projects a normalized account whose only claim is one
    // independent single-hotel scope back onto `legacy_hotel`, because an
    // independent hotel has no company Access surface to manage it from. That
    // combination is the standing shape for every hotel that is not under a
    // management company, so it must parse.
    //
    // The reverse remains impossible by construction: the RPC's CASE falls
    // through to `legacy_hotel` for anything not normalized, so a
    // non-normalized account is never projected onto `company_access`.
    const normalized = account.authorityMode === 'normalized';
    if ((!normalized && account.managementSurface !== 'legacy_hotel')
        || (account.role !== 'admin' && !propertyIds.includes(root.propertyId as string))
        || (account.role === 'admin' && propertyIds.length !== 0)) return null;
    seen.add(account.accountId);
    accounts.push({
      accountId: account.accountId,
      username: account.username,
      displayName: account.displayName,
      role: account.role,
      active: account.active,
      dataUserId: account.dataUserId,
      staffId: account.staffId as string | null,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
      authorityMode: account.authorityMode as HotelRosterAuthorityMode,
      authorityVersion: Number(account.authorityVersion),
      propertyIds,
      managementSurface: account.managementSurface as HotelRosterManagementSurface,
    });
  }
  return {
    schemaVersion: AUTHORITATIVE_HOTEL_ROSTER_SCHEMA_VERSION,
    propertyId: root.propertyId,
    generatedAt: root.generatedAt,
    accounts,
  };
}

export async function loadAuthoritativeHotelRoster(
  propertyId: string,
  includePlatformAdmins = false,
): Promise<AuthoritativeHotelRoster> {
  if (!isUuid(propertyId)) throw new AuthoritativeHotelRosterError('Invalid hotel id', '22023');
  const { data, error } = await supabaseAdmin.rpc(
    'staxis_list_authoritative_hotel_accounts',
    {
      p_property_id: propertyId,
      p_include_platform_admins: includePlatformAdmins,
    },
  );
  if (error) throw new AuthoritativeHotelRosterError(
    error.message ?? 'Authoritative hotel roster failed',
    error.code,
  );
  const parsed = parseAuthoritativeHotelRoster(data);
  if (!parsed) throw new AuthoritativeHotelRosterError(
    'Authoritative hotel roster response was malformed',
    'PGRST_CONTRACT',
  );
  return parsed;
}
