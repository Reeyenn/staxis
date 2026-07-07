/**
 * GET /api/admin/mapper/feed-sample?propertyId=<uuid>&feedKeys=k1,k2,...
 *
 * fix/cua-freeform-capture — the "Captured" panel at the bottom of the coverage
 * editor. Returns, per requested feed, a small SAMPLE of what the robot last read
 * (each captured field name + its current value, from the first row), so the
 * founder can SEE exactly what's being captured — including blanks and freshly
 * dragged custom columns — BEFORE the map is made live.
 *
 * Source: the live/{propertyId}/{feed}.sample.json artifact the on-demand capture
 * job (mapper.capture_feed) writes. GRACEFUL: a feed with no sample yet → null;
 * any read failure → null, never a 500.
 *
 * Auth: requireAdmin. supabaseAdmin (the private mapping-screenshots bucket).
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
// The sanitizer AND the proven rule are SHARED with promoteMap's Make-live
// gating so the two can never disagree on which artifact proves a feed
// (feed-sample-key.ts).
import { sanitizeFeedKey as sanitizeKey, sampleIndicatesSuccess } from '@/lib/pms/feed-sample-key';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f-]{36}$/i;
const FEED_KEY = /^[A-Za-z0-9_.-]{1,80}$/;

interface SampleField { name: string; value: string }
interface FeedSample {
  /**
   * Extraction success (feature/coverage-gated-feeds). The worker stamps
   * `ok: boolean` into the stored sample — a partially-failed read still writes
   * an artifact (a "see what went wrong" preview) but with ok:false. Absent in
   * a legacy artifact → true (grandfathered as proven, shared rule
   * sampleIndicatesSuccess). The coverage page uses this — not mere artifact
   * presence — to predict whether Make-live will collect the feed.
   */
  ok: boolean;
  capturedAt: string;
  rowCount: number;
  fields: SampleField[];
  pageValues?: SampleField[];
}

/** Validate + clamp an array of {name,value} fields from the stored sample. */
function sanitizeFields(raw: unknown): SampleField[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f: unknown) => f && typeof f === 'object' && typeof (f as { name?: unknown }).name === 'string')
    .map((f: { name: string; value?: unknown }) => {
      const v = typeof f.value === 'string' ? f.value : '';
      return { name: f.name.slice(0, 80), value: v.length > 200 ? v.slice(0, 200) : v };
    })
    .slice(0, 60);
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const admin = await requireAdmin(req);
  if (!admin.ok) return admin.response;

  const sp = req.nextUrl.searchParams;
  const propertyId = sp.get('propertyId') ?? '';
  if (!UUID.test(propertyId)) {
    return err('propertyId (uuid) is required', { requestId, status: 400, code: 'bad_request' });
  }
  const feedKeys = (sp.get('feedKeys') ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter((k) => FEED_KEY.test(k))
    .slice(0, 24); // bound the fan-out

  const samples: Record<string, FeedSample | null> = {};
  await Promise.all(feedKeys.map(async (feedKey) => {
    samples[feedKey] = await loadSample(propertyId, feedKey);
  }));

  return ok({ samples }, { requestId });
}

/** Download + validate one feed's live sample. Never throws → null on any miss. */
async function loadSample(propertyId: string, feedKey: string): Promise<FeedSample | null> {
  try {
    const path = `live/${propertyId}/${sanitizeKey(feedKey)}.sample.json`;
    const { data: blob } = await supabaseAdmin.storage.from('mapping-screenshots').download(path);
    if (!blob || blob.size > 200_000) return null;
    const parsed = JSON.parse(await blob.text());
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.fields)) return null;
    const fields = sanitizeFields(parsed.fields);
    const pageValues = sanitizeFields(parsed.pageValues);
    return {
      ok: sampleIndicatesSuccess(parsed),
      capturedAt: typeof parsed.capturedAt === 'string' ? parsed.capturedAt : '',
      rowCount: typeof parsed.rowCount === 'number' && Number.isFinite(parsed.rowCount) ? parsed.rowCount : 0,
      fields,
      ...(pageValues.length > 0 ? { pageValues } : {}),
    };
  } catch {
    return null;
  }
}
