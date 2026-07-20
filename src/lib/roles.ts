// Single source of truth for the role enum.
// DB-side this is enforced by the accounts.role CHECK constraint
// (see supabase/migrations/0064_team_roles_and_invites.sql).

export const ALL_ROLES = [
  'admin',
  'owner',
  'general_manager',
  'front_desk',
  'housekeeping',
  'maintenance',
  'staff',  // legacy alias — kept so existing rows validate; new accounts pick one of the above
] as const;

// Hotel-facing roles available to invitation/account-management flows. The
// caller-specific hierarchy is enforced by canGrantHotelRole: GMs may grant
// operational roles only, while owner/admin may also grant owner or GM. We
// hide 'admin' (Staxis-only) and 'staff' (legacy).
export const ASSIGNABLE_ROLES = [
  'owner',
  'general_manager',
  'front_desk',
  'housekeeping',
  'maintenance',
] as const;

export type AppRole = typeof ALL_ROLES[number];
export type AssignableRole = typeof ASSIGNABLE_ROLES[number];

export function isValidRole(s: unknown): s is AppRole {
  return typeof s === 'string' && (ALL_ROLES as readonly string[]).includes(s);
}

export function isAssignableRole(s: unknown): s is AssignableRole {
  return typeof s === 'string' && (ASSIGNABLE_ROLES as readonly string[]).includes(s);
}

// Roles that can manage the team (invite people, generate join codes).
export function canManageTeam(role: AppRole): boolean {
  return role === 'admin' || role === 'owner' || role === 'general_manager';
}

/**
 * Role hierarchy for hotel account invitations.
 *
 * General Managers can onboard operational staff, but they cannot create a
 * peer GM or an owner. Owner and GM are account-wide authority tiers, so only
 * an existing owner or a Staxis administrator may grant either one. Keep this
 * shared between invite creation and acceptance so an old pending invite
 * cannot bypass a later hierarchy check.
 */
export function canGrantHotelRole(
  callerRole: AppRole,
  invitedRole: AssignableRole,
): boolean {
  if (!canManageTeam(callerRole)) return false;
  if (invitedRole === 'owner' || invitedRole === 'general_manager') {
    return callerRole === 'admin' || callerRole === 'owner';
  }
  return true;
}

// Roles that can see the Financials suite (Checkbook / Budget / CapEx, revenue,
// profit). Finance is sensitive — front_desk / housekeeping / maintenance / staff
// must NOT reach the tab or any /api/financials/* route. Same trio as
// canManageTeam today, but kept as its own predicate so the finance gate can
// diverge from team-management without a security regression.
export function canViewFinancials(role: AppRole): boolean {
  return role === 'admin' || role === 'owner' || role === 'general_manager';
}

// Display label for the role (English). Spanish translations live in the UI.
export function roleLabel(role: AppRole): string {
  switch (role) {
    case 'admin':           return 'Admin';
    case 'owner':           return 'Owner';
    case 'general_manager': return 'General Manager';
    case 'front_desk':      return 'Front Desk';
    case 'housekeeping':    return 'Housekeeping';
    case 'maintenance':     return 'Maintenance';
    case 'staff':           return 'Staff';
  }
}
