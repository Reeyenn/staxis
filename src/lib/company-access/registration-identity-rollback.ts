import { log } from '@/lib/log';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';

export interface RegistrationIdentityRollbackResult {
  accountDeleteConfirmed: boolean;
  authDeleteAttempted: boolean;
  authDeleted: boolean;
}

/**
 * Compensates for a failed public invitation registration.
 *
 * The account row is the authoritative link protecting an Auth identity. A
 * returned or thrown account-delete failure leaves that link's state unknown,
 * so deleting the Auth user would risk cascading a real account. In that
 * case we preserve the Auth identity for the orphan reconciler/manual repair.
 */
export async function deleteCreatedIdentity(
  accountId: string | null,
  authUserId: string | null,
  requestId: string,
): Promise<RegistrationIdentityRollbackResult> {
  const preserved: RegistrationIdentityRollbackResult = {
    accountDeleteConfirmed: false,
    authDeleteAttempted: false,
    authDeleted: false,
  };

  if (!accountId) {
    if (authUserId) {
      log.warn('[company-invite:register] auth identity preserved because account rollback was not confirmable', {
        requestId,
        authUserId,
      });
    }
    return preserved;
  }

  try {
    const { error } = await supabaseAdmin.from('accounts').delete().eq('id', accountId);
    if (error) {
      log.error('[company-invite:register] account rollback failed; auth identity preserved', {
        requestId,
        accountId,
        code: error.code ?? null,
      });
      return preserved;
    }
  } catch (caught) {
    log.error('[company-invite:register] account rollback threw; auth identity preserved', {
      requestId,
      accountId,
      error: errToString(caught),
    });
    return preserved;
  }

  if (!authUserId) {
    return {
      accountDeleteConfirmed: true,
      authDeleteAttempted: false,
      authDeleted: false,
    };
  }

  try {
    const { error } = await supabaseAdmin.auth.admin.deleteUser(authUserId);
    if (error) {
      log.error('[company-invite:register] auth rollback failed', {
        requestId,
        authUserId,
        status: error.status ?? undefined,
      });
      return {
        accountDeleteConfirmed: true,
        authDeleteAttempted: true,
        authDeleted: false,
      };
    }
  } catch (caught) {
    log.error('[company-invite:register] auth rollback threw', {
      requestId,
      authUserId,
      error: errToString(caught),
    });
    return {
      accountDeleteConfirmed: true,
      authDeleteAttempted: true,
      authDeleted: false,
    };
  }

  return {
    accountDeleteConfirmed: true,
    authDeleteAttempted: true,
    authDeleted: true,
  };
}
