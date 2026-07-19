import type { AppRole, AssignableRole } from '@/lib/roles';

export interface RoleChangeCaller {
  role: AppRole;
}

/** Return null when a hotel role change is allowed, otherwise its denial reason. */
export function denyRoleChange(args: {
  caller: RoleChangeCaller;
  targetCurrentRole: AppRole;
  newRole: AssignableRole;
  isSelf: boolean;
}): string | null {
  const { caller, targetCurrentRole, newRole, isSelf } = args;
  if (targetCurrentRole === 'admin') return 'Cannot modify admin accounts here';
  if (newRole === 'owner' as AssignableRole && caller.role !== 'admin' && caller.role !== 'owner') {
    return 'Only an existing owner can promote someone to owner (use Transfer Ownership)';
  }
  if (targetCurrentRole === 'owner' && caller.role !== 'admin' && caller.role !== 'owner') {
    return 'Only an admin or another owner can change an owner\'s role';
  }
  if (caller.role === 'general_manager') {
    if (targetCurrentRole === 'general_manager') {
      return 'Only an owner or admin can change another General Manager\'s role';
    }
    if (newRole === 'general_manager') {
      return 'Only an owner or admin can promote someone to General Manager';
    }
  }
  if (isSelf && newRole !== caller.role) {
    return 'Cannot change your own role here — use Transfer Ownership instead';
  }
  return null;
}
