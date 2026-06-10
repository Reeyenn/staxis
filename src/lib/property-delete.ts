/**
 * Decide what happens to the accounts linked to a property that's being
 * hard-deleted from the admin Onboarding timeline (the hover-✕).
 *
 * `accounts.property_access` is a uuid[] (not an FK), so deleting a property
 * leaves its owner/staff accounts behind — which is exactly what blocked
 * re-using an email after deleting a test hotel. This classifier decides,
 * per linked account:
 *
 *   - role === 'admin'        → never touched (admins access every hotel by
 *                               role, not by property_access; never auto-delete one).
 *   - access === [thisHotel]  → the account exists ONLY for this hotel →
 *                               remove it entirely (account + auth user → email freed).
 *   - access has other hotels → keep the account, just drop this hotel from
 *                               its property_access.
 *
 * Pure + side-effect free so it can be unit-tested without a DB; the route
 * applies the plan.
 */

export interface LinkedAccount {
  id: string;
  data_user_id: string | null;
  role: string | null;
  property_access: string[] | null;
}

export interface AccountDeletePlan {
  /** auth.users ids whose account exists only for this hotel — delete account + auth user. */
  deleteUserIds: string[];
  /** accounts that also belong to other hotels — keep, but with this hotel removed. */
  prune: { id: string; remaining: string[] }[];
}

export function classifyAccountsForPropertyDelete(
  accounts: LinkedAccount[],
  propertyId: string,
): AccountDeletePlan {
  const deleteUserIds: string[] = [];
  const prune: { id: string; remaining: string[] }[] = [];

  for (const a of accounts) {
    if (a.role === 'admin') continue; // never auto-delete an admin
    const remaining = (a.property_access ?? []).filter((id) => id !== propertyId);
    if (remaining.length === 0) {
      // Account exists solely for this hotel → remove it (frees the email).
      if (a.data_user_id) deleteUserIds.push(a.data_user_id);
    } else {
      // Account also belongs to other hotels → keep it, drop this one.
      prune.push({ id: a.id, remaining });
    }
  }

  return { deleteUserIds, prune };
}
