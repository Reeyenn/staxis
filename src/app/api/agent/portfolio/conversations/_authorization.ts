import 'server-only';

import type { NextRequest } from 'next/server';

import { requireSession } from '@/lib/api-auth';
import type { AuthorizationScopeReceipt } from '@/lib/authorization';
import { resolvePortfolioAccessUncached } from '@/lib/company/portfolio';
import { supabaseAdmin } from '@/lib/supabase-admin';

export type PortfolioConversationRequestAuthorization =
  | {
      ok: true;
      accountId: string;
      receipt: AuthorizationScopeReceipt;
    }
  | {
      ok: false;
      reason: 'session_response';
      response: Response;
    }
  | {
      ok: false;
      reason: 'not_found' | 'unavailable';
    };

/**
 * Resolve the active account and the exact selected company from storage.
 * Nothing from a prior request, browser selector, or conversation row is
 * accepted as authority. Foreign and nonexistent organizations deliberately
 * collapse to the same result.
 */
export async function authorizePortfolioConversationRequest(
  req: NextRequest,
  organizationId: string,
): Promise<PortfolioConversationRequestAuthorization> {
  const session = await requireSession(req);
  if (!session.ok) {
    return { ok: false, reason: 'session_response', response: session.response };
  }
  const { data: account, error: accountError } = await supabaseAdmin
    .from('accounts')
    .select('id, active')
    .eq('data_user_id', session.userId)
    .maybeSingle();
  if (accountError) return { ok: false, reason: 'unavailable' };
  if (!account || account.active !== true) return { ok: false, reason: 'not_found' };

  const access = await resolvePortfolioAccessUncached(account.id as string, organizationId);
  if (!access.ok) {
    return {
      ok: false,
      reason: access.reason === 'authorization_unavailable' ? 'unavailable' : 'not_found',
    };
  }
  if (access.access.organizationId !== organizationId
    || access.access.authorizationReceipt.accountId !== account.id
    || access.access.authorizationReceipt.organizationId !== organizationId) {
    return { ok: false, reason: 'not_found' };
  }
  return {
    ok: true,
    accountId: account.id as string,
    receipt: access.access.authorizationReceipt,
  };
}
export function samePortfolioConversationAuthorization(
  initial: Extract<PortfolioConversationRequestAuthorization, { ok: true }>,
  current: Extract<PortfolioConversationRequestAuthorization, { ok: true }>,
): boolean {
  return initial.accountId === current.accountId
    && initial.receipt.organizationId === current.receipt.organizationId
    && initial.receipt.authorizationHash === current.receipt.authorizationHash
    && initial.receipt.authorizedPropertyIds.length === current.receipt.authorizedPropertyIds.length
    && initial.receipt.authorizedPropertyIds.every(
      (propertyId, index) => current.receipt.authorizedPropertyIds[index] === propertyId,
    );
}
