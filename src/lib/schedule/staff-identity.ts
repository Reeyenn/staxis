import 'server-only';

import { randomUUID } from 'node:crypto';

import { commsStaffIdentityId } from '@/lib/comms/identity';
import { log } from '@/lib/log';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';

/**
 * Resolve the signed-in account's operational identity at one hotel.
 *
 * `accounts.staff_id` is a legacy account-wide pointer and cannot represent an
 * account linked to a different staff profile at each hotel. The canonical
 * source is account_property_staff_links, keyed by (account, property).
 */
export async function activeStaffIdForAccountAtProperty(
  accountId: string,
  propertyId: string,
): Promise<string | null> {
  const { data: link, error: linkError } = await supabaseAdmin
    .from('account_property_staff_links')
    .select('staff_id')
    .eq('account_id', accountId)
    .eq('property_id', propertyId)
    .eq('is_active', true)
    .maybeSingle();
  if (linkError) throw linkError;
  if (!link?.staff_id) return null;

  const { data: staff, error: staffError } = await supabaseAdmin
    .from('staff')
    .select('id')
    .eq('id', link.staff_id)
    .eq('property_id', propertyId)
    .eq('is_active', true)
    .maybeSingle();
  if (staffError) throw staffError;
  return staff?.id ? String(staff.id) : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// A manager login joins the hotel's staff list
//
// Staxis keeps two records of a person on purpose, and a Codex ruling the
// founder upheld says they stay separate lifecycles:
//   • "Add staff member" makes an EMPLOYMENT record (`staff`). Schedule, hours,
//     department. No login.
//   • "Invite people" makes a LOGIN (`accounts` + canonical hats). No
//     employment record.
//
// That is right for a housekeeper who never signs in, and right for a company
// VP who never works a shift. It was wrong for exactly one person: the manager
// you invite to RUN a hotel. They arrive with a login and no employment record,
// which means the hotel's own to-do list cannot hand them anything: the Who
// list is the `staff` table (see worklist/assignable.ts), so a GM with a login
// and no roster row is invisible to the people trying to delegate to them.
//
// This is the one-way bridge. Accepting a hotel-scoped MANAGER invitation
// creates (or adopts) that person's roster row at that hotel. It never runs the
// other way: adding a staff member still creates no login, and a housekeeper
// invitation still creates no roster row here.
//
// IDEMPOTENT AND ADOPT-FIRST. Communications already mints a deterministic
// roster row the first time a manager sends a message
// (comms/core.ts resolveStaffIdForAccount), so the person may already have one,
// possibly several from older paths. The rule is one ACTIVE row per identity
// per hotel: adopt the oldest, archive the rest through the canonical archive
// RPC so their history and shift coverage are preserved.
//
// ARCHIVED IS INTENT. A row somebody archived is never revived here. Archiving
// a person is a manager saying "they do not work here any more"; an invitation
// arriving later is a NEW employment, so it gets a fresh row and the archived
// one stays archived as history.
// ═══════════════════════════════════════════════════════════════════════════

/** Manager roster rows are office staff, never housekeeping. `other` is the
 *  same department Communications gives a manager identity, so the two paths
 *  converge on one row instead of fighting over two. */
export const MANAGER_ROSTER_DEPARTMENT = 'other';

/** The hotel words an invitation can promise that mean "runs this hotel". */
export const MANAGER_TIER_HOTEL_ROLES: readonly string[] = ['owner', 'general_manager'];

/** The shape of the promise an invitation carries, as stored on
 *  `account_invites` and as passed to the existing-account grant RPC. */
export interface HotelAccessGrantShape {
  role: string;
  /** `'company'` / `'property'` for a normalized hat, `null` for a plain
   *  single-hotel invitation. */
  membershipScope: 'company' | 'property' | string | null;
  organizationId: string | null;
}

/**
 * Does this grant make somebody a manager OF ONE HOTEL?
 *
 * Company-scope hats (owner / VP / finance over a whole company) deliberately
 * say NO. They are not on any hotel's staff list: they oversee it. My Hotel
 * shows them in their own Company section and the hotel's to-do list cannot
 * hand them work, which is the correct answer for somebody who is not in the
 * building.
 */
export function isHotelScopedManagerGrant(grant: HotelAccessGrantShape): boolean {
  if (grant.membershipScope === 'company') return false;
  if (grant.membershipScope === 'property') return grant.role === 'general_manager';
  // No hat at all: a plain invitation at an independent hotel.
  return grant.organizationId === null && MANAGER_TIER_HOTEL_ROLES.includes(grant.role);
}

/**
 * Which hotels this grant makes somebody a manager OF.
 *
 * A property-scope hat can name several hotels at once, and a manager who runs
 * three of them has to be on all three staff lists: the to-do Who list is
 * per-hotel, so being on only the anchor hotel's list would leave the other two
 * unable to hand them anything. A grant that is not hotel-scoped manager work
 * names nothing.
 */
export function managerRosterPropertyIds(grant: HotelAccessGrantShape & {
  hotelId: string;
  coveredPropertyIds: unknown;
}): string[] {
  if (!isHotelScopedManagerGrant(grant)) return [];
  if (grant.membershipScope !== 'property') return [grant.hotelId];
  const covered = Array.isArray(grant.coveredPropertyIds)
    ? grant.coveredPropertyIds.filter((value): value is string => (
      typeof value === 'string' && value.length > 0
    ))
    : [];
  return [...new Set(covered.length > 0 ? covered : [grant.hotelId])].sort();
}

/** One `staff` row considered as a candidate identity for an account. */
export interface StaffIdentityCandidate {
  id: string;
  isActive: boolean;
  createdAt: string | null;
  /** The account holding the ACTIVE link on this row, if any. A row already
   *  claimed by somebody else is never taken. */
  activeLinkAccountId: string | null;
}

export interface ManagerStaffIdentityPlan {
  /** The row to keep and link. `null` when a row has to be made. */
  keeperStaffId: string | null;
  /** The id to insert when `keeperStaffId` is null. */
  createStaffId: string | null;
  /** Duplicate ACTIVE rows for the same person, to archive. */
  archiveStaffIds: string[];
  outcome: 'adopted' | 'deduped' | 'created';
}

function candidateOrder(
  left: StaffIdentityCandidate,
  right: StaffIdentityCandidate,
): number {
  const leftTime = left.createdAt ? Date.parse(left.createdAt) : Number.NaN;
  const rightTime = right.createdAt ? Date.parse(right.createdAt) : Number.NaN;
  const leftKnown = Number.isFinite(leftTime);
  const rightKnown = Number.isFinite(rightTime);
  if (leftKnown && rightKnown && leftTime !== rightTime) return leftTime - rightTime;
  if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
  return left.id.localeCompare(right.id);
}

/**
 * Decide, with no database access, which roster row this manager should own.
 *
 * Pure so the interesting part is testable: Testing Hotel really does carry
 * four active "Reeyen Patel" rows minted by the Communications path, and the
 * rule that collapses them to one has to be exercised without a live database.
 *
 * The order is: keep whatever is already linked, else the oldest unclaimed
 * active row, else make one. A row claimed by a DIFFERENT account is never a
 * candidate, so two managers can never end up fighting over one identity.
 */
export function planManagerStaffIdentity(input: {
  accountId: string;
  deterministicStaffId: string;
  /** A pre-minted uuid, used only when the deterministic id is already taken
   *  by an archived row. Passed in so the plan stays deterministic in tests. */
  freshStaffId: string;
  activeLinkStaffId: string | null;
  candidates: readonly StaffIdentityCandidate[];
}): ManagerStaffIdentityPlan {
  const claimable = input.candidates.filter((candidate) => (
    candidate.isActive
    && (candidate.activeLinkAccountId === null
      || candidate.activeLinkAccountId === input.accountId)
  ));
  const deduped = new Map<string, StaffIdentityCandidate>();
  for (const candidate of claimable) deduped.set(candidate.id, candidate);
  const ordered = [...deduped.values()].sort(candidateOrder);
  const alreadyLinked = input.activeLinkStaffId
    ? ordered.find((candidate) => candidate.id === input.activeLinkStaffId) ?? null
    : null;
  const keeper = alreadyLinked ?? ordered[0] ?? null;

  if (!keeper) {
    // The deterministic id may belong to an archived row. Archiving is intent,
    // so that row is left alone and this employment starts fresh.
    const deterministicTaken = input.candidates.some(
      (candidate) => candidate.id === input.deterministicStaffId,
    );
    return {
      keeperStaffId: null,
      createStaffId: deterministicTaken ? input.freshStaffId : input.deterministicStaffId,
      archiveStaffIds: [],
      outcome: 'created',
    };
  }

  const archiveStaffIds = ordered
    .filter((candidate) => candidate.id !== keeper.id)
    .map((candidate) => candidate.id);
  return {
    keeperStaffId: keeper.id,
    createStaffId: null,
    archiveStaffIds,
    outcome: archiveStaffIds.length > 0 ? 'deduped' : 'adopted',
  };
}

export interface ManagerStaffIdentityResult {
  staffId: string;
  outcome: 'adopted' | 'deduped' | 'created';
  archivedStaffIds: string[];
}

async function readClaimedStaffIds(
  propertyId: string,
  staffIds: readonly string[],
): Promise<Map<string, string>> {
  if (staffIds.length === 0) return new Map();
  const { data, error } = await supabaseAdmin
    .from('account_property_staff_links')
    .select('account_id, staff_id')
    .eq('property_id', propertyId)
    .eq('is_active', true)
    .in('staff_id', [...staffIds]);
  if (error) throw error;
  const claimed = new Map<string, string>();
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    if (typeof row.staff_id === 'string' && typeof row.account_id === 'string') {
      claimed.set(row.staff_id, row.account_id);
    }
  }
  return claimed;
}

