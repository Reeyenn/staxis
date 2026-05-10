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

// Roles that an admin/owner/GM can assign when inviting someone or
// generating a join code. We hide 'admin' (Staxis-only) and 'staff' (legacy).
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
