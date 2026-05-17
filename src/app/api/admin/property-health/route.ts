/**
 * GET /api/admin/property-health?id=<propertyId>
 *
 * Detail view for /admin/properties/[id]. Returns everything Reeyen
 * needs to triage one property:
 *   - Property metadata (subscription, services, kind)
 *   - PMS credentials state (set / unset; never returns the password)
 *   - Active recipe (id, version, status, age)
 *   - Last 10 onboarding_jobs
 *   - Staff list (count + first 5 names)
 *   - Owner info from accounts table
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const idV = validateUuid(new URL(req.url).searchParams.get('id'), 'id');
  if (idV.error) return err(idV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const pid = idV.value!;

  // ─── Property ───────────────────────────────────────────────────────────
  const { data: property } = await supabaseAdmin
    .from('properties')
    .select('*')
    .eq('id', pid)
    .maybeSingle();

  if (!property) {
    return err('Property not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }

  // ─── Credentials (never return the password) ────────────────────────────
  const { data: creds } = await supabaseAdmin
    .from('scraper_credentials')
    .select('property_id, pms_type, ca_login_url, ca_username, is_active, scraper_instance, created_at, updated_at')
    .eq('property_id', pid)
    .maybeSingle();

  // ─── Active recipe ──────────────────────────────────────────────────────
  let activeRecipe = null;
  if (creds?.pms_type) {
    const { data: r } = await supabaseAdmin
      .from('pms_recipes')
      .select('id, version, status, learned_by_property_id, notes, created_at')
      .eq('pms_type', creds.pms_type as string)
      .eq('status', 'active')
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();
    activeRecipe = r;
  }

  // ─── Recent onboarding jobs ─────────────────────────────────────────────
  const { data: jobs } = await supabaseAdmin
    .from('onboarding_jobs')
    .select('id, status, step, progress_pct, error, recipe_id, worker_id, created_at, started_at, completed_at')
    .eq('property_id', pid)
    .order('created_at', { ascending: false })
    .limit(10);

  // ─── Staff sample ───────────────────────────────────────────────────────
  const { count: staffCount } = await supabaseAdmin
    .from('staff')
    .select('id', { count: 'exact', head: true })
    .eq('property_id', pid);

  const { data: staffSample } = await supabaseAdmin
    .from('staff')
    .select('id, name, phone, language, department, is_active')
    .eq('property_id', pid)
    .order('name')
    .limit(5);

  // ─── Owner ──────────────────────────────────────────────────────────────
  const ownerId = property.owner_id as string | null;
  let owner: { email: string | null; displayName: string | null; username: string | null } | null = null;
  if (ownerId) {
    const { data: account } = await supabaseAdmin
      .from('accounts')
      .select('username, display_name')
      .eq('data_user_id', ownerId)
      .maybeSingle();
    let email: string | null = null;
    try {
      const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(ownerId);
      email = authUser?.user?.email ?? null;
    } catch {
      email = null;
    }
    owner = {
      email,
      displayName: (account?.display_name as string) ?? null,
      username: (account?.username as string) ?? null,
    };
  }

  return ok({
    property: {
      id: property.id,
      name: property.name,
      totalRooms: property.total_rooms,
      subscriptionStatus: property.subscription_status,
      trialEndsAt: property.trial_ends_at,
      stripeCustomerId: property.stripe_customer_id,
      stripeSubscriptionId: property.stripe_subscription_id,
      servicesEnabled: property.services_enabled,
      propertyKind: property.property_kind,
      onboardingSource: property.onboarding_source,
      pmsType: property.pms_type,
      pmsConnected: property.pms_connected,
      lastSyncedAt: property.last_synced_at,
      timezone: property.timezone,
      createdAt: property.created_at,
    },
    credentials: creds
      ? {
          pmsType: creds.pms_type,
          loginUrl: creds.ca_login_url,
          username: creds.ca_username,
          isActive: creds.is_active,
          scraperInstance: creds.scraper_instance,
          createdAt: creds.created_at,
          updatedAt: creds.updated_at,
        }
      : null,
    activeRecipe,
    jobs: jobs ?? [],
    staff: {
      count: staffCount ?? 0,
      sample: staffSample ?? [],
    },
    owner,
  }, { requestId });
}
