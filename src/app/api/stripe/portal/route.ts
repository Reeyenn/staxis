/**
 * POST /api/stripe/portal
 *
 * Creates a Stripe-hosted Customer Portal session. The GM clicks
 * "Manage subscription" on /settings/billing, we POST here, and we
 * return a URL where they can update card, change plan, cancel,
 * see invoices. Stripe handles all the UI and PCI scope.
 *
 * Body: { propertyId }
 * Returns: { url }
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireSession } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';
import { createPortalSession, stripeIsConfigured } from '@/lib/stripe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

interface Body { propertyId?: unknown }

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  if (!stripeIsConfigured) {
    return err('Billing is not yet configured.', {
      requestId, status: 503, code: ApiErrorCode.UpstreamFailure,
    });
  }

  const session = await requireSession(req);
  if (!session.ok) return session.response;

  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body) return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const pidV = validateUuid(body.propertyId, 'propertyId');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const { data: property } = await supabaseAdmin
    .from('properties')
    .select('id, owner_id, stripe_customer_id')
    .eq('id', pidV.value!)
    .maybeSingle();
  if (!property) return err('Property not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  if (!property.owner_id || (property.owner_id as string) !== session.userId) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  const customerId = property.stripe_customer_id as string | null;
  if (!customerId) {
    return err(
      'No billing account yet — start a subscription first.',
      { requestId, status: 400, code: ApiErrorCode.ValidationFailed },
    );
  }

  const origin = req.headers.get('origin') ?? new URL(req.url).origin;
  const portal = await createPortalSession({
    customerId,
    returnUrl: `${origin}/settings`,
  });
  if (!('ok' in portal) || !portal.ok) {
    return err(
      'disabled' in portal && portal.disabled
        ? 'Billing portal is not yet configured.'
        : `Could not open billing portal: ${(portal as { error: string }).error}`,
      { requestId, status: 500, code: ApiErrorCode.UpstreamFailure },
    );
  }

  return ok({ url: portal.url }, { requestId });
}
