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
import { errToString } from '@/lib/utils';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';

function toE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (raw.startsWith('+')) return raw.trim();
  return null;
}

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

    // PromiseLike (not Promise) because Supabase's query-builder chain is a
    // thenable — .then() on it returns a PromiseLike, which Promise.all
    // accepts without a full Promise cast.
    const updates: PromiseLike<unknown>[] = [];
    const examples: Array<{ staffId: string; phone: string; phoneLookup: string }> = [];
    let updated = 0;
    let skippedNoPhone = 0;
    let alreadyCurrent = 0;

    for (const row of (staff ?? [])) {
      const phone = (row.phone as string | null) ?? '';
      if (!phone) { skippedNoPhone++; continue; }
      const normalized = toE164(phone);
      if (!normalized) { skippedNoPhone++; continue; }
      if ((row.phone_lookup as string | null) === normalized) { alreadyCurrent++; continue; }

      updates.push(
        supabaseAdmin
          .from('staff')
          .update({ phone_lookup: normalized })
          .eq('id', row.id)
          .then(({ error: upErr }) => { if (upErr) throw upErr; }),
      );
      if (examples.length < 10) {
        examples.push({ staffId: row.id as string, phone, phoneLookup: normalized });
      }
      updated++;
    }

    if (updates.length > 0) await Promise.all(updates);

    return ok({
      scanned: (staff ?? []).length,
      updated,
      alreadyCurrent,
      skippedNoPhone,
      examples,
    }, { requestId });
  } catch (caughtErr) {
    const msg = errToString(caughtErr);
    console.error('backfill-phonelookup error:', msg);
    return err(msg, { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}

export async function GET(req: NextRequest) {
  // GET is just a convenience alias for POST so you can hit the URL with
  // a browser. Same auth gate.
  return POST(req);
}
