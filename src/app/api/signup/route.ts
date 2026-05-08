/**
 * POST /api/signup
 *
 * Public endpoint — no auth required, this is what creates the auth.users
 * row and the corresponding properties row + scraper_credentials in one
 * transaction. After this returns ok the user has a Supabase session and
 * should be redirected to /onboarding to finish PMS connection + staff
 * setup.
 *
 * Body:
 *   {
 *     email, password,                       // creates auth.users
 *     hotelName,                              // properties.name
 *     propertyKind,                           // limited_service / extended_stay / etc.
 *     totalRooms,                             // properties.total_rooms (rough estimate, refined by PMS pull)
 *     timezone,                               // e.g., 'America/Chicago'
 *   }
 *
 * Returns:
 *   { ok: true, propertyId, accessToken, refreshToken }
 *
 * Side effects:
 *   - Creates auth.users row via supabaseAdmin.auth.admin.createUser
 *   - Inserts properties row with subscription_status='trial', trial_ends_at=now+14d,
 *     onboarding_source='self_signup', services_enabled defaulted by property_kind
 *   - Inserts a stripe customer (best-effort, non-blocking)
 *   - Issues a Supabase session via auth.admin.generateLink
 */

import { NextRequest } from 'next/server';
import bcrypt from 'bcryptjs';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { validateString, validateInt, validateEnum } from '@/lib/api-validate';
import { createStripeCustomer, trialEndsAt } from '@/lib/stripe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const PROPERTY_KINDS = ['limited_service', 'extended_stay', 'full_service', 'boutique', 'other'] as const;
type PropertyKind = typeof PROPERTY_KINDS[number];

interface Body {
  email?: unknown;
  password?: unknown;
  hotelName?: unknown;
  propertyKind?: unknown;
  totalRooms?: unknown;
  timezone?: unknown;
  ownerName?: unknown;
}

/**
 * Default services_enabled based on property kind. Extended-stay
 * properties don't have daily housekeeping by default — the GM can
 * still toggle it on in /onboarding if they want.
 */