/**
 * Make sure this manager has exactly one active roster row at this hotel, and
 * that their login is linked to it.
 *
 * Safe to call twice, safe to call on somebody who already has a row, and safe
 * to call after Communications has already minted one. Returns which of those
 * three things actually happened so the caller can log the truth.
 *
 * Writes go through the service-role client because this runs inside invitation
 * acceptance, where there is no browser session to authorize against, and the
 * canonical `staxis_archive_staff_member` RPC is service-role only.
 *
 * AN ADOPTED ROW KEEPS ITS DEPARTMENT. If the person already has employment
 * here, that record is a manager's answer about the job they do: it drives the
 * housekeeping board and the schedule. Quietly rewriting it because a login
 * arrived would move somebody off a board they are working from today, which is
 * exactly the kind of change the founder's rule forbids. The rare case of a
 * housekeeper promoted to GM is therefore a department change a manager makes
 * on the People screen, not one this function makes behind them.
 */
export async function ensureManagerStaffIdentity(input: {
  accountId: string;
  propertyId: string;
  authUserId: string;
  displayName: string;
  /** Who caused this. Recorded on the link and passed to the archive RPC. */
  actorAccountId: string | null;
  source: 'invitation' | 'system';
}): Promise<ManagerStaffIdentityResult> {
  const { accountId, propertyId, authUserId, source } = input;
  const displayName = input.displayName.trim().slice(0, 120) || 'Manager';
  const deterministicStaffId = commsStaffIdentityId(propertyId, accountId);

  const linkRead = await supabaseAdmin
    .from('account_property_staff_links')
    .select('staff_id')
    .eq('account_id', accountId)
    .eq('property_id', propertyId)
    .eq('is_active', true)
    .maybeSingle();
  if (linkRead.error) throw linkRead.error;
  const activeLinkStaffId = typeof linkRead.data?.staff_id === 'string'
    ? linkRead.data.staff_id
    : null;

  // Two narrow reads rather than one `.or(...)`: the same person is found
  // either by the auth identity their row was bound to, or by an id we already
  // know about (the deterministic Communications row, or whatever is linked).
  const byAuthUser = await supabaseAdmin
    .from('staff')
    .select('id, is_active, created_at')
    .eq('property_id', propertyId)
    .eq('auth_user_id', authUserId);
  if (byAuthUser.error) throw byAuthUser.error;

  const knownIds = [...new Set([
    deterministicStaffId,
    ...(activeLinkStaffId ? [activeLinkStaffId] : []),
  ])];
  const byKnownId = await supabaseAdmin
    .from('staff')
    .select('id, is_active, created_at')
    .eq('property_id', propertyId)
    .in('id', knownIds);
  if (byKnownId.error) throw byKnownId.error;

  const rowsById = new Map<string, { isActive: boolean; createdAt: string | null }>();
  for (const row of [...(byAuthUser.data ?? []), ...(byKnownId.data ?? [])] as Array<Record<string, unknown>>) {
    if (typeof row.id !== 'string') continue;
    rowsById.set(row.id, {
      isActive: row.is_active !== false,
      createdAt: typeof row.created_at === 'string' ? row.created_at : null,
    });
  }
  const claimed = await readClaimedStaffIds(propertyId, [...rowsById.keys()]);
  const candidates: StaffIdentityCandidate[] = [...rowsById.entries()].map(([id, row]) => ({
    id,
    isActive: row.isActive,
    createdAt: row.createdAt,
    activeLinkAccountId: claimed.get(id) ?? null,
  }));

  const plan = planManagerStaffIdentity({
    accountId,
    deterministicStaffId,
    freshStaffId: randomUUID(),
    activeLinkStaffId,
    candidates,
  });

  // Archive the duplicates FIRST. The canonical RPC reopens their future
  // shifts, cancels their pending time off, and drops their links, so doing it
  // before the keeper is linked means no window where two rows look live.
  const archivedStaffIds: string[] = [];
  for (const staffId of plan.archiveStaffIds) {
    const { data, error } = await supabaseAdmin.rpc('staxis_archive_staff_member', {
      p_property_id: propertyId,
      p_staff_id: staffId,
      p_archived_by: input.actorAccountId,
    });
    const archived = data !== null && typeof data === 'object' && !Array.isArray(data)
      ? data as { ok?: unknown }
      : null;
    if (error || archived?.ok !== true) {
      throw error ?? new Error(`duplicate staff row ${staffId} could not be archived`);
    }
    archivedStaffIds.push(staffId);
  }

  let staffId = plan.keeperStaffId;
  if (!staffId) {
    const createStaffId = plan.createStaffId!;
    const inserted = await supabaseAdmin
      .from('staff')
      .insert({
        id: createStaffId,
        property_id: propertyId,
        auth_user_id: authUserId,
        name: displayName,
        department: MANAGER_ROSTER_DEPARTMENT,
        is_active: true,
        language: 'en',
      })
      .select('id')
      .maybeSingle();
    if (inserted.error || !inserted.data?.id) {
      // A concurrent acceptance may have inserted the same deterministic row.
      const afterConflict = await supabaseAdmin
        .from('staff')
        .select('id, is_active')
        .eq('id', createStaffId)
        .eq('property_id', propertyId)
        .maybeSingle();
      if (afterConflict.error
          || typeof afterConflict.data?.id !== 'string'
          || afterConflict.data.is_active === false) {
        throw inserted.error ?? new Error('manager roster row could not be created');
      }
      staffId = afterConflict.data.id;
    } else {
      staffId = String(inserted.data.id);
    }
  }

  const now = new Date().toISOString();
  const linkWrite = await supabaseAdmin
    .from('account_property_staff_links')
    .upsert({
      account_id: accountId,
      property_id: propertyId,
      staff_id: staffId,
      is_active: true,
      source,
      linked_by_account_id: input.actorAccountId,
      linked_at: now,
      deactivated_at: null,
      deactivated_by_account_id: null,
      updated_at: now,
    }, { onConflict: 'account_id,property_id' });
  if (linkWrite.error) throw linkWrite.error;

  return { staffId, outcome: plan.outcome, archivedStaffIds };
}

/**
 * The same bridge, but never allowed to fail the thing that called it.
 *
 * Invitation acceptance has already committed the account and its access by the
 * time this runs. A roster row that could not be written is a person who cannot
 * be handed a to-do yet, which the backfill repairs; it is not a reason to
 * delete somebody's brand-new login. So this reports and returns.
 */
export async function ensureManagerStaffIdentityBestEffort(
  input: Parameters<typeof ensureManagerStaffIdentity>[0],
  context: { requestId: string },
): Promise<ManagerStaffIdentityResult | null> {
  try {
    const result = await ensureManagerStaffIdentity(input);
    log.info('[roster-bridge] manager roster identity ensured', {
      requestId: context.requestId,
      propertyId: input.propertyId,
      outcome: result.outcome,
      archived: result.archivedStaffIds.length,
    });
    return result;
  } catch (error) {
    log.error('[roster-bridge] manager roster identity failed', {
      requestId: context.requestId,
      propertyId: input.propertyId,
      msg: errToString(error),
    });
    return null;
  }
}
