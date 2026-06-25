/**
 * GET /api/admin/mapper/feed-capture?feedKey=<key>&jobId=<uuid>
 *   (or ?feedKey=<key>&propertyId=<uuid>)
 *
 * feature/cua-admin-mapper-visibility — the per-feed SOURCE screenshot the
 * robot read a feed from, surfaced in the Coverage Editor so an admin can
 * confirm the robot pulled the data off the RIGHT PMS screen.
 *
 * Looks up mapping_feed_captures for the feed and mints a short-lived signed
 * URL into the private `mapping-screenshots` bucket — the same signing pattern
 * as the sibling live-frame route. The bucket is private (admin-only RLS), so
 * the browser can't read object keys directly.
 *
 * Two resolvers (feedKey is always required):
 *   - jobId      → the capture from that specific learning run (the contract
 *                  form; used by job-scoped callers).
 *   - propertyId → the LATEST capture of this feed for this hotel. This is what
 *                  the Coverage Editor uses: it opens a hotel's active map (not
 *                  a job), and the active map can outlive — or be re-published
 *                  past — the run that first learned a given feed.
 *
 * GRACEFUL BY DESIGN: mapping_feed_captures (migration 0283) is owned and
 * populated by the CUA worker. Until it lands — and for any feed the robot has
 * not captured yet — this returns { url: null } and the editor shows a calm
 * empty state. ANY lookup failure (including the table not existing yet, or a
 * recorded path that no longer signs) degrades to { url: null }, never a 500.
 *
 * Auth: requireAdmin.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f-]{36}$/i;
// Mapper target keys ("getRoomStatus") + legacy feed names. Bounded so a junk
// query param can't fan out; the actual capture path comes from the DB row,
// never reconstructed from this value.
const FEED_KEY = /^[A-Za-z0-9_.-]{1,80}$/;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const admin = await requireAdmin(req);
  if (!admin.ok) return admin.response;

  const sp = req.nextUrl.searchParams;
  const feedKey = sp.get('feedKey') ?? '';
  const jobId = sp.get('jobId') ?? '';
  const propertyId = sp.get('propertyId') ?? '';

  if (!FEED_KEY.test(feedKey)) {
    return err('feedKey is required', { requestId, status: 400, code: 'bad_request' });
  }
  const byJob = UUID.test(jobId);
  const byProperty = UUID.test(propertyId);
  if (!byJob && !byProperty) {
    return err('jobId or propertyId (uuid) is required', {
      requestId, status: 400, code: 'bad_request',
    });
  }

  // fix/cua-freeform-capture-live — RESOLVE the screenshot. Prefer the LIVE
  // per-property key the session refreshes during normal polls (so the drag
  // works WITHOUT re-mapping); fall back to the job/mapping-time capture row.
  let resolved = byProperty ? await signAndGeometry(`live/${propertyId}/${sanitizeKey(feedKey)}.png`) : null;
  if (!resolved) {
    // The capture table is worker-owned (0283) and may not exist yet — treat ANY
    // failure as "no capture" so the editor degrades to its empty state.
    let screenshotPath: string | null = null;
    try {
      let q = supabaseAdmin
        .from('mapping_feed_captures')
        .select('screenshot_path, created_at')
        .eq('feed_key', feedKey);
      q = byJob ? q.eq('job_id', jobId) : q.eq('property_id', propertyId);
      const { data, error } = await q.order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (!error && data && typeof data.screenshot_path === 'string' && data.screenshot_path.length > 0) {
        screenshotPath = data.screenshot_path;
      }
    } catch { screenshotPath = null; }
    if (screenshotPath) resolved = await signAndGeometry(screenshotPath);
  }

  if (!resolved) return ok({ url: null }, { requestId });
  return ok({ url: resolved.url, geometry: resolved.geometry }, { requestId });
}

const sanitizeKey = (k: string): string => k.replace(/[^a-z0-9_-]/gi, '_');

interface ResolvedCapture {
  url: string;
  geometry: {
    viewport: { w: number; h: number };
    columns: Array<{ index: number; header: string; x: number; y: number; w: number; h: number }>;
    values?: Array<{ selector: string; text: string; x: number; y: number; w: number; h: number }>;
  } | null;
}

/** Sign a screenshot path (1h) + best-effort fetch its sibling `.boxes.json`
 *  geometry (columns + freeform values). Returns null when the object isn't
 *  there (so the caller can fall back / degrade). Never throws. */
async function signAndGeometry(path: string): Promise<ResolvedCapture | null> {
  const { data: signed, error } = await supabaseAdmin.storage.from('mapping-screenshots').createSignedUrl(path, 3600);
  if (error || !signed?.signedUrl) return null;
  let geometry: ResolvedCapture['geometry'] = null;
  try {
    const boxesPath = path.replace(/\.png$/, '.boxes.json');
    if (boxesPath !== path) {
      const { data: blob } = await supabaseAdmin.storage.from('mapping-screenshots').download(boxesPath);
      // Size guard before parsing — our own worker writes this (a few KB), so
      // anything large is corrupt/hostile; skip it.
      if (blob && blob.size <= 200_000) {
        const parsed = JSON.parse(await blob.text());
        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.columns)
          && parsed.viewport && typeof parsed.viewport.w === 'number' && typeof parsed.viewport.h === 'number') {
          const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
          const box = (b: Record<string, unknown>) => num(b.x) && num(b.y) && num(b.w) && num(b.h);
          // Require ALL box fields (a truncated/corrupt boxes.json must not yield
          // a half-box that renders at NaN), and cap value selector length.
          const cols = parsed.columns.filter((c: Record<string, unknown>) => c && num(c.index) && box(c));
          const vals = Array.isArray(parsed.values)
            ? parsed.values.filter((v: Record<string, unknown>) => v && typeof v.selector === 'string' && v.selector.length <= 200 && typeof v.text === 'string' && box(v))
            : [];
          if (cols.length > 0) geometry = { viewport: parsed.viewport, columns: cols, ...(vals.length > 0 ? { values: vals } : {}) };
        }
      }
    }
  } catch { geometry = null; }
  return { url: signed.signedUrl, geometry };
}
