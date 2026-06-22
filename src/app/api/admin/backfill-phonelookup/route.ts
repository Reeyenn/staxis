/**
 * GET or POST /api/admin/backfill-phonelookup
 *
 * Backfills `staff.phone_lookup` for every staff row that has a `phone` but no
 * `phone_lookup`. Under the Supabase model there's no separate phoneLookup
 * table — /api/sms-reply matches the inbound phone against `staff.phone_lookup`
 * and then finds the newest open `shift_confirmations` for that staff member.
 *
 * Safe to call repeatedly. Returns counts + examples so you can verify.
 */
import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { runWithConcurrency } from '@/lib/parallel';
import { errToString } from '@/lib/utils';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';

function toE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (raw.startsWith('+')) return raw.trim();
  return null;
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  // Codex 2026-05-16 P1 fix (Pattern C): was gated on CRON_SECRET alone,
  // but it (a) writes to staff across every tenant and (b) returns
  // example rows with staff phone numbers. Not actually called by any
  // cron. Switch to admin session so the auth bar matches the real
  // caller (Reeyen via the admin dashboard).
  const admin = await requireAdmin(req);
  if (!admin.ok) return admin.response;
  try {
    const { data: staff, error } = await supabaseAdmin
      .from('staff')
      .select('id, phone, phone_lookup');
    if (error) throw error;

    const toUpdate: Array<{ id: string; normalized: string }> = [];
    const examples: Array<{ staffId: string; phone: string; phoneLookup: string }> = [];
    let skippedNoPhone = 0;
    let alreadyCurrent = 0;

    for (const row of (staff ?? [])) {
      const phone = (row.phone as string | null) ?? '';
      if (!phone) { skippedNoPhone++; continue; }
      const normalized = toE164(phone);
      if (!normalized) { skippedNoPhone++; continue; }
      if ((row.phone_lookup as string | null) === normalized) { alreadyCurrent++; continue; }

      toUpdate.push({ id: row.id as string, normalized });
      if (examples.length < 10) {
        examples.push({ staffId: row.id as string, phone, phoneLookup: normalized });
      }
    }

    // Bounded fan-out (cap 20) instead of firing every UPDATE at once — at fleet
    // scale (thousands of staff) Promise.all opened one connection per row
    // simultaneously, and a single failure aborted the whole backfill. Now each
    // row's outcome is captured independently. (Audit fix 2026-06-18.)
    const outcomes = await runWithConcurrency(
      toUpdate,
      async (r) => {
        const { error: upErr } = await supabaseAdmin
          .from('staff')
          .update({ phone_lookup: r.normalized })
          .eq('id', r.id);
        if (upErr) throw upErr;
      },
      20,
    );
    const failed = outcomes.filter((o) => !o.ok).length;
    const updated = outcomes.length - failed;
    if (failed > 0) {
      log.error('[admin/backfill-phonelookup] some updates failed', { failed, total: outcomes.length });
    }

    return ok({
      scanned: (staff ?? []).length,
      updated,
      failed,
      alreadyCurrent,
      skippedNoPhone,
      examples,
    }, { requestId });
  } catch (caughtErr) {
    const msg = errToString(caughtErr);
    log.error('[admin/backfill-phonelookup] error', { msg });
    return err(msg, { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}

export async function GET(req: NextRequest) {
  // GET is just a convenience alias for POST so you can hit the URL with
  // a browser. Same auth gate.
  return POST(req);
}