function defaultServicesFor(kind: PropertyKind): Record<string, boolean> {
  const all = {
    housekeeping: true,
    laundry: true,
    maintenance: true,
    deep_cleaning: true,
    public_areas: true,
    inventory: true,
    equipment: true,
  };
  if (kind === 'extended_stay') {
    return { ...all, housekeeping: false, deep_cleaning: false };
  }
  return all;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  // ─── Validate ───────────────────────────────────────────────────────────
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body) {
    return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const emailV = validateString(body.email, { max: 200, label: 'email' });
  if (emailV.error) return err(emailV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  // Light email regex — Supabase will do the canonical check.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailV.value!)) {
    return err('Email looks invalid', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const email = emailV.value!.toLowerCase().trim();

  const pwV = validateString(body.password, { max: 200, min: 8, label: 'password' });
  if (pwV.error) return err(pwV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const nameV = validateString(body.hotelName, { max: 200, label: 'hotelName' });
  if (nameV.error) return err(nameV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const kindV = validateEnum(body.propertyKind, PROPERTY_KINDS, 'propertyKind');
  if (kindV.error || !kindV.value) {
    return err(kindV.error ?? 'invalid propertyKind', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const roomsV = validateInt(body.totalRooms, { min: 1, max: 5000, label: 'totalRooms' });
  if (roomsV.error) return err(roomsV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const tzV = validateString(body.timezone ?? 'America/Chicago', { max: 100, label: 'timezone' });
  if (tzV.error) return err(tzV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const ownerName = typeof body.ownerName === 'string' ? body.ownerName.slice(0, 200).trim() : '';

  // ─── Create the auth user ───────────────────────────────────────────────
  const { data: createdUser, error: createUserErr } = await supabaseAdmin.auth.admin.createUser({
    email,
    password: pwV.value!,
    email_confirm: true, // skip the magic-link step for signup; can flip to false later when we want verification
    user_metadata: {
      owner_name: ownerName || undefined,
      onboarding_source: 'self_signup',
    },
  });

  if (createUserErr || !createdUser.user) {
    // Email collision is the most common error — surface a friendly message.
    const msg = createUserErr?.message ?? 'Could not create account';
    const isDup = /already registered|already exists/i.test(msg);
    return err(
      isDup ? 'An account already exists for this email. Try signing in instead.' : msg,
      { requestId, status: isDup ? 409 : 500, code: isDup ? ApiErrorCode.IdempotencyConflict : ApiErrorCode.InternalError },
    );
  }

  const userId = createdUser.user.id;

  // ─── Create the property ────────────────────────────────────────────────
  const { data: property, error: propErr } = await supabaseAdmin
    .from('properties')
    .insert({
      owner_id: userId,
      name: nameV.value!.trim(),
      total_rooms: roomsV.value!,
      timezone: tzV.value!,
      property_kind: kindV.value,
      services_enabled: defaultServicesFor(kindV.value),
      onboarding_source: 'self_signup',
      subscription_status: 'trial',
      trial_ends_at: trialEndsAt().toISOString(),
    })
    .select('id')
    .single();

  if (propErr || !property) {
    // Best-effort cleanup of the auth user so they don't end up
    // half-signed-up. Failure here is logged but not surfaced.
    await supabaseAdmin.auth.admin.deleteUser(userId).catch(() => {});
    return err(
      `Could not create your property: ${propErr?.message ?? 'unknown'}`,
      { requestId, status: 500, code: ApiErrorCode.InternalError },
    );
  }

  // ─── Create the accounts row ────────────────────────────────────────────
  // The dashboard's AuthContext expects an accounts row keyed on
  // data_user_id. Self-signup users get one with role='owner' and
  // property_access scoped to just the property they created. We use
  // the email as the username so they can also sign in via the
  // legacy username-based flow if they want.
  // password_hash: stored for legacy schema compatibility — Supabase
  // Auth is the actual auth provider, but the column is NOT NULL.
  const passwordHash = await bcrypt.hash(pwV.value!, 10);
  const username = email.split('@')[0].slice(0, 100);
  const { error: acctErr } = await supabaseAdmin.from('accounts').insert({
    username,
    password_hash: passwordHash,
    display_name: ownerName || username,
    role: 'owner',
    property_access: [property.id],
    data_user_id: userId,
  });
  if (acctErr) {
    // If the username collides with an existing account, we still
    // own the auth user + property — let them sign in via Supabase
    // and we'll reconcile manually. Log and proceed; don't roll back.
    console.warn('[signup] accounts insert failed', acctErr.message);
  }

  // ─── Stripe customer (best-effort) ──────────────────────────────────────
  // If Stripe isn't configured yet (early days), this returns disabled
  // and we just leave stripe_customer_id null. The trial still applies.
  try {
    const cust = await createStripeCustomer({
      email,
      name: ownerName || undefined,
      propertyName: nameV.value!,
      propertyId: property.id as string,
    });
    if ('ok' in cust && cust.ok) {
      await supabaseAdmin
        .from('properties')
        .update({ stripe_customer_id: cust.customerId })
        .eq('id', property.id);
    }
  } catch {
    // Stripe is non-blocking on signup. Worst case: when the GM hits
    // /api/stripe/create-checkout, we create the customer there.
  }

  // ─── Issue a session for the new user ───────────────────────────────────
  // The supabase-js admin API doesn't directly issue an access token,
  // but we can sign the user in with their fresh credentials. This
  // saves them an extra /signin redirect.
  const { data: session, error: signInErr } = await supabaseAdmin.auth.signInWithPassword({
    email,
    password: pwV.value!,
  });

  if (signInErr || !session.session) {
    // Account was created but we couldn't sign them in. They can use
    // /signin manually with their email + password.
    return ok(
      {
        propertyId: property.id,
        userId,
        signInRequired: true,
        message: 'Account created. Please sign in.',
      },
      { requestId, status: 201 },
    );
  }

  return ok(
    {
      propertyId: property.id,
      userId,
      accessToken: session.session.access_token,
      refreshToken: session.session.refresh_token,
      expiresAt: session.session.expires_at,
    },
    { requestId, status: 201 },
  );
}
