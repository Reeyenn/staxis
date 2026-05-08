/**
 * POST /api/pms/save-credentials
 *
 * Persists a property's PMS login info to scraper_credentials. This is
 * the "Test Connection" button on /settings/pms — it saves the creds
 * (so the next click of "Save & Onboard" can use them) and confirms we
 * can reach the login URL. We don't run a full Playwright login here
 * because that's a Fly.io-only capability and Vercel functions are
 * 60s-capped — the actual login attempt happens during the onboarding
 * job (POST /api/pms/onboard).
 *
 * Body: { propertyId, pmsType, loginUrl, username, password }
 *
 * Returns:
 *   { ok: true, data: { propertyId } } on success
 *   { ok: false, error, code }         on validation/auth failure
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireSession } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { validateUuid, validateString, validateEnum } from '@/lib/api-validate';
import { checkAndIncrementRateLimit } from '@/lib/api-ratelimit';
import { PMS_TYPES, isPMSType } from '@/lib/pms';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

interface Body {
  propertyId?: unknown;
  pmsType?: unknown;
  loginUrl?: unknown;
  username?: unknown;
  password?: unknown;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  // ─── Auth ────────────────────────────────────────────────────────────────
  const session = await requireSession(req);
  if (!session.ok) return session.response;

  // ─── Parse + validate ────────────────────────────────────────────────────
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body) {
    return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const pidV = validateUuid(body.propertyId, 'propertyId');
  if (pidV.error) {
    return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const pmsTypeV = validateEnum(body.pmsType, PMS_TYPES, 'pmsType');
  if (pmsTypeV.error || !pmsTypeV.value) {
    return err(pmsTypeV.error ?? 'invalid pmsType', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  const urlV = validateString(body.loginUrl, { max: 500, label: 'loginUrl' });
  if (urlV.error) {
    return err(urlV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const userV = validateString(body.username, { max: 200, label: 'username' });
  if (userV.error) {
    return err(userV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const passV = validateString(body.password, { max: 500, label: 'password' });
  if (passV.error) {
    return err(passV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  // Sanity check the URL is http(s)
  try {
    const u = new URL(urlV.value!);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return err('loginUrl must be http(s)', {
        requestId, status: 400, code: ApiErrorCode.ValidationFailed,
      });
    }
  } catch {
    return err('loginUrl is not a valid URL', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  if (!isPMSType(pmsTypeV.value)) {
    return err('invalid pmsType', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  // ─── Capability: caller must own this property ──────────────────────────
  const { data: property } = await supabaseAdmin
    .from('properties')
    .select('id, owner_id')
    .eq('id', pidV.value!)
    .maybeSingle();

  if (!property) {
    return err('Property not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }
  // Explicit null check — a property with owner_id=NULL (orphaned, e.g.
  // from a manual data fix or pre-auth migration) shouldn't pass
  // ownership. Without this check the !== comparison would still return
  // true (NULL !== userId) but the semantics are murky; be explicit.
  if (!property.owner_id || (property.owner_id as string) !== session.userId) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  // ─── Rate limit ─────────────────────────────────────────────────────────
  // Cap test-cred saves at 30/hour per property — plenty for a GM
  // typo-fixing iteratively, but stops a runaway script from carpet-
  // bombing the table.
  const rl = await checkAndIncrementRateLimit('pms-save-credentials', pidV.value!);
  if (!rl.allowed) {
    return err(
      `Rate limited. ${rl.current}/${rl.cap} credential saves this hour for this property. Try again in ${rl.retryAfterSec}s.`,
      { requestId, status: 429, code: ApiErrorCode.RateLimited,
        headers: { 'Retry-After': String(rl.retryAfterSec) } },
    );
  }

  // ─── Upsert scraper_credentials ─────────────────────────────────────────
  // Note: column names are CA-prefixed for legacy reasons (migration 0018
  // was Choice Advantage-only). They're now the generic PMS credential
  // columns until we do a renaming migration.
  const { error: upsertErr } = await supabaseAdmin
    .from('scraper_credentials')
    .upsert(
      {
        property_id:  pidV.value!,
        pms_type:     pmsTypeV.value,
        ca_login_url: urlV.value!,
        ca_username:  userV.value!,
        ca_password:  passV.value!,
        is_active:    true,
      },
      { onConflict: 'property_id' },
    );

  if (upsertErr) {
    console.error('[pms/save-credentials] upsert failed', upsertErr);
    return err('Could not save credentials', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  // Also stamp pms_type + pms_url onto the properties row so the rest of
  // the app (and the existing /settings/pms read path) sees the change
  // without an extra join.
  await supabaseAdmin
    .from('properties')
    .update({
      pms_type: pmsTypeV.value,
      pms_url:  urlV.value!,
    })
    .eq('id', pidV.value!);

  return ok({ propertyId: pidV.value!, pmsType: pmsTypeV.value }, { requestId });
}
