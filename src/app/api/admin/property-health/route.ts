/**
 * GET /api/admin/property-health?id=<uuid>
 *
 * Per-hotel triage payload for the admin detail page (/admin/properties/[id]).
 *
 * REBUILT 2026-07-09. The original was deleted in 138f8f32's "pre-v4 scraper-era
 * residue" cleanup because it read two tables that no longer exist:
 *   - scraper_credentials (Choice-Advantage login creds), and
 *   - pms_recipes (the learned mapping recipe).
 * With the route gone the detail page 404'd → res.json() choked on the HTML
 * error page → the WHOLE page rendered "Network error" for every hotel.
 *
 * This version reads ONLY current tables. property / recent onboarding jobs /
 * staff / owner still map 1:1 to the same columns. The mapping "recipe" now
 * comes from pms_knowledge_files (the v4 replacement). Raw PMS login credentials
 * are no longer surfaced here (the table is gone) — but PMS type + connection
 * status still show from the property block, so the page loses nothing an admin
 * relies on. Every sub-read is BEST-EFFORT: a single failure nulls/empties its
 * section and never fails the whole route, so the page always renders.
 *
 * Auth: requireAdmin (a recognized tenant-scope guard) + supabaseAdmin.
 */

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const idV = validateUuid(new URL(req.url).searchParams.get('id'), 'id');
  if (idV.error) return err(idV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const pid = idV.value!;

  // ─── Property (the only required read) ─────────────────────────────────
  const { data: property, error: propErr } = await supabaseAdmin
    .from('properties')
    .select('*')
    .eq('id', pid)
    .maybeSingle();
  if (propErr) {
    return err(`Could not load property: ${propErr.message}`, { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  if (!property) {
    return err('Property not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }
  const p = property as Record<string, unknown>;

  // ─── Active mapping recipe — v4 lives in pms_knowledge_files (was the
  //     deleted pms_recipes). One active file per PMS family. Best-effort. ─
  let activeRecipe:
    | { id: string; version: number; status: string; learned_by_property_id: string | null; notes: string | null; created_at: string }
    | null = null;
  const family = (p.pms_type as string | null) ?? null;
  if (family) {
    try {
      const { data: kf } = await supabaseAdmin
        .from('pms_knowledge_files')
        .select('id, version, status, learned_at, created_at')
        .eq('pms_family', family)
        .eq('status', 'active')
        .is('deleted_at', null)
        .order('version', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (kf) {
        const k = kf as Record<string, unknown>;
        activeRecipe = {
          id: String(k.id ?? `${family}-v${k.version ?? '?'}`),
          version: Number(k.version ?? 0),
          status: String(k.status ?? 'active'),
          learned_by_property_id: null,
          notes: null,
          created_at: String(k.learned_at ?? k.created_at ?? ''),
        };
      }
    } catch { activeRecipe = null; }
  }

  // ─── Recent onboarding jobs (table + columns unchanged) ────────────────
  let jobs: unknown[] = [];
  try {
    const { data } = await supabaseAdmin
      .from('onboarding_jobs')
      .select('id, status, step, progress_pct, error, recipe_id, worker_id, created_at, started_at, completed_at')
      .eq('property_id', pid)
      .order('created_at', { ascending: false })
      .limit(10);
    jobs = data ?? [];
  } catch { jobs = []; }

  // ─── Staff (count + sample) ────────────────────────────────────────────
  let staffCount = 0;
  let staffSample: unknown[] = [];
  try {
    const { count } = await supabaseAdmin
      .from('staff')
      .select('id', { count: 'exact', head: true })
      .eq('property_id', pid);
    staffCount = count ?? 0;
    const { data } = await supabaseAdmin
      .from('staff')
      .select('id, name, phone, language, department, is_active')
      .eq('property_id', pid)
      .order('name')
      .limit(5);
    // Coalesce nullable columns to the non-null shape the page's HealthData
    // types (department/is_active) so the sample is well-formed if ever rendered.
    staffSample = (data ?? []).map((s) => {
      const r = s as Record<string, unknown>;
      return {
        id: String(r.id ?? ''),
        name: String(r.name ?? ''),
        phone: (r.phone as string | null) ?? null,
        language: String(r.language ?? 'en'),
        department: String(r.department ?? 'other'),
        is_active: (r.is_active as boolean | null) ?? true,
      };
    });
  } catch { /* keep defaults */ }

  // ─── Owner (accounts + auth email) ─────────────────────────────────────
  const ownerId = (p.owner_id as string | null) ?? null;
  let owner: { email: string | null; displayName: string | null; username: string | null } | null = null;
  if (ownerId) {
    let displayName: string | null = null;
    let username: string | null = null;
    try {
      const { data: account } = await supabaseAdmin
        .from('accounts')
        .select('username, display_name')
        .eq('data_user_id', ownerId)
        .maybeSingle();
      displayName = (account?.display_name as string | null) ?? null;
      username = (account?.username as string | null) ?? null;
    } catch { /* null */ }
    let email: string | null = null;
    try {
      const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(ownerId);
      email = authUser?.user?.email ?? null;
    } catch { email = null; }
    owner = { email, displayName, username };
  }

  return ok(
    {
      property: {
        id: String(p.id),
        name: (p.name as string | null) ?? null,
        totalRooms: (p.total_rooms as number | null) ?? null,
        subscriptionStatus: (p.subscription_status as string | null) ?? null,
        trialEndsAt: (p.trial_ends_at as string | null) ?? null,
        stripeCustomerId: (p.stripe_customer_id as string | null) ?? null,
        stripeSubscriptionId: (p.stripe_subscription_id as string | null) ?? null,
        servicesEnabled: (p.services_enabled as Record<string, boolean> | null) ?? null,
        propertyKind: (p.property_kind as string | null) ?? null,
        onboardingSource: (p.onboarding_source as string | null) ?? null,
        pmsType: (p.pms_type as string | null) ?? null,
        pmsConnected: (p.pms_connected as boolean | null) ?? null,
        lastSyncedAt: (p.last_synced_at as string | null) ?? null,
        timezone: (p.timezone as string | null) ?? null,
        createdAt: String(p.created_at ?? ''),
      },
      // Raw PMS login credentials are intentionally no longer surfaced — the
      // scraper_credentials table was removed in the v4 rebuild. The page
      // renders its "no credentials" branch; PMS type / connection are above.
      credentials: null,
      activeRecipe,
      jobs,
      staff: { count: staffCount, sample: staffSample },
      owner,
    },
    { requestId },
  );
}
