/**
 * POST /api/admin/mapper/coverage/capture-feed
 *   body: { propertyId, feedKey }
 *
 * fix/cua-freeform-capture-live — trigger an ON-DEMAND drag-map capture for ONE
 * feed so the founder can use the freeform "drag on the screenshot" editor
 * WITHOUT re-mapping.
 *
 * Why this exists: the drag editor needs a screenshot + per-column geometry. The
 * session-driver normally refreshes that during polls — but a hotel whose map is
 * still a PARKED DRAFT has no active session (paused_no_knowledge_file) and never
 * polls, so the drag-map never appears (the Comfort Suites / Choice Advantage
 * case). This enqueues a `mapper.capture_feed` worker job: it reuses the stored
 * session (FREE, no Claude) to navigate to the one feed and write
 * screenshot+geometry to the stable live/{property}/{feed} keys that
 * GET /api/admin/mapper/feed-capture reads. If that stored session is expired it
 * falls back to ONE vision re-login (org-daily-cap-gated), so this route enforces
 * a short per-(property,feed) COOLDOWN to stop repeated clicks re-firing logins.
 * The UI then polls feed-capture until the geometry appears.
 *
 * RECIPE_SIGNING_KEY is Fly-only and this never re-signs anything (read-only
 * capture), so unlike edit-column there's no draft/live split — it's always a
 * worker job.
 *
 * Auth: requireAdmin. supabaseAdmin (workflow_jobs / property_sessions are
 * deny-all-browser).
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f-]{36}$/i;
const FEED_KEY = /^[A-Za-z0-9_.-]{1,80}$/;
const PMS_FAMILY = /^[a-z][a-z0-9_]{0,48}$/;
// Min gap between on-demand captures of the SAME feed — the expired-session
// fallback spends a vision re-login, so this stops "try again" mashing.
const CAPTURE_COOLDOWN_MS = 60_000;

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const admin = await requireAdmin(req);
  if (!admin.ok) return err('Unauthorized', { requestId, status: 401, code: 'unauthorized' });

  let body: { propertyId?: unknown; feedKey?: unknown; pmsFamily?: unknown };
  try { body = await req.json(); } catch {
    return err('Invalid JSON', { requestId, status: 400, code: 'bad_request' });
  }
  if (typeof body.propertyId !== 'string' || !UUID.test(body.propertyId)) {
    return err('propertyId must be a uuid', { requestId, status: 400, code: 'bad_request' });
  }
  if (typeof body.feedKey !== 'string' || !FEED_KEY.test(body.feedKey)) {
    return err('feedKey is required', { requestId, status: 400, code: 'bad_request' });
  }
  const propertyId = body.propertyId;
  const feedKey = body.feedKey;

  // Resolve the PMS family for this hotel — the worker keys the recipe off it.
  // Prefer the body hint (validated), else the property's session row.
  let pmsFamily = typeof body.pmsFamily === 'string' && PMS_FAMILY.test(body.pmsFamily) ? body.pmsFamily : null;
  if (!pmsFamily) {
    const { data: sess } = await supabaseAdmin
      .from('property_sessions')
      .select('pms_family')
      .eq('property_id', propertyId)
      .maybeSingle();
    const fam = (sess as { pms_family?: string } | null)?.pms_family;
    if (typeof fam === 'string' && PMS_FAMILY.test(fam)) pmsFamily = fam;
  }
  if (!pmsFamily) {
    return err('This hotel has no PMS family configured yet — finish onboarding its PMS first.', {
      requestId, status: 409, code: 'no_pms_family',
    });
  }

  // De-dupe: if a capture for this exact feed is already queued/running, reuse it
  // rather than launching a second browser. Best-effort — a missed dedupe just
  // costs one extra cheap capture. AND a COOLDOWN: the expired-session fallback
  // spends a vision re-login, so a founder mashing "try again" against a broken
  // login must not re-fire one every ~90s. Reuse an in-flight job; refuse a fresh
  // one within CAPTURE_COOLDOWN_MS of the last attempt (the relogin_needed message
  // steers them to Re-map anyway, not to re-click).
  const { data: latest } = await supabaseAdmin
    .from('workflow_jobs')
    .select('id, status, created_at')
    .eq('property_id', propertyId)
    .eq('kind', 'mapper.capture_feed')
    .contains('payload', { feed_key: feedKey })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latest && typeof latest.id === 'string') {
    if (latest.status === 'queued' || latest.status === 'running') {
      return ok({ jobId: latest.id, reused: true }, { requestId });
    }
    const ageMs = Date.now() - new Date(latest.created_at as string).getTime();
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < CAPTURE_COOLDOWN_MS) {
      return err('The robot just tried reading this page — give it a few seconds, or use Re-map.', {
        requestId, status: 429, code: 'cooldown',
      });
    }
  }

  const { data: inserted, error: insErr } = await supabaseAdmin
    .from('workflow_jobs')
    .insert({
      property_id: propertyId,
      kind: 'mapper.capture_feed',
      idempotency_key: `mapper.capture_feed:${propertyId}:${feedKey}:${Date.now()}`,
      max_attempts: 1,
      triggered_by: `admin:${admin.accountId}:coverage-capture`,
      payload: { pms_family: pmsFamily, property_id: propertyId, feed_key: feedKey },
    })
    .select('id')
    .single<{ id: string }>();
  if (insErr || !inserted) {
    return err(`Could not start the capture: ${insErr?.message ?? 'unknown'}`, {
      requestId, status: 500, code: 'db_error',
    });
  }
  return ok({ jobId: inserted.id }, { requestId });
}
